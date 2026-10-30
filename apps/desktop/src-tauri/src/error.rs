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
    // ---- hardware wallets (docs/IPC.md §2.3) ----
    #[error("Appareil introuvable : branche-le, déverrouille-le, puis relance la détection.")]
    HwNotFound,
    #[error("Appareil verrouillé : déverrouille-le avec ton code PIN, puis réessaie.")]
    HwLocked,
    #[error("Mauvaise application ouverte sur l'appareil : ouvre « {expected} » (ouverte : « {open} »).")]
    HwWrongApp { expected: String, open: String },
    #[error("Refusé sur l'appareil.")]
    HwRejected,
    #[error("Appareil débranché ou injoignable : opération abandonnée, rien n'a été signé.")]
    HwDisconnected,
    #[error("Non pris en charge : {what}")]
    HwUnsupported { what: String, min: Option<String> },
    #[error("Appareil occupé : {0}")]
    HwBusy(String),
    #[error("Délai dépassé : pas de réponse de l'appareil à temps. Opération abandonnée.")]
    HwTimeout,
    #[error("Réponse de l'appareil refusée par Kyro : {0}")]
    HwBadResponse(String),
    #[error("ADRESSES DIFFÉRENTES : l'appareil donne {device}, Kyro attendait {expected}. N'utilise pas cette adresse.")]
    HwAddressMismatch { device: String, expected: String },
    #[error("Ce n'est pas l'appareil de ce compte (clés différentes).")]
    HwWrongDevice,
    #[error("Appareil pas encore appairé avec Kyro : connecte-le depuis l'écran des appareils pour l'appairer (code à 6 chiffres affiché sur l'appareil).")]
    HwPairingRequired,
    #[error(
        "Appairage échoué : {0}. Recommence la connexion : l'appareil affichera un nouveau code."
    )]
    HwPairingFailed(String),
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
            AppError::HwNotFound => "HW_NOT_FOUND",
            AppError::HwLocked => "HW_LOCKED",
            AppError::HwWrongApp { .. } => "HW_WRONG_APP",
            AppError::HwRejected => "HW_REJECTED",
            AppError::HwDisconnected => "HW_DISCONNECTED",
            AppError::HwUnsupported { .. } => "HW_UNSUPPORTED",
            AppError::HwBusy(_) => "HW_BUSY",
            AppError::HwTimeout => "HW_TIMEOUT",
            AppError::HwBadResponse(_) => "HW_BAD_RESPONSE",
            AppError::HwAddressMismatch { .. } => "HW_ADDRESS_MISMATCH",
            AppError::HwWrongDevice => "HW_WRONG_DEVICE",
            AppError::HwPairingRequired => "HW_PAIRING_REQUIRED",
            AppError::HwPairingFailed(_) => "HW_PAIRING_FAILED",
        }
    }

    /// Structured details for the UI (`data` field), only for errors that carry some.
    fn data(&self) -> Option<serde_json::Value> {
        match self {
            AppError::HwWrongApp { expected, open } => {
                Some(serde_json::json!({ "expected": expected, "open": open }))
            }
            AppError::HwUnsupported { min, .. } => Some(serde_json::json!({ "min": min })),
            AppError::HwAddressMismatch { device, expected } => {
                Some(serde_json::json!({ "device": device, "expected": expected }))
            }
            _ => None,
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let data = self.data();
        let mut s = serializer.serialize_struct("AppError", 2 + usize::from(data.is_some()))?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        if let Some(data) = data {
            s.serialize_field("data", &data)?;
        }
        s.end()
    }
}

impl From<wallet_core::Error> for AppError {
    fn from(e: wallet_core::Error) -> Self {
        match e {
            wallet_core::Error::WrongPassword => AppError::WrongPassword,
            wallet_core::Error::Device(m) => AppError::HwBadResponse(m),
            // The core's own Display is English ("invalid input: …"): its inner messages are
            // French for the chains the user sees, so only they are shown, after a French prefix.
            wallet_core::Error::InvalidInput(m) => AppError::InvalidInput(m),
            wallet_core::Error::InvalidMnemonic => {
                AppError::InvalidInput("phrase de récupération invalide".into())
            }
            wallet_core::Error::Psbt(m) => AppError::InvalidInput(format!("PSBT invalide : {m}")),
            wallet_core::Error::Crypto(m) => {
                AppError::InvalidInput(format!("échec cryptographique : {m}"))
            }
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
