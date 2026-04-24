//! 20 ms tick broadcaster.
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::broadcast;
use tokio::task::JoinHandle;
use tokio::time::{interval_at, MissedTickBehavior};
use tracing::{debug, warn};
use crate::media::FRAME_MS;

#[derive(Debug, Clone, Copy)]
pub struct TickEvent {
    pub tick_number: u64,
    pub rtp_timestamp: u32,
    pub scheduled_at: Instant,
}

pub struct Pacer {
    pub tx: broadcast::Sender<TickEvent>,
    handle: Option<JoinHandle<()>>,
}

impl Pacer {
    pub fn spawn(capacity: usize) -> Self {
        let (tx, _rx0) = broadcast::channel(capacity.max(2));
        let tx_task = tx.clone();
        let handle = tokio::spawn(async move { pacer_loop(tx_task).await });
        Self { tx, handle: Some(handle) }
    }
    #[inline] pub fn subscribe(&self) -> broadcast::Receiver<TickEvent> { self.tx.subscribe() }
    #[inline] pub fn receiver_count(&self) -> usize { self.tx.receiver_count() }
}
impl Drop for Pacer {
    fn drop(&mut self) { if let Some(h) = self.handle.take() { h.abort(); } }
}

async fn pacer_loop(tx: broadcast::Sender<TickEvent>) {
    let period = Duration::from_millis(FRAME_MS);
    let start = next_aligned_instant(period);
    let mut ticker = interval_at(start.into(), period);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut tick_number: u64 = 0;
    let samples_per_tick: u32 = (FRAME_MS as u32) * 48;
    loop {
        let scheduled_at = ticker.tick().await.into_std();
        let rtp_timestamp = (tick_number as u32).wrapping_mul(samples_per_tick);
        let event = TickEvent { tick_number, rtp_timestamp, scheduled_at };
        match tx.send(event) {
            Ok(_) => {}
            Err(_) => debug!("pacer tick had no receivers"),
        }
        let lag = scheduled_at.elapsed();
        if lag > period.saturating_mul(2) { warn!(lag_ms = lag.as_millis() as u64, "pacer lag exceeds 2 ticks"); }
        tick_number = tick_number.wrapping_add(1);
    }
}

fn next_aligned_instant(period: Duration) -> Instant {
    let now = Instant::now();
    let Ok(epoch_delta) = SystemTime::now().duration_since(UNIX_EPOCH) else { return now + period; };
    let p_nanos = period.as_nanos().max(1);
    let since_epoch_nanos = epoch_delta.as_nanos();
    let next_multiple = ((since_epoch_nanos / p_nanos) + 1) * p_nanos;
    let wait_nanos = (next_multiple - since_epoch_nanos) as u64;
    now + Duration::from_nanos(wait_nanos)
}
