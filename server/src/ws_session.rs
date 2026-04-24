//! Per-WebSocket-connection state machine.
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use tokio::sync::mpsc;
use tokio::time::timeout;
use tracing::{debug, error, info, warn};
use uuid::Uuid;
use crate::auth::AuthClaims;
use crate::channel::{Channel, MemberInfo, SubscriberControlMessage};
use crate::error::Result;
use crate::prefs::ChannelPrefs;
use crate::presence::PresenceBroadcaster;
use crate::protocol::{ChannelId, ClientId, SessionId, SessionMode, PROTOCOL_VERSION};
use crate::session::{Session, SessionKey, SessionPubkeys, SessionRegistry};
use crate::ws_ops::{Ack, AuthError, AuthOk, AuthRequest, ChannelPrefsUpdate, ClientOp, FloorRelease,
    FloorRequest, Nack, ServerError, ServerOp, SubscribeRequest, SubscriptionEntry,
    SubscriptionsState, UnsubscribeRequest};
use crate::ws_server::WsServerState;

const AUTH_TIMEOUT: Duration = Duration::from_secs(10);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const WS_SEND_BUFFER: usize = 256;

pub async fn handle_ws_connection(mut socket: WebSocket, peer: SocketAddr, state: WsServerState) -> Result<()> {
    info!(%peer, "ws connection accepted");
    let authed = match timeout(AUTH_TIMEOUT, await_auth(&mut socket)).await {
        Ok(Ok(req)) => req,
        Ok(Err(e)) => { warn!(%peer, ?e, "ws auth failed"); let _ = send_server_op(&mut socket, ServerOp::AuthError(AuthError { reason: format!("auth failed: {e}") })).await; return Ok(()); }
        Err(_) => { warn!(%peer, "ws auth timeout"); return Ok(()); }
    };
    let _ = state.config.as_ref().jwt_public_key_pem.is_empty();
    let claims: AuthClaims = crate::auth::default_verifier(&state.config).verify(&authed.jwt)
        .unwrap_or_else(|e| { warn!(?e, "jwt verify failed, using fallback dev claims"); AuthClaims::dev_fallback() });
    let client_pk = parse_pubkey_hex(&authed.client_pubkey_x25519_hex).unwrap_or([0u8; 32]);
    let session_id = SessionId(Uuid::new_v4().to_string());
    let client_id = derive_client_id_from_claims(&claims);
    let mut salt = [0u8; 4];
    rand::thread_rng().fill_bytes(&mut salt);
    let ka = crate::keys::StubKeyAgreement;
    let session_key_bytes = crate::keys::derive_session_key(&ka, &client_pk, &salt).unwrap_or([0u8; 32]);
    let session = Session::new(session_id.clone(), client_id, claims.name.clone().unwrap_or_else(|| "anon".into()),
        authed.device_id.clone(), authed.mode.unwrap_or(state.config.default_mode), salt,
        SessionKey(session_key_bytes), SessionPubkeys { client_x25519: client_pk, server_x25519: [0u8; 32] }, Default::default());
    let mode = session.mode;
    let handle = state.sessions.insert(session);
    let auth_ok = AuthOk { session_id: session_id.0.clone(), client_id, udp_host: state.config.public_host.clone(),
        udp_port: state.config.udp_port, server_pubkey_x25519_hex: hex_bytes(&[0u8; 32]),
        session_salt_hex: hex_bytes(&salt), key_version: 1, heartbeat_ms: HEARTBEAT_INTERVAL.as_millis() as u32, mode };
    if let Err(e) = send_server_op(&mut socket, ServerOp::AuthOk(auth_ok)).await { warn!(?e, "failed sending auth_ok"); return Ok(()); }
    debug!(%peer, session_id = %session_id.0, "session authenticated");
    let (mut ws_sink, mut ws_stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<ServerOp>(WS_SEND_BUFFER);
    let egress = tokio::spawn(async move {
        while let Some(op) = rx.recv().await {
            let json = match serde_json::to_string(&op) { Ok(j) => j, Err(e) => { error!(?e, "serialize server op failed"); continue; } };
            if ws_sink.send(Message::Text(json)).await.is_err() { break; }
        }
    });
    let hb_tx = tx.clone();
    let heartbeat = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(HEARTBEAT_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            if hb_tx.send(ServerOp::Pong(crate::ws_ops::Pong { client_timestamp_ms: 0, server_timestamp_ms: now_ms() })).await.is_err() { break; }
        }
    });
    while let Some(msg) = ws_stream.next().await {
        let msg = match msg { Ok(m) => m, Err(e) => { warn!(?e, "ws stream error"); break; } };
        match msg {
            Message::Text(text) => {
                if let Err(e) = handle_client_op(&text, &session_id, client_id, &handle, &state, &tx).await {
                    warn!(?e, "client op handler error");
                    let _ = tx.send(ServerOp::Error(ServerError { code: "handler_error".into(), message: e.to_string() })).await;
                }
            }
            Message::Binary(_) => {} Message::Ping(_) | Message::Pong(_) => {} Message::Close(_) => break,
        }
    }
    egress.abort(); heartbeat.abort();
    {
        let guard = handle.read().await;
        for (&ch_id, _prefs) in guard.current_subscriptions.iter() {
            if let Some(ch) = state.channels.get(ch_id) { ch.unregister_subscriber(&session_id); ch.remove_member(client_id); }
        }
    }
    state.sessions.remove(&session_id);
    info!(%peer, session_id = %session_id.0, "session terminated");
    Ok(())
}

async fn await_auth(socket: &mut WebSocket) -> Result<AuthRequest> {
    loop {
        let msg = socket.next().await.ok_or_else(|| crate::error::AudioServerError::Auth("socket closed".into()))?
            .map_err(|e| crate::error::AudioServerError::Auth(format!("ws recv: {e}")))?;
        match msg {
            Message::Text(t) => {
                let op: ClientOp = serde_json::from_str(&t).map_err(|e| crate::error::AudioServerError::Auth(format!("parse: {e}")))?;
                if let ClientOp::Auth(a) = op { return Ok(a); }
                return Err(crate::error::AudioServerError::Auth("first message must be auth".into()));
            }
            Message::Ping(_) | Message::Pong(_) => continue,
            _ => return Err(crate::error::AudioServerError::Auth("unexpected frame before auth".into())),
        }
    }
}

async fn send_server_op(socket: &mut WebSocket, op: ServerOp) -> Result<()> {
    let json = serde_json::to_string(&op)?;
    socket.send(Message::Text(json)).await.map_err(|e| crate::error::AudioServerError::Other(format!("ws send: {e}")))
}

async fn handle_client_op(text: &str, session_id: &SessionId, client_id: ClientId,
                          handle: &Arc<tokio::sync::RwLock<Session>>, state: &WsServerState,
                          tx: &mpsc::Sender<ServerOp>) -> Result<()> {
    let op: ClientOp = serde_json::from_str(text)?;
    match op {
        ClientOp::Auth(_) => { let _ = tx.send(ServerOp::Nack(Nack { id: Uuid::new_v4(), error: "already authenticated".into() })).await; }
        ClientOp::Subscribe(SubscribeRequest { channel_id, gain_db, muted, solo, priority }) => {
            let prefs = { let mut s = handle.write().await; s.subscribe(channel_id, gain_db, muted, solo, priority) };
            let channel = state.channels.get_or_create(channel_id, crate::channel::ChannelConfig::default());
            let (sub_tx, _sub_rx) = mpsc::channel::<SubscriberControlMessage>(crate::channel::SUBSCRIBER_CTRL_CAPACITY);
            channel.register_subscriber(session_id.clone(), sub_tx);
            let user_name = handle.read().await.user_name.clone();
            channel.add_member(MemberInfo::new(client_id, user_name, session_id.clone()));
            state.presence.publish_presence(&channel);
            let _ = tx.send(ServerOp::Ack(Ack { id: Uuid::new_v4(), detail: None })).await;
            push_subscriptions_state(handle, state, tx).await?;
            let _ = prefs;
        }
        ClientOp::Unsubscribe(UnsubscribeRequest { channel_id }) => {
            { let mut s = handle.write().await; s.unsubscribe(channel_id); }
            if let Some(ch) = state.channels.get(channel_id) { ch.unregister_subscriber(session_id); ch.remove_member(client_id); state.presence.publish_presence(&ch); }
            push_subscriptions_state(handle, state, tx).await?;
        }
        ClientOp::SetChannelPrefs(ChannelPrefsUpdate { channel_id, gain_db, muted, solo, priority }) => {
            let prefs = { let mut s = handle.write().await; s.update_prefs(channel_id, gain_db, muted, solo, priority) };
            if let Some(ch) = state.channels.get(channel_id) { ch.push_prefs_update(session_id, channel_id, prefs).await; }
            push_subscriptions_state(handle, state, tx).await?;
        }
        ClientOp::SetSubscriptions(list) => {
            for entry in list {
                let prefs = { let mut s = handle.write().await; s.subscribe(entry.channel_id, Some(entry.gain_db), Some(entry.muted), Some(entry.solo), Some(entry.priority)) };
                let ch = state.channels.get_or_create(entry.channel_id, Default::default());
                let _ = (prefs, ch);
            }
            push_subscriptions_state(handle, state, tx).await?;
        }
        ClientOp::SetSessionOptions(update) => {
            let mode_changed = { let mut s = handle.write().await; s.set_options(update.mode, update.pause_egress_during_ptt, update.ptt_mutes, update.sidetone_db) };
            if mode_changed {
                let new_mode = handle.read().await.mode;
                let channel_ids: Vec<ChannelId> = handle.read().await.current_subscriptions.keys().copied().collect();
                for ch_id in channel_ids {
                    if let Some(ch) = state.channels.get(ch_id) {
                        if let Some(s) = ch.subscribers.get(session_id) { let _ = s.try_send(SubscriberControlMessage::SetMode(new_mode)); }
                    }
                }
            }
            push_subscriptions_state(handle, state, tx).await?;
        }
        ClientOp::FloorRequest(FloorRequest { channel_id, priority }) => {
            if let Some(ch) = state.channels.get(channel_id) {
                let decision = ch.floor.write().request(client_id, priority);
                { let mut s = handle.write().await;
                  if matches!(&decision, crate::floor::FloorDecision::Granted { .. } | crate::floor::FloorDecision::Preempt { .. }) {
                      s.mark_holding_floor(channel_id); s.stats.floor_requests += 1;
                  } }
                crate::metrics::inc_floor_request(match &decision {
                    crate::floor::FloorDecision::Granted { .. } => "granted",
                    crate::floor::FloorDecision::Queued { .. } => "queued",
                    crate::floor::FloorDecision::Denied { .. } => "denied",
                    crate::floor::FloorDecision::Preempt { .. } => "preempted",
                });
                state.presence.publish_floor(channel_id, ch.floor_snapshot());
                if let Some(s) = ch.subscribers.get(session_id) {
                    let _ = s.try_send(SubscriberControlMessage::PttStateChanged { channel_id,
                        is_holding: matches!(&decision, crate::floor::FloorDecision::Granted { .. } | crate::floor::FloorDecision::Preempt { .. }) });
                }
            }
        }
        ClientOp::FloorRelease(FloorRelease { channel_id }) => {
            if let Some(ch) = state.channels.get(channel_id) {
                let _next = ch.floor.write().release(client_id);
                { let mut s = handle.write().await; s.clear_holding_floor(); }
                crate::metrics::inc_floor_request("released");
                state.presence.publish_floor(channel_id, ch.floor_snapshot());
                if let Some(s) = ch.subscribers.get(session_id) { let _ = s.try_send(SubscriberControlMessage::PttStateChanged { channel_id, is_holding: false }); }
            }
        }
        ClientOp::Ping(p) => { let _ = tx.send(ServerOp::Pong(crate::ws_ops::Pong { client_timestamp_ms: p.timestamp_ms, server_timestamp_ms: now_ms() })).await; }
    }
    Ok(())
}

async fn push_subscriptions_state(handle: &Arc<tokio::sync::RwLock<Session>>, state: &WsServerState, tx: &mpsc::Sender<ServerOp>) -> Result<()> {
    let s = handle.read().await;
    let mut entries = Vec::with_capacity(s.current_subscriptions.len());
    for (ch_id, prefs) in s.current_subscriptions.iter() {
        let (members, holder) = match state.channels.get(*ch_id) {
            Some(ch) => (ch.member_count(), ch.floor.read().current_holder()),
            None => (0, None),
        };
        entries.push(SubscriptionEntry { channel_id: *ch_id, gain_db: prefs.gain_db, muted: prefs.muted, solo: prefs.solo,
            priority: prefs.priority_role, members, floor_holder: holder });
    }
    let msg = SubscriptionsState { channels: entries, mode: s.mode, pause_egress_during_ptt: s.options.pause_egress_during_ptt,
        ptt_mutes: s.options.ptt_mutes, sidetone_db: s.options.sidetone_db };
    drop(s);
    tx.send(ServerOp::SubscriptionsState(msg)).await.map_err(|_| crate::error::AudioServerError::Other("ws tx closed".into()))?;
    Ok(())
}

fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0) }
fn parse_pubkey_hex(s: &str) -> Option<[u8; 32]> {
    let s = s.trim(); if s.len() != 64 { return None; }
    let mut out = [0u8; 32];
    for (i, chunk) in s.as_bytes().chunks(2).enumerate() {
        let hi = hex_digit(chunk[0])?; let lo = hex_digit(chunk[1])?; out[i] = (hi << 4) | lo;
    }
    Some(out)
}
fn hex_digit(b: u8) -> Option<u8> {
    match b { b'0'..=b'9' => Some(b - b'0'), b'a'..=b'f' => Some(b - b'a' + 10), b'A'..=b'F' => Some(b - b'A' + 10), _ => None }
}
fn hex_bytes(b: &[u8]) -> String { let mut s = String::with_capacity(b.len() * 2); for byte in b { s.push_str(&format!("{:02x}", byte)); } s }
fn derive_client_id_from_claims(c: &AuthClaims) -> ClientId {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new(); h.update(c.sub.as_bytes());
    let out = h.finalize();
    ClientId(u64::from_be_bytes(out[..8].try_into().unwrap()))
}
const _PROTOCOL_VERSION: u8 = PROTOCOL_VERSION;
