//! Floor control — half-duplex arbitration for a single channel.
use std::cmp::Ordering;
use std::collections::BinaryHeap;
use std::time::{Duration, Instant};
use crate::protocol::{ClientId, Priority};

pub const GRANT_CAP_NORMAL: Duration = Duration::from_secs(30);
pub const GRANT_CAP_HIGH: Duration = Duration::from_secs(60);

pub fn grant_cap(priority: Priority) -> Option<Duration> {
    match priority {
        Priority::Normal => Some(GRANT_CAP_NORMAL),
        Priority::High => Some(GRANT_CAP_HIGH),
        Priority::Emergency | Priority::ImminentPeril => None,
    }
}

#[derive(Debug, Clone, Copy)]
pub struct QueuedEntry {
    pub priority: Priority,
    pub since: u64,
    pub client_id: ClientId,
    pub queued_at: Instant,
}
impl PartialEq for QueuedEntry { fn eq(&self, o: &Self) -> bool { self.priority == o.priority && self.since == o.since } }
impl Eq for QueuedEntry {}
impl Ord for QueuedEntry {
    fn cmp(&self, o: &Self) -> Ordering {
        match self.priority.cmp(&o.priority) {
            Ordering::Equal => o.since.cmp(&self.since),
            ord => ord,
        }
    }
}
impl PartialOrd for QueuedEntry { fn partial_cmp(&self, o: &Self) -> Option<Ordering> { Some(self.cmp(o)) } }

#[derive(Debug, Clone, Copy)]
pub enum FloorMachineState {
    Idle,
    Granted { holder: ClientId, priority: Priority, started_at: Instant, until: Option<Instant> },
}

#[derive(Debug, Clone)]
pub enum FloorDecision {
    Granted { started_at: Instant, until: Option<Instant> },
    Queued { pos: usize },
    Denied { reason: String },
    Preempt { previous_holder: ClientId, started_at: Instant, until: Option<Instant> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReleaseCause { ClientRelease, Expired, Preempted, Disconnect }

#[derive(Debug, Clone)]
pub struct FloorStateSnapshot {
    pub holder: Option<ClientId>,
    pub priority: Priority,
    pub started_at: Option<Instant>,
    pub until: Option<Instant>,
    pub queue: Vec<QueuedEntry>,
    pub full_duplex: bool,
}

pub struct FloorControl {
    state: FloorMachineState,
    queue: BinaryHeap<QueuedEntry>,
    next_since: u64,
    full_duplex: bool,
}

impl FloorControl {
    pub fn new(full_duplex: bool) -> Self { Self { state: FloorMachineState::Idle, queue: BinaryHeap::new(), next_since: 0, full_duplex } }
    #[inline] pub fn is_full_duplex(&self) -> bool { self.full_duplex }
    pub fn set_full_duplex(&mut self, flag: bool) { self.full_duplex = flag; if flag { self.queue.clear(); self.state = FloorMachineState::Idle; } }
    #[inline] pub fn is_holder(&self, c: ClientId) -> bool { matches!(self.state, FloorMachineState::Granted { holder, .. } if holder == c) }
    #[inline] pub fn current_holder(&self) -> Option<ClientId> {
        match self.state { FloorMachineState::Granted { holder, .. } => Some(holder), FloorMachineState::Idle => None }
    }
    pub fn request(&mut self, client_id: ClientId, priority: Priority) -> FloorDecision { self.request_at(client_id, priority, Instant::now()) }
    pub fn request_at(&mut self, client_id: ClientId, priority: Priority, now: Instant) -> FloorDecision {
        if self.full_duplex {
            let cap = grant_cap(priority);
            let until = cap.map(|c| now + c);
            self.state = FloorMachineState::Granted { holder: client_id, priority, started_at: now, until };
            return FloorDecision::Granted { started_at: now, until };
        }
        match self.state {
            FloorMachineState::Idle => {
                let cap = grant_cap(priority);
                let until = cap.map(|c| now + c);
                self.state = FloorMachineState::Granted { holder: client_id, priority, started_at: now, until };
                FloorDecision::Granted { started_at: now, until }
            }
            FloorMachineState::Granted { holder, priority: held_pri, .. } => {
                if client_id == holder {
                    let cap = grant_cap(priority);
                    let until = cap.map(|c| now + c);
                    let started_at = match self.state { FloorMachineState::Granted { started_at, .. } => started_at, _ => now };
                    self.state = FloorMachineState::Granted { holder, priority, started_at, until };
                    return FloorDecision::Granted { started_at, until };
                }
                if priority > held_pri {
                    let previous_holder = holder;
                    let cap = grant_cap(priority);
                    let until = cap.map(|c| now + c);
                    self.state = FloorMachineState::Granted { holder: client_id, priority, started_at: now, until };
                    FloorDecision::Preempt { previous_holder, started_at: now, until }
                } else {
                    let since = self.next_since;
                    self.next_since = self.next_since.wrapping_add(1);
                    self.queue.retain(|e| e.client_id != client_id);
                    self.queue.push(QueuedEntry { priority, since, client_id, queued_at: now });
                    let pos = self.compute_queue_position(client_id);
                    FloorDecision::Queued { pos }
                }
            }
        }
    }
    pub fn release(&mut self, c: ClientId) -> Option<ClientId> { self.release_at(c, Instant::now()) }
    pub fn release_at(&mut self, c: ClientId, now: Instant) -> Option<ClientId> {
        self.queue.retain(|e| e.client_id != c);
        match self.state {
            FloorMachineState::Granted { holder, .. } if holder == c => { self.state = FloorMachineState::Idle; self.promote_next(now) }
            _ => None,
        }
    }
    pub fn expire_if_due(&mut self, now: Instant) -> Option<ClientId> {
        let should = match self.state { FloorMachineState::Granted { until: Some(u), .. } => now >= u, _ => false };
        if should { self.state = FloorMachineState::Idle; self.promote_next(now) } else { None }
    }
    pub fn drop_client(&mut self, c: ClientId) -> Option<ClientId> { self.release(c) }
    pub fn snapshot(&self) -> FloorStateSnapshot {
        let (holder, priority, started_at, until) = match self.state {
            FloorMachineState::Idle => (None, Priority::Normal, None, None),
            FloorMachineState::Granted { holder, priority, started_at, until } => (Some(holder), priority, Some(started_at), until),
        };
        let mut queue: Vec<QueuedEntry> = self.queue.iter().copied().collect();
        queue.sort_by(|a, b| match b.priority.cmp(&a.priority) { Ordering::Equal => a.since.cmp(&b.since), o => o });
        FloorStateSnapshot { holder, priority, started_at, until, queue, full_duplex: self.full_duplex }
    }
    fn promote_next(&mut self, now: Instant) -> Option<ClientId> {
        while let Some(top) = self.queue.pop() {
            let cap = grant_cap(top.priority);
            let until = cap.map(|c| now + c);
            self.state = FloorMachineState::Granted { holder: top.client_id, priority: top.priority, started_at: now, until };
            return Some(top.client_id);
        }
        None
    }
    fn compute_queue_position(&self, c: ClientId) -> usize {
        let mut items: Vec<QueuedEntry> = self.queue.iter().copied().collect();
        items.sort_by(|a, b| match b.priority.cmp(&a.priority) { Ordering::Equal => a.since.cmp(&b.since), o => o });
        items.iter().position(|e| e.client_id == c).unwrap_or(items.len().saturating_sub(1))
    }
}
