use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

/// Errors crossing the IPC boundary. Serialized as `{ code, message }` (see docs/IPC.md);
/// messages are user-facing, in the current language ([`AppError::message`]: the `#[error]`
/// texts below are the English ones), and never contain secrets.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Wrong password.")]
    WrongPassword,
    #[error("The vault is locked.")]
    Locked,
    #[error("Too many attempts. Try again in {0} s.")]
    RateLimited(u64),
    #[error("Action cancelled.")]
    UserRejected,
    #[error("Server not allowed: {0}")]
    HostNotAllowed(String),
    #[error("Invalid input: {0}")]
    InvalidInput(String),
    #[error("Internal error: {0}")]
    Internal(String),
    #[error("Tor unavailable: {0}")]
    TorUnavailable(String),
    #[error("Invalid server: {0}")]
    ServerInvalid(String),
    #[error("Wrong network: {0}")]
    ServerWrongNetwork(String),
    #[error("Server unreachable: {0}")]
    ServerUnreachable(String),
    #[error("Feature disabled: {0}")]
    FeatureDisabled(String),
    #[error("Default server disabled: {0} (a custom server is configured for this chain)")]
    DefaultServerDisabled(String),
    // ---- hardware wallets (docs/IPC.md §2.3) ----
    #[error("Device not found: plug it in, unlock it, then run the detection again.")]
    HwNotFound,
    #[error("Device locked: unlock it with your PIN, then try again.")]
    HwLocked,
    #[error("Wrong app open on the device: open « {expected} » (open: « {open} »).")]
    HwWrongApp { expected: String, open: String },
    #[error("Refused on the device.")]
    HwRejected,
    #[error("Device unplugged or unreachable: operation aborted, nothing was signed.")]
    HwDisconnected,
    #[error("Not supported: {what}")]
    HwUnsupported { what: String, min: Option<String> },
    #[error("Device busy: {0}")]
    HwBusy(String),
    #[error("Timed out: no answer from the device in time. Operation aborted.")]
    HwTimeout,
    #[error("Device answer refused by Kyro: {0}")]
    HwBadResponse(String),
    #[error("DIFFERENT ADDRESSES: the device gives {device}, Kyro expected {expected}. Do not use this address.")]
    HwAddressMismatch { device: String, expected: String },
    #[error("This is not this account's device (different keys).")]
    HwWrongDevice,
    #[error("Device not paired with Kyro yet: connect it from the devices screen to pair it (6-digit code shown on the device).")]
    HwPairingRequired,
    #[error("Pairing failed: {0}. Start the connection again: the device will show a new code.")]
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

    /// The user-facing message in `lang`. English is the `Display` text. In French, the fixed
    /// texts are translated here and the free-form details (`InvalidInput(…)` and the like)
    /// through [`crate::i18n::detail_fr`]: the common ones in French, any other in English.
    pub fn message(&self, lang: crate::i18n::Lang) -> String {
        use crate::i18n::Lang;
        if lang == Lang::En {
            return self.to_string();
        }
        let detail = |d: &str| crate::i18n::detail_fr(d);
        match self {
            AppError::WrongPassword => "Mot de passe incorrect.".into(),
            AppError::Locked => "Le coffre est verrouillé.".into(),
            AppError::RateLimited(s) => format!("Trop de tentatives. Réessaie dans {s} s."),
            AppError::UserRejected => "Action annulée.".into(),
            AppError::HostNotAllowed(h) => format!("Serveur non autorisé : {h}"),
            AppError::InvalidInput(d) => format!("Entrée invalide : {}", detail(d)),
            AppError::Internal(d) => format!("Erreur interne : {}", detail(d)),
            AppError::TorUnavailable(d) => format!("Tor indisponible : {}", detail(d)),
            AppError::ServerInvalid(d) => format!("Serveur invalide : {}", detail(d)),
            AppError::ServerWrongNetwork(d) => format!("Mauvais réseau : {}", detail(d)),
            AppError::ServerUnreachable(d) => format!("Serveur injoignable : {}", detail(d)),
            AppError::FeatureDisabled(d) => format!("Fonction désactivée : {}", detail(d)),
            AppError::DefaultServerDisabled(d) => format!(
                "Serveur par défaut désactivé : {} (un serveur personnalisé est configuré pour cette chaîne)",
                detail(d)
            ),
            AppError::HwNotFound => {
                "Appareil introuvable : branche-le, déverrouille-le, puis relance la détection."
                    .into()
            }
            AppError::HwLocked => {
                "Appareil verrouillé : déverrouille-le avec ton code PIN, puis réessaie.".into()
            }
            AppError::HwWrongApp { expected, open } => format!(
                "Mauvaise application ouverte sur l'appareil : ouvre « {expected} » (ouverte : « {open} »)."
            ),
            AppError::HwRejected => "Refusé sur l'appareil.".into(),
            AppError::HwDisconnected => {
                "Appareil débranché ou injoignable : opération abandonnée, rien n'a été signé."
                    .into()
            }
            AppError::HwUnsupported { what, .. } => format!("Non pris en charge : {}", detail(what)),
            AppError::HwBusy(d) => format!("Appareil occupé : {}", detail(d)),
            AppError::HwTimeout => {
                "Délai dépassé : pas de réponse de l'appareil à temps. Opération abandonnée.".into()
            }
            AppError::HwBadResponse(d) => {
                format!("Réponse de l'appareil refusée par Kyro : {}", detail(d))
            }
            AppError::HwAddressMismatch { device, expected } => format!(
                "ADRESSES DIFFÉRENTES : l'appareil donne {device}, Kyro attendait {expected}. N'utilise pas cette adresse."
            ),
            AppError::HwWrongDevice => {
                "Ce n'est pas l'appareil de ce compte (clés différentes).".into()
            }
            AppError::HwPairingRequired => "Appareil pas encore appairé avec Kyro : connecte-le depuis l'écran des appareils pour l'appairer (code à 6 chiffres affiché sur l'appareil).".into(),
            AppError::HwPairingFailed(d) => format!(
                "Appairage échoué : {}. Recommence la connexion : l'appareil affichera un nouveau code.",
                detail(d)
            ),
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
        s.serialize_field("message", &self.message(crate::i18n::current()))?;
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
            // The core's own Display is English ("invalid input: …"): only the inner message is
            // kept, after the shell's "Invalid input: " prefix.
            wallet_core::Error::InvalidInput(m) => AppError::InvalidInput(m),
            wallet_core::Error::InvalidMnemonic => {
                AppError::InvalidInput("invalid recovery phrase".into())
            }
            wallet_core::Error::Psbt(m) => AppError::InvalidInput(format!("invalid PSBT: {m}")),
            wallet_core::Error::Crypto(m) => {
                AppError::InvalidInput(format!("cryptographic failure: {m}"))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::Lang;

    #[test]
    fn messages_in_both_languages() {
        assert_eq!(
            AppError::WrongPassword.message(Lang::Fr),
            "Mot de passe incorrect."
        );
        assert_eq!(AppError::WrongPassword.message(Lang::En), "Wrong password.");
        assert_eq!(
            AppError::RateLimited(30).message(Lang::En),
            "Too many attempts. Try again in 30 s."
        );
        assert_eq!(
            AppError::UserRejected.message(Lang::En),
            "Action cancelled."
        );
        assert_eq!(
            AppError::HwWrongApp {
                expected: "Bitcoin".into(),
                open: "Ethereum".into()
            }
            .message(Lang::En),
            "Wrong app open on the device: open « Bitcoin » (open: « Ethereum »)."
        );
        assert!(AppError::HwAddressMismatch {
            device: "a".into(),
            expected: "b".into()
        }
        .message(Lang::En)
        .starts_with("DIFFERENT ADDRESSES"));
        assert_eq!(
            AppError::HwWrongApp {
                expected: "Bitcoin".into(),
                open: "Ethereum".into()
            }
            .message(Lang::Fr),
            "Mauvaise application ouverte sur l'appareil : ouvre « Bitcoin » (ouverte : « Ethereum »)."
        );
        // Common details are in French for a French UI, any other stays in English.
        assert_eq!(
            AppError::InvalidInput("a vault already exists on this device".into())
                .message(Lang::Fr),
            "Entrée invalide : un coffre existe déjà sur cet appareil"
        );
        assert_eq!(
            AppError::InvalidInput("a vault already exists on this device".into())
                .message(Lang::En),
            "Invalid input: a vault already exists on this device"
        );
        assert_eq!(
            AppError::InvalidInput("invalid settings: x".into()).message(Lang::Fr),
            "Entrée invalide : réglages invalides : x"
        );
        assert_eq!(
            AppError::InvalidInput("xyz".into()).message(Lang::En),
            "Invalid input: xyz"
        );
        assert_eq!(
            AppError::InvalidInput("xyz".into()).message(Lang::Fr),
            "Entrée invalide : xyz"
        );
    }
}
