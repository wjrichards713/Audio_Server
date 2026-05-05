//! Admin REST endpoints for live session/mixer management.
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use crate::protocol::{ChannelId, SessionId};
use crate::ws_server::WsServerState;

#[derive(Serialize)]
struct ChannelInfo {
    channel_id: u32,
    member_count: u32,
    members: Vec<MemberPrefsInfo>,
}

#[derive(Serialize)]
struct MemberPrefsInfo {
    session_id: String,
    client_id: u64,
    user_name: String,
    gain_db: f32,
    muted: bool,
    solo: bool,
}

#[derive(Deserialize)]
struct UpdatePrefsRequest {
    channel_id: u32,
    gain_db: Option<f32>,
    muted: Option<bool>,
    solo: Option<bool>,
}

pub fn admin_router() -> Router<WsServerState> {
    Router::new()
        .route("/api/admin/channels", get(list_channels))
        .route("/api/admin/sessions/{session_id}/prefs", post(update_session_prefs))
}

async fn list_channels(State(state): State<WsServerState>) -> impl IntoResponse {
    let channels = state.channels.snapshot();
    let sessions = state.sessions.snapshot();

    let mut result = Vec::new();
    for ch in &channels {
        let mut members = Vec::new();
        for session_arc in &sessions {
            let session = session_arc.read().await;
            if let Some(prefs) = session.current_subscriptions.get(&ch.channel_id) {
                members.push(MemberPrefsInfo {
                    session_id: session.session_id.0.clone(),
                    client_id: session.client_id.0,
                    user_name: session.user_name.clone(),
                    gain_db: prefs.gain_db,
                    muted: prefs.muted,
                    solo: prefs.solo,
                });
            }
        }
        result.push(ChannelInfo {
            channel_id: ch.channel_id.0,
            member_count: ch.member_count(),
            members,
        });
    }
    Json(result).into_response()
}

async fn update_session_prefs(
    State(state): State<WsServerState>,
    Path(session_id): Path<String>,
    Json(req): Json<UpdatePrefsRequest>,
) -> impl IntoResponse {
    let sid = SessionId(session_id);
    let Some(session_arc) = state.sessions.get(&sid) else {
        return (StatusCode::NOT_FOUND, "session not found").into_response();
    };

    let channel_id = ChannelId(req.channel_id);
    let prefs = {
        let mut s = session_arc.write().await;
        s.update_prefs(channel_id, req.gain_db, req.muted, req.solo, None)
    };

    if let Some(ch) = state.channels.get(channel_id) {
        ch.push_prefs_update(&sid, channel_id, prefs).await;
    }

    (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
}
