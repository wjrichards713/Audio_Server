//! Unified error type for the audio server.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum AudioServerError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("config: {0}")]
    Config(String),

    #[error("redis: {0}")]
    Redis(#[from] redis::RedisError),

    #[error("rest: {0}")]
    Rest(#[from] reqwest::Error),

    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("protocol: {0}")]
    Protocol(String),

    #[error("crypto: {0}")]
    Crypto(String),

    #[error("auth: {0}")]
    Auth(String),

    #[error("not_found: {0}")]
    NotFound(String),

    #[error("invalid: {0}")]
    Invalid(String),

    #[error("other: {0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, AudioServerError>;

impl From<anyhow::Error> for AudioServerError {
    fn from(e: anyhow::Error) -> Self {
        Self::Other(e.to_string())
    }
}
