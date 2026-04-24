//! Presence and floor-state broadcaster (rate-limited).
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use dashmap::DashMap;
use parking_lot::Mutex;
use tokio::sync::broadcast;
use tracing::trace;
use crate::channel::Channel;
use crate::floor::FloorStateSnapshot;
use crate::protocol::{ChannelId, ClientId};
use crate::ws_ops::{FloorState, MemberInfo, Presence, QueuedFloor, ServerOp};

pub const PRESENCE_MIN_INTERVAL: Duration = Duration::from_millis(250);
pub const PRESENCE_CHANNEL_CAPACITY: usize = 128;

struct ChannelBroadcast {
    tx: broadcast::Sender<ServerOp>,
    last_presence: Mutex<Instant>,
    pending_presence: Mutex<bool>,
}
impl ChannelBroadcast {
    fn new() -> Self {
        let (tx, _rx) = broadcast::channel(PRESENCE_CHANNEL_CAPACITY);
        Self { tx, last_presence: Mutex::new(Instant::now() - PRESENCE_MIN_INTERVAL * 2), pending_presence: Mutex::new(false) }
    }
}

#[derive(Default)]
pub struct PresenceBroadcaster { channels: DashMap<ChannelId, Arc<ChannelBroadcast>> }

impl PresenceBroadcaster {
    pub fn new() -> Arc<Self> { Arc::new(Self::default()) }
    pub fn subscribe(&self, channel_id: ChannelId) -> broadcast::Receiver<ServerOp> {
        let entry = self.channels.entry(channel_id).or_insert_with(|| Arc::new(ChannelBroadcast::new()));
        entry.value().tx.subscribe()
    }
    pub fn drop_channel(&self, channel_id: ChannelId) { self.channels.remove(&channel_id); }
    pub fn publish_presence(&self, channel: &Channel) {
        let channel_id = channel.channel_id;
        let entry = match self.channels.get(&channel_id) {
            Some(e) => e.value().clone(),
            None => { let bc = Arc::new(ChannelBroadcast::new()); self.channels.insert(channel_id, bc.clone()); bc }
        };
        let now = Instant::now();
        {
            let mut last = entry.last_presence.lock();
            if now.duration_since(*last) < PRESENCE_MIN_INTERVAL {
                *entry.pending_presence.lock() = true;
                trace!(%channel_id, "presence update coalesced");
                return;
            }
            *last = now;
            *entry.pending_presence.lock() = false;
        }
        let _ = entry.tx.send(ServerOp::Presence(build_presence(channel)));
    }
    pub fn flush_pending(&self, channel: &Channel) {
        let channel_id = channel.channel_id;
        let Some(entry_ref) = self.channels.get(&channel_id) else { return; };
        let entry = entry_ref.value().clone(); drop(entry_ref);
        let should = { *entry.pending_presence.lock() };
        if !should { return; }
        { *entry.last_presence.lock() = Instant::now(); *entry.pending_presence.lock() = false; }
        let _ = entry.tx.send(ServerOp::Presence(build_presence(channel)));
    }
    pub fn publish_floor(&self, channel_id: ChannelId, snapshot: FloorStateSnapshot) {
        let entry = self.channels.entry(channel_id).or_insert_with(|| Arc::new(ChannelBroadcast::new())).value().clone();
        let _ = entry.tx.send(ServerOp::FloorState(build_floor_state(channel_id, snapshot)));
    }
    pub fn total_subscribers(&self) -> usize {
        self.channels.iter().map(|e| e.value().tx.receiver_count()).sum()
    }
}

fn build_presence(channel: &Channel) -> Presence {
    let mut members: BTreeMap<u64, MemberInfo> = BTreeMap::new();
    for entry in channel.members.iter() {
        let m = entry.value();
        members.insert(m.client_id.0, MemberInfo {
            client_id: m.client_id, user_name: m.user_name.clone(),
            speaking: m.speaking, since_ms: m.since_ms,
        });
    }
    Presence { channel_id: channel.channel_id, members: members.into_values().collect() }
}

fn build_floor_state(channel_id: ChannelId, snap: FloorStateSnapshot) -> FloorState {
    let started_at_ms = snap.started_at.map(instant_to_approx_unix_ms).unwrap_or(0);
    let until_ms = snap.until.map(instant_to_approx_unix_ms);
    let queue = snap.queue.into_iter().map(|e| QueuedFloor { client_id: e.client_id, priority: e.priority, since_ms: instant_to_approx_unix_ms(e.queued_at) }).collect();
    FloorState { channel_id, holder: snap.holder, priority: snap.priority, started_at_ms, until_ms, queue }
}

fn instant_to_approx_unix_ms(i: Instant) -> u64 {
    let now = Instant::now();
    let now_unix = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    if i >= now { now_unix.saturating_add(i.duration_since(now).as_millis() as u64) }
    else { now_unix.saturating_sub(now.duration_since(i).as_millis() as u64) }
}

pub fn note_speaking(broadcaster: &PresenceBroadcaster, channel: &Channel, client_id: ClientId, speaking: bool) {
    if let Some(mut m) = channel.members.get_mut(&client_id) {
        if m.speaking == speaking { return; }
        m.speaking = speaking;
    }
    broadcaster.publish_presence(channel);
}
