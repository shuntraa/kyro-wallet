//! Automatic updates from Kyro's GitHub releases (SECURITY.md « Mises à jour automatiques »,
//! docs/NETWORK.md, docs/IPC.md `update_status`).
//!
//! **Check** (background, a while after launch, never blocking the UI): `latest.json` of the latest
//! release, through Kyro's own network layer ([`NetClient::server_request`], family `update`, over
//! Tor when Tor is on, never a fallback to clear).

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine as _;
use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::net::{Family, ServerRequest};
use crate::state::AppState;

/// Manifest of the latest (non-pre-)release; GitHub redirects it to the release-asset CDN.
pub const MANIFEST_URL: &str =
    "https://github.com/shuntraa/kyro-wallet/releases/latest/download/latest.json";
/// Packages are downloaded only from this repository's release downloads.
pub const ASSET_PREFIX: &str = "https://github.com/shuntraa/kyro-wallet/releases/download/";
const MANIFEST_MAX: usize = 256 * 1024;
/// Tries to apply one staged update (quit, then starts) before it is discarded.
pub const MAX_ATTEMPTS: u32 = 3;
/// First check after launch (Tor bootstrap, the UI first), then retries on failure.
const FIRST_CHECK: Duration = Duration::from_secs(45);
const RETRY: Duration = Duration::from_secs(15 * 60);
const CHECKS: usize = 3;

fn log(msg: impl std::fmt::Display) {
    eprintln!("[update] {msg}");
}

/// `1.2.3` or `v1.2.3` (release tags).
pub fn parse_version(s: &str) -> Option<Version> {
    Version::parse(s.trim().trim_start_matches('v')).ok()
}

/// Strictly newer (never a downgrade nor a reinstall); a pre-release is only taken by a
/// pre-release build.
pub fn is_newer(candidate: &Version, current: &Version) -> bool {
    candidate > current && (candidate.pre.is_empty() || !current.pre.is_empty())
}

/// Tauri's `latest.json` (written by tauri-action, see docs/RELEASING.md).
#[derive(Debug, Deserialize)]
pub struct Manifest {
    pub version: String,
    #[serde(default)]
    pub platforms: HashMap<String, PlatformEntry>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PlatformEntry {
    /// Base64 of the minisign `.sig` file.
    pub signature: String,
    pub url: String,
}

/// How this copy of Kyro is installed: only these can update themselves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Install {
    /// Windows, NSIS installer (`uninstall.exe` next to the executable). Not MSI.
    Nsis,
    /// macOS, the `.app` bundle.
    MacApp(PathBuf),
    /// Linux, the AppImage file (`$APPIMAGE`). Not .deb / .rpm (the package manager's job).
    AppImage(PathBuf),
}

impl Install {
    fn suffix(&self) -> &'static str {
        match self {
            Install::Nsis => "nsis",
            Install::MacApp(_) => "app",
            Install::AppImage(_) => "appimage",
        }
    }

    /// The package must be of this installation's kind: a generic `linux-x86_64` entry could
    /// point to a (validly signed) `.deb`, `windows-x86_64` to an `.msi`.
    pub fn accepts(&self, file_name: &str) -> bool {
        match self {
            Install::Nsis => file_name.ends_with("-setup.exe"),
            Install::MacApp(_) => file_name.ends_with(".app.tar.gz"),
            Install::AppImage(_) => file_name.ends_with(".AppImage"),
        }
    }
}

fn target_os() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    }
}

fn target_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86" => "i686",
        "arm" => "armv7",
        other => other,
    }
}

/// `latest.json` keys to look up, most specific first (`windows-x86_64-nsis`, `windows-x86_64`).
pub fn platform_keys(os: &str, arch: &str, install: &Install) -> Vec<String> {
    vec![
        format!("{os}-{arch}-{}", install.suffix()),
        format!("{os}-{arch}"),
    ]
}

/// A newer release for this platform, not downloaded yet.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub version: Version,
    pub url: url::Url,
    pub signature: String,
    pub file_name: String,
}

/// Parses `latest.json`: `Ok(None)` when it is not newer than `current`.
pub fn select(
    bytes: &[u8],
    current: &Version,
    keys: &[String],
) -> Result<Option<Candidate>, String> {
    if bytes.len() > MANIFEST_MAX {
        return Err("latest.json too large".into());
    }
    let m: Manifest = serde_json::from_slice(bytes).map_err(|e| format!("latest.json: {e}"))?;
    let version = parse_version(&m.version).ok_or("latest.json: invalid version")?;
    if !is_newer(&version, current) {
        return Ok(None);
    }
    let entry = keys
        .iter()
        .find_map(|k| m.platforms.get(k))
        .ok_or_else(|| format!("latest.json: no entry for {}", keys.join(" / ")))?;
    if !entry.url.starts_with(ASSET_PREFIX) {
        return Err(format!("package URL refused: {}", entry.url));
    }
    let url = url::Url::parse(&entry.url).map_err(|_| "invalid package URL")?;
    let file_name = url
        .path_segments()
        .and_then(|mut s| s.next_back())
        .filter(|n| safe_file_name(n))
        .ok_or("invalid package name")?
        .to_owned();
    Ok(Some(Candidate {
        version,
        url,
        signature: entry.signature.trim().to_owned(),
        file_name,
    }))
}

fn safe_file_name(n: &str) -> bool {
    !n.is_empty()
        && n.len() <= 128
        && !n.starts_with('.')
        && n.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && n != "staged.json"
        && n != "applied.json"
}

/// What the signed trusted comment says (`timestamp:<unix>\tfile:<name>`, Tauri's signer).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Trusted {
    pub timestamp: u64,
    pub file: Option<String>,
}

fn parse_trusted(comment: &str) -> Trusted {
    let mut t = Trusted::default();
    for field in comment.split('\t') {
        if let Some(ts) = field.strip_prefix("timestamp:") {
            t.timestamp = ts.trim().parse().unwrap_or(0);
        } else if let Some(f) = field.strip_prefix("file:") {
            t.file = Some(f.trim().to_owned());
        }
    }
    t
}

fn b64_text(s: &str) -> Result<String, String> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .map_err(|_| "invalid base64")?;
    String::from_utf8(raw).map_err(|_| "invalid text".into())
}

/// Checks the minisign signature of `bytes` (Tauri encoding: base64 of the `.sig` file and of the
/// public key file).
pub fn verify(bytes: &[u8], signature_b64: &str, pubkey_b64: &str) -> Result<Trusted, String> {
    let pk = minisign_verify::PublicKey::decode(&b64_text(pubkey_b64)?)
        .map_err(|e| format!("public key: {e}"))?;
    let sig = minisign_verify::Signature::decode(&b64_text(signature_b64)?)
        .map_err(|e| format!("signature: {e}"))?;
    pk.verify(bytes, &sig, false)
        .map_err(|e| format!("signature refused: {e}"))?;
    Ok(parse_trusted(sig.trusted_comment()))
}

/// The signed data must not contradict the unsigned manifest: a version written in the signed
/// file name (`Kyro_1.2.0_x64-setup.exe`) must be the announced one, and the signature must be
/// newer than the last applied update's (`floor`), so an older signed package cannot be
/// replayed under a newer version number.
pub fn check_binding(t: &Trusted, version: &Version, floor: u64) -> Result<(), String> {
    if t.timestamp == 0 || t.timestamp <= floor {
        return Err("signature older than the installed version".into());
    }
    if let Some(file) = &t.file {
        for token in file.split(['_', '-']) {
            if let Some(v) = parse_version(token) {
                if &v != version {
                    return Err(format!("package signed for {v}, announced {version}"));
                }
            }
        }
    }
    Ok(())
}

fn verify_all(
    bytes: &[u8],
    signature: &str,
    pubkey: &str,
    version: &Version,
    floor: u64,
) -> Result<Trusted, String> {
    let t = verify(bytes, signature, pubkey)?;
    check_binding(&t, version, floor)?;
    Ok(t)
}

/// `staged.json`: a verified package waiting to be applied.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Staged {
    pub version: String,
    pub file: String,
    pub signature: String,
    pub timestamp: u64,
    pub attempts: u32,
}

/// Where the stage lives. [`FsStore`] in the app, an in-memory store in the tests.
pub trait Store {
    fn load(&self) -> Option<Staged>;
    fn save(&self, s: &Staged) -> io::Result<()>;
    fn write_package(&self, name: &str, bytes: &[u8]) -> io::Result<()>;
    fn read_package(&self, name: &str) -> io::Result<Vec<u8>>;
    fn package_path(&self, name: &str) -> PathBuf;
    fn clear(&self);
    fn floor(&self) -> u64;
    fn set_floor(&self, ts: u64);
}

/// What to do with the stage, at a start or at quit.
#[derive(Debug, PartialEq)]
pub enum Step {
    Idle,
    /// This start runs the staged version: show the notice (once).
    Updated(String),
    /// Apply this (re-verified) package now; `attempts` already counted on disk.
    Apply {
        staged: Staged,
        package: Vec<u8>,
    },
}

/// The state machine.
pub fn pending(store: &dyn Store, current: &Version, enabled: bool, pubkey: &str) -> Step {
    let Some(mut s) = store.load() else {
        return Step::Idle;
    };
    let Some(v) = parse_version(&s.version) else {
        store.clear();
        return Step::Idle;
    };
    if *current >= v {
        store.clear();
        if *current == v {
            store.set_floor(s.timestamp);
            return Step::Updated(v.to_string());
        }
        return Step::Idle;
    }
    if !enabled || s.attempts >= MAX_ATTEMPTS {
        if enabled {
            log(format!("{v}: giving up after {} attempts", s.attempts));
        }
        store.clear();
        return Step::Idle;
    }
    let package = match store.read_package(&s.file) {
        Ok(p) => p,
        Err(e) => {
            log(format!("package {v} unreadable: {e}"));
            store.clear();
            return Step::Idle;
        }
    };
    if let Err(e) = verify_all(&package, &s.signature, pubkey, &v, store.floor()) {
        log(format!("package {v} refused: {e}"));
        store.clear();
        return Step::Idle;
    }
    s.attempts += 1;
    if store.save(&s).is_err() {
        store.clear();
        return Step::Idle;
    }
    Step::Apply { staged: s, package }
}

/// Verifies a downloaded package and stages it (package first, then `staged.json`).
pub fn stage(store: &dyn Store, c: &Candidate, bytes: &[u8], pubkey: &str) -> Result<(), String> {
    let t = verify_all(bytes, &c.signature, pubkey, &c.version, store.floor())?;
    store.clear();
    store
        .write_package(&c.file_name, bytes)
        .map_err(|e| format!("writing the package: {e}"))?;
    let s = Staged {
        version: c.version.to_string(),
        file: c.file_name.clone(),
        signature: c.signature.clone(),
        timestamp: t.timestamp,
        attempts: 0,
    };
    store.save(&s).map_err(|e| {
        store.clear();
        format!("writing staged.json: {e}")
    })
}

pub struct FsStore {
    dir: PathBuf,
}

impl FsStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            dir: data_dir.join("update"),
        }
    }

    fn write(&self, name: &str, bytes: &[u8]) -> io::Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        crate::settings::write_atomic(&self.dir.join(name), bytes)
            .map_err(|e| io::Error::other(e.to_string()))
    }
}

impl Store for FsStore {
    fn load(&self) -> Option<Staged> {
        let text = std::fs::read_to_string(self.dir.join("staged.json")).ok()?;
        serde_json::from_str(&text).ok()
    }

    fn save(&self, s: &Staged) -> io::Result<()> {
        self.write("staged.json", &serde_json::to_vec_pretty(s)?)
    }

    fn write_package(&self, name: &str, bytes: &[u8]) -> io::Result<()> {
        self.write(name, bytes)
    }

    fn read_package(&self, name: &str) -> io::Result<Vec<u8>> {
        std::fs::read(self.package_path(name))
    }

    fn package_path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    fn clear(&self) {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return;
        };
        for e in entries.flatten() {
            if e.file_name() != "applied.json" {
                let p = e.path();
                let _ = if p.is_dir() {
                    std::fs::remove_dir_all(&p)
                } else {
                    std::fs::remove_file(&p)
                };
            }
        }
    }

    fn floor(&self) -> u64 {
        std::fs::read_to_string(self.dir.join("applied.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .and_then(|v| v["timestamp"].as_u64())
            .unwrap_or(0)
    }

    fn set_floor(&self, ts: u64) {
        let body = serde_json::json!({ "timestamp": ts }).to_string();
        let _ = self.write("applied.json", body.as_bytes());
    }
}

/// This copy's installation, if it can update itself (never a debug build).
fn detect_install() -> Option<Install> {
    if cfg!(debug_assertions) {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    if cfg!(windows) {
        exe.parent()?
            .join("uninstall.exe")
            .is_file()
            .then_some(Install::Nsis)
    } else if cfg!(target_os = "macos") {
        exe.ancestors()
            .find(|p| p.extension().is_some_and(|e| e == "app"))
            .map(|p| Install::MacApp(p.to_path_buf()))
    } else {
        std::env::var_os("APPIMAGE")
            .map(PathBuf::from)
            .filter(|p| p.is_file())
            .map(Install::AppImage)
    }
}

fn install(how: &Install, package: &Path, at_quit: bool) -> Result<(), String> {
    match how {
        Install::Nsis => {
            let args: &[&str] = if at_quit {
                &["/S", "/UPDATE"]
            } else {
                &["/P", "/R", "/UPDATE"]
            };
            std::process::Command::new(package)
                .args(args)
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("launching the installer: {e}"))
        }
        Install::MacApp(bundle) => replace_bundle(bundle, package),
        Install::AppImage(target) => replace_appimage(target, package),
    }
}

fn replace_bundle(bundle: &Path, archive: &Path) -> Result<(), String> {
    let parent = bundle.parent().ok_or("bundle without a parent folder")?;
    let tmp = parent.join(".kyro-update");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let result = (|| {
        let ok = std::process::Command::new("/usr/bin/tar")
            .arg("-xzf")
            .arg(archive)
            .arg("-C")
            .arg(&tmp)
            .status()
            .map_err(|e| e.to_string())?
            .success();
        if !ok {
            return Err("cannot extract the archive".to_owned());
        }
        let new = std::fs::read_dir(&tmp)
            .map_err(|e| e.to_string())?
            .flatten()
            .map(|e| e.path())
            .find(|p| p.extension().is_some_and(|e| e == "app"))
            .ok_or("no .app in the archive")?;
        let backup = parent.join(".kyro-previous.app");
        let _ = std::fs::remove_dir_all(&backup);
        std::fs::rename(bundle, &backup).map_err(|e| e.to_string())?;
        if let Err(e) = std::fs::rename(&new, bundle) {
            let _ = std::fs::rename(&backup, bundle);
            return Err(e.to_string());
        }
        let _ = std::fs::remove_dir_all(&backup);
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

fn replace_appimage(target: &Path, package: &Path) -> Result<(), String> {
    let name = target.file_name().ok_or("AppImage without a name")?;
    let tmp = target.with_file_name(format!(".{}.new", name.to_string_lossy()));
    std::fs::copy(package, &tmp).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

fn pubkey(app: &tauri::AppHandle) -> Option<String> {
    app.config()
        .plugins
        .0
        .get("updater")?
        .get("pubkey")?
        .as_str()
        .map(str::to_owned)
        .filter(|k| !k.trim().is_empty())
}

fn current_version(app: &tauri::AppHandle) -> Option<Version> {
    parse_version(&app.package_info().version.to_string())
}

/// Managed state: the version this start was updated to, shown once by the UI.
#[derive(Default)]
pub struct UpdaterState {
    updated_to: Mutex<Option<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub version: String,
    /// `Some(version)` once, on the first call after a start that applied an update.
    pub updated_to: Option<String>,
}

#[tauri::command]
pub fn update_status(app: tauri::AppHandle, state: tauri::State<'_, UpdaterState>) -> UpdateStatus {
    UpdateStatus {
        version: app.package_info().version.to_string(),
        updated_to: crate::net::lock(&state.updated_to).take(),
    }
}

fn context(app: &tauri::AppHandle) -> Option<(FsStore, Version, bool, String)> {
    let st = app.state::<AppState>();
    let store = FsStore::new(&st.data_dir());
    let enabled = st.settings().auto_update;
    Some((store, current_version(app)?, enabled, pubkey(app)?))
}

/// At start, before the window: notice of an applied update, or a staged one not applied at quit
/// (applied now, then the app restarts).
pub fn on_start(app: &tauri::AppHandle) {
    app.manage(UpdaterState::default());
    let Some((store, current, enabled, key)) = context(app) else {
        return;
    };
    match pending(&store, &current, enabled, &key) {
        Step::Idle => {}
        Step::Updated(v) => {
            log(format!("update {v} applied"));
            *crate::net::lock(&app.state::<UpdaterState>().updated_to) = Some(v);
        }
        Step::Apply { staged, .. } => {
            if let Some(how) = detect_install() {
                match install(&how, &store.package_path(&staged.file), false) {
                    Ok(()) if how == Install::Nsis => std::process::exit(0),
                    Ok(()) => app.restart(),
                    Err(e) => log(format!("installing {}: {e}", staged.version)),
                }
            }
        }
    }
    if enabled && detect_install().is_some() {
        spawn_checks(app.clone());
    }
}

/// When the app quits: applies a staged update silently.
pub fn on_exit(app: &tauri::AppHandle) {
    let Some((store, current, enabled, key)) = context(app) else {
        return;
    };
    let Some(how) = detect_install() else {
        return;
    };
    if let Step::Apply { staged, .. } = pending(&store, &current, enabled, &key) {
        if let Err(e) = install(&how, &store.package_path(&staged.file), true) {
            log(format!("installing {}: {e}", staged.version));
        }
    }
}

fn spawn_checks(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        for i in 0..CHECKS {
            match check(&app).await {
                Ok(()) => return,
                Err(e) => log(format!("check {}: {e}", i + 1)),
            }
            tokio::time::sleep(RETRY).await;
        }
    });
}

async fn get(app: &tauri::AppHandle, url: url::Url) -> Result<Vec<u8>, String> {
    let st = app.state::<AppState>();
    let tor = st.settings().tor.enabled;
    let net = st.net.clone();
    let (status, bytes) = net
        .server_request(ServerRequest::get(url, Family::Update), tor)
        .await
        .map_err(|e| e.to_string())?;
    if status != 200 {
        return Err(format!("HTTP {status}"));
    }
    Ok(bytes)
}

async fn check(app: &tauri::AppHandle) -> Result<(), String> {
    let (store, current, enabled, key) = context(app).ok_or("updates unavailable")?;
    let how = detect_install().ok_or("unsupported installation")?;
    if !enabled {
        return Ok(());
    }
    let manifest_url = url::Url::parse(MANIFEST_URL).map_err(|e| e.to_string())?;
    let manifest = get(app, manifest_url).await?;
    let keys = platform_keys(target_os(), target_arch(), &how);
    let Some(c) = select(&manifest, &current, &keys)? else {
        return Ok(());
    };
    if !how.accepts(&c.file_name) {
        return Err(format!("package of another type: {}", c.file_name));
    }
    if store
        .load()
        .is_some_and(|s| s.version == c.version.to_string())
    {
        return Ok(());
    }
    let bytes = get(app, c.url.clone()).await?;
    if !app.state::<AppState>().settings().auto_update {
        return Ok(());
    }
    stage(&store, &c, &bytes, &key)?;
    log(format!("{} ready, applied on exit", c.version));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use blake2::Digest as _;
    use ed25519_dalek::Signer as _;
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    fn v(s: &str) -> Version {
        parse_version(s).unwrap()
    }

    #[test]
    fn version_ordering_refuses_downgrades() {
        assert!(is_newer(&v("0.2.0"), &v("0.1.0")));
        assert!(is_newer(&v("v0.10.0"), &v("0.9.9")), "semver, not text");
        assert!(is_newer(&v("1.0.0"), &v("1.0.0-beta.2")));
        assert!(!is_newer(&v("0.1.0"), &v("0.1.0")), "no reinstall");
        assert!(!is_newer(&v("0.0.9"), &v("0.1.0")), "no downgrade");
        assert!(
            !is_newer(&v("0.2.0-rc.1"), &v("0.1.0")),
            "no pre-release on stable"
        );
        assert!(is_newer(&v("0.2.0-rc.2"), &v("0.2.0-rc.1")));
        assert!(parse_version("latest").is_none());
    }

    fn keys() -> Vec<String> {
        platform_keys("windows", "x86_64", &Install::Nsis)
    }

    fn manifest(version: &str, url: &str) -> Vec<u8> {
        serde_json::json!({
            "version": version,
            "notes": "",
            "pub_date": "2026-11-01T00:00:00Z",
            "platforms": {
                "windows-x86_64-nsis": { "signature": "c2ln", "url": url },
                "linux-x86_64": { "signature": "x", "url": "https://example.com/a" },
            }
        })
        .to_string()
        .into_bytes()
    }

    #[test]
    fn manifest_parsing() {
        let url = format!("{ASSET_PREFIX}v0.2.0/Kyro_0.2.0_x64-setup.exe");
        let c = select(&manifest("v0.2.0", &url), &v("0.1.0"), &keys())
            .unwrap()
            .unwrap();
        assert_eq!(c.version, v("0.2.0"));
        assert_eq!(c.file_name, "Kyro_0.2.0_x64-setup.exe");
        assert_eq!(c.signature, "c2ln");
        assert_eq!(
            platform_keys("darwin", "aarch64", &Install::MacApp("/A/Kyro.app".into())),
            ["darwin-aarch64-app", "darwin-aarch64"]
        );
        assert_eq!(
            select(&manifest("0.1.0", &url), &v("0.1.0"), &keys()),
            Ok(None)
        );
        assert_eq!(
            select(&manifest("0.0.5", &url), &v("0.1.0"), &keys()),
            Ok(None)
        );
        for bad in [
            "https://example.com/Kyro.exe",
            "https://github.com/someone/else/releases/download/v1/Kyro.exe",
            "http://github.com/shuntraa/kyro-wallet/releases/download/v1/Kyro.exe",
        ] {
            assert!(
                select(&manifest("0.2.0", bad), &v("0.1.0"), &keys()).is_err(),
                "{bad}"
            );
        }
        let traversal = format!("{ASSET_PREFIX}v0.2.0/..%2F..%2Fevil.exe");
        assert!(select(&manifest("0.2.0", &traversal), &v("0.1.0"), &keys()).is_err());
        let mac = platform_keys("darwin", "aarch64", &Install::MacApp("/A/Kyro.app".into()));
        assert!(select(&manifest("0.2.0", &url), &v("0.1.0"), &mac).is_err());
        assert!(select(b"{not json", &v("0.1.0"), &keys()).is_err());
        assert!(select(&manifest("two", &url), &v("0.1.0"), &keys()).is_err());
        assert!(select(&vec![b' '; MANIFEST_MAX + 1], &v("0.1.0"), &keys()).is_err());
        // Package kind must match the installation.
        assert!(Install::Nsis.accepts("Kyro_0.2.0_x64-setup.exe"));
        assert!(!Install::Nsis.accepts("Kyro_0.2.0_x64_en-US.msi"));
        let appimage = Install::AppImage("/opt/Kyro.AppImage".into());
        assert!(appimage.accepts("Kyro_0.2.0_amd64.AppImage"));
        assert!(!appimage.accepts("Kyro_0.2.0_amd64.deb"));
        assert!(Install::MacApp("/A/Kyro.app".into()).accepts("Kyro_aarch64.app.tar.gz"));
        assert!(!Install::MacApp("/A/Kyro.app".into()).accepts("Kyro_0.2.0_aarch64.dmg"));
    }

    struct TestKey {
        sk: ed25519_dalek::SigningKey,
        id: [u8; 8],
    }

    impl TestKey {
        fn new() -> Self {
            let mut seed = [0u8; 32];
            let mut id = [0u8; 8];
            getrandom::getrandom(&mut seed).unwrap();
            getrandom::getrandom(&mut id).unwrap();
            Self {
                sk: ed25519_dalek::SigningKey::from_bytes(&seed),
                id,
            }
        }

        fn b64(bytes: &[u8]) -> String {
            base64::engine::general_purpose::STANDARD.encode(bytes)
        }

        fn pubkey(&self) -> String {
            let mut bin = b"Ed".to_vec();
            bin.extend_from_slice(&self.id);
            bin.extend_from_slice(self.sk.verifying_key().as_bytes());
            let text = format!(
                "untrusted comment: minisign public key\n{}\n",
                Self::b64(&bin)
            );
            Self::b64(text.as_bytes())
        }

        fn sign(&self, data: &[u8], trusted: &str) -> String {
            let hash = blake2::Blake2b512::digest(data);
            let sig = self.sk.sign(&hash).to_bytes();
            let mut bin = b"ED".to_vec();
            bin.extend_from_slice(&self.id);
            bin.extend_from_slice(&sig);
            let mut global = sig.to_vec();
            global.extend_from_slice(trusted.as_bytes());
            let gsig = self.sk.sign(&global).to_bytes();
            let text = format!(
                "untrusted comment: signature from tauri secret key\n{}\ntrusted comment: {trusted}\n{}\n",
                Self::b64(&bin),
                Self::b64(&gsig)
            );
            Self::b64(text.as_bytes())
        }
    }

    const TRUSTED: &str = "timestamp:1793000000\tfile:Kyro_0.2.0_x64-setup.exe";

    #[test]
    fn signature_verification() {
        let key = TestKey::new();
        let data = b"Kyro 0.2.0 installer bytes";
        let sig = key.sign(data, TRUSTED);
        let t = verify(data, &sig, &key.pubkey()).unwrap();
        assert_eq!(t.timestamp, 1_793_000_000);
        assert_eq!(t.file.as_deref(), Some("Kyro_0.2.0_x64-setup.exe"));
        assert!(verify(b"Kyro 0.2.0 installer bytez", &sig, &key.pubkey()).is_err());
        assert!(verify(data, &sig, &TestKey::new().pubkey()).is_err());
        assert!(verify(data, "not base64!", &key.pubkey()).is_err());
        assert!(verify(data, &sig, "").is_err());
        let text = b64_text(&sig).unwrap().replace("1793000000", "1999999999");
        assert!(verify(data, &TestKey::b64(text.as_bytes()), &key.pubkey()).is_err());
    }

    /// The key pinned in tauri.conf.json verifies a file signed by `pnpm tauri signer sign`
    /// with the real private key (format of the release pipeline, prehashed).
    #[test]
    fn pinned_key_verifies_a_real_tauri_signature() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let pk = conf["plugins"]["updater"]["pubkey"].as_str().unwrap();
        assert_eq!(conf["bundle"]["createUpdaterArtifacts"], true);
        let data = include_bytes!("testdata/updater_fixture_Kyro_0.1.1_x64-setup.bin");
        let sig = include_str!("testdata/updater_fixture_Kyro_0.1.1_x64-setup.bin.sig");
        let t = verify(data, sig, pk).unwrap();
        assert!(check_binding(&t, &v("0.1.1"), 0).is_ok());
        assert!(check_binding(&t, &v("0.2.0"), 0).is_err());
        assert!(verify(b"other bytes", sig, pk).is_err());
        assert!(verify(data, sig, &TestKey::new().pubkey()).is_err());
    }

    #[test]
    fn signature_must_match_the_announced_version() {
        let t = |file: &str, ts| Trusted {
            timestamp: ts,
            file: Some(file.into()),
        };
        assert!(check_binding(&t("Kyro_0.2.0_x64-setup.exe", 10), &v("0.2.0"), 0).is_ok());
        assert!(check_binding(&t("Kyro_0.2.0_amd64.AppImage", 10), &v("0.2.0"), 0).is_ok());
        assert!(check_binding(&t("Kyro.app.tar.gz", 10), &v("0.2.0"), 0).is_ok());
        assert!(check_binding(&t("Kyro_0.1.0_x64-setup.exe", 10), &v("0.2.0"), 0).is_err());
        assert!(check_binding(&t("Kyro.app.tar.gz", 10), &v("0.2.0"), 10).is_err());
        assert!(check_binding(&Trusted::default(), &v("0.2.0"), 0).is_err());
    }

    #[derive(Default)]
    struct MemStore {
        staged: RefCell<Option<Staged>>,
        files: RefCell<BTreeMap<String, Vec<u8>>>,
        floor: RefCell<u64>,
        fail_writes: bool,
    }

    impl Store for MemStore {
        fn load(&self) -> Option<Staged> {
            self.staged.borrow().clone()
        }
        fn save(&self, s: &Staged) -> io::Result<()> {
            if self.fail_writes {
                return Err(io::Error::other("disk full"));
            }
            *self.staged.borrow_mut() = Some(s.clone());
            Ok(())
        }
        fn write_package(&self, name: &str, bytes: &[u8]) -> io::Result<()> {
            if self.fail_writes {
                return Err(io::Error::other("disk full"));
            }
            self.files.borrow_mut().insert(name.into(), bytes.into());
            Ok(())
        }
        fn read_package(&self, name: &str) -> io::Result<Vec<u8>> {
            self.files
                .borrow()
                .get(name)
                .cloned()
                .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))
        }
        fn package_path(&self, name: &str) -> PathBuf {
            PathBuf::from(name)
        }
        fn clear(&self) {
            *self.staged.borrow_mut() = None;
            self.files.borrow_mut().clear();
        }
        fn floor(&self) -> u64 {
            *self.floor.borrow()
        }
        fn set_floor(&self, ts: u64) {
            *self.floor.borrow_mut() = ts;
        }
    }

    fn candidate(key: &TestKey, data: &[u8]) -> Candidate {
        Candidate {
            version: v("0.2.0"),
            url: url::Url::parse(&format!("{ASSET_PREFIX}v0.2.0/Kyro_0.2.0_x64-setup.exe"))
                .unwrap(),
            signature: key.sign(data, TRUSTED),
            file_name: "Kyro_0.2.0_x64-setup.exe".into(),
        }
    }

    #[test]
    fn staged_update_is_applied_at_next_start_then_noticed() {
        let key = TestKey::new();
        let pk = key.pubkey();
        let data = b"installer";
        let store = MemStore::default();
        assert_eq!(pending(&store, &v("0.1.0"), true, &pk), Step::Idle);

        stage(&store, &candidate(&key, data), data, &pk).unwrap();
        assert_eq!(store.load().unwrap().attempts, 0);
        match pending(&store, &v("0.1.0"), true, &pk) {
            Step::Apply { staged, package } => {
                assert_eq!((staged.version.as_str(), staged.attempts), ("0.2.0", 1));
                assert_eq!(package, data);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(
            pending(&store, &v("0.2.0"), true, &pk),
            Step::Updated("0.2.0".into())
        );
        assert!(store.load().is_none() && store.files.borrow().is_empty());
        assert_eq!(store.floor(), 1_793_000_000);
        assert_eq!(pending(&store, &v("0.2.0"), true, &pk), Step::Idle);
        assert!(stage(&store, &candidate(&key, data), data, &pk).is_err());
    }

    #[test]
    fn stage_state_machine_failures() {
        let key = TestKey::new();
        let pk = key.pubkey();
        let data = b"installer";

        let store = MemStore::default();
        let mut bad = candidate(&key, data);
        bad.signature = TestKey::new().sign(data, TRUSTED);
        assert!(stage(&store, &bad, data, &pk).is_err());
        assert!(store.load().is_none() && store.files.borrow().is_empty());

        let full = MemStore {
            fail_writes: true,
            ..MemStore::default()
        };
        assert!(stage(&full, &candidate(&key, data), data, &pk).is_err());
        assert!(full.load().is_none());

        // Tried too often: discarded, never retried.
        stage(&store, &candidate(&key, data), data, &pk).unwrap();
        for _ in 0..MAX_ATTEMPTS {
            assert!(matches!(
                pending(&store, &v("0.1.0"), true, &pk),
                Step::Apply { .. }
            ));
        }
        assert_eq!(pending(&store, &v("0.1.0"), true, &pk), Step::Idle);
        assert!(store.load().is_none());

        stage(&store, &candidate(&key, data), data, &pk).unwrap();
        store
            .files
            .borrow_mut()
            .insert("Kyro_0.2.0_x64-setup.exe".into(), b"evil".to_vec());
        assert_eq!(pending(&store, &v("0.1.0"), true, &pk), Step::Idle);
        assert!(store.load().is_none());

        stage(&store, &candidate(&key, data), data, &pk).unwrap();
        store.files.borrow_mut().clear();
        assert_eq!(pending(&store, &v("0.1.0"), true, &pk), Step::Idle);
        stage(&store, &candidate(&key, data), data, &pk).unwrap();
        assert_eq!(pending(&store, &v("0.1.0"), false, &pk), Step::Idle);
        assert!(store.load().is_none());
        stage(&store, &candidate(&key, data), data, &pk).unwrap();
        store.staged.borrow_mut().as_mut().unwrap().version = "x".into();
        assert_eq!(pending(&store, &v("0.1.0"), true, &pk), Step::Idle);

        stage(&store, &candidate(&key, data), data, &pk).unwrap();
        assert_eq!(pending(&store, &v("0.3.0"), true, &pk), Step::Idle);
        assert!(store.load().is_none());
    }

    #[test]
    fn fs_store_keeps_the_floor_when_clearing() {
        let dir = std::env::temp_dir().join(format!("kyro-maj-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = FsStore::new(&dir);
        assert!(store.load().is_none());
        assert_eq!(store.floor(), 0);
        store.write_package("Kyro.app.tar.gz", b"pkg").unwrap();
        let s = Staged {
            version: "0.2.0".into(),
            file: "Kyro.app.tar.gz".into(),
            signature: "s".into(),
            timestamp: 7,
            attempts: 0,
        };
        store.save(&s).unwrap();
        store.set_floor(5);
        assert_eq!(store.load(), Some(s));
        assert_eq!(store.read_package("Kyro.app.tar.gz").unwrap(), b"pkg");
        store.clear();
        assert!(store.load().is_none());
        assert!(store.read_package("Kyro.app.tar.gz").is_err());
        assert_eq!(store.floor(), 5);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn webview_cannot_reach_update_hosts() {
        use crate::net::{prepare, EnvKeys, FetchRequest, NetContext, ALLOWED_HOSTS, UPDATE_HOSTS};
        for h in UPDATE_HOSTS {
            assert!(ALLOWED_HOSTS.contains(h), "{h}: redirects must be followed");
            assert_eq!(
                crate::net::family_for(h, &NetContext::default()),
                Family::Update
            );
            let req = FetchRequest {
                url: format!(
                    "https://{h}/shuntraa/kyro-wallet/releases/latest/download/latest.json"
                ),
                method: "GET".into(),
                headers: Default::default(),
                body: None,
            };
            let r = prepare(
                req,
                &NetContext::default(),
                &EnvKeys::default(),
                &Default::default(),
            );
            assert!(
                matches!(r, Err(crate::error::AppError::HostNotAllowed(_))),
                "{h}"
            );
        }
        assert!(MANIFEST_URL.starts_with("https://github.com/"));
        assert!(ASSET_PREFIX.starts_with("https://github.com/shuntraa/kyro-wallet/"));
    }
}
