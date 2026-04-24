//! Per-sender jitter buffer.
use std::collections::VecDeque;

pub type PopResult<T> = Option<T>;

pub struct JitterBuffer<T> {
    queue: VecDeque<Entry<T>>,
    min_frames: usize,
    max_frames: usize,
    highest_seen: Option<u32>,
    last_popped: Option<u32>,
    primed: bool,
    pub loss_count: u64,
    pub underrun_count: u64,
    pub reorder_count: u64,
    pub duplicate_count: u64,
}
struct Entry<T> { seq: u32, item: T }

impl<T> JitterBuffer<T> {
    pub fn new(min_frames: usize, max_frames: usize) -> Self {
        let min = min_frames.max(1);
        let max = max_frames.max(min);
        Self { queue: VecDeque::with_capacity(max), min_frames: min, max_frames: max,
               highest_seen: None, last_popped: None, primed: false,
               loss_count: 0, underrun_count: 0, reorder_count: 0, duplicate_count: 0 }
    }
    #[inline] pub fn len(&self) -> usize { self.queue.len() }
    #[inline] pub fn is_empty(&self) -> bool { self.queue.is_empty() }
    #[inline] pub fn is_primed(&self) -> bool { self.primed }
    #[inline] pub fn highest_seen(&self) -> Option<u32> { self.highest_seen }

    pub fn push(&mut self, seq: u32, item: T) {
        if let Some(last) = self.last_popped {
            if seq_leq_wrap(seq, last) { self.duplicate_count += 1; return; }
        }
        match self.highest_seen {
            None => self.highest_seen = Some(seq),
            Some(h) => {
                if seq_gt_wrap(seq, h) {
                    let gap = seq.wrapping_sub(h).wrapping_sub(1);
                    if gap > 0 && gap < 1024 { self.loss_count = self.loss_count.saturating_add(gap as u64); }
                    self.highest_seen = Some(seq);
                } else { self.reorder_count += 1; }
            }
        }
        let mut idx = self.queue.len();
        while idx > 0 {
            let prev = &self.queue[idx - 1];
            if seq_gt_wrap(seq, prev.seq) { break; }
            if prev.seq == seq { self.duplicate_count += 1; return; }
            idx -= 1;
        }
        self.queue.insert(idx, Entry { seq, item });
        while self.queue.len() > self.max_frames {
            let _ = self.queue.pop_front();
            self.loss_count = self.loss_count.saturating_add(1);
        }
        if !self.primed && self.queue.len() >= self.min_frames { self.primed = true; }
    }

    pub fn pop(&mut self) -> PopResult<T> {
        if !self.primed { return None; }
        match self.queue.pop_front() {
            Some(entry) => {
                self.last_popped = Some(entry.seq);
                if self.queue.is_empty() { self.primed = false; }
                Some(entry.item)
            }
            None => { self.underrun_count += 1; self.primed = false; None }
        }
    }
    pub fn reset(&mut self) {
        self.queue.clear();
        self.highest_seen = None;
        self.last_popped = None;
        self.primed = false;
    }
}

#[inline]
fn seq_gt_wrap(a: u32, b: u32) -> bool {
    ((a > b) && (a - b < 0x8000_0000)) || ((a < b) && (b - a > 0x8000_0000))
}
#[inline]
fn seq_leq_wrap(a: u32, b: u32) -> bool { a == b || seq_gt_wrap(b, a) }
