//! JWT verification (pluggable). NoopJwtVerifier for dev; Rs256JwtVerifier is a TODO.
use crate::config::Config;
use crate::error::{AudioServerError, Result};
use crate::protocol::ChannelId;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthClaims {
    pub sub: String,
    #[serde(default)]
    pub name: Option<String>,
    pub exp: u64,
    pub aud: String,
    pub iss: String,
    #[serde(default)]
    pub allowed_channels: Option<Vec<ChannelId>>,
}

impl AuthClaims {
    /// Synthesize a fallback claim set for dev environments where JWT
    /// verification fails open. Production paths must NOT rely on this.
    pub fn dev_fallback() -> Self {
        Self {
            sub: "dev-anon".into(),
            name: Some("anon".into()),
            exp: u64::MAX,
            aud: String::new(),
            iss: String::new(),
            allowed_channels: None,
        }
    }
}

pub trait JwtVerifier: Send + Sync {
    fn verify(&self, token: &str) -> Result<AuthClaims>;
}
pub type SharedVerifier = Arc<dyn JwtVerifier>;

pub struct NoopJwtVerifier { audience: String, issuer: String }
impl NoopJwtVerifier {
    pub fn new(audience: impl Into<String>, issuer: impl Into<String>) -> Self {
        Self { audience: audience.into(), issuer: issuer.into() }
    }
}
impl JwtVerifier for NoopJwtVerifier {
    fn verify(&self, token: &str) -> Result<AuthClaims> {
        let parts: Vec<&str> = token.split('.').collect();
        if parts.len() != 3 { return Err(AudioServerError::Auth("jwt: expected 3 segments".into())); }
        let payload_bytes = b64url_decode(parts[1])?;
        let claims: AuthClaims = serde_json::from_slice(&payload_bytes).map_err(|e| AudioServerError::Auth(format!("jwt payload: {e}")))?;
        validate_claims(&claims, &self.audience, &self.issuer)?;
        tracing::debug!(sub = %claims.sub, "jwt verified (noop)");
        Ok(claims)
    }
}

pub struct Rs256JwtVerifier { _public_key_pem: String, _audience: String, _issuer: String }
impl Rs256JwtVerifier {
    pub fn new(public_key_pem: impl Into<String>, audience: impl Into<String>, issuer: impl Into<String>) -> Self {
        Self { _public_key_pem: public_key_pem.into(), _audience: audience.into(), _issuer: issuer.into() }
    }
}
impl JwtVerifier for Rs256JwtVerifier {
    fn verify(&self, _token: &str) -> Result<AuthClaims> {
        Err(AudioServerError::Auth("RS256 verifier not implemented".into()))
    }
}

pub fn default_verifier(cfg: &Config) -> SharedVerifier {
    tracing::warn!("auth: using NoopJwtVerifier — NOT SUITABLE FOR PRODUCTION");
    Arc::new(NoopJwtVerifier::new(&cfg.jwt_audience, &cfg.jwt_issuer))
}

pub fn verify_jwt(token: &str, cfg: &Config) -> Result<AuthClaims> { default_verifier(cfg).verify(token) }

fn validate_claims(c: &AuthClaims, audience: &str, issuer: &str) -> Result<()> {
    if c.aud != audience { return Err(AudioServerError::Auth(format!("jwt aud mismatch"))); }
    if c.iss != issuer { return Err(AudioServerError::Auth(format!("jwt iss mismatch"))); }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    if c.exp <= now { return Err(AudioServerError::Auth(format!("jwt expired"))); }
    if c.sub.is_empty() { return Err(AudioServerError::Auth("jwt sub empty".into())); }
    Ok(())
}

fn b64url_decode(s: &str) -> Result<Vec<u8>> {
    let s = s.trim_end_matches('=');
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;
    for ch in s.bytes() {
        let v = match ch {
            b'A'..=b'Z' => ch - b'A', b'a'..=b'z' => ch - b'a' + 26,
            b'0'..=b'9' => ch - b'0' + 52, b'-' => 62, b'_' => 63,
            _ => return Err(AudioServerError::Auth("jwt: invalid base64url".into())),
        };
        buf = (buf << 6) | v as u32;
        bits += 6;
        if bits >= 8 { bits -= 8; out.push((buf >> bits) as u8); buf &= (1 << bits) - 1; }
    }
    Ok(out)
}
