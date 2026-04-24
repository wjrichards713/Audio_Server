//! Axum WebSocket control-plane server.
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use axum::{extract::{ws::WebSocketUpgrade, ConnectInfo, State}, http::StatusCode,
           response::{IntoResponse, Response}, routing::get, Router};
use tokio::net::TcpListener;
use tower_http::trace::TraceLayer;
use tracing::{error, info};
use crate::channel::ChannelRegistry;
use crate::config::Config;
use crate::error::{AudioServerError, Result};
use crate::presence::PresenceBroadcaster;
use crate::session::SessionRegistry;
use crate::ws_session::handle_ws_connection;

pub type ReadyProbe = Arc<dyn Fn() -> futures_util::future::BoxFuture<'static, std::result::Result<(), String>> + Send + Sync>;

#[derive(Clone)]
pub struct WsServerState {
    pub config: Arc<Config>,
    pub sessions: Arc<SessionRegistry>,
    pub channels: Arc<ChannelRegistry>,
    pub presence: Arc<PresenceBroadcaster>,
    pub redis_probe: Option<ReadyProbe>,
    pub rest_probe: Option<ReadyProbe>,
}

impl WsServerState {
    pub fn new(config: Arc<Config>, sessions: Arc<SessionRegistry>,
               channels: Arc<ChannelRegistry>, presence: Arc<PresenceBroadcaster>) -> Self {
        Self { config, sessions, channels, presence, redis_probe: None, rest_probe: None }
    }
    pub fn with_probes(mut self, redis: ReadyProbe, rest: ReadyProbe) -> Self {
        self.redis_probe = Some(redis); self.rest_probe = Some(rest); self
    }
}

pub fn build_router(state: WsServerState) -> Router {
    Router::new()
        .route("/ws", get(ws_upgrade))
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

pub async fn ws_server_run(state: WsServerState) -> Result<()> {
    let addr = SocketAddr::new(state.config.bind_ip, state.config.ws_port);
    let listener = TcpListener::bind(addr).await
        .map_err(|e| AudioServerError::Config(format!("failed to bind WS listener on {addr}: {e}")))?;
    info!(%addr, "ws control-plane server listening");
    let app = build_router(state);
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await
        .map_err(|e| AudioServerError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;
    Ok(())
}

async fn ws_upgrade(State(state): State<WsServerState>, ws: WebSocketUpgrade,
                    ConnectInfo(peer): ConnectInfo<SocketAddr>) -> Response {
    ws.on_upgrade(move |socket| async move {
        if let Err(e) = handle_ws_connection(socket, peer, state).await {
            error!(peer = %peer, error = %e, "ws connection terminated with error");
        }
    })
}

async fn healthz() -> impl IntoResponse { (StatusCode::OK, "ok") }

async fn readyz(State(state): State<WsServerState>) -> impl IntoResponse {
    let timeout = Duration::from_millis(750);
    async fn run_probe(probe: &Option<ReadyProbe>, timeout: Duration) -> std::result::Result<(), String> {
        let Some(p) = probe else { return Err("not configured".into()); };
        match tokio::time::timeout(timeout, p()).await {
            Ok(Ok(())) => Ok(()), Ok(Err(e)) => Err(e), Err(_) => Err("probe timeout".into())
        }
    }
    let redis = run_probe(&state.redis_probe, timeout).await;
    let rest = run_probe(&state.rest_probe, timeout).await;
    match (redis, rest) {
        (Ok(()), Ok(())) => (StatusCode::OK, "ready").into_response(),
        (r, s) => {
            let reason = match (r, s) {
                (Err(re), Err(se)) => format!("redis={re}; rest={se}"),
                (Err(re), _) => format!("redis={re}"),
                (_, Err(se)) => format!("rest={se}"),
                _ => "unknown".into(),
            };
            (StatusCode::SERVICE_UNAVAILABLE, reason).into_response()
        }
    }
}
