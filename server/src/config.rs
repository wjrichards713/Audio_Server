//! Runtime configuration loaded from environment variables.
use crate::error::{AudioServerError, Result};
use std::net::IpAddr;

#[derive(Debug, Clone)]
pub struct Config {
    pub public_host: String,
    pub bind_ip: IpAddr,
    pub udp_port: u16, pub ws_port: u16, pub mesh_port: u16, pub metrics_port: u16,
    pub server_id: u32,
    pub redis_sentinels: Vec<String>,
    pub redis_master_name: String, pub redis_password: Option<String>,
    pub rest_base_url: String, pub rest_api_key: Option<String>,
    pub mesh_key_hex: String,
    pub default_mode: crate::protocol::SessionMode,
    pub max_subscriptions_per_session: u32,
    pub max_active_talkers_in_mix: u32,
    pub max_sessions_per_server: u32,
    pub jwt_audience: String, pub jwt_issuer: String, pub jwt_public_key_pem: String,
    pub log_format: LogFormat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogFormat { Pretty, Json }

impl Config {
    pub fn from_env() -> Result<Self> {
        fn env(k: &str) -> Result<String> { std::env::var(k).map_err(|_| AudioServerError::Config(format!("missing {k}"))) }
        fn env_opt(k: &str) -> Option<String> { std::env::var(k).ok() }
        fn env_u16(k: &str, d: u16) -> Result<u16> { match std::env::var(k) { Ok(v)=>v.parse().map_err(|_|AudioServerError::Config(format!("bad {k}"))), Err(_)=>Ok(d) } }
        fn env_u32(k: &str, d: u32) -> Result<u32> { match std::env::var(k) { Ok(v)=>v.parse().map_err(|_|AudioServerError::Config(format!("bad {k}"))), Err(_)=>Ok(d) } }

        let public_host = env("AUDIO_PUBLIC_HOST")?;
        let bind_ip: IpAddr = env_opt("AUDIO_BIND_IP").unwrap_or_else(|| "0.0.0.0".into()).parse()
            .map_err(|_| AudioServerError::Config("bad AUDIO_BIND_IP".into()))?;
        let udp_port = env_u16("AUDIO_UDP_PORT", 4002)?;
        let ws_port = env_u16("AUDIO_WS_PORT", 3001)?;
        let mesh_port = env_u16("AUDIO_MESH_PORT", 4003)?;
        let metrics_port = env_u16("AUDIO_METRICS_PORT", 9100)?;
        let server_id = env_u32("AUDIO_SERVER_ID", 1)?;

        let redis_sentinels = env("REDIS_SENTINELS")?.split(',').map(|s|s.trim().to_string()).filter(|s|!s.is_empty()).collect::<Vec<_>>();
        if redis_sentinels.is_empty() { return Err(AudioServerError::Config("REDIS_SENTINELS must list host:port pairs".into())); }
        let redis_master_name = env_opt("REDIS_MASTER_NAME").unwrap_or_else(|| "mymaster".into());
        let redis_password = env_opt("REDIS_PASSWORD");

        let rest_base_url = env("REST_BASE_URL")?;
        let rest_api_key = env_opt("REST_API_KEY");
        let mesh_key_hex = env("MESH_KEY_HEX")?;
        if hex_len(&mesh_key_hex) != 32 { return Err(AudioServerError::Config("MESH_KEY_HEX must decode to 32 bytes".into())); }

        let default_mode = match env_opt("AUDIO_DEFAULT_MODE").unwrap_or_else(||"mix".into()).to_lowercase().as_str() {
            "forward" | "fwd" => crate::protocol::SessionMode::Forward,
            _ => crate::protocol::SessionMode::Mix,
        };
        let max_subscriptions_per_session = env_u32("AUDIO_MAX_SUBSCRIPTIONS", 50)?;
        let max_active_talkers_in_mix = env_u32("AUDIO_MAX_ACTIVE_TALKERS", 8)?;
        let max_sessions_per_server = env_u32("AUDIO_MAX_SESSIONS_PER_SERVER", 4000)?;
        let jwt_audience = env_opt("JWT_AUDIENCE").unwrap_or_else(|| "redenes-audio".into());
        let jwt_issuer = env_opt("JWT_ISSUER").unwrap_or_else(|| "redenes-auth".into());
        let jwt_public_key_pem = env("JWT_PUBLIC_KEY_PEM")?;
        let log_format = match env_opt("LOG_FORMAT").unwrap_or_else(||"pretty".into()).to_lowercase().as_str() {
            "json" => LogFormat::Json, _ => LogFormat::Pretty,
        };

        Ok(Self { public_host, bind_ip, udp_port, ws_port, mesh_port, metrics_port, server_id,
                  redis_sentinels, redis_master_name, redis_password, rest_base_url, rest_api_key,
                  mesh_key_hex, default_mode, max_subscriptions_per_session, max_active_talkers_in_mix,
                  max_sessions_per_server, jwt_audience, jwt_issuer, jwt_public_key_pem, log_format })
    }
}

fn hex_len(s: &str) -> usize {
    let s = s.trim();
    if s.len() % 2 != 0 || !s.bytes().all(|b| b.is_ascii_hexdigit()) { return 0; }
    s.len() / 2
}
