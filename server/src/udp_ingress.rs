//! UDP media-plane ingress.
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;
use tokio::net::UdpSocket;
use tracing::{debug, trace, warn};
use crate::channel::{ChannelRegistry, DecryptedFrame};
use crate::config::Config;
use crate::error::{AudioServerError, Result};
use crate::media::crypto_pool::Direction;
use crate::media::{CryptoPool, OpusDecoderPool, FRAME_SIZE};
use crate::metrics;
use crate::prefs;
use crate::protocol::{ChannelId, ClientId, Header, PacketType, EXPLICIT_IV_SIZE, HEADER_SIZE, MAX_UDP_PACKET};
use crate::session::SessionRegistry;
use crate::shutdown::ShutdownListener;

pub struct UdpIngress {
    socket: Arc<UdpSocket>,
    sessions: Arc<SessionRegistry>,
    channels: Arc<ChannelRegistry>,
    decoders: OpusDecoderPool,
}

impl UdpIngress {
    pub async fn start(cfg: &Config, sessions: Arc<SessionRegistry>, channels: Arc<ChannelRegistry>, mut shutdown: ShutdownListener) -> Result<()> {
        let bind = SocketAddr::new(cfg.bind_ip, cfg.udp_port);
        let socket = UdpSocket::bind(bind).await.map_err(AudioServerError::Io)?;
        let socket = Arc::new(socket);
        tracing::info!(%bind, "udp ingress listening");
        let ingress = Self { socket: socket.clone(), sessions, channels, decoders: OpusDecoderPool::new() };
        let mut buf = vec![0u8; MAX_UDP_PACKET];
        loop {
            tokio::select! {
                _ = shutdown.wait() => { tracing::info!("udp ingress shutting down"); return Ok(()); }
                res = socket.recv_from(&mut buf) => {
                    match res {
                        Ok((n, from)) => { if let Err(e) = ingress.handle_packet(&buf[..n], from).await { trace!(%from, ?e, "drop packet"); } }
                        Err(e) => warn!(?e, "udp recv error"),
                    }
                }
            }
        }
    }

    async fn handle_packet(&self, pkt: &[u8], from: SocketAddr) -> Result<()> {
        let header = Header::parse(pkt).ok_or_else(|| { metrics::inc_pkts_dropped("header"); AudioServerError::Protocol("bad header".into()) })?;
        metrics::inc_pkts_in(header.channel_id);
        match PacketType::from_u8(header.packet_type) {
            Some(PacketType::Audio) => {}
            Some(PacketType::Keepalive) => { self.update_egress_addr(ClientId(header.client_id), from).await; return Ok(()); }
            Some(PacketType::Ping) => { let _ = self.socket.send_to(pkt, from).await; return Ok(()); }
            _ => { metrics::inc_pkts_dropped("type"); return Err(AudioServerError::Protocol("unsupported type".into())); }
        }
        if pkt.len() < HEADER_SIZE + EXPLICIT_IV_SIZE + 16 { metrics::inc_pkts_dropped("short"); return Err(AudioServerError::Protocol("short packet".into())); }
        let client_id = ClientId(header.client_id);
        let session = match self.sessions.get_by_client(client_id) {
            Some(s) => s, None => { metrics::inc_pkts_dropped("session"); return Err(AudioServerError::NotFound(format!("no session for client {client_id}"))); }
        };
        {
            let mut s = session.write().await;
            if !s.observe_ingress_seq(ChannelId(header.channel_id), client_id, header.sequence) { metrics::inc_pkts_dropped("replay"); return Err(AudioServerError::Protocol("replay".into())); }
            if s.egress_addr != Some(from) { s.egress_addr = Some(from); }
            s.stats.packets_rx += 1;
            s.stats.bytes_rx += pkt.len() as u64;
        }
        let (salt, key, key_version) = { let s = session.read().await; (s.session_salt, s.session_key.0, header.key_version) };
        let pool = CryptoPool::new(salt);
        let ch_key = crate::keys::derive_channel_key(&key, crate::keys::Direction::Ingress, ChannelId(header.channel_id), key_version)?;
        pool.install_key(key_version, Direction::Ingress, &ch_key);
        let iv_bytes: [u8; EXPLICIT_IV_SIZE] = pkt[HEADER_SIZE..HEADER_SIZE + EXPLICIT_IV_SIZE].try_into().expect("EXPLICIT_IV_SIZE");
        let ct = &pkt[HEADER_SIZE + EXPLICIT_IV_SIZE..];
        let aad = &pkt[..HEADER_SIZE];
        let plaintext = pool.open(key_version, aad, ct, &iv_bytes).map_err(|e| { metrics::inc_pkts_dropped("decrypt"); e })?;
        let mut pcm_f32 = [0.0f32; FRAME_SIZE];
        let n = self.decoders.decode(header.channel_id, header.client_id, &plaintext, &mut pcm_f32).unwrap_or(0);
        if n == 0 { metrics::inc_pkts_dropped("decode"); return Err(AudioServerError::Protocol("opus decode 0".into())); }
        let samples_i16: Vec<i16> = pcm_f32.iter().map(|&s| (s.clamp(-1.0, 1.0) * 32767.0) as i16).collect();
        let frame = DecryptedFrame { source: client_id, channel_id: ChannelId(header.channel_id), sequence: header.sequence,
            timestamp: header.timestamp, flags: header.flags, samples: Arc::new(samples_i16), channels: 1, received_at: Instant::now() };
        if let Some(ch) = self.channels.get(ChannelId(header.channel_id)) {
            if ch.inbound_tx.try_send(frame).is_err() { metrics::inc_pkts_dropped("hub_full"); debug!(channel = header.channel_id, "hub inbound full, dropped"); }
        } else { metrics::inc_pkts_dropped("no_channel"); }
        let _ = prefs::DEFAULT_SIDETONE_DB;
        Ok(())
    }

    async fn update_egress_addr(&self, client_id: ClientId, from: SocketAddr) {
        if let Some(session) = self.sessions.get_by_client(client_id) {
            let mut s = session.write().await;
            s.egress_addr = Some(from);
        }
    }
}
