//! Key material management.
use crate::error::{AudioServerError, Result};
use crate::protocol::ChannelId;
use crate::redis_client::RedisClient;
use crate::shutdown::ShutdownListener;
use dashmap::DashMap;
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const SESSION_INFO: &[u8] = b"redenes/audio/v2/session";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Direction { Ingress, Egress }
impl Direction {
    pub fn as_label(self) -> &'static str { match self { Direction::Ingress => "in", Direction::Egress => "out" } }
}

pub trait KeyAgreement: Send + Sync { fn derive(&self, peer_pub: &[u8; 32]) -> Result<[u8; 32]>; }

pub struct StubKeyAgreement;
impl KeyAgreement for StubKeyAgreement {
    fn derive(&self, _peer_pub: &[u8; 32]) -> Result<[u8; 32]> { Err(AudioServerError::Crypto("x25519 not wired".into())) }
}

pub struct HashKeyAgreement { pub secret: [u8; 32] }
impl KeyAgreement for HashKeyAgreement {
    fn derive(&self, peer_pub: &[u8; 32]) -> Result<[u8; 32]> {
        let mut h = Sha256::new();
        h.update(b"test-x25519"); h.update(self.secret); h.update(peer_pub);
        let out = h.finalize();
        let mut shared = [0u8; 32];
        shared.copy_from_slice(&out);
        Ok(shared)
    }
}

pub fn derive_session_key(agreement: &dyn KeyAgreement, peer_pub: &[u8; 32], salt: &[u8]) -> Result<[u8; 32]> {
    let shared = agreement.derive(peer_pub)?;
    let hkdf = Hkdf::<Sha256>::new(Some(salt), &shared);
    let mut out = [0u8; 32];
    hkdf.expand(SESSION_INFO, &mut out).map_err(|e| AudioServerError::Crypto(format!("hkdf expand: {e}")))?;
    Ok(out)
}

pub fn derive_channel_key(session_key: &[u8; 32], dir: Direction, channel_id: ChannelId, key_version: u16) -> Result<[u8; 32]> {
    let hkdf = Hkdf::<Sha256>::from_prk(session_key).map_err(|e| AudioServerError::Crypto(format!("hkdf from_prk: {e}")))?;
    let mut info = Vec::with_capacity(dir.as_label().len() + 4 + 2);
    info.extend_from_slice(dir.as_label().as_bytes());
    info.extend_from_slice(&channel_id.0.to_be_bytes());
    info.extend_from_slice(&key_version.to_be_bytes());
    let mut out = [0u8; 32];
    hkdf.expand(&info, &mut out).map_err(|e| AudioServerError::Crypto(format!("hkdf expand: {e}")))?;
    Ok(out)
}

#[derive(Default)]
pub struct ChannelKeyCache { inner: DashMap<(ChannelId, u16, Direction), [u8; 32]> }
impl ChannelKeyCache {
    pub fn new() -> Self { Self::default() }
    pub fn get_or_derive(&self, session_key: &[u8; 32], channel_id: ChannelId, key_version: u16, direction: Direction) -> Result<[u8; 32]> {
        let k = (channel_id, key_version, direction);
        if let Some(v) = self.inner.get(&k) { return Ok(*v); }
        let derived = derive_channel_key(session_key, direction, channel_id, key_version)?;
        self.inner.insert(k, derived);
        Ok(derived)
    }
    pub fn invalidate_channel(&self, channel_id: ChannelId) { self.inner.retain(|k, _| k.0 != channel_id); }
    pub fn len(&self) -> usize { self.inner.len() }
    pub fn is_empty(&self) -> bool { self.inner.is_empty() }
}

pub struct KeyRotator {
    redis: RedisClient,
    rotation_threshold: Duration,
    tick_interval: Duration,
    state: DashMap<ChannelId, KeyState>,
}
#[derive(Debug, Clone, Copy)] struct KeyState { last_rotated: Instant, dirty: bool }

impl KeyRotator {
    pub fn new(redis: RedisClient) -> Self { Self { redis, rotation_threshold: Duration::from_secs(3600), tick_interval: Duration::from_secs(60), state: DashMap::new() } }
    pub fn with_rotation_threshold(mut self, d: Duration) -> Self { self.rotation_threshold = d; self }
    pub fn with_tick_interval(mut self, d: Duration) -> Self { self.tick_interval = d; self }
    pub fn mark_dirty(&self, channel_id: ChannelId) {
        self.state.entry(channel_id).and_modify(|s| s.dirty = true)
            .or_insert(KeyState { last_rotated: Instant::now() - self.rotation_threshold, dirty: true });
    }
    pub fn observe_rotation(&self, channel_id: ChannelId) {
        self.state.insert(channel_id, KeyState { last_rotated: Instant::now(), dirty: false });
    }
    pub fn spawn(self: Arc<Self>, mut shutdown: ShutdownListener) {
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(self.tick_interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    _ = ticker.tick() => { self.tick().await; }
                    _ = shutdown.wait() => { tracing::info!("KeyRotator: shutdown"); return; }
                }
            }
        });
    }
    async fn tick(&self) {
        let now = Instant::now();
        let due: Vec<ChannelId> = self.state.iter().filter_map(|kv| {
            let aged = now.duration_since(kv.last_rotated) >= self.rotation_threshold;
            if kv.dirty || aged { Some(*kv.key()) } else { None }
        }).collect();
        for cid in due {
            match self.redis.bump_channel_key_version(cid).await {
                Ok(new_v) => {
                    let evt = serde_json::json!({ "channel_id": cid.0, "key_version": new_v }).to_string();
                    if let Err(e) = self.redis.publish(&format!("channel:{}:key_rotation", cid.0), &evt).await {
                        tracing::warn!(?e, channel = cid.0, "publish key_rotation failed");
                    }
                    self.state.insert(cid, KeyState { last_rotated: Instant::now(), dirty: false });
                    tracing::info!(channel = cid.0, new_version = new_v, "rotated channel key");
                }
                Err(e) => tracing::warn!(?e, channel = cid.0, "bump_channel_key_version failed"),
            }
        }
    }
}
