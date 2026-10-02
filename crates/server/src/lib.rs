//! `baren-server`: accounts, teams ("parties"), invite links and live Loro rooms for
//! Baren. See ARCHITECTURE.md ("Server API") and `README.md` in this crate.
//!
//! [`start`] binds the listener and runs the server in the background, which is what both the
//! binary and the integration tests use.

pub mod config;
pub mod mailer;
pub mod rooms;

mod dates;
mod db;
mod error;
mod html;
mod ratelimit;
mod routes;
mod secrets;
mod session;
mod state;
mod validate;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use axum::serve::ListenerExt;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

pub use config::{Config, MailConfig, MailTransport};
pub use mailer::{Email, LogMailer, MailQueue, Mailer, MemoryMailer};
use rooms::{RoomSettings, Rooms};
use state::AppState;

pub const DEFAULT_ADDR: &str = config::DEFAULT_BIND;

/// How often expired sessions, codes and device requests are purged.
const PURGE_EVERY: Duration = Duration::from_secs(10 * 60);

/// A running server.
pub struct Server {
    addr: SocketAddr,
    state: AppState,
    shutdown: Option<oneshot::Sender<()>>,
    serve: JoinHandle<std::io::Result<()>>,
    purge: JoinHandle<()>,
}

/// Open the database (running migrations), bind `config.bind` and serve in the background.
pub async fn start(config: Config, mailer: Arc<dyn Mailer>) -> anyhow::Result<Server> {
    let db = db::connect(&config.database_url).await?;
    let listener = TcpListener::bind(&config.bind)
        .await
        .with_context(|| format!("binding {}", config.bind))?;
    let addr = listener.local_addr()?;
    // Sync and presence frames are small and latency-bound: never let Nagle hold them back.
    let listener = listener.tap_io(|tcp| {
        if let Err(err) = tcp.set_nodelay(true) {
            tracing::warn!(error = %err, "failed to set TCP_NODELAY");
        }
    });
    let public_url = config.public_url_for(addr);
    let rooms = Rooms::new(db.clone(), RoomSettings::from_config(&config));
    let state = AppState::new(db.clone(), config, public_url, mailer, rooms);
    tokio::fs::create_dir_all(&state.assets_dir)
        .await
        .with_context(|| format!("creating ASSETS_DIR {}", state.assets_dir.display()))?;

    let app = routes::router(state.clone());
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let serve = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
    });
    let purge_state = state.clone();
    let purge = tokio::spawn(async move {
        let mut every = tokio::time::interval(PURGE_EVERY);
        loop {
            every.tick().await;
            if let Err(err) = db::purge_expired(&db).await {
                tracing::warn!(error = %err, "purging expired rows failed");
            }
            if let Err(err) =
                routes::assets::sweep_orphans(&purge_state, routes::assets::ORPHAN_GRACE).await
            {
                tracing::warn!(error = %err, "sweeping unreferenced assets failed");
            }
        }
    });
    Ok(Server {
        addr,
        state,
        shutdown: Some(shutdown_tx),
        serve,
        purge,
    })
}

impl Server {
    /// The bound socket address (useful with `BIND=127.0.0.1:0`).
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// `http://<bound address>`.
    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// Base URL used in invite and device links.
    pub fn public_url(&self) -> &str {
        &self.state.public_url
    }

    /// Where uploaded assets are stored.
    pub fn assets_dir(&self) -> &std::path::Path {
        &self.state.assets_dir
    }

    /// Run the unreferenced-asset sweep now with a custom grace period (the purge task runs
    /// it every 10 minutes with 24 h). Returns how many assets were deleted.
    pub async fn sweep_unreferenced_assets(&self, grace: Duration) -> anyhow::Result<usize> {
        routes::assets::sweep_orphans(&self.state, grace).await
    }

    /// Number of rooms currently loaded in memory.
    pub fn open_rooms(&self) -> usize {
        self.state.rooms.open_rooms()
    }

    /// Wait until the HTTP server stops on its own (it normally does not).
    pub async fn wait(&mut self) -> anyhow::Result<()> {
        (&mut self.serve).await??;
        Ok(())
    }

    /// Graceful shutdown: close every room (flushing and compacting it), stop accepting
    /// requests, wait for in-flight ones, and close the database.
    pub async fn shutdown(mut self) -> anyhow::Result<()> {
        self.state.rooms.shutdown().await;
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        self.purge.abort();
        match tokio::time::timeout(Duration::from_secs(10), &mut self.serve).await {
            Ok(result) => result??,
            Err(_) => {
                tracing::warn!("in-flight requests did not finish within 10s; aborting");
                self.serve.abort();
            }
        }
        // Give queued emails (codes someone is waiting for) a moment to go out.
        self.state.mailer.flush(Duration::from_secs(5)).await;
        self.state.db.close().await;
        Ok(())
    }
}
