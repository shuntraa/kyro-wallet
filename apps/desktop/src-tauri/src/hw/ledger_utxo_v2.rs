//! Litecoin on the current Ledger "Litecoin" app, built on the Bitcoin app v2 code base: it
//! speaks the v2 protocol (CLA `E1`: GET MASTER FINGERPRINT `05`, GET EXTENDED PUBKEY `00`,
//! GET WALLET ADDRESS `03`, SIGN PSBT `04` with the default policy `wpkh(@0/**)`), not the legacy
//! CLA `E0` commands of [`super::ledger_utxo`] (it answers them `6F00` / `6E00` / `6D00`).
//!
//! Which protocol an app speaks is decided by its version: 2.1 and later are v2 apps, older ones
//! the legacy app. Every v2 command uses exactly the Bitcoin app's framing (that of
//! `ledger_bitcoin_client`, P2 = protocol version `01`): Litecoin 2.4.11 does not answer the
//! P2 = `00` form, which sent Kyro down the legacy path. Kyro's own summary and the device screen
//! still show every output; the device signs only after the user confirms there.

use bitcoin::bip32::{DerivationPath, Fingerprint, Xpub};
use ledger_bitcoin_client::apdu::{APDUCommand, StatusWord, CURRENT_PROTOCOL_VERSION};
use ledger_bitcoin_client::error::BitcoinClientError;
use ledger_bitcoin_client::wallet::{Version, WalletPubKey};
use ledger_bitcoin_client::{BitcoinClient, WalletPolicy};
use wallet_core::{HwBtcSignature, UtxoAccount, UtxoCoin};

use super::ledger::ApduLink;
use super::ledger_apdu::{self as apdu, SwContext, SW_OK};
use super::{Ctl, HwError, HwResult};

const CLA: u8 = 0xE1;
const INS_GET_EXTENDED_PUBKEY: u8 = 0x00;
const INS_GET_WALLET_ADDRESS: u8 = 0x03;
const INS_SIGN_PSBT: u8 = 0x04;
const INS_GET_MASTER_FINGERPRINT: u8 = 0x05;
/// P2 of every v2 command: the client protocol version (as `ledger_bitcoin_client` sends it).
const P2: u8 = CURRENT_PROTOCOL_VERSION;
/// First Litecoin app version on the Bitcoin app v2 code base.
pub const MIN_V2: &str = "2.1.0";
/// BIP32 version bytes of a mainnet `xpub` (Kyro stores Litecoin account keys as `xpub…`).
const XPUB_MAIN: [u8; 4] = [0x04, 0x88, 0xB2, 0x1E];

/// Shown when the open coin app does not understand Kyro's commands.
pub fn outdated(coin: UtxoCoin) -> HwError {
    HwError::unsupported(format!(
        "The {} app on your Ledger is outdated or not compatible. Update it in Ledger Live.",
        coin.name()
    ))
}

/// Whether `sw` means "this app does not speak that protocol".
pub fn is_protocol_mismatch(sw: u16) -> bool {
    sw == 0x6F00 || apdu::is_wrong_app(sw)
}

/// Coins whose current Ledger app may be a v2 (Bitcoin app code base) app. Dogecoin, Bitcoin
/// Cash and Dash stay on the legacy protocol.
pub fn may_be_v2(coin: UtxoCoin) -> bool {
    coin == UtxoCoin::Litecoin
}

/// Whether the app of `coin` at `version` speaks the v2 protocol.
pub fn is_v2(coin: UtxoCoin, version: &str) -> bool {
    may_be_v2(coin) && super::version_at_least(version, MIN_V2)
}

/// GET MASTER FINGERPRINT.
pub fn master_fingerprint_apdu() -> HwResult<Vec<u8>> {
    apdu::apdu(CLA, INS_GET_MASTER_FINGERPRINT, 0, P2, &[])
}

/// GET EXTENDED PUBKEY of `path` (`display`: show it on the device).
pub fn extended_pubkey_apdu(path: &[u32], display: bool) -> HwResult<Vec<u8>> {
    let len = u8::try_from(path.len()).map_err(|_| HwError::bad("derivation path too long"))?;
    let mut data = vec![u8::from(display), len];
    for i in path {
        data.extend_from_slice(&i.to_be_bytes());
    }
    apdu::apdu(CLA, INS_GET_EXTENDED_PUBKEY, 0, P2, &data)
}

/// Probes the open app: `Some(master fingerprint)` for a v2 app (version ≥ [`MIN_V2`]), `None`
/// for a legacy one (no v2 APDU sent). A v2 app refusing the fingerprint is an error, never a
/// silent fall back to the legacy protocol.
pub fn probe(
    link: &dyn ApduLink,
    ctl: &Ctl,
    app: &str,
    coin: UtxoCoin,
) -> HwResult<Option<[u8; 4]>> {
    if !may_be_v2(coin) {
        return Ok(None);
    }
    let (_, version) = super::chains::ledger_open_app(link, ctl)?;
    if !is_v2(coin, &version) {
        return Ok(None);
    }
    let (data, sw) = link.exchange(ctl, &master_fingerprint_apdu()?)?;
    match sw {
        SW_OK => {
            let fp = data
                .get(..4)
                .and_then(|s| <[u8; 4]>::try_from(s).ok())
                .ok_or_else(|| HwError::bad("malformed master fingerprint"))?;
            Ok(Some(fp))
        }
        sw if is_protocol_mismatch(sw) => Err(outdated(coin)),
        sw => Err(super::chains::ledger_sw_error(
            link,
            ctl,
            sw,
            SwContext::General,
            app,
        )),
    }
}

/// Parses a GET EXTENDED PUBKEY answer (base58check, any coin's BIP32 version bytes); returns
/// the key as a mainnet `xpub` and the version bytes the app used.
pub fn parse_xpub(resp: &[u8]) -> HwResult<(Xpub, [u8; 4])> {
    let s = std::str::from_utf8(resp).map_err(|_| HwError::bad("malformed extended key"))?;
    let mut raw = bitcoin::base58::decode_check(s.trim_end_matches('\0'))
        .map_err(|_| HwError::bad("malformed extended key"))?;
    if raw.len() != 78 {
        return Err(HwError::bad("malformed extended key"));
    }
    let mut version = [0u8; 4];
    version.copy_from_slice(&raw[..4]);
    raw[..4].copy_from_slice(&XPUB_MAIN);
    let xpub = Xpub::decode(&raw).map_err(|_| HwError::bad("malformed extended key"))?;
    Ok((xpub, version))
}

fn call(
    link: &dyn ApduLink,
    ctl: &Ctl,
    app: &str,
    cmd: &[u8],
    ctx: SwContext,
) -> HwResult<Vec<u8>> {
    super::chains::ledger_call(link, ctl, cmd, ctx, app)
}

/// Account key of `path` (`m/84'/2'/a'`) with the master fingerprint `fp` from [`probe`].
pub fn account(
    link: &dyn ApduLink,
    ctl: &Ctl,
    app: &str,
    coin: UtxoCoin,
    fp: [u8; 4],
    path: &[u32],
) -> HwResult<UtxoAccount> {
    let resp = call(
        link,
        ctl,
        app,
        &extended_pubkey_apdu(path, false)?,
        SwContext::General,
    )?;
    let (xpub, _) = parse_xpub(&resp)?;
    let child = path.last().map(|c| bitcoin::bip32::ChildNumber::from(*c));
    if usize::from(xpub.depth) != path.len() || child != Some(xpub.child_number) {
        return Err(HwError::bad("extended key of another path"));
    }
    Ok(UtxoAccount {
        coin,
        xpub: xpub.to_string(),
        fingerprint: hex::encode(fp),
        path: super::path_string(path),
    })
}

struct LinkTransport<'a> {
    link: &'a dyn ApduLink,
    ctl: &'a Ctl,
    app: &'a str,
}

impl ledger_bitcoin_client::Transport for LinkTransport<'_> {
    type Error = HwError;

    fn exchange(&self, cmd: &APDUCommand) -> Result<(StatusWord, Vec<u8>), HwError> {
        let bytes = apdu::apdu(cmd.cla, cmd.ins, cmd.p1, cmd.p2, &cmd.data)?;
        let (data, sw) = self.link.exchange(self.ctl, &bytes)?;
        match sw {
            SW_OK => Ok((StatusWord::OK, data)),
            0xE000 => Ok((StatusWord::InterruptedExecution, data)),
            other => {
                let ctx = if matches!(cmd.ins, INS_GET_WALLET_ADDRESS | INS_SIGN_PSBT) {
                    SwContext::Signing
                } else {
                    SwContext::General
                };
                Err(super::chains::ledger_sw_error(
                    self.link, self.ctl, other, ctx, self.app,
                ))
            }
        }
    }
}

fn client<'a>(
    link: &'a dyn ApduLink,
    ctl: &'a Ctl,
    app: &'a str,
) -> BitcoinClient<LinkTransport<'a>> {
    BitcoinClient::new(LinkTransport { link, ctl, app })
}

fn client_err(e: BitcoinClientError<HwError>) -> HwError {
    match e {
        BitcoinClientError::Transport(e) => e,
        other => HwError::bad(format!("Litecoin app: {other:?}")),
    }
}

/// Default policy `wpkh(@0/**)` of the stored account, after checking that the device holds the
/// same account key and uses `xpub` version bytes (what the policy serializes).
fn policy(link: &dyn ApduLink, ctl: &Ctl, app: &str, acc: &UtxoAccount) -> HwResult<WalletPolicy> {
    use std::str::FromStr;
    let xpub = Xpub::from_str(&acc.xpub).map_err(|_| HwError::bad("invalid saved xpub"))?;
    let fp = Fingerprint::from_str(&acc.fingerprint)
        .map_err(|_| HwError::bad("invalid saved fingerprint"))?;
    let path =
        DerivationPath::from_str(&acc.path).map_err(|_| HwError::bad("invalid saved path"))?;
    let raw: Vec<u32> = path.as_ref().iter().map(|c| u32::from(*c)).collect();
    let resp = call(
        link,
        ctl,
        app,
        &extended_pubkey_apdu(&raw, false)?,
        SwContext::General,
    )?;
    let (live, version) = parse_xpub(&resp)?;
    if live != xpub {
        return Err(HwError::bad(
            "this Ledger does not hold the saved Litecoin account",
        ));
    }
    if version != XPUB_MAIN {
        return Err(HwError::unsupported(
            "this Litecoin app version uses a key format Kyro does not support yet",
        ));
    }
    Ok(WalletPolicy::new(
        String::new(),
        Version::V2,
        "wpkh(@0/**)".into(),
        vec![WalletPubKey::from(((fp, path), xpub))],
    ))
}

/// Shows `…/change/index` of the stored account on the device; returns the device's address.
pub fn display_address(
    link: &dyn ApduLink,
    ctl: &Ctl,
    app: &str,
    acc: &UtxoAccount,
    change: bool,
    index: u32,
) -> HwResult<String> {
    let policy = policy(link, ctl, app, acc)?;
    ctl.prompt(super::Prompt::ConfirmOnDevice);
    match client(link, ctl, app).get_wallet_address(&policy, None, change, index, true) {
        Ok(a) => Ok(a.assume_checked().to_string()),
        // `ltc1…` is not a Bitcoin address: the client returns the device's raw answer.
        Err(BitcoinClientError::UnexpectedResult { command, data })
            if command == INS_GET_WALLET_ADDRESS =>
        {
            String::from_utf8(data).map_err(|_| HwError::bad("malformed address"))
        }
        Err(e) => Err(client_err(e)),
    }
}

/// SIGN PSBT with the default policy of the stored account.
pub fn sign(
    link: &dyn ApduLink,
    ctl: &Ctl,
    app: &str,
    acc: &UtxoAccount,
    psbt: &bitcoin::psbt::Psbt,
) -> HwResult<Vec<HwBtcSignature>> {
    let policy = policy(link, ctl, app, acc)?;
    ctl.prompt(super::Prompt::ConfirmOnDevice);
    let yielded = client(link, ctl, app)
        .sign_psbt(psbt, &policy, None)
        .map_err(client_err)?;
    super::ledger::yielded_signatures(yielded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::Duration;

    type Exchange = (Vec<u8>, Vec<u8>, u16);

    struct Replay(Mutex<Vec<Exchange>>);

    impl ApduLink for Replay {
        fn exchange(&self, _ctl: &Ctl, apdu: &[u8]) -> HwResult<(Vec<u8>, u16)> {
            let (cmd, data, sw) = super::super::lock(&self.0).remove(0);
            assert_eq!(hex::encode(apdu), hex::encode(cmd));
            Ok((data, sw))
        }
    }

    fn ctl() -> Ctl {
        Ctl::for_tests(Duration::from_secs(5))
    }

    fn ltc_xpub_string(version: [u8; 4]) -> (String, Xpub) {
        use bitcoin::secp256k1::Secp256k1;
        let master =
            bitcoin::bip32::Xpriv::new_master(bitcoin::NetworkKind::Main, &[7u8; 32]).unwrap();
        let path = DerivationPath::from_str("m/84'/2'/0'").unwrap();
        let x = Xpub::from_priv(
            &Secp256k1::new(),
            &master.derive_priv(&Secp256k1::new(), &path).unwrap(),
        );
        let mut raw = x.encode().to_vec();
        raw[..4].copy_from_slice(&version);
        (bitcoin::base58::encode_check(&raw), x)
    }
    use std::str::FromStr;

    fn app(version: &str) -> Exchange {
        let mut r = vec![1, 8];
        r.extend(b"Litecoin");
        r.push(version.len() as u8);
        r.extend(version.as_bytes());
        (apdu::get_app_and_version(), r, SW_OK)
    }

    fn probe_with(steps: Vec<Exchange>, coin: UtxoCoin) -> HwResult<Option<[u8; 4]>> {
        let link = Replay(Mutex::new(steps));
        let r = probe(&link, &ctl(), "Litecoin", coin);
        assert!(super::super::lock(&link.0).is_empty(), "unused exchanges");
        r
    }

    #[test]
    fn probe_decides_the_protocol_by_version() {
        let fp_cmd = master_fingerprint_apdu().unwrap();
        // Same framing as the Bitcoin app client: P2 = protocol version 01.
        assert_eq!(hex::encode(&fp_cmd), "e105000100");
        // Litecoin 2.4.11 (the real device): v2.
        let v2 = vec![app("2.4.11"), (fp_cmd.clone(), vec![1, 2, 3, 4], SW_OK)];
        assert_eq!(
            probe_with(v2, UtxoCoin::Litecoin).unwrap(),
            Some([1, 2, 3, 4])
        );
        // Before 2.1: legacy app, no v2 APDU at all.
        for v in ["1.4.0", "2.0.6"] {
            assert_eq!(probe_with(vec![app(v)], UtxoCoin::Litecoin).unwrap(), None);
        }
        // A v2 app refusing the fingerprint is an error, never the legacy path.
        for sw in [0x6F00, 0x6E00, 0x6D00] {
            let steps = vec![app("2.4.11"), (fp_cmd.clone(), vec![], sw)];
            assert!(matches!(
                probe_with(steps, UtxoCoin::Litecoin),
                Err(HwError::Unsupported { .. })
            ));
        }
        // Dogecoin is never probed (no APDU at all).
        assert_eq!(probe_with(vec![], UtxoCoin::Dogecoin).unwrap(), None);
        let locked = vec![app("2.4.11"), (fp_cmd, vec![], 0x5515)];
        assert!(matches!(
            probe_with(locked, UtxoCoin::Litecoin),
            Err(HwError::Locked)
        ));
    }

    #[test]
    fn account_over_v2_with_any_version_bytes() {
        let path = [84 | super::super::H, 2 | super::super::H, super::super::H];
        let cmd = extended_pubkey_apdu(&path, false).unwrap();
        assert_eq!(hex::encode(&cmd), "e10000010e0003800000548000000280000000");
        // Ltub (019DA462) and xpub answers give the same stored xpub.
        for version in [[0x01, 0x9D, 0xA4, 0x62], XPUB_MAIN] {
            let (s, x) = ltc_xpub_string(version);
            let link = Replay(Mutex::new(vec![(cmd.clone(), s.into_bytes(), SW_OK)]));
            let acc = account(
                &link,
                &ctl(),
                "Litecoin",
                UtxoCoin::Litecoin,
                [9, 9, 9, 9],
                &path,
            )
            .unwrap();
            assert_eq!(acc.xpub, x.to_string());
            assert_eq!(acc.fingerprint, "09090909");
            assert_eq!(acc.path, "m/84'/2'/0'");
        }
        // A key of another depth is refused.
        let (s, _) = ltc_xpub_string(XPUB_MAIN);
        let link = Replay(Mutex::new(vec![(
            extended_pubkey_apdu(&path[..2], false).unwrap(),
            s.into_bytes(),
            SW_OK,
        )]));
        assert!(account(
            &link,
            &ctl(),
            "Litecoin",
            UtxoCoin::Litecoin,
            [0; 4],
            &path[..2]
        )
        .is_err());
    }

    #[test]
    fn mismatch_message() {
        assert!(is_protocol_mismatch(0x6F00));
        assert!(is_protocol_mismatch(0x6D00));
        assert!(!is_protocol_mismatch(0x6985));
        let HwError::Unsupported { what, .. } = outdated(UtxoCoin::Litecoin) else {
            panic!()
        };
        assert_eq!(
            what,
            "The Litecoin app on your Ledger is outdated or not compatible. Update it in Ledger Live."
        );
    }
}
