//! Redis Sentinel async client (redis 0.25 API).
//!
//! Uses the lower-level `Sentinel` directly because `SentinelClient::async_get_client`
//! is private in 0.25; this gives us a `Client` we can wrap in a `ConnectionManager`
//! for multiplexed access from many concurrent commands.
use crate::config::Config;
use crate::error::{AudioServerError, Result};
use crate::protocol::ChannelId;
use redis::aio::ConnectionManager;
use redis::sentinel::{Sentinel, SentinelNodeConnectionInfo};
use redis::{AsyncCommands, Client, RedisError};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, Mutex};

const RETRY_BACKOFFS_MS: [u64; 3] = [100, 500, 2000];

#[derive(Debug, Clone)]
pub struct PubSubMessage { pub channel: String, pub pattern: Option<String>, pub payload: String }

#[derive(Clone)]
pub struct RedisClient { inner: Arc<Inner> }

struct Inner {
    sentinel: Mutex<Sentinel>,
    manager: Mutex<Option<ConnectionManager>>,
    master_name: String,
    node_info: SentinelNodeConnectionInfo,
}

impl RedisClient {
    pub async fn connect(cfg: &Config) -> Result<Self> {
        let nodes: Vec<String> = cfg.redis_sentinels.iter().map(|s| if s.starts_with("redis://") { s.clone() } else { format!("redis://{s}") }).collect();
        let node_info = SentinelNodeConnectionInfo {
            tls_mode: None,
            redis_connection_info: Some(redis::RedisConnectionInfo {
                db: 0,
                username: None,
                password: cfg.redis_password.clone(),
            }),
        };
        let sentinel = Sentinel::build(nodes)
            .map_err(|e| AudioServerError::Other(format!("sentinel build: {e}")))?;
        Ok(Self { inner: Arc::new(Inner {
            sentinel: Mutex::new(sentinel),
            manager: Mutex::new(None),
            master_name: cfg.redis_master_name.clone(),
            node_info,
        }) })
    }

    /// Resolve the current Redis master via Sentinel and wrap it in a
    /// `ConnectionManager`. Cached; rebuilt on transient errors.
    async fn manager(&self) -> Result<ConnectionManager> {
        let mut slot = self.inner.manager.lock().await;
        if let Some(m) = slot.as_ref() { return Ok(m.clone()); }
        let client: Client = {
            let mut s = self.inner.sentinel.lock().await;
            s.async_master_for(&self.inner.master_name, Some(&self.inner.node_info))
                .await
                .map_err(AudioServerError::Redis)?
        };
        let mgr = ConnectionManager::new(client).await.map_err(AudioServerError::Redis)?;
        *slot = Some(mgr.clone());
        Ok(mgr)
    }
    async fn invalidate_manager(&self) { *self.inner.manager.lock().await = None; }

    async fn with_retry<F, Fut, T>(&self, mut f: F) -> Result<T>
        where F: FnMut(ConnectionManager) -> Fut,
              Fut: std::future::Future<Output = std::result::Result<T, RedisError>> {
        let mut last: Option<RedisError> = None;
        for (i, backoff) in RETRY_BACKOFFS_MS.iter().enumerate() {
            let mgr = match self.manager().await {
                Ok(m) => m,
                Err(e) => { tracing::warn!(attempt = i, ?e, "redis manager acquire failed"); tokio::time::sleep(Duration::from_millis(*backoff)).await; continue; }
            };
            match f(mgr).await {
                Ok(v) => return Ok(v),
                Err(e) => {
                    let retriable = is_retriable(&e);
                    tracing::warn!(attempt = i, retriable, %e, "redis command failed");
                    last = Some(e);
                    if !retriable { break; }
                    self.invalidate_manager().await;
                    tokio::time::sleep(Duration::from_millis(*backoff)).await;
                }
            }
        }
        Err(AudioServerError::Redis(last.unwrap_or_else(|| redis_io_error("redis retries exhausted"))))
    }

    pub async fn register_channel_server(&self, channel_id: ChannelId, server_addr: String) -> Result<()> {
        let key = channel_servers_key(channel_id);
        self.with_retry(|mut c| { let key = key.clone(); let addr = server_addr.clone(); async move { let _: () = c.sadd(&key, addr).await?; Ok(()) } }).await
    }
    pub async fn deregister_channel_server(&self, channel_id: ChannelId, server_addr: &str) -> Result<()> {
        let key = channel_servers_key(channel_id); let addr = server_addr.to_owned();
        self.with_retry(|mut c| { let key = key.clone(); let addr = addr.clone(); async move { let _: () = c.srem(&key, addr).await?; Ok(()) } }).await
    }
    pub async fn list_channel_servers(&self, channel_id: ChannelId) -> Result<Vec<String>> {
        let key = channel_servers_key(channel_id);
        self.with_retry(|mut c| { let key = key.clone(); async move { let v: Vec<String> = c.smembers(&key).await?; Ok(v) } }).await
    }
    pub async fn add_channel_member(&self, channel_id: ChannelId, addr_key: &str, user_json: &str) -> Result<()> {
        let key = channel_members_key(channel_id); let field = addr_key.to_owned(); let value = user_json.to_owned();
        self.with_retry(|mut c| { let key = key.clone(); let field = field.clone(); let value = value.clone(); async move { let _: () = c.hset(&key, field, value).await?; Ok(()) } }).await
    }
    pub async fn remove_channel_member(&self, channel_id: ChannelId, addr_key: &str) -> Result<()> {
        let key = channel_members_key(channel_id); let field = addr_key.to_owned();
        self.with_retry(|mut c| { let key = key.clone(); let field = field.clone(); async move { let _: () = c.hdel(&key, field).await?; Ok(()) } }).await
    }
    pub async fn list_channel_members(&self, channel_id: ChannelId) -> Result<Vec<(String, String)>> {
        let key = channel_members_key(channel_id);
        self.with_retry(|mut c| { let key = key.clone(); async move { let v: Vec<(String, String)> = c.hgetall(&key).await?; Ok(v) } }).await
    }
    pub async fn set_channel_floor(&self, channel_id: ChannelId, state_json: &str, ttl_secs: u64) -> Result<()> {
        let key = channel_floor_key(channel_id); let value = state_json.to_owned();
        self.with_retry(|mut c| { let key = key.clone(); let value = value.clone(); async move { if ttl_secs == 0 { let _: () = c.set(&key, value).await?; } else { let _: () = c.set_ex(&key, value, ttl_secs).await?; } Ok(()) } }).await
    }
    pub async fn get_channel_floor(&self, channel_id: ChannelId) -> Result<Option<String>> {
        let key = channel_floor_key(channel_id);
        self.with_retry(|mut c| { let key = key.clone(); async move { let v: Option<String> = c.get(&key).await?; Ok(v) } }).await
    }
    pub async fn put_session(&self, session_id: &str, hash: &[(String, String)], ttl_secs: u64) -> Result<()> {
        let key = session_key(session_id); let hash = hash.to_vec();
        self.with_retry(|mut c| { let key = key.clone(); let hash = hash.clone(); async move { let _: () = c.hset_multiple(&key, &hash).await?; if ttl_secs > 0 { let _: () = c.expire(&key, ttl_secs as i64).await?; } Ok(()) } }).await
    }
    pub async fn del_session(&self, session_id: &str) -> Result<()> {
        let key = session_key(session_id);
        self.with_retry(|mut c| { let key = key.clone(); async move { let _: () = c.del(&key).await?; Ok(()) } }).await
    }
    pub async fn publish(&self, topic: &str, payload: &str) -> Result<()> {
        let topic = topic.to_owned(); let payload = payload.to_owned();
        self.with_retry(|mut c| { let topic = topic.clone(); let payload = payload.clone(); async move { let _: () = c.publish(topic, payload).await?; Ok(()) } }).await
    }
    pub async fn subscribe(&self, patterns: Vec<String>) -> Result<mpsc::Receiver<PubSubMessage>> {
        let (tx, rx) = mpsc::channel::<PubSubMessage>(256);
        let this = self.clone();
        tokio::spawn(async move {
            let mut backoff_ms = 100u64;
            loop {
                if tx.is_closed() { return; }
                if let Err(e) = this.run_pubsub_loop(&patterns, &tx).await { tracing::warn!(?e, "pubsub loop errored, reconnecting"); }
                tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                backoff_ms = (backoff_ms.saturating_mul(2)).min(5000);
            }
        });
        Ok(rx)
    }
    async fn run_pubsub_loop(&self, patterns: &[String], tx: &mpsc::Sender<PubSubMessage>) -> Result<()> {
        use futures_util::StreamExt;
        let client: Client = {
            let mut s = self.inner.sentinel.lock().await;
            s.async_master_for(&self.inner.master_name, Some(&self.inner.node_info))
                .await
                .map_err(AudioServerError::Redis)?
        };
        let mut pubsub = client.get_async_pubsub().await.map_err(AudioServerError::Redis)?;
        for pat in patterns { pubsub.psubscribe(pat).await.map_err(AudioServerError::Redis)?; }
        let mut stream = pubsub.on_message();
        while let Some(msg) = stream.next().await {
            let channel = msg.get_channel_name().to_owned();
            let pattern = msg.get_pattern::<String>().ok();
            let payload = msg.get_payload::<String>().unwrap_or_default();
            if tx.send(PubSubMessage { channel, pattern, payload }).await.is_err() { break; }
        }
        Ok(())
    }
    pub async fn get_channel_key_version(&self, channel_id: ChannelId) -> Result<u16> {
        let key = channel_key_version_key(channel_id);
        self.with_retry(|mut c| { let key = key.clone(); async move { let v: Option<u64> = c.get(&key).await?; Ok(v.unwrap_or(0) as u16) } }).await
    }
    pub async fn bump_channel_key_version(&self, channel_id: ChannelId) -> Result<u16> {
        let key = channel_key_version_key(channel_id); let this_key = key.clone();
        self.with_retry(|mut c| { let key = this_key.clone(); async move {
            let new_val: i64 = c.incr(&key, 1i64).await?;
            if new_val > u16::MAX as i64 { let _: () = c.set(&key, 1i64).await?; Ok(1u16) } else { Ok(new_val as u16) }
        } }).await
    }
    pub async fn update_server_status(&self, server_id: u32, status_json: &str, ttl_secs: u64) -> Result<()> {
        let key = format!("server:{server_id}:status"); let value = status_json.to_owned();
        self.with_retry(|mut c| { let key = key.clone(); let value = value.clone(); async move { let _: () = c.set(&key, value).await?; if ttl_secs > 0 { let _: () = c.expire(&key, ttl_secs as i64).await?; } Ok(()) } }).await
    }
    pub fn master_name(&self) -> &str { &self.inner.master_name }
}

fn channel_servers_key(id: ChannelId) -> String { format!("channel:{}:servers", id.0) }
fn channel_members_key(id: ChannelId) -> String { format!("channel:{}:members", id.0) }
fn channel_floor_key(id: ChannelId) -> String { format!("channel:{}:floor", id.0) }
fn channel_key_version_key(id: ChannelId) -> String { format!("channel:{}:key_version", id.0) }
fn session_key(session_id: &str) -> String { format!("session:{session_id}") }
fn is_retriable(e: &RedisError) -> bool { e.is_io_error() || e.is_timeout() || e.is_connection_dropped() || e.is_cluster_error() }
fn redis_io_error(msg: &str) -> RedisError { redis::RedisError::from((redis::ErrorKind::IoError, "audio-server", msg.to_owned())) }
