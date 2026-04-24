//! Channel state, ChannelHub fanout task, ChannelRegistry.
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use dashmap::DashMap;
use parking_lot::RwLock;
use tokio::sync::mpsc;
use tracing::{debug, trace, warn};
use crate::floor::{FloorControl, FloorStateSnapshot};
use crate::prefs::ChannelPrefs;
use crate::protocol::{ChannelId, ClientId, SessionId};

pub const CHANNEL_INBOUND_CAPACITY: usize = 1024;
pub const SUBSCRIBER_CTRL_CAPACITY: usize = 512;

#[derive(Debug, Clone)]
pub struct DecryptedFrame {
    pub source: ClientId,
    pub channel_id: ChannelId,
    pub sequence: u32,
    pub timestamp: u32,
    pub flags: u8,
    pub samples: Arc<Vec<i16>>,
    pub channels: u8,
    pub received_at: Instant,
}

#[derive(Debug, Clone)]
pub struct DecodedFrame {
    pub source: ClientId,
    pub channel_id: ChannelId,
    pub sequence: u32,
    pub timestamp: u32,
    pub flags: u8,
    pub samples: Arc<Vec<i16>>,
    pub channels: u8,
}
impl From<DecryptedFrame> for DecodedFrame {
    fn from(f: DecryptedFrame) -> Self {
        Self { source: f.source, channel_id: f.channel_id, sequence: f.sequence,
               timestamp: f.timestamp, flags: f.flags, samples: f.samples, channels: f.channels }
    }
}

#[derive(Debug, Clone)]
pub enum SubscriberControlMessage {
    Frame(DecodedFrame),
    UpdateChannelPrefs { channel_id: ChannelId, prefs: ChannelPrefs },
    AddChannel { channel_id: ChannelId, prefs: ChannelPrefs },
    RemoveChannel { channel_id: ChannelId },
    SetMode(crate::protocol::SessionMode),
    PttStateChanged { channel_id: ChannelId, is_holding: bool },
    Shutdown,
}

#[derive(Debug, Clone)]
pub struct ChannelConfig {
    pub name: String,
    pub full_duplex: bool,
    pub require_auth: bool,
    pub max_members: Option<u32>,
    pub key_version: u16,
}
impl Default for ChannelConfig {
    fn default() -> Self { Self { name: String::new(), full_duplex: false, require_auth: true, max_members: None, key_version: 1 } }
}

#[derive(Debug, Clone)]
pub struct MemberInfo {
    pub client_id: ClientId, pub user_name: String,
    pub speaking: bool, pub since_ms: u64, pub session_id: SessionId,
}
impl MemberInfo {
    pub fn new(client_id: ClientId, user_name: String, session_id: SessionId) -> Self {
        let since_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        Self { client_id, user_name, speaking: false, since_ms, session_id }
    }
}

pub struct Channel {
    pub channel_id: ChannelId,
    pub config: ChannelConfig,
    pub members: DashMap<ClientId, MemberInfo>,
    pub floor: RwLock<FloorControl>,
    pub subscribers: DashMap<SessionId, mpsc::Sender<SubscriberControlMessage>>,
    pub inbound_tx: mpsc::Sender<DecryptedFrame>,
}

impl Channel {
    pub fn spawn(channel_id: ChannelId, config: ChannelConfig) -> (Arc<Self>, tokio::task::JoinHandle<()>) {
        let (inbound_tx, inbound_rx) = mpsc::channel(CHANNEL_INBOUND_CAPACITY);
        let floor = RwLock::new(FloorControl::new(config.full_duplex));
        let channel = Arc::new(Self { channel_id, config, members: DashMap::new(), floor,
                                       subscribers: DashMap::new(), inbound_tx });
        let hub = ChannelHub { channel: Arc::clone(&channel), inbound_rx };
        let join = tokio::spawn(hub.run());
        (channel, join)
    }
    pub fn add_member(&self, info: MemberInfo) { self.members.entry(info.client_id).or_insert(info); }
    pub fn remove_member(&self, client_id: ClientId) -> Option<ClientId> {
        self.members.remove(&client_id);
        self.floor.write().drop_client(client_id)
    }
    pub fn register_subscriber(&self, session_id: SessionId, sender: mpsc::Sender<SubscriberControlMessage>) {
        self.subscribers.insert(session_id, sender);
    }
    pub fn unregister_subscriber(&self, session_id: &SessionId) -> Option<mpsc::Sender<SubscriberControlMessage>> {
        self.subscribers.remove(session_id).map(|(_, s)| s)
    }
    pub fn member_count(&self) -> u32 { self.members.len() as u32 }
    pub fn floor_snapshot(&self) -> FloorStateSnapshot { self.floor.read().snapshot() }
    pub async fn push_prefs_update(&self, session_id: &SessionId, channel_id: ChannelId, prefs: ChannelPrefs) {
        if let Some(sender) = self.subscribers.get(session_id) {
            let msg = SubscriberControlMessage::UpdateChannelPrefs { channel_id, prefs };
            if let Err(e) = sender.send(msg).await { warn!(?session_id, error = %e, "failed to push prefs update"); }
        }
    }
    pub async fn broadcast(&self, msg: SubscriberControlMessage) -> usize {
        let mut ok = 0usize;
        let senders: Vec<_> = self.subscribers.iter().map(|e| e.value().clone()).collect();
        for sender in senders { if sender.send(msg.clone()).await.is_ok() { ok += 1; } }
        ok
    }
}

pub struct ChannelHub { channel: Arc<Channel>, inbound_rx: mpsc::Receiver<DecryptedFrame> }
impl ChannelHub {
    pub async fn run(mut self) {
        let channel_id = self.channel.channel_id;
        debug!(%channel_id, "channel hub started");
        while let Some(frame) = self.inbound_rx.recv().await {
            if !self.enforce_floor(&frame) {
                trace!(%channel_id, source = %frame.source, "drop frame: sender not floor holder");
                continue;
            }
            self.fanout(frame).await;
        }
        debug!(%channel_id, "channel hub terminated");
    }
    fn enforce_floor(&self, frame: &DecryptedFrame) -> bool {
        let floor = self.channel.floor.read();
        if floor.is_full_duplex() { return true; }
        floor.is_holder(frame.source)
    }
    async fn fanout(&self, frame: DecryptedFrame) {
        if let Some(mut m) = self.channel.members.get_mut(&frame.source) { m.speaking = true; }
        let decoded: DecodedFrame = frame.into();
        let senders: Vec<_> = self.channel.subscribers.iter().map(|e| e.value().clone()).collect();
        for sender in senders {
            match sender.try_send(SubscriberControlMessage::Frame(decoded.clone())) {
                Ok(_) => {}
                Err(mpsc::error::TrySendError::Full(_)) => trace!(channel_id = %self.channel.channel_id, "subscriber queue full; dropping frame"),
                Err(mpsc::error::TrySendError::Closed(_)) => {}
            }
        }
    }
}

#[derive(Default)]
pub struct ChannelRegistry { channels: DashMap<ChannelId, Arc<Channel>> }
impl ChannelRegistry {
    pub fn new() -> Arc<Self> { Arc::new(Self::default()) }
    pub fn get(&self, channel_id: ChannelId) -> Option<Arc<Channel>> { self.channels.get(&channel_id).map(|e| e.value().clone()) }
    pub fn get_or_create(&self, channel_id: ChannelId, config: ChannelConfig) -> Arc<Channel> {
        if let Some(ch) = self.get(channel_id) { return ch; }
        let (channel, _hub) = Channel::spawn(channel_id, config);
        self.channels.entry(channel_id).or_insert(channel).value().clone()
    }
    pub fn remove(&self, channel_id: ChannelId) -> Option<Arc<Channel>> { self.channels.remove(&channel_id).map(|(_, ch)| ch) }
    pub fn len(&self) -> usize { self.channels.len() }
    pub fn is_empty(&self) -> bool { self.channels.is_empty() }
    pub fn snapshot(&self) -> Vec<Arc<Channel>> { self.channels.iter().map(|e| e.value().clone()).collect() }
}
