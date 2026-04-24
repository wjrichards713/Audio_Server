//! Per-client Session and SessionRegistry.
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;
use dashmap::DashMap;
use tokio::sync::RwLock;
use zeroize::{Zeroize, ZeroizeOnDrop};
use crate::prefs::{ChannelPrefs, SessionOptions};
use crate::protocol::{ChannelId, ChannelPriorityRole, ClientId, SessionId, SessionMode};

pub const SESSION_SALT_LEN: usize = 4;

#[derive(Zeroize, ZeroizeOnDrop, Clone)]
pub struct SessionKey(pub [u8; 32]);
impl Default for SessionKey { fn default() -> Self { Self([0u8; 32]) } }
impl std::fmt::Debug for SessionKey { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("SessionKey([redacted])") } }

#[derive(Debug, Clone, Default)]
pub struct SessionPubkeys { pub client_x25519: [u8; 32], pub server_x25519: [u8; 32] }

#[derive(Debug, Clone, Default)]
pub struct IngressSeqTracker { pub highest: u32, pub reorder_drops: u64, pub accepted: u64 }
impl IngressSeqTracker {
    pub fn observe(&mut self, seq: u32) -> bool {
        if seq > self.highest || self.highest == 0 { self.highest = seq; self.accepted = self.accepted.saturating_add(1); true }
        else { self.reorder_drops = self.reorder_drops.saturating_add(1); false }
    }
}

#[derive(Debug, Clone, Default)]
pub struct SessionStats {
    pub packets_rx: u64, pub packets_tx: u64,
    pub bytes_rx: u64, pub bytes_tx: u64,
    pub decrypt_errors: u64, pub floor_requests: u64,
}

pub struct Session {
    pub session_id: SessionId,
    pub client_id: ClientId,
    pub user_name: String,
    pub device_id: String,
    pub mode: SessionMode,
    pub egress_addr: Option<SocketAddr>,
    pub session_salt: [u8; SESSION_SALT_LEN],
    pub session_key: SessionKey,
    pub pubkeys: SessionPubkeys,
    pub current_subscriptions: HashMap<ChannelId, ChannelPrefs>,
    pub options: SessionOptions,
    pub holding_floor_on: Option<ChannelId>,
    pub ingress_seq_trackers: HashMap<(ChannelId, ClientId), IngressSeqTracker>,
    pub stats: SessionStats,
    pub key_version: u16,
    pub created_at: Instant,
}

impl Session {
    #[allow(clippy::too_many_arguments)]
    pub fn new(session_id: SessionId, client_id: ClientId, user_name: String, device_id: String,
               mode: SessionMode, session_salt: [u8; SESSION_SALT_LEN], session_key: SessionKey,
               pubkeys: SessionPubkeys, options: SessionOptions) -> Self {
        Self { session_id, client_id, user_name, device_id, mode, egress_addr: None,
               session_salt, session_key, pubkeys, current_subscriptions: HashMap::new(),
               options, holding_floor_on: None, ingress_seq_trackers: HashMap::new(),
               stats: SessionStats::default(), key_version: 1, created_at: Instant::now() }
    }
    pub fn update_prefs(&mut self, channel_id: ChannelId, gain_db: Option<f32>, muted: Option<bool>,
                        solo: Option<bool>, priority_role: Option<ChannelPriorityRole>) -> ChannelPrefs {
        let prefs = self.current_subscriptions.entry(channel_id).or_insert_with(ChannelPrefs::default);
        prefs.apply_update(gain_db, muted, solo, priority_role);
        prefs.clone()
    }
    pub fn subscribe(&mut self, channel_id: ChannelId, gain_db: Option<f32>, muted: Option<bool>,
                     solo: Option<bool>, priority_role: Option<ChannelPriorityRole>) -> ChannelPrefs {
        let prefs = self.current_subscriptions.entry(channel_id).or_insert_with(
            || ChannelPrefs::from_parts(gain_db, muted, solo, priority_role));
        prefs.apply_update(gain_db, muted, solo, priority_role);
        prefs.snap_gain();
        prefs.clone()
    }
    pub fn unsubscribe(&mut self, channel_id: ChannelId) -> Option<ChannelPrefs> {
        self.ingress_seq_trackers.retain(|(ch, _), _| *ch != channel_id);
        self.current_subscriptions.remove(&channel_id)
    }
    pub fn set_mode(&mut self, new_mode: SessionMode) -> bool {
        if self.mode != new_mode { self.mode = new_mode; self.options.mode = new_mode; true } else { false }
    }
    pub fn set_options(&mut self, mode: Option<SessionMode>, pause_egress_during_ptt: Option<bool>,
                       ptt_mutes: Option<crate::protocol::PttMuteScope>, sidetone_db: Option<f32>) -> bool {
        let mode_changed = self.options.apply_update(mode, pause_egress_during_ptt, ptt_mutes, sidetone_db);
        if mode_changed { self.mode = self.options.mode; }
        mode_changed
    }
    pub fn mark_holding_floor(&mut self, channel_id: ChannelId) { self.holding_floor_on = Some(channel_id); }
    pub fn clear_holding_floor(&mut self) { self.holding_floor_on = None; }
    pub fn observe_ingress_seq(&mut self, channel_id: ChannelId, source: ClientId, seq: u32) -> bool {
        self.ingress_seq_trackers.entry((channel_id, source)).or_default().observe(seq)
    }
}

#[derive(Default)]
pub struct SessionRegistry {
    by_session: DashMap<SessionId, Arc<RwLock<Session>>>,
    by_client: DashMap<ClientId, SessionId>,
}
impl SessionRegistry {
    pub fn new() -> Arc<Self> { Arc::new(Self::default()) }
    pub fn insert(&self, session: Session) -> Arc<RwLock<Session>> {
        let session_id = session.session_id.clone();
        let client_id = session.client_id;
        if let Some(prev) = self.by_client.get(&client_id) {
            let prev_sid = prev.value().clone(); drop(prev);
            self.by_session.remove(&prev_sid);
        }
        let handle = Arc::new(RwLock::new(session));
        self.by_session.insert(session_id.clone(), handle.clone());
        self.by_client.insert(client_id, session_id);
        handle
    }
    pub fn get(&self, session_id: &SessionId) -> Option<Arc<RwLock<Session>>> { self.by_session.get(session_id).map(|e| e.value().clone()) }
    pub fn get_by_client(&self, client_id: ClientId) -> Option<Arc<RwLock<Session>>> {
        let sid = self.by_client.get(&client_id)?.value().clone();
        self.by_session.get(&sid).map(|e| e.value().clone())
    }
    pub fn remove(&self, session_id: &SessionId) -> Option<Arc<RwLock<Session>>> {
        let (_, handle) = self.by_session.remove(session_id)?;
        let cid_opt = handle.try_read().ok().map(|g| g.client_id);
        if let Some(cid) = cid_opt { self.by_client.remove_if(&cid, |_, sid| sid == session_id); }
        Some(handle)
    }
    pub fn len(&self) -> usize { self.by_session.len() }
    pub fn is_empty(&self) -> bool { self.by_session.is_empty() }
    pub fn snapshot(&self) -> Vec<Arc<RwLock<Session>>> { self.by_session.iter().map(|e| e.value().clone()).collect() }
}
