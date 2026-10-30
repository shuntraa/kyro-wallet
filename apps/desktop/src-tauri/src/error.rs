use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

/// Errors crossing the IPC boundary. Serialized as `{ code, message }` (see docs/IPC.md);
/// messages are user-facing French and never contain secrets.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Mot de passe incorrect.")]
    WrongPassword,
    #[error("Le coffre est verrouillé.")]
    Locked,
    #[error("Trop de tentatives. Réessaie dans {0} s.")]
    RateLimited(u64),
    #[error("Action annulée.")]
    UserRejected,
    #[error("Serveur non autorisé : {0}")]
    HostNotAllowed(String),
    #[error("Entrée invalide : {0}")]
    InvalidInput(String),
    #[error("Erreur interne : {0}")]
    Internal(String),
    #[error("Tor indisponible : {0}")]
    TorUnavailable(String),
    #[error("Serveur invalide : {0}")]
    ServerInvalid(String),
    #[error("Mauvais réseau : {0}")]
    ServerWrongNetwork(String),
    #[error("Serveur injoignable : {0}")]
    ServerUnreachable(String),
    #[error("Fonction désactivée : {0}")]
    FeatureDisabled(String),
    #[error("Serveur par défaut désactivé : {0} (un serveur personnalisé est configuré pour cette chaîne)")]
    DefaultServerDisabled(String),
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    fn code(&self) -> &'static str {
        match self {
            AppError::WrongPassword => "WRONG_PASSWORD",
            AppError::Locked => "LOCKED",
            AppError::RateLimited(_) => "RATE_LIMITED",
            AppError::UserRejected => "USER_REJECTED",
            AppError::HostNotAllowed(_) => "HOST_NOT_ALLOWED",
            AppError::InvalidInput(_) => "INVALID_INPUT",
            AppError::Internal(_) => "INTERNAL",
            AppError::TorUnavailable(_) => "TOR_UNAVAILABLE",
            AppError::ServerInvalid(_) => "SERVER_INVALID",
            AppError::ServerWrongNetwork(_) => "SERVER_WRONG_NETWORK",
            AppError::ServerUnreachable(_) => "SERVER_UNREACHABLE",
            AppError::DefaultServerDisabled(_) => "DEFAULT_SERVER_DISABLED",
            AppError::FeatureDisabled(_) => "FEATURE_DISABLED",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("AppError", 2)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

impl From<wallet_core::Error> for AppError {
    fn from(e: wallet_core::Error) -> Self {
        match e {
            wallet_core::Error::WrongPassword => AppError::WrongPassword,
            other => AppError::InvalidInput(other.to_string()),
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}

impl From<tauri::Error> for AppError {
    fn from(e: tauri::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}
