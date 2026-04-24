//! Media plane module exports + shared types.
pub mod crypto_pool;
pub mod decoder;
pub mod encoder;
pub mod jitter;
pub mod mixer;
pub mod pacer;
pub mod subscriber;

pub use crypto_pool::CryptoPool;
pub use decoder::OpusDecoderPool;
pub use encoder::OpusEncoderPool;
pub use jitter::JitterBuffer;
pub use mixer::SubscriberMixer;
pub use pacer::{Pacer, TickEvent};
pub use subscriber::{SubscriberHandle, SubscriberMessage, SubscriberTask};

use crate::protocol::Header;

pub const SAMPLE_RATE: u32 = 48_000;
pub const FRAME_SIZE: usize = 960;
pub const FRAME_MS: u64 = 20;
pub const CHANNELS: usize = 1;
pub const AE_MAX_MIX_INPUTS: usize = 8;
pub const AE_RAMP_SAMPLES: usize = 240;

#[derive(Debug, Clone)]
pub struct MediaFrame {
    pub header: Header,
    pub samples: Box<[f32; FRAME_SIZE]>,
}
impl MediaFrame {
    #[inline] pub fn silence(header: Header) -> Self { Self { header, samples: Box::new([0.0; FRAME_SIZE]) } }
}

#[derive(Debug, Clone)]
pub struct AudioFrame {
    pub header: Header,
    pub bytes: Vec<u8>,
}
impl AudioFrame {
    #[inline] pub fn empty(header: Header) -> Self { Self { header, bytes: Vec::new() } }
}
