//! Float32 N-input mixer with 5ms ramps + tanh soft limiter.
use crate::media::{AE_MAX_MIX_INPUTS, AE_RAMP_SAMPLES, FRAME_SIZE};

#[derive(Debug, Clone)]
pub struct SubscriberMixer {
    max_inputs: usize,
    prev_gains: [f32; AE_MAX_MIX_INPUTS],
    master_gain: f32,
    master_gain_target: f32,
}

impl SubscriberMixer {
    pub fn new(max_inputs: usize) -> Self {
        let cap = max_inputs.max(1).min(AE_MAX_MIX_INPUTS);
        Self { max_inputs: cap, prev_gains: [0.0; AE_MAX_MIX_INPUTS], master_gain: 1.0, master_gain_target: 1.0 }
    }
    #[inline] pub fn max_inputs(&self) -> usize { self.max_inputs }
    pub fn set_master_gain(&mut self, gain: f32) { self.master_gain_target = gain.clamp(0.0, 4.0); }
    #[inline] pub fn master_gain(&self) -> f32 { self.master_gain_target }

    pub fn mix(&mut self, inputs: &[&[f32; FRAME_SIZE]], gains: &[f32], out: &mut [f32; FRAME_SIZE]) {
        for s in out.iter_mut() { *s = 0.0; }
        let n = inputs.len().min(gains.len()).min(self.max_inputs);
        let ramp_len = AE_RAMP_SAMPLES.min(FRAME_SIZE);
        let inv_ramp = 1.0_f32 / ramp_len as f32;
        for i in 0..n {
            let input = inputs[i];
            let prev = self.prev_gains[i];
            let target = gains[i].clamp(0.0, 4.0);
            if (prev - target).abs() < 1e-6 {
                if target.abs() < 1e-6 { /* silent */ }
                else if (target - 1.0).abs() < 1e-6 { for s in 0..FRAME_SIZE { out[s] += input[s]; } }
                else { for s in 0..FRAME_SIZE { out[s] += input[s] * target; } }
            } else {
                for s in 0..ramp_len {
                    let t = (s as f32) * inv_ramp;
                    let g = prev + (target - prev) * t;
                    out[s] += input[s] * g;
                }
                for s in ramp_len..FRAME_SIZE { out[s] += input[s] * target; }
            }
            self.prev_gains[i] = target;
        }
        let mv_prev = self.master_gain;
        let mv_target = self.master_gain_target;
        if (mv_prev - mv_target).abs() < 1e-6 {
            if (mv_target - 1.0).abs() > 1e-6 { for s in 0..FRAME_SIZE { out[s] *= mv_target; } }
        } else {
            for s in 0..ramp_len {
                let t = (s as f32) * inv_ramp;
                let g = mv_prev + (mv_target - mv_prev) * t;
                out[s] *= g;
            }
            for s in ramp_len..FRAME_SIZE { out[s] *= mv_target; }
        }
        self.master_gain = mv_target;
        for s in 0..FRAME_SIZE { out[s] = out[s].tanh(); }
    }
}
impl Default for SubscriberMixer { fn default() -> Self { Self::new(AE_MAX_MIX_INPUTS) } }
