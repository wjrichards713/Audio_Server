//! Graceful shutdown coordinator.
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;

pub const DEFAULT_DRAIN_GRACE_SECS: u64 = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShutdownState { Running, Draining, Shutdown }

pub struct ShutdownController { tx: watch::Sender<ShutdownState>, drain_grace: Duration }

#[derive(Clone)]
pub struct ShutdownListener { rx: watch::Receiver<ShutdownState> }

pub fn new() -> (ShutdownController, ShutdownListener) {
    new_with_grace(Duration::from_secs(DEFAULT_DRAIN_GRACE_SECS))
}

pub fn new_with_grace(drain_grace: Duration) -> (ShutdownController, ShutdownListener) {
    let (tx, rx) = watch::channel(ShutdownState::Running);
    (ShutdownController { tx, drain_grace }, ShutdownListener { rx })
}

impl ShutdownController {
    pub async fn terminate(&self) {
        let current = *self.tx.borrow();
        if current == ShutdownState::Shutdown { return; }
        if current == ShutdownState::Running {
            let _ = self.tx.send(ShutdownState::Draining);
            tracing::info!(grace_secs = self.drain_grace.as_secs(), "entering drain state");
            tokio::time::sleep(self.drain_grace).await;
        }
        let _ = self.tx.send(ShutdownState::Shutdown);
        tracing::info!("shutdown signalled");
    }
    pub fn force_shutdown(&self) { let _ = self.tx.send(ShutdownState::Shutdown); }
    pub fn install_signal_handler(self: Arc<Self>) {
        tokio::spawn(async move {
            #[cfg(unix)]
            let sig = async {
                use tokio::signal::unix::{signal, SignalKind};
                let mut sigint = match signal(SignalKind::interrupt()) { Ok(s) => s, Err(e) => { tracing::error!(?e, "sigint install"); return; } };
                let mut sigterm = match signal(SignalKind::terminate()) { Ok(s) => s, Err(e) => { tracing::error!(?e, "sigterm install"); return; } };
                tokio::select! { _ = sigint.recv() => tracing::warn!("SIGINT received"), _ = sigterm.recv() => tracing::warn!("SIGTERM received") }
                let ctl = self.clone();
                let grace = tokio::spawn(async move { ctl.terminate().await });
                tokio::select! {
                    _ = sigint.recv() => { tracing::warn!("second signal — forcing shutdown"); self.force_shutdown(); }
                    _ = sigterm.recv() => { tracing::warn!("second signal — forcing shutdown"); self.force_shutdown(); }
                    _ = grace => {}
                }
            };
            #[cfg(not(unix))]
            let sig = async {
                if let Err(e) = tokio::signal::ctrl_c().await { tracing::error!(?e, "ctrl_c"); return; }
                tracing::warn!("ctrl-c received"); self.clone().terminate().await;
            };
            sig.await;
        });
    }
}

impl ShutdownListener {
    pub async fn wait(&mut self) {
        if *self.rx.borrow() == ShutdownState::Shutdown { return; }
        loop {
            if self.rx.changed().await.is_err() { return; }
            if *self.rx.borrow() == ShutdownState::Shutdown { return; }
        }
    }
    pub async fn wait_drain(&mut self) {
        if *self.rx.borrow() != ShutdownState::Running { return; }
        loop {
            if self.rx.changed().await.is_err() { return; }
            if *self.rx.borrow() != ShutdownState::Running { return; }
        }
    }
    pub fn state(&self) -> ShutdownState { *self.rx.borrow() }
    pub fn is_shutdown(&self) -> bool { self.state() == ShutdownState::Shutdown }
    pub fn is_draining(&self) -> bool { matches!(self.state(), ShutdownState::Draining | ShutdownState::Shutdown) }
}
