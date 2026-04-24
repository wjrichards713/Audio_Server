//! Inter-server UDP mesh.
use crate::config::Config;
use crate::error::{AudioServerError, Result};
use crate::protocol::{self, ChannelId, ClientId, Header, PacketType, PayloadType, HEADER_SIZE, NONCE_SIZE, SESSION_SALT_SIZE};
use crate::redis_client::RedisClient;
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use dashmap::DashMap;
use parking_lot::Mutex;
use std::net::{SocketAddr, ToSocketAddrs};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::net::UdpSocket;
use tokio::sync::mpsc;

const MESH_SALT: [u8; SESSION_SALT_SIZE] = *b"MESH";
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(2);
const MAX_MISSED_PONGS: u32 = 3;

#[derive(Debug, Clone)]
pub struct MeshFrame {
    pub channel_id: ChannelId,
    pub client_id: ClientId,
    pub origin_server_id: u32,
    pub sequence: u32,
    pub timestamp: u32,
    pub key_version: u16,
    pub opus_payload: Vec<u8>,
}

enum InboundEvent { Frame(MeshFrame), Pong { peer: SocketAddr }, Ping { peer: SocketAddr, nonce: u64 } }

#[derive(Clone)]
pub struct MeshHandle { inner: Arc<MeshInner> }

struct MeshInner {
    socket: Arc<UdpSocket>,
    cipher: Aes256Gcm,
    server_id: u32,
    seq: AtomicU64,
    egress_counter: AtomicU64,
    peers: DashMap<SocketAddr, PeerState>,
    redis: RedisClient,
    subscriber: Mutex<Option<mpsc::Sender<MeshFrame>>>,
}

#[derive(Debug, Clone)]
struct PeerState { last_pong: Instant, missed: u32, alive: bool }
impl Default for PeerState { fn default() -> Self { Self { last_pong: Instant::now(), missed: 0, alive: true } } }

impl MeshHandle {
    pub fn on_peer_frame(&self, tx: mpsc::Sender<MeshFrame>) { *self.inner.subscriber.lock() = Some(tx); }
    pub async fn forward_frame(&self, channel_id: ChannelId, client_id: ClientId, key_version: u16, opus_payload: &[u8]) -> Result<()> {
        let peers = match self.inner.redis.list_channel_servers(channel_id).await {
            Ok(list) => list, Err(e) => { tracing::warn!(?e, "mesh: list_channel_servers failed"); return Ok(()); }
        };
        let seq_base = self.inner.seq.fetch_add(1, Ordering::Relaxed) as u32;
        let ts = now_48k_ticks();
        for peer_addr in peers {
            let Some(sa) = resolve_first(&peer_addr) else { tracing::debug!(%peer_addr, "mesh: unresolvable peer addr"); continue; };
            if self.is_self(&sa) { continue; }
            if let Some(p) = self.inner.peers.get(&sa) { if !p.alive { continue; } }
            let header = Header { version: protocol::PROTOCOL_VERSION, packet_type: PacketType::Audio as u8,
                payload_type: PayloadType::Opus48kMono as u8, flags: 0, sequence: seq_base, timestamp: ts,
                channel_id: channel_id.0, client_id: client_id.0, server_id: self.inner.server_id, key_version, payload_length: 0 };
            match self.build_packet(header, opus_payload) {
                Ok(pkt) => { if let Err(e) = self.inner.socket.send_to(&pkt, sa).await { tracing::warn!(%sa, ?e, "mesh: send_to failed"); } }
                Err(e) => tracing::error!(?e, "mesh: build_packet failed"),
            }
        }
        Ok(())
    }
    fn is_self(&self, addr: &SocketAddr) -> bool {
        if let Ok(local) = self.inner.socket.local_addr() { local == *addr } else { false }
    }
    fn build_packet(&self, mut header: Header, plaintext: &[u8]) -> Result<Vec<u8>> {
        let iv_counter = self.inner.egress_counter.fetch_add(1, Ordering::Relaxed);
        let iv = iv_counter.to_be_bytes();
        let mut nonce_bytes = [0u8; NONCE_SIZE];
        nonce_bytes[..SESSION_SALT_SIZE].copy_from_slice(&MESH_SALT);
        nonce_bytes[SESSION_SALT_SIZE..].copy_from_slice(&iv);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let mut header_buf = [0u8; HEADER_SIZE];
        header.encode(&mut header_buf);
        let ciphertext = self.inner.cipher.encrypt(nonce, aes_gcm::aead::Payload { msg: plaintext, aad: &header_buf })
            .map_err(|_| AudioServerError::Crypto("mesh encrypt failed".into()))?;
        header.payload_length = ciphertext.len() as u16;
        header.encode(&mut header_buf);
        let mut out = Vec::with_capacity(HEADER_SIZE + 8 + ciphertext.len());
        out.extend_from_slice(&header_buf);
        out.extend_from_slice(&iv);
        out.extend_from_slice(&ciphertext);
        Ok(out)
    }
    pub fn server_id(&self) -> u32 { self.inner.server_id }
}

pub async fn spawn(cfg: &Config, redis: RedisClient) -> Result<MeshHandle> {
    let bind = SocketAddr::new(cfg.bind_ip, cfg.mesh_port);
    let socket = Arc::new(UdpSocket::bind(bind).await.map_err(AudioServerError::Io)?);
    let key_bytes = decode_hex32(&cfg.mesh_key_hex)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let inner = Arc::new(MeshInner { socket: socket.clone(), cipher, server_id: cfg.server_id,
        seq: AtomicU64::new(0), egress_counter: AtomicU64::new(now_epoch_ms()),
        peers: DashMap::new(), redis, subscriber: Mutex::new(None) });
    let handle = MeshHandle { inner: inner.clone() };
    let recv_handle = handle.clone();
    tokio::spawn(async move { if let Err(e) = recv_loop(recv_handle).await { tracing::error!(?e, "mesh recv_loop exited"); } });
    let hb_handle = handle.clone();
    tokio::spawn(async move { heartbeat_loop(hb_handle).await; });
    tracing::info!(%bind, "mesh listening");
    Ok(handle)
}

async fn recv_loop(handle: MeshHandle) -> Result<()> {
    let mut buf = vec![0u8; protocol::MAX_UDP_PACKET];
    loop {
        let (n, peer) = match handle.inner.socket.recv_from(&mut buf).await { Ok(v) => v, Err(e) => { tracing::warn!(?e, "mesh recv_from error"); continue; } };
        match decode_inbound(&handle, &buf[..n], peer) { Ok(ev) => on_inbound(&handle, ev).await, Err(e) => tracing::debug!(%peer, ?e, "mesh: drop unparseable packet") }
    }
}

fn decode_inbound(handle: &MeshHandle, pkt: &[u8], peer: SocketAddr) -> Result<InboundEvent> {
    if pkt.len() < HEADER_SIZE + 8 + 16 { return Err(AudioServerError::Protocol("mesh: short packet".into())); }
    let header = Header::parse(&pkt[..HEADER_SIZE]).ok_or_else(|| AudioServerError::Protocol("mesh: bad header".into()))?;
    let iv: [u8; 8] = pkt[HEADER_SIZE..HEADER_SIZE + 8].try_into().expect("8-byte slice");
    let ct = &pkt[HEADER_SIZE + 8..];
    let mut nonce_bytes = [0u8; NONCE_SIZE];
    nonce_bytes[..SESSION_SALT_SIZE].copy_from_slice(&MESH_SALT);
    nonce_bytes[SESSION_SALT_SIZE..].copy_from_slice(&iv);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let plaintext = handle.inner.cipher.decrypt(nonce, aes_gcm::aead::Payload { msg: ct, aad: &pkt[..HEADER_SIZE] })
        .map_err(|_| AudioServerError::Crypto("mesh decrypt failed".into()))?;
    match PacketType::from_u8(header.packet_type) {
        Some(PacketType::Ping) => {
            let nonce = if plaintext.len() >= 8 { u64::from_be_bytes(plaintext[..8].try_into().expect("8-byte slice")) } else { 0 };
            Ok(InboundEvent::Ping { peer, nonce })
        }
        Some(PacketType::Pong) => Ok(InboundEvent::Pong { peer }),
        Some(PacketType::Audio) | Some(PacketType::Mixed) => Ok(InboundEvent::Frame(MeshFrame {
            channel_id: ChannelId(header.channel_id), client_id: ClientId(header.client_id),
            origin_server_id: header.server_id, sequence: header.sequence, timestamp: header.timestamp,
            key_version: header.key_version, opus_payload: plaintext })),
        _ => Err(AudioServerError::Protocol("mesh: unsupported type".into())),
    }
}

async fn on_inbound(handle: &MeshHandle, ev: InboundEvent) {
    match ev {
        InboundEvent::Frame(f) => {
            let sub = handle.inner.subscriber.lock().clone();
            if let Some(tx) = sub { if let Err(e) = tx.try_send(f) { tracing::warn!(?e, "mesh: subscriber channel full or closed"); } }
            else { tracing::trace!("mesh: dropping frame — no subscriber installed"); }
        }
        InboundEvent::Pong { peer } => {
            let mut entry = handle.inner.peers.entry(peer).or_default();
            entry.last_pong = Instant::now(); entry.missed = 0;
            if !entry.alive { entry.alive = true; tracing::info!(%peer, "mesh: peer revived"); }
        }
        InboundEvent::Ping { peer, nonce } => {
            let header = Header { version: protocol::PROTOCOL_VERSION, packet_type: PacketType::Pong as u8,
                payload_type: 0, flags: 0, sequence: 0, timestamp: now_48k_ticks(), channel_id: 0, client_id: 0,
                server_id: handle.inner.server_id, key_version: 0, payload_length: 0 };
            let payload = nonce.to_be_bytes();
            if let Ok(pkt) = handle.build_packet(header, &payload) { let _ = handle.inner.socket.send_to(&pkt, peer).await; }
        }
    }
}

async fn heartbeat_loop(handle: MeshHandle) {
    let mut ticker = tokio::time::interval(HEARTBEAT_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        for mut entry in handle.inner.peers.iter_mut() {
            let peer = *entry.key();
            entry.missed = entry.missed.saturating_add(1);
            if entry.missed >= MAX_MISSED_PONGS && entry.alive { entry.alive = false; tracing::warn!(%peer, missed = entry.missed, "mesh: peer marked dead"); }
        }
        let keys: Vec<SocketAddr> = handle.inner.peers.iter().map(|kv| *kv.key()).collect();
        for peer in keys {
            let nonce = now_epoch_ms();
            let header = Header { version: protocol::PROTOCOL_VERSION, packet_type: PacketType::Ping as u8, payload_type: 0,
                flags: 0, sequence: 0, timestamp: now_48k_ticks(), channel_id: 0, client_id: 0,
                server_id: handle.inner.server_id, key_version: 0, payload_length: 0 };
            let payload = nonce.to_be_bytes();
            if let Ok(pkt) = handle.build_packet(header, &payload) { let _ = handle.inner.socket.send_to(&pkt, peer).await; }
        }
    }
}

fn decode_hex32(s: &str) -> Result<[u8; 32]> {
    let s = s.trim();
    if s.len() != 64 { return Err(AudioServerError::Crypto("MESH_KEY_HEX must be 64 hex chars".into())); }
    let mut out = [0u8; 32];
    for (i, chunk) in s.as_bytes().chunks(2).enumerate() { out[i] = (hex_digit(chunk[0])? << 4) | hex_digit(chunk[1])?; }
    Ok(out)
}
fn hex_digit(b: u8) -> Result<u8> {
    match b { b'0'..=b'9' => Ok(b - b'0'), b'a'..=b'f' => Ok(b - b'a' + 10), b'A'..=b'F' => Ok(b - b'A' + 10), _ => Err(AudioServerError::Crypto("bad hex digit in mesh key".into())) }
}
fn resolve_first(addr: &str) -> Option<SocketAddr> { addr.to_socket_addrs().ok().and_then(|mut i| i.next()) }
fn now_epoch_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0) }
fn now_48k_ticks() -> u32 { (now_epoch_ms().wrapping_mul(48)) as u32 }
