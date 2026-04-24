//! libopus decoder pool, keyed by (channel_id, client_id).
use std::collections::HashMap;
use std::time::{Duration, Instant};
use audiopus::{coder::Decoder as OpusDecoder, Channels, SampleRate};
use parking_lot::Mutex;
use crate::error::{AudioServerError, Result};
use crate::media::{FRAME_SIZE, SAMPLE_RATE};

const DECODER_IDLE_TTL: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq)]
pub struct DecoderKey { pub channel_id: u32, pub client_id: u64 }

struct Slot { decoder: OpusDecoder, last_used: Instant }

#[derive(Clone)]
pub struct OpusDecoderPool { inner: std::sync::Arc<Mutex<HashMap<DecoderKey, Slot>>> }

impl OpusDecoderPool {
    pub fn new() -> Self { Self { inner: std::sync::Arc::new(Mutex::new(HashMap::new())) } }

    pub fn decode(&self, channel_id: u32, client_id: u64, opus_bytes: &[u8], out: &mut [f32; FRAME_SIZE]) -> Result<usize> {
        let key = DecoderKey { channel_id, client_id };
        let mut guard = self.inner.lock();
        let slot = Self::get_or_create(&mut guard, key)?;
        slot.last_used = Instant::now();
        let input = if opus_bytes.is_empty() { None } else { Some(opus_bytes) };
        let n = slot.decoder.decode_float(
            input.map(audiopus::packet::Packet::try_from).transpose().map_err(|e| AudioServerError::Protocol(format!("opus packet: {e}")))?,
            audiopus::MutSignals::try_from(&mut out[..]).map_err(|e| AudioServerError::Other(format!("opus buffer: {e}")))?,
            false,
        ).map_err(|e| AudioServerError::Protocol(format!("opus decode: {e}")))?;
        Ok(n)
    }

    pub fn decode_plc(&self, channel_id: u32, client_id: u64, out: &mut [f32; FRAME_SIZE]) -> Result<()> {
        let key = DecoderKey { channel_id, client_id };
        let mut guard = self.inner.lock();
        let slot = Self::get_or_create(&mut guard, key)?;
        slot.last_used = Instant::now();
        slot.decoder.decode_float(None,
            audiopus::MutSignals::try_from(&mut out[..]).map_err(|e| AudioServerError::Other(format!("opus buffer: {e}")))?,
            false,
        ).map_err(|e| AudioServerError::Protocol(format!("opus PLC: {e}")))?;
        Ok(())
    }

    pub fn sweep_idle(&self) -> usize {
        let now = Instant::now();
        let mut guard = self.inner.lock();
        let before = guard.len();
        guard.retain(|_, slot| now.duration_since(slot.last_used) < DECODER_IDLE_TTL);
        before.saturating_sub(guard.len())
    }
    pub fn forget(&self, key: DecoderKey) { self.inner.lock().remove(&key); }
    pub fn len(&self) -> usize { self.inner.lock().len() }

    fn get_or_create<'a>(map: &'a mut HashMap<DecoderKey, Slot>, key: DecoderKey) -> Result<&'a mut Slot> {
        if !map.contains_key(&key) {
            let dec = OpusDecoder::new(SampleRate::Hz48000, Channels::Mono).map_err(|e| AudioServerError::Other(format!("opus decoder create: {e}")))?;
            let _ = SAMPLE_RATE;
            map.insert(key, Slot { decoder: dec, last_used: Instant::now() });
        }
        Ok(map.get_mut(&key).expect("just inserted"))
    }
}
impl Default for OpusDecoderPool { fn default() -> Self { Self::new() } }
