use std::io::IsTerminal;
use std::sync::Arc;

use baren_server::config::redact_url;
use baren_server::{Config, MailTransport};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with_ansi(std::io::stdout().is_terminal())
        .init();

    let config = Config::from_env()?;
    match &config.mail.transport {
        MailTransport::Log => tracing::info!(
            "email: MAIL_TRANSPORT=log; codes and invite links are written to this log, nothing is sent"
        ),
        MailTransport::File(dir) => {
            tracing::info!("email: writing messages to {} (not sent)", dir.display())
        }
        MailTransport::Smtp(url) => tracing::info!(
            "email: SMTP via {} from {}",
            redact_url(url),
            config.mail.from
        ),
    }
    let mailer: Arc<dyn baren_server::Mailer> = baren_server::mailer::from_config(&config.mail)?;
    let server = baren_server::start(config, mailer).await?;
    // The sync-client e2e test waits for this exact line.
    tracing::info!(
        "baren-server listening on {} (public URL {})",
        server.url(),
        server.public_url()
    );

    shutdown_signal().await;
    tracing::info!("shutting down: closing rooms and flushing documents");
    server.shutdown().await?;
    tracing::info!("bye");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
