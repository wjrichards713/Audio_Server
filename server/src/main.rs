//! audio-server binary entry point.
#![allow(unused_imports)]
use std::sync::Arc;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

mod auth;
mod channel;
mod config;
mod error;
mod floor;
mod keys;
mod media;
mod mesh;
mod metrics;
mod prefs;
mod presence;
mod protocol;
mod redis_client;
mod rest_client;
mod session;
mod shutdown;
mod udp_ingress;
mod ws_ops;
mod ws_server;
mod ws_session;

use crate::channel::ChannelRegistry;
use crate::config::{Config, LogFormat};
use crate::error::{AudioServerError, Result};
use crate::presence::PresenceBroadcaster;
use crate::session::SessionRegistry;
use crate::ws_server::{ws_server_run, WsServerState};

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() -> Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all().thread_name("audio-worker").build().map_err(AudioServerError::Io)?;
    runtime.block_on(async_main())
}

async fn async_main() -> Result<()> {
    let cfg = Config::from_env()?;
    init_tracing(&cfg);

    if let Err(e) = metrics::init(&cfg) { tracing::warn!(?e, "metrics exporter failed to install"); }

    let redis = redis_client::RedisClient::connect(&cfg).await?;
    tracing::info!(master = redis.master_name(), "connected to redis sentinel");

    let rest = rest_client::RestClient::new(&cfg)?;
    if let Err(e) = rest.health().await { tracing::warn!(?e, "REST health check failed (continuing)"); }

    let server_addr_ad = advertised_addr(&cfg);
    let status_json = serde_json::json!({
        "server_id": cfg.server_id,
        "udp":  format!("{}:{}", cfg.public_host, cfg.udp_port),
        "ws":   format!("{}:{}", cfg.public_host, cfg.ws_port),
        "mesh": format!("{}:{}", cfg.public_host, cfg.mesh_port),
        "version": VERSION,
    }).to_string();
    redis.update_server_status(cfg.server_id, &status_json, 15).await?;
    spawn_heartbeat(redis.clone(), cfg.server_id, status_json.clone());

    let (shutdown_ctl, shutdown_lis) = shutdown::new();
    let shutdown_ctl = Arc::new(shutdown_ctl);
    shutdown_ctl.clone().install_signal_handler();

    let _jwt_verifier = auth::default_verifier(&cfg);
    let mesh_handle = mesh::spawn(&cfg, redis.clone()).await?;
    let rotator = Arc::new(keys::KeyRotator::new(redis.clone()));
    rotator.clone().spawn(shutdown_lis.clone());

    let sessions = SessionRegistry::new();
    let channels = ChannelRegistry::new();
    let presence = PresenceBroadcaster::new();
    let cfg_arc = Arc::new(cfg.clone());

    let ws_state = WsServerState::new(cfg_arc.clone(), sessions.clone(), channels.clone(), presence.clone());
    let ws_task = tokio::spawn(ws_server_run(ws_state));

    // UdpIngress::start takes &Config; we clone into the spawned task so the
    // future is 'static. The clone is cheap (Config is mostly Strings + scalars).
    let udp_cfg = cfg.clone();
    let udp_sessions = sessions.clone();
    let udp_channels = channels.clone();
    let udp_shutdown = shutdown_lis.clone();
    let udp_task = tokio::spawn(async move {
        if let Err(e) = udp_ingress::UdpIngress::start(
            &udp_cfg, udp_sessions, udp_channels, udp_shutdown,
        )
        .await
        {
            tracing::error!(?e, "udp ingress exited with error");
        }
    });
    let _ = (ws_task, udp_task);

    banner(&cfg);

    let mut lis = shutdown_lis;
    tokio::select! { _ = lis.wait() => tracing::info!("shutdown signal received") }

    tracing::info!("deregistering from redis");
    let _ = server_addr_ad;
    let terminal = serde_json::json!({ "server_id": cfg.server_id, "state": "draining", "version": VERSION }).to_string();
    if let Err(e) = redis.update_server_status(cfg.server_id, &terminal, 5).await { tracing::warn!(?e, "terminal status update failed"); }
    drop(mesh_handle);
    drop(rotator);
    tracing::info!("bye");
    Ok(())
}

fn init_tracing(cfg: &Config) {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,audio_server=debug"));
    match cfg.log_format {
        LogFormat::Json => { let layer = fmt::layer().json().with_current_span(true).with_span_list(false);
            tracing_subscriber::registry().with(filter).with(layer).init(); }
        LogFormat::Pretty => { let layer = fmt::layer().compact();
            tracing_subscriber::registry().with(filter).with(layer).init(); }
    }
}
fn advertised_addr(cfg: &Config) -> String { format!("{}:{}", cfg.public_host, cfg.mesh_port) }
fn banner(cfg: &Config) {
    tracing::info!("audio-server v{} id={} udp=:{} ws=:{} mesh=:{} metrics=:{}",
        VERSION, cfg.server_id, cfg.udp_port, cfg.ws_port, cfg.mesh_port, cfg.metrics_port);
    println!("audio-server v{} id={} udp=:{} ws=:{} mesh=:{} metrics=:{}",
        VERSION, cfg.server_id, cfg.udp_port, cfg.ws_port, cfg.mesh_port, cfg.metrics_port);
}
fn spawn_heartbeat(redis: redis_client::RedisClient, server_id: u32, status_json: String) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(5));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            if let Err(e) = redis.update_server_status(server_id, &status_json, 15).await { tracing::warn!(?e, "server heartbeat failed"); }
        }
    });
}
