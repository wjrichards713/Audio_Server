//! Per-subscriber egress task (MIX/FWD).
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::UdpSocket;
use tokio::sync::mpsc;
use tracing::{trace, warn};
use crate::channel::{DecodedFrame, SubscriberControlMessage};
use crate::media::{CryptoPool, OpusEncoderPool, SubscriberMixer, FRAME_SIZE};
use crate::metrics;
use crate::prefs::{ChannelPrefs, SessionOptions};
use crate::protocol::{flags as pkt_flags, ChannelId, ChannelPriorityRole, ClientId, Header,
    PacketType, PayloadType, PttMuteScope, SessionMode, CHANNEL_ID_MIX,
    EXPLICIT_IV_SIZE, HEADER_SIZE, PROTOCOL_VERSION};

#[derive(Debug, Clone)]
struct InboundFrame { channel_id: ChannelId, sequence: u32, timestamp: u32, source: ClientId, samples_f32: [f32; FRAME_SIZE] }

pub type SubscriberMessage = SubscriberControlMessage;

pub struct SubscriberHandle { pub tx: mpsc::Sender<SubscriberMessage>, pub join: tokio::task::JoinHandle<()> }

pub struct SubscriberTask {
    subscriber_id: u64, server_id: u32, key_version: u16,
    mode: SessionMode, options: SessionOptions,
    socket: Arc<UdpSocket>, egress_addr: SocketAddr,
    encoders: OpusEncoderPool, crypto: CryptoPool, mixer: SubscriberMixer,
    channels: HashMap<ChannelId, ChannelState>,
    iv_counter: u64, egress_seq: u32, holding_floor_on: Option<ChannelId>,
    tick_rx: tokio::sync::broadcast::Receiver<super::pacer::TickEvent>,
    ctrl_rx: mpsc::Receiver<SubscriberMessage>,
}

#[derive(Debug, Clone)]
struct ChannelState { prefs: ChannelPrefs, latest: Option<InboundFrame>, last_sequence: u32 }

impl SubscriberTask {
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(subscriber_id: u64, server_id: u32, key_version: u16,
                 mode: SessionMode, options: SessionOptions,
                 socket: Arc<UdpSocket>, egress_addr: SocketAddr, crypto: CryptoPool,
                 pacer_rx: tokio::sync::broadcast::Receiver<super::pacer::TickEvent>) -> SubscriberHandle {
        let (tx, rx) = mpsc::channel(512);
        let task = Self {
            subscriber_id, server_id, key_version, mode, options, socket, egress_addr,
            encoders: OpusEncoderPool::new(), crypto, mixer: SubscriberMixer::default(),
            channels: HashMap::new(), iv_counter: 1, egress_seq: 0, holding_floor_on: None,
            tick_rx: pacer_rx, ctrl_rx: rx,
        };
        SubscriberHandle { tx, join: tokio::spawn(task.run()) }
    }

    async fn run(mut self) {
        loop {
            tokio::select! { biased;
                tick = self.tick_rx.recv() => {
                    match tick {
                        Ok(ev) => self.on_tick(ev).await,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => warn!(subscriber=self.subscriber_id, lagged=n, "pacer lagged"),
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                    }
                }
                msg = self.ctrl_rx.recv() => match msg { Some(m) => if !self.on_ctrl(m) { return; }, None => return }
            }
        }
    }

    fn on_ctrl(&mut self, msg: SubscriberMessage) -> bool {
        match msg {
            SubscriberControlMessage::Frame(decoded) => self.ingest_frame(decoded),
            SubscriberControlMessage::AddChannel { channel_id, prefs } => {
                self.channels.entry(channel_id).or_insert(ChannelState { prefs, latest: None, last_sequence: 0 });
            }
            SubscriberControlMessage::UpdateChannelPrefs { channel_id, prefs } => {
                if let Some(c) = self.channels.get_mut(&channel_id) { c.prefs = prefs; }
            }
            SubscriberControlMessage::RemoveChannel { channel_id } => { self.channels.remove(&channel_id); }
            SubscriberControlMessage::SetMode(m) => { self.mode = m; self.options.mode = m; }
            SubscriberControlMessage::PttStateChanged { channel_id, is_holding } => {
                self.holding_floor_on = if is_holding { Some(channel_id) } else { None };
            }
            SubscriberControlMessage::Shutdown => return false,
        }
        true
    }

    fn ingest_frame(&mut self, decoded: DecodedFrame) {
        let Some(c) = self.channels.get_mut(&decoded.channel_id) else { return; };
        if decoded.sequence <= c.last_sequence && c.last_sequence != 0 { return; }
        let mut buf = [0f32; FRAME_SIZE];
        let src = &decoded.samples[..];
        let n = src.len().min(FRAME_SIZE);
        for i in 0..n { buf[i] = (src[i] as f32) / 32768.0; }
        c.latest = Some(InboundFrame { channel_id: decoded.channel_id, sequence: decoded.sequence,
                                       timestamp: decoded.timestamp, source: decoded.source, samples_f32: buf });
        c.last_sequence = decoded.sequence;
    }

    async fn on_tick(&mut self, tick: super::pacer::TickEvent) {
        let tick_start = std::time::Instant::now();
        let any_solo = self.channels.values().any(|c| c.prefs.solo && !c.prefs.is_effectively_silent());
        let ptt_active = self.holding_floor_on.is_some();
        let ptt_mute_all = ptt_active && self.options.ptt_mutes == PttMuteScope::All;
        let ptt_mute_others = ptt_active && self.options.ptt_mutes == PttMuteScope::Others;
        let ptt_channel = self.holding_floor_on;
        if ptt_active && self.options.pause_egress_during_ptt { return; }

        match self.mode {
            SessionMode::Forward => {
                let channel_ids: Vec<ChannelId> = self.channels.keys().copied().collect();
                for ch_id in channel_ids {
                    let Some(state) = self.channels.get_mut(&ch_id) else { continue };
                    let emergency = matches!(state.prefs.priority_role, ChannelPriorityRole::EmergencyOverride);
                    let monitor = matches!(state.prefs.priority_role, ChannelPriorityRole::Monitor);
                    if state.prefs.muted && !emergency && !monitor { continue; }
                    if any_solo && !state.prefs.solo && !emergency && !monitor { continue; }
                    if ptt_mute_all && !emergency { continue; }
                    if ptt_mute_others && ptt_channel != Some(ch_id) && !emergency { continue; }
                    let Some(frame) = state.latest.take() else { continue };
                    let gain = state.prefs.target_gain_linear;
                    let mut out = frame.samples_f32;
                    for s in out.iter_mut() { *s = (*s * gain).clamp(-1.0, 1.0); }
                    self.send_opus_packet(ch_id.0, tick.rtp_timestamp, frame.source, &out).await;
                }
            }
            SessionMode::Mix => {
                let mut input_bufs: Vec<[f32; FRAME_SIZE]> = Vec::new();
                let mut gains: Vec<f32> = Vec::new();
                let mut ch_ids: Vec<ChannelId> = self.channels.keys().copied().collect();
                ch_ids.sort_by_key(|c| c.0);
                for ch_id in ch_ids {
                    let Some(state) = self.channels.get_mut(&ch_id) else { continue };
                    let emergency = matches!(state.prefs.priority_role, ChannelPriorityRole::EmergencyOverride);
                    let monitor = matches!(state.prefs.priority_role, ChannelPriorityRole::Monitor);
                    if state.prefs.muted && !emergency && !monitor { continue; }
                    if any_solo && !state.prefs.solo && !emergency && !monitor { continue; }
                    if ptt_mute_all && !emergency { continue; }
                    if ptt_mute_others && ptt_channel != Some(ch_id) && !emergency { continue; }
                    let Some(frame) = state.latest.take() else { continue };
                    let mut gain = state.prefs.target_gain_linear;
                    if monitor || emergency { gain = gain.max(1.0); }
                    input_bufs.push(frame.samples_f32);
                    gains.push(gain);
                    if input_bufs.len() >= super::AE_MAX_MIX_INPUTS { break; }
                }
                if !input_bufs.is_empty() {
                    let refs: Vec<&[f32; FRAME_SIZE]> = input_bufs.iter().collect();
                    let mut mixed = [0f32; FRAME_SIZE];
                    self.mixer.mix(&refs, &gains, &mut mixed);
                    self.send_opus_packet(CHANNEL_ID_MIX, tick.rtp_timestamp, ClientId(0), &mixed).await;
                }
            }
        }
        metrics::obs_mix_tick_seconds(tick_start.elapsed().as_secs_f64());
    }

    async fn send_opus_packet(&mut self, channel_id: u32, rtp_ts: u32, source: ClientId, pcm: &[f32; FRAME_SIZE]) {
        let mut opus_bytes = Vec::with_capacity(1500);
        let enc_key = super::encoder::EncoderKey { subscriber_id: self.subscriber_id, stream_id: channel_id };
        let encode_t0 = std::time::Instant::now();
        let n = match self.encoders.encode(enc_key, pcm, &mut opus_bytes) { Ok(n) => n, Err(e) => { warn!(?e, "opus encode failed"); return; } };
        metrics::obs_encode_seconds(encode_t0.elapsed().as_secs_f64());
        if n == 0 { return; }

        self.egress_seq = self.egress_seq.wrapping_add(1);
        let flags = if channel_id == CHANNEL_ID_MIX { pkt_flags::MIX_EGRESS } else { 0 };
        let header = Header {
            version: PROTOCOL_VERSION,
            packet_type: if channel_id == CHANNEL_ID_MIX { PacketType::Mixed as u8 } else { PacketType::Audio as u8 },
            payload_type: PayloadType::Opus48kMono as u8, flags,
            sequence: self.egress_seq, timestamp: rtp_ts, channel_id, client_id: source.0,
            server_id: self.server_id, key_version: self.key_version, payload_length: 0,
        };

        let iv = self.iv_counter.to_be_bytes();
        self.iv_counter = self.iv_counter.wrapping_add(1);

        let mut header_buf = [0u8; HEADER_SIZE];
        let mut h_local = header;
        h_local.payload_length = (opus_bytes.len() + 16) as u16;
        h_local.encode(&mut header_buf);

        let ct = match self.crypto.seal(self.key_version, &header_buf, &opus_bytes, &iv) {
            Ok(c) => c, Err(e) => { warn!(?e, "crypto seal failed"); return; }
        };

        let mut pkt = Vec::with_capacity(HEADER_SIZE + EXPLICIT_IV_SIZE + ct.len());
        pkt.extend_from_slice(&header_buf);
        pkt.extend_from_slice(&iv);
        pkt.extend_from_slice(&ct);

        if let Err(e) = self.socket.send_to(&pkt, self.egress_addr).await { trace!(?e, "udp egress send failed"); return; }
        metrics::inc_pkts_out(match self.mode { SessionMode::Mix => "mix", SessionMode::Forward => "forward" });
    }
}
