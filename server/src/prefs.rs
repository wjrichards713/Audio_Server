//! Per-subscriber preferences and session-wide options.
use crate::protocol::{ChannelPriorityRole, PttMuteScope, SessionMode};
use serde::{Deserialize, Serialize};

pub const MIN_GAIN_DB: f32 = -60.0;
pub const MAX_GAIN_DB: f32 = 12.0;
pub const DEFAULT_SIDETONE_DB: f32 = -18.0;

#[inline]
pub fn clamp_gain_db(db: f32) -> f32 {
    if db.is_nan() { 0.0 } else { db.clamp(MIN_GAIN_DB, MAX_GAIN_DB) }
}
#[inline]
pub fn db_to_linear(db: f32) -> f32 { 10.0_f32.powf(db / 20.0) }
#[inline]
pub fn clamped_db_to_linear(db: f32) -> f32 { db_to_linear(clamp_gain_db(db)) }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelPrefs {
    pub gain_db: f32,
    pub target_gain_linear: f32,
    pub current_gain_linear: f32,
    pub muted: bool,
    pub solo: bool,
    pub priority_role: ChannelPriorityRole,
}
impl Default for ChannelPrefs {
    fn default() -> Self {
        Self { gain_db: 0.0, target_gain_linear: 1.0, current_gain_linear: 1.0,
               muted: false, solo: false, priority_role: ChannelPriorityRole::Normal }
    }
}
impl ChannelPrefs {
    pub fn from_parts(gain_db: Option<f32>, muted: Option<bool>, solo: Option<bool>,
                      priority_role: Option<ChannelPriorityRole>) -> Self {
        let db = clamp_gain_db(gain_db.unwrap_or(0.0));
        let lin = db_to_linear(db);
        Self { gain_db: db, target_gain_linear: lin, current_gain_linear: lin,
               muted: muted.unwrap_or(false), solo: solo.unwrap_or(false),
               priority_role: priority_role.unwrap_or(ChannelPriorityRole::Normal) }
    }
    pub fn apply_update(&mut self, gain_db: Option<f32>, muted: Option<bool>,
                        solo: Option<bool>, priority_role: Option<ChannelPriorityRole>) {
        if let Some(db) = gain_db { self.gain_db = clamp_gain_db(db); self.target_gain_linear = db_to_linear(self.gain_db); }
        if let Some(m) = muted { self.muted = m; }
        if let Some(s) = solo { self.solo = s; }
        if let Some(p) = priority_role { self.priority_role = p; }
    }
    #[inline] pub fn snap_gain(&mut self) { self.current_gain_linear = self.target_gain_linear; }
    #[inline] pub fn is_effectively_silent(&self) -> bool { self.muted || self.target_gain_linear <= 1e-6 }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionOptions {
    pub mode: SessionMode,
    pub pause_egress_during_ptt: bool,
    pub ptt_mutes: PttMuteScope,
    pub sidetone_db: f32,
}
impl Default for SessionOptions {
    fn default() -> Self { Self { mode: SessionMode::default(), pause_egress_during_ptt: true,
                                   ptt_mutes: PttMuteScope::default(), sidetone_db: DEFAULT_SIDETONE_DB } }
}
impl SessionOptions {
    pub fn apply_update(&mut self, mode: Option<SessionMode>,
                        pause_egress_during_ptt: Option<bool>,
                        ptt_mutes: Option<PttMuteScope>,
                        sidetone_db: Option<f32>) -> bool {
        let mut mode_changed = false;
        if let Some(m) = mode { if self.mode != m { mode_changed = true; } self.mode = m; }
        if let Some(v) = pause_egress_during_ptt { self.pause_egress_during_ptt = v; }
        if let Some(v) = ptt_mutes { self.ptt_mutes = v; }
        if let Some(v) = sidetone_db { self.sidetone_db = clamp_gain_db(v); }
        mode_changed
    }
}
