use thiserror::Error;

pub type Result<T, E = CoreError> = std::result::Result<T, E>;

/// Every failure the core can report. [`CoreError::code`] is a stable,
/// machine-readable identifier that the N-API layer puts in front of the
/// message (`"[not-found] file … does not exist"`).
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum CoreError {
    #[error("file {0} does not exist")]
    FileNotFound(String),
    #[error("node {0} does not exist")]
    NodeNotFound(String),
    /// The bytes are not a Loro update/snapshot this document accepts.
    #[error("invalid update: {0}")]
    InvalidUpdate(String),
    #[error("{0}")]
    InvalidInput(String),
    #[error("{what} is {size} bytes; the limit is {max} bytes")]
    TooLarge {
        what: &'static str,
        size: usize,
        max: usize,
    },
    /// Another `Store` (in this or another process) owns the database.
    #[error("the database {0} is already open (by this or another Baren process)")]
    Locked(String),
    #[error(
        "the database was written by a newer Baren (schema {found}; this build supports {supported})"
    )]
    DatabaseTooNew { found: i64, supported: i64 },
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("document error: {0}")]
    Loro(String),
    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),
}

impl CoreError {
    /// Stable error code, safe to match on from JS.
    pub fn code(&self) -> &'static str {
        match self {
            CoreError::FileNotFound(_) | CoreError::NodeNotFound(_) => "not-found",
            CoreError::InvalidUpdate(_) => "invalid-update",
            CoreError::InvalidInput(_) => "invalid-input",
            CoreError::TooLarge { .. } => "too-large",
            CoreError::Locked(_) => "locked",
            CoreError::DatabaseTooNew { .. } => "database-too-new",
            CoreError::Db(_) => "db",
            CoreError::Loro(_) => "loro",
            CoreError::Io(_) => "io",
        }
    }

    /// True for errors caused by the caller's input rather than the system.
    pub fn is_user_error(&self) -> bool {
        matches!(
            self,
            CoreError::FileNotFound(_)
                | CoreError::NodeNotFound(_)
                | CoreError::InvalidUpdate(_)
                | CoreError::InvalidInput(_)
                | CoreError::TooLarge { .. }
        )
    }

    pub(crate) fn invalid(msg: impl Into<String>) -> Self {
        CoreError::InvalidInput(msg.into())
    }
}

impl From<loro::LoroError> for CoreError {
    fn from(e: loro::LoroError) -> Self {
        CoreError::Loro(e.to_string())
    }
}

impl From<loro::LoroEncodeError> for CoreError {
    fn from(e: loro::LoroEncodeError) -> Self {
        CoreError::Loro(e.to_string())
    }
}

impl From<serde_json::Error> for CoreError {
    fn from(e: serde_json::Error) -> Self {
        CoreError::Loro(format!("json: {e}"))
    }
}
