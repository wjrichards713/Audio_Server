//! libopus encoder pool, keyed per subscriber.
use std::collections::HashMap;
use audiopus::{coder::{Encoder as OpusEncoder, GenericCtl}, Application, Channels, SampleRate};
use parking_lot::Mutex;
use crate::error::{AudioServerError, Result};
use crate::media::FRAME_SIZE;

pub const ENCODER_BITRATE_BPS: i32 = 24_000;
/// Opus complexity 0..10. `audiopus::set_complexity` takes `u8`.
pub const ENCODER_COMPLEXITY: u8 = 8;
pub const OPUS_MAX_FRAME_BYTES: usize = 4000;

#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq)]
pub struct EncoderKey { pub subscriber_id: u64, pub stream_id: u32 }

#[derive(Clone)]
pub struct OpusEncoderPool { inner: std::sync::Arc<Mutex<HashMap<EncoderKey, OpusEncoder>>> }

impl OpusEncoderPool {
    pub fn new() -> Self { Self { inner: std::sync::Arc::new(Mutex::new(HashMap::new())) } }

    pub fn encode(&self, key: EncoderKey, pcm: &[f32; FRAME_SIZE], out_buf: &mut Vec<u8>) -> Result<usize> {
        let mut guard = self.inner.lock();
        let enc = Self::get_or_create(&mut guard, key)?;
        if out_buf.capacity() < OPUS_MAX_FRAME_BYTES {
            out_buf.reserve(OPUS_MAX_FRAME_BYTES - out_buf.capacity());
        }
        out_buf.resize(OPUS_MAX_FRAME_BYTES, 0);
        let n = enc
            .encode_float(&pcm[..], &mut out_buf[..])
            .map_err(|e| AudioServerError::Protocol(format!("opus encode: {e}")))?;
        out_buf.truncate(n);
        Ok(n)
    }

    pub fn forget(&self, key: EncoderKey) { self.inner.lock().remove(&key); }
    pub fn forget_subscriber(&self, subscriber_id: u64) { self.inner.lock().retain(|k, _| k.subscriber_id != subscriber_id); }
    pub fn len(&self) -> usize { self.inner.lock().len() }

    fn get_or_create<'a>(map: &'a mut HashMap<EncoderKey, OpusEncoder>, key: EncoderKey) -> Result<&'a mut OpusEncoder> {
        if !map.contains_key(&key) {
            let mut enc = OpusEncoder::new(SampleRate::Hz48000, Channels::Mono, Application::Voip)
                .map_err(|e| AudioServerError::Other(format!("opus encoder create: {e}")))?;
            enc.set_bitrate(audiopus::Bitrate::BitsPerSecond(ENCODER_BITRATE_BPS)).map_err(|e| AudioServerError::Other(format!("opus bitrate: {e}")))?;
            enc.set_inband_fec(true).map_err(|e| AudioServerError::Other(format!("opus fec: {e}")))?;
            enc.set_packet_loss_perc(5).map_err(|e| AudioServerError::Other(format!("opus plp: {e}")))?;
            enc.set_dtx(true).map_err(|e| AudioServerError::Other(format!("opus dtx: {e}")))?;
            enc.set_complexity(ENCODER_COMPLEXITY).map_err(|e| AudioServerError::Other(format!("opus cpx: {e}")))?;
            map.insert(key, enc);
        }
        Ok(map.get_mut(&key).expect("just inserted"))
    }
}
impl Default for OpusEncoderPool { fn default() -> Self { Self::new() } }
