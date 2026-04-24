//! REST API client.
use crate::config::Config;
use crate::error::{AudioServerError, Result};
use crate::protocol::{ChannelId, Priority};
use crate::ws_ops::ChannelPrefs;
use reqwest::{Client, Method, RequestBuilder, Response, StatusCode};
use serde::{Deserialize, Serialize};
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const USER_AGENT: &str = concat!("audio-server/", env!("CARGO_PKG_VERSION"));

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelConfig {
    pub id: ChannelId,
    pub name: String,
    #[serde(default)] pub priority: Priority,
    #[serde(default)] pub full_duplex: bool,
    #[serde(default)] pub allow_list: Vec<String>,
    pub master_key_hex: String,
    #[serde(default)] pub key_version: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserProfile {
    pub name: String,
    #[serde(default)] pub default_prefs: Vec<ChannelPrefs>,
    #[serde(default)] pub default_options: serde_json::Value,
}

#[derive(Clone)]
pub struct RestClient { http: Client, base: String, api_key: Option<String> }

impl RestClient {
    pub fn new(cfg: &Config) -> Result<Self> {
        let http = Client::builder().timeout(REQUEST_TIMEOUT).connect_timeout(CONNECT_TIMEOUT).user_agent(USER_AGENT).build().map_err(AudioServerError::Rest)?;
        let base = cfg.rest_base_url.trim_end_matches('/').to_owned();
        Ok(Self { http, base, api_key: cfg.rest_api_key.clone() })
    }
    pub async fn get_channel_config(&self, channel_id: ChannelId) -> Result<ChannelConfig> {
        self.send_json::<ChannelConfig>(Method::GET, &format!("/v1/channels/{}", channel_id.0), None::<&()>).await
    }
    pub async fn get_channel_master_key(&self, channel_id: ChannelId, key_version: u16) -> Result<[u8; 32]> {
        #[derive(Deserialize)] struct Resp { master_key_hex: String }
        let resp: Resp = self.send_json(Method::GET, &format!("/v1/channels/{}/master_key?key_version={}", channel_id.0, key_version), None::<&()>).await?;
        hex32(&resp.master_key_hex)
    }
    pub async fn list_user_channels(&self, user_id: &str) -> Result<Vec<ChannelId>> {
        #[derive(Deserialize)] struct Resp { channels: Vec<ChannelId> }
        let resp: Resp = self.send_json(Method::GET, &format!("/v1/users/{}/channels", urlencode(user_id)), None::<&()>).await?;
        Ok(resp.channels)
    }
    pub async fn get_user_profile(&self, user_id: &str) -> Result<UserProfile> {
        self.send_json(Method::GET, &format!("/v1/users/{}", urlencode(user_id)), None::<&()>).await
    }
    pub async fn put_user_channel_prefs(&self, user_id: &str, prefs: &[ChannelPrefs]) -> Result<()> {
        #[derive(Serialize)] struct Body<'a> { prefs: &'a [ChannelPrefs] }
        let _: serde_json::Value = self.send_json(Method::PUT, &format!("/v1/users/{}/channel_prefs", urlencode(user_id)), Some(&Body { prefs })).await?;
        Ok(())
    }
    pub async fn health(&self) -> Result<()> {
        let url = format!("{}/v1/health", self.base);
        let resp = self.build(Method::GET, &url).send().await?;
        if resp.status().is_success() { Ok(()) } else { Err(classify(resp.status(), "health")) }
    }
    fn build(&self, method: Method, url: &str) -> RequestBuilder {
        let mut rb = self.http.request(method, url);
        if let Some(k) = &self.api_key { rb = rb.bearer_auth(k); }
        rb
    }
    async fn send_json<T: for<'de> Deserialize<'de>>(&self, method: Method, path: &str, body: Option<&impl Serialize>) -> Result<T> {
        let url = format!("{}{}", self.base, path);
        let do_send = |attempt: u32| { let mut rb = self.build(method.clone(), &url); if let Some(b) = body { rb = rb.json(b); } async move { tracing::trace!(attempt, %url, "rest request"); rb.send().await } };
        let resp = match do_send(0).await { Ok(r) => r, Err(e) => { tracing::warn!(%e, "rest transport error, retrying once"); do_send(1).await.map_err(AudioServerError::Rest)? } };
        let status = resp.status();
        if status.is_success() { return resp.json::<T>().await.map_err(AudioServerError::Rest); }
        if status.is_server_error() {
            tracing::warn!(%status, %url, "rest 5xx, retrying once");
            let resp2 = do_send(1).await.map_err(AudioServerError::Rest)?;
            let status2 = resp2.status();
            if status2.is_success() { return resp2.json::<T>().await.map_err(AudioServerError::Rest); }
            return Err(classify_with_body(resp2, "rest").await);
        }
        Err(classify_with_body(resp, "rest").await)
    }
}

fn classify(status: StatusCode, tag: &str) -> AudioServerError {
    if status.is_client_error() { AudioServerError::Invalid(format!("{tag}: {}", status)) }
    else { AudioServerError::Other(format!("{tag}: {}", status)) }
}
async fn classify_with_body(resp: Response, tag: &str) -> AudioServerError {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let body_snip: String = body.chars().take(256).collect();
    if status.is_client_error() { AudioServerError::Invalid(format!("{tag}: {status}: {body_snip}")) }
    else { AudioServerError::Other(format!("{tag}: {status}: {body_snip}")) }
}
fn hex32(s: &str) -> Result<[u8; 32]> {
    let s = s.trim();
    if s.len() != 64 { return Err(AudioServerError::Invalid("master_key_hex must be 64 hex chars".into())); }
    let mut out = [0u8; 32];
    for (i, chunk) in s.as_bytes().chunks(2).enumerate() { out[i] = (hex_digit(chunk[0])? << 4) | hex_digit(chunk[1])?; }
    Ok(out)
}
fn hex_digit(b: u8) -> Result<u8> {
    match b { b'0'..=b'9' => Ok(b - b'0'), b'a'..=b'f' => Ok(b - b'a' + 10), b'A'..=b'F' => Ok(b - b'A' + 10), _ => Err(AudioServerError::Invalid("bad hex digit".into())) }
}
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() { match c { 'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' | '~' => out.push(c),
        _ => { let mut buf = [0u8; 4]; for b in c.encode_utf8(&mut buf).as_bytes() { out.push_str(&format!("%{b:02X}")); } } } }
    out
}
