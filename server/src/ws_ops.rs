//! WebSocket control-plane op schema.
//! See `docs/WIRE_SPEC.md` §2 for the normative contract.

use crate::protocol::{ChannelId, ChannelPriorityRole, ClientId, PttMuteScope, Priority, SessionMode};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope<T> {
    pub op: String,
    #[serde(default = "Uuid::new_v4")]
    pub id: Uuid,
    pub data: T,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", content = "data", rename_all = "snake_case")]
pub enum ClientOp {
    Auth(AuthRequest),
    Subscribe(SubscribeRequest),
    Unsubscribe(UnsubscribeRequest),
    SetChannelPrefs(ChannelPrefsUpdate),
    SetSubscriptions(Vec<ChannelPrefs>),
    SetSessionOptions(SessionOptionsUpdate),
    FloorRequest(FloorRequest),
    FloorRelease(FloorRelease),
    Ping(PingRequest),
}

#[derive(Debug, Clone, Deserialize)]
pub struct AuthRequest {
    pub jwt: String,
    pub device_id: String,
    pub client_pubkey_x25519_hex: String,
    #[serde(default)]
    pub mode: Option<SessionMode>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SubscribeRequest {
    pub channel_id: ChannelId,
    #[serde(default)] pub gain_db: Option<f32>,
    #[serde(default)] pub muted: Option<bool>,
    #[serde(default)] pub solo: Option<bool>,
    #[serde(default)] pub priority: Option<ChannelPriorityRole>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UnsubscribeRequest { pub channel_id: ChannelId }

#[derive(Debug, Clone, Deserialize)]
pub struct ChannelPrefsUpdate {
    pub channel_id: ChannelId,
    #[serde(default)] pub gain_db: Option<f32>,
    #[serde(default)] pub muted: Option<bool>,
    #[serde(default)] pub solo: Option<bool>,
    #[serde(default)] pub priority: Option<ChannelPriorityRole>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelPrefs {
    pub channel_id: ChannelId,
    #[serde(default)] pub gain_db: f32,
    #[serde(default)] pub muted: bool,
    #[serde(default)] pub solo: bool,
    #[serde(default)] pub priority: ChannelPriorityRole,
}
impl Default for ChannelPrefs {
    fn default() -> Self { Self { channel_id: ChannelId(0), gain_db: 0.0, muted: false, solo: false, priority: ChannelPriorityRole::Normal } }
}

#[derive(Debug, Clone, Deserialize)]
pub struct SessionOptionsUpdate {
    #[serde(default)] pub mode: Option<SessionMode>,
    #[serde(default)] pub pause_egress_during_ptt: Option<bool>,
    #[serde(default)] pub ptt_mutes: Option<PttMuteScope>,
    #[serde(default)] pub sidetone_db: Option<f32>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FloorRequest { pub channel_id: ChannelId, #[serde(default)] pub priority: Priority }

#[derive(Debug, Clone, Deserialize)]
pub struct FloorRelease { pub channel_id: ChannelId }

#[derive(Debug, Clone, Deserialize)]
pub struct PingRequest { pub timestamp_ms: u64 }

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "op", content = "data", rename_all = "snake_case")]
pub enum ServerOp {
    AuthOk(AuthOk), AuthError(AuthError),
    Ack(Ack), Nack(Nack),
    SubscriptionsState(SubscriptionsState),
    Presence(Presence), FloorState(FloorState),
    KeyRotation(KeyRotation), ServerMigrate(ServerMigrate),
    Pong(Pong), Error(ServerError),
}

#[derive(Debug, Clone, Serialize)]
pub struct AuthOk {
    pub session_id: String, pub client_id: ClientId,
    pub udp_host: String, pub udp_port: u16,
    pub server_pubkey_x25519_hex: String, pub session_salt_hex: String,
    pub key_version: u16, pub heartbeat_ms: u32, pub mode: SessionMode,
}
#[derive(Debug, Clone, Serialize)] pub struct AuthError { pub reason: String }
#[derive(Debug, Clone, Serialize)] pub struct Ack { pub id: Uuid, #[serde(skip_serializing_if = "Option::is_none")] pub detail: Option<String> }
#[derive(Debug, Clone, Serialize)] pub struct Nack { pub id: Uuid, pub error: String }

#[derive(Debug, Clone, Serialize)]
pub struct SubscriptionsState {
    pub channels: Vec<SubscriptionEntry>,
    pub mode: SessionMode,
    pub pause_egress_during_ptt: bool,
    pub ptt_mutes: PttMuteScope,
    pub sidetone_db: f32,
}
#[derive(Debug, Clone, Serialize)]
pub struct SubscriptionEntry {
    pub channel_id: ChannelId, pub gain_db: f32, pub muted: bool, pub solo: bool,
    pub priority: ChannelPriorityRole, pub members: u32, pub floor_holder: Option<ClientId>,
}

#[derive(Debug, Clone, Serialize)] pub struct Presence { pub channel_id: ChannelId, pub members: Vec<MemberInfo> }
#[derive(Debug, Clone, Serialize)]
pub struct MemberInfo { pub client_id: ClientId, pub user_name: String, pub speaking: bool, pub since_ms: u64 }

#[derive(Debug, Clone, Serialize)]
pub struct FloorState {
    pub channel_id: ChannelId, pub holder: Option<ClientId>, pub priority: Priority,
    pub started_at_ms: u64, pub until_ms: Option<u64>, pub queue: Vec<QueuedFloor>,
}
#[derive(Debug, Clone, Serialize)]
pub struct QueuedFloor { pub client_id: ClientId, pub priority: Priority, pub since_ms: u64 }

#[derive(Debug, Clone, Serialize)] pub struct KeyRotation { pub channel_id: ChannelId, pub key_version: u16, pub wrapped_key_hex: String }
#[derive(Debug, Clone, Serialize)] pub struct ServerMigrate { pub new_server_host: String, pub new_server_port: u16, pub reason: String }
#[derive(Debug, Clone, Serialize)] pub struct Pong { pub client_timestamp_ms: u64, pub server_timestamp_ms: u64 }
#[derive(Debug, Clone, Serialize)] pub struct ServerError { pub code: String, pub message: String }
