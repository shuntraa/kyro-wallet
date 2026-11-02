//! Hardware wallets for Litecoin, Dogecoin, Bitcoin Cash, Dash, XRP, TRON, Stellar, Cardano and
//! Zcash (transparent): which device / app supports what, and the device calls (keys, address on
//! screen, signature) of these chains on top of [`HardwareWallet::raw`].
//!
//! | chain | Ledger app (min) | Trezor |
//! |---|---|---|
//! | Litecoin, Dogecoin, Bitcoin Cash, Dash | "Litecoin", "Dogecoin", "Bitcoin Cash", "Dash" ≥ 1.4.0 (mainnet only: no Ledger testnet app) | One ≥ 1.10.4, T/Safe ≥ 2.4.3 (no Dogecoin testnet) |
//! | XRP | "XRP" ≥ 2.0.0 | — (no public key before signing) |
//! | TRON | "Tron" ≥ 0.5.0 | — (not in Trezor's firmware) |
//! | Stellar | "Stellar" ≥ 5.0.0 | One ≥ 1.10.4, T/Safe ≥ 2.4.3 |
//! | Cardano | "Cardano ADA" ≥ 7.0.0 (`ledger_cardano.rs`) | T/Safe ≥ 2.7.2, not the One (`trezor_cardano.rs`) |
//! | Zcash (transparent) | — (see [`ZEC_LEDGER_REASON`]) | One ≥ 1.11.1, T/Safe ≥ 2.5.1 (`trezor_zcash.rs`) |

use trezor_client::protos::{self, features::Capability};
use trezor_client::TrezorMessage;
use wallet_core::{
    HwBtcSignature, Network, UtxoAccount, UtxoCoin, UtxoHwPlan, WatchKey, WatchOnlyAccount,
};

use super::ledger::ApduLink;
use super::ledger_apdu::{self as apdu, SwContext, SW_OK};
use super::trezor::{decode, TrezorDevice};
use super::{
    ledger_cardano, ledger_coins, ledger_utxo, path_string, trezor_cardano, trezor_coins,
    trezor_zcash, version_at_least, Chain, ChainState, ChainStatus, Ctl, HardwareWallet, HwError,
    HwResult, Prompt, RawDevice, H,
};
use wallet_core::{CardanoHwPlan, ZecAccount, ZecHwPlan};

/// Why Zcash is not offered on Ledger. Ledger's Zcash (transparent) app is the legacy Bitcoin app
/// protocol: every previous transaction must be streamed in full through GET TRUSTED INPUT, and for
/// v5 previous transactions that includes their Sapling / Orchard bundles, from which the app
/// recomputes the ZIP-244 txid (`@ledgerhq/hw-app-btc` `getTrustedInput`, `splitTransaction`).
pub const ZEC_LEDGER_REASON: &str = "Zcash: not supported on Ledger in Kyro (the Zcash app requires every previous transaction in full, shielded parts included) — use a Trezor or the Kyro vault";

pub fn utxo_coin(chain: Chain) -> Option<UtxoCoin> {
    match chain {
        Chain::Ltc => Some(UtxoCoin::Litecoin),
        Chain::Doge => Some(UtxoCoin::Dogecoin),
        Chain::Bch => Some(UtxoCoin::BitcoinCash),
        Chain::Dash => Some(UtxoCoin::Dash),
        _ => None,
    }
}

pub fn chain_of(coin: UtxoCoin) -> Chain {
    match coin {
        UtxoCoin::Litecoin => Chain::Ltc,
        UtxoCoin::Dogecoin => Chain::Doge,
        UtxoCoin::BitcoinCash => Chain::Bch,
        UtxoCoin::Dash => Chain::Dash,
    }
}

/// Whether this module handles `chain`.
pub fn handles(chain: Chain) -> bool {
    utxo_coin(chain).is_some()
        || matches!(
            chain,
            Chain::Xrp | Chain::Tron | Chain::Stellar | Chain::Cardano | Chain::Zec
        )
}

/// Ledger app (name, minimum version) for `chain` on `net`.
pub fn ledger_app(chain: Chain, net: Network) -> Option<(&'static str, &'static str)> {
    let mainnet = net == Network::Mainnet;
    match chain {
        Chain::Ltc if mainnet => Some(("Litecoin", "1.4.0")),
        Chain::Doge if mainnet => Some(("Dogecoin", "1.4.0")),
        Chain::Bch if mainnet => Some(("Bitcoin Cash", "1.4.0")),
        Chain::Dash if mainnet => Some(("Dash", "1.4.0")),
        Chain::Xrp => Some(("XRP", "2.0.0")),
        Chain::Tron => Some(("Tron", "0.5.0")),
        Chain::Stellar => Some(("Stellar", "5.0.0")),
        Chain::Cardano => Some((ledger_cardano::APP, ledger_cardano::MIN_VERSION)),
        _ => None,
    }
}

/// Ledger status of a chain that has no app on `net` (UTXO coins on testnet).
pub fn ledger_unavailable(chain: Chain, net: Network) -> Option<ChainStatus> {
    if chain == Chain::Zec {
        return Some(ChainStatus {
            reason: Some(ZEC_LEDGER_REASON.into()),
            ..ChainStatus::new(chain, ChainState::Unsupported)
        });
    }
    utxo_coin(chain)?;
    (net == Network::Testnet).then(|| ChainStatus {
        reason: Some(format!(
            "{}: no Ledger app for testnet (mainnet only)",
            chain.label()
        )),
        ..ChainStatus::new(chain, ChainState::Unsupported)
    })
}

/// Trezor capability and minimum firmware for `chain`.
pub fn trezor_support(
    chain: Chain,
    one: bool,
) -> Result<(Capability, &'static str), Option<&'static str>> {
    let min = if one { "1.10.4" } else { "2.4.3" };
    match chain {
        Chain::Ltc | Chain::Doge | Chain::Bch | Chain::Dash => {
            Ok((Capability::Capability_Bitcoin_like, min))
        }
        Chain::Stellar => Ok((Capability::Capability_Stellar, min)),
        Chain::Xrp => Err(Some(
            "XRP: the Trezor firmware does not provide the public key before signing \
             (use a Ledger or the Kyro vault)",
        )),
        Chain::Tron => Err(Some("TRON is not supported by the Trezor firmware")),
        Chain::Cardano if one => Err(Some("Cardano is not available on the Trezor One")),
        Chain::Cardano => Ok((Capability::Capability_Cardano, trezor_cardano::MIN_FIRMWARE)),
        Chain::Zec => Ok((
            Capability::Capability_Bitcoin_like,
            if one {
                trezor_zcash::MIN_FIRMWARE_ONE
            } else {
                trezor_zcash::MIN_FIRMWARE
            },
        )),
        _ => Err(None),
    }
}

pub fn utxo_account_path(coin: UtxoCoin, net: Network, account: u32) -> [u32; 3] {
    let purpose = if coin == UtxoCoin::Litecoin { 84 } else { 44 };
    let coin_type = match (coin, net) {
        (_, Network::Testnet) => 1,
        (UtxoCoin::Litecoin, _) => 2,
        (UtxoCoin::Dogecoin, _) => 3,
        (UtxoCoin::BitcoinCash, _) => 145,
        (UtxoCoin::Dash, _) => 5,
    };
    [purpose | H, coin_type | H, account | H]
}

pub fn key_path(chain: Chain, account: u32) -> HwResult<Vec<u32>> {
    Ok(match chain {
        Chain::Xrp => vec![44 | H, 144 | H, account | H, 0, 0],
        Chain::Tron => vec![44 | H, 195 | H, account | H, 0, 0],
        Chain::Stellar => vec![44 | H, 148 | H, account | H],
        other => return Err(HwError::unsupported(other.label())),
    })
}

/// One APDU through `link`; a non-`9000` status is a typed error (wrong-app codes completed
/// with the open app's name).
pub fn ledger_call(
    link: &dyn ApduLink,
    ctl: &Ctl,
    cmd: &[u8],
    ctx: SwContext,
    expected: &str,
) -> HwResult<Vec<u8>> {
    let (data, sw) = link.exchange(ctl, cmd)?;
    if sw == SW_OK {
        return Ok(data);
    }
    if expected == ledger_cardano::APP {
        if let Some(e) = ledger_cardano::sw_error(sw) {
            return Err(e);
        }
    }
    Err(match (sw, apdu::sw_error(sw, ctx)) {
        (_, HwError::WrongApp { .. }) => HwError::WrongApp {
            expected: expected.into(),
            open: ledger_open_app(link, ctl)
                .map(|(n, _)| n)
                .unwrap_or_else(|_| "?".into()),
        },
        (0x6C66, _) => {
            HwError::unsupported("turn on “Hash signing” in the Stellar app settings, or reject")
        }
        (0xB004, _) => HwError::unsupported("transaction too large for the Stellar app"),
        (_, e) => e,
    })
}

fn ledger_open_app(link: &dyn ApduLink, ctl: &Ctl) -> HwResult<(String, String)> {
    let (data, sw) = link.exchange(ctl, &apdu::get_app_and_version())?;
    if sw != SW_OK {
        return Err(apdu::sw_error(sw, SwContext::General));
    }
    apdu::parse_app_and_version(&data)
}

/// Fails unless the app of `chain` is open and recent enough; returns its name.
pub fn ledger_ensure(
    link: &dyn ApduLink,
    ctl: &Ctl,
    chain: Chain,
    net: Network,
) -> HwResult<&'static str> {
    let (expected, min) =
        ledger_app(chain, net).ok_or_else(|| match ledger_unavailable(chain, net) {
            Some(st) => HwError::unsupported(st.reason.unwrap_or_default()),
            None => HwError::unsupported(format!("{} on Ledger", chain.label())),
        })?;
    let (name, version) = super::ledger::ensure_open(link, ctl, expected)?;
    if name != expected {
        return Err(HwError::WrongApp {
            expected: expected.into(),
            open: name,
        });
    }
    if !version_at_least(&version, min) {
        return Err(HwError::too_old(
            format!("{expected} app {version} too old: update it"),
            min,
        ));
    }
    Ok(expected)
}

fn ledger_wallet_key(
    link: &dyn ApduLink,
    ctl: &Ctl,
    app: &str,
    coin: UtxoCoin,
    path: &[u32],
    display: bool,
) -> HwResult<ledger_utxo::WalletPublicKey> {
    let ctx = if display {
        ctl.prompt(Prompt::ConfirmOnDevice);
        SwContext::Signing
    } else {
        SwContext::General
    };
    let cmd = ledger_utxo::get_wallet_public_key(path, display, ledger_utxo::address_format(coin))?;
    ledger_utxo::parse_wallet_public_key(&ledger_call(link, ctl, &cmd, ctx, app)?)
}

fn fingerprint_of(pubkey: &[u8; 33]) -> [u8; 4] {
    use bitcoin::hashes::{hash160, Hash};
    let h = hash160::Hash::hash(pubkey);
    let mut fp = [0u8; 4];
    fp.copy_from_slice(&h.as_byte_array()[..4]);
    fp
}

fn ledger_utxo_account(
    link: &dyn ApduLink,
    ctl: &Ctl,
    app: &str,
    coin: UtxoCoin,
    net: Network,
    account: u32,
) -> HwResult<UtxoAccount> {
    let path = utxo_account_path(coin, net, account);
    let master = ledger_wallet_key(link, ctl, app, coin, &[], false)?;
    let parent = ledger_wallet_key(link, ctl, app, coin, &path[..2], false)?;
    let node = ledger_wallet_key(link, ctl, app, coin, &path, false)?;
    let xpub = bitcoin::bip32::Xpub {
        network: match net {
            Network::Mainnet => bitcoin::NetworkKind::Main,
            Network::Testnet => bitcoin::NetworkKind::Test,
        },
        depth: 3,
        parent_fingerprint: fingerprint_of(&parent.pubkey).into(),
        child_number: path[2].into(),
        public_key: bitcoin::secp256k1::PublicKey::from_slice(&node.pubkey)
            .map_err(|_| HwError::bad("invalid public key"))?,
        chain_code: node.chain_code.into(),
    };
    Ok(UtxoAccount {
        coin,
        xpub: xpub.to_string(),
        fingerprint: hex::encode(fingerprint_of(&master.pubkey)),
        path: path_string(&path),
    })
}

fn tsend<M: TrezorMessage, R: TrezorMessage>(
    t: &mut dyn TrezorDevice,
    ctl: &Ctl,
    m: &M,
) -> HwResult<R> {
    let bytes = m
        .write_to_bytes()
        .map_err(|e| HwError::bad(format!("protobuf encoding: {e}")))?;
    decode(t.call(ctl, M::MESSAGE_TYPE, bytes)?)
}

fn trezor_utxo_account(
    t: &mut dyn TrezorDevice,
    ctl: &Ctl,
    coin: UtxoCoin,
    net: Network,
    account: u32,
) -> HwResult<UtxoAccount> {
    let path = utxo_account_path(coin, net, account);
    let pk: protos::PublicKey = tsend(t, ctl, &trezor_coins::get_public_key(coin, net, &path)?)?;
    let (xpub, fingerprint) = trezor_coins::account_xpub(&pk, net)?;
    Ok(UtxoAccount {
        coin,
        xpub,
        fingerprint,
        path: path_string(&path),
    })
}

/// What [`read_keys`] read for one chain.
#[derive(Debug, Clone, Default)]
pub struct ChainKeys {
    pub utxo: Option<UtxoAccount>,
    /// XRP / TRON / Stellar key, or the Cardano account key (`pubkey`: key ‖ chain code).
    pub key: Option<WatchKey>,
    pub zec: Option<ZecAccount>,
}

/// Zcash account path `m/44'/133'/a'` (testnet `m/44'/1'/a'`).
pub fn zec_account_path(net: Network, account: u32) -> [u32; 3] {
    let coin = if net == Network::Mainnet { 133 } else { 1 };
    [44 | H, coin | H, account | H]
}

fn cardano_key(net: Network, account: u32, xpub: &[u8; 64]) -> HwResult<WatchKey> {
    let pubkey = hex::encode(xpub);
    Ok(WatchKey {
        address: wallet_core::cardano_address_from_xpub(&pubkey, net, 0)
            .map_err(|e| HwError::bad(e.to_string()))?,
        pubkey,
        path: wallet_core::cardano_account_path(account),
    })
}

fn ledger_cardano_key(
    link: &dyn ApduLink,
    ctl: &Ctl,
    net: Network,
    account: u32,
) -> HwResult<WatchKey> {
    let d = ledger_call(
        link,
        ctl,
        &ledger_cardano::get_ext_public_key(account)?,
        SwContext::General,
        ledger_cardano::APP,
    )?;
    cardano_key(net, account, &ledger_cardano::parse_ext_public_key(&d)?)
}

fn trezor_zec_account(
    t: &mut dyn TrezorDevice,
    ctl: &Ctl,
    net: Network,
    account: u32,
) -> HwResult<ZecAccount> {
    let path = zec_account_path(net, account);
    let pk: protos::PublicKey = tsend(t, ctl, &trezor_zcash::get_public_key(net, &path))?;
    let (xpub, fingerprint) = trezor_coins::account_xpub(&pk, net)?;
    Ok(ZecAccount {
        xpub,
        fingerprint,
        path: path_string(&path),
    })
}

fn watch_key(chain: Chain, account: u32, pubkey: &[u8], address: String) -> HwResult<WatchKey> {
    Ok(WatchKey {
        address,
        pubkey: hex::encode(pubkey),
        path: path_string(&key_path(chain, account)?),
    })
}

fn ledger_key(
    link: &dyn ApduLink,
    ctl: &Ctl,
    chain: Chain,
    app: &str,
    account: u32,
    display: bool,
) -> HwResult<WatchKey> {
    let path = key_path(chain, account)?;
    let ctx = if display {
        ctl.prompt(Prompt::ConfirmOnDevice);
        SwContext::Signing
    } else {
        SwContext::General
    };
    let mismatch = || HwError::bad("the returned address does not match the returned key");
    match chain {
        Chain::Xrp => {
            let d = ledger_call(
                link,
                ctl,
                &ledger_coins::xrp_get_address(&path, display)?,
                ctx,
                app,
            )?;
            let (pk, addr) = ledger_coins::parse_key_and_address(&d)?;
            let ours =
                wallet_core::xrp_address_of_pubkey(&pk).map_err(|e| HwError::bad(e.to_string()))?;
            if pk.len() != 33 || ours != addr {
                return Err(mismatch());
            }
            watch_key(chain, account, &pk, ours)
        }
        Chain::Tron => {
            let d = ledger_call(
                link,
                ctl,
                &ledger_coins::tron_get_address(&path, display)?,
                ctx,
                app,
            )?;
            let (pk, addr) = ledger_coins::parse_key_and_address(&d)?;
            let ours = wallet_core::tron_address_of_pubkey(&pk)
                .map_err(|e| HwError::bad(e.to_string()))?;
            if pk.len() != 65 || ours != addr {
                return Err(mismatch());
            }
            watch_key(chain, account, &pk, ours)
        }
        Chain::Stellar => {
            let d = ledger_call(
                link,
                ctl,
                &ledger_coins::stellar_get_public_key(&path, display)?,
                ctx,
                app,
            )?;
            let pk = ledger_coins::stellar_parse_public_key(&d)?;
            watch_key(
                chain,
                account,
                &pk,
                wallet_core::stellar_address_from_key(&pk),
            )
        }
        other => Err(HwError::unsupported(other.label())),
    }
}

fn trezor_stellar_key(
    t: &mut dyn TrezorDevice,
    ctl: &Ctl,
    account: u32,
    display: bool,
) -> HwResult<WatchKey> {
    let path = key_path(Chain::Stellar, account)?;
    let a: protos::StellarAddress =
        tsend(t, ctl, &trezor_coins::stellar_get_address(&path, display))?;
    let pk =
        wallet_core::stellar_account_id(a.address()).map_err(|e| HwError::bad(e.to_string()))?;
    watch_key(Chain::Stellar, account, &pk, a.address().to_string())
}

/// Keys of `chain` for account number `account`.
pub fn read_keys(
    dev: &mut dyn HardwareWallet,
    ctl: &Ctl,
    net: Network,
    chain: Chain,
    account: u32,
) -> HwResult<ChainKeys> {
    let mut out = ChainKeys::default();
    match dev.raw() {
        RawDevice::Ledger(link) => {
            let app = ledger_ensure(link, ctl, chain, net)?;
            match utxo_coin(chain) {
                Some(coin) => {
                    out.utxo = Some(ledger_utxo_account(link, ctl, app, coin, net, account)?)
                }
                None if chain == Chain::Cardano => {
                    out.key = Some(ledger_cardano_key(link, ctl, net, account)?)
                }
                None => out.key = Some(ledger_key(link, ctl, chain, app, account, false)?),
            }
        }
        RawDevice::Trezor(t) => {
            t.ensure_chain(chain)?;
            match (utxo_coin(chain), chain) {
                (Some(coin), _) => {
                    out.utxo = Some(trezor_utxo_account(t, ctl, coin, net, account)?)
                }
                (None, Chain::Stellar) => {
                    out.key = Some(trezor_stellar_key(t, ctl, account, false)?)
                }
                (None, Chain::Cardano) => {
                    let k = trezor_cardano::read_account_key(t, ctl, account)?;
                    out.key = Some(cardano_key(net, account, &k)?)
                }
                (None, Chain::Zec) => out.zec = Some(trezor_zec_account(t, ctl, net, account)?),
                _ => return Err(HwError::unsupported(format!("{} on Trezor", chain.label()))),
            }
        }
        RawDevice::None => return Err(HwError::unsupported(chain.label())),
    }
    Ok(out)
}

/// The device's keys for `chain` equal the stored ones.
pub fn same_device(
    dev: &mut dyn HardwareWallet,
    ctl: &Ctl,
    acc: &WatchOnlyAccount,
    chain: Chain,
) -> HwResult<bool> {
    let live = read_keys(dev, ctl, acc.network, chain, acc.account)?;
    Ok(match utxo_coin(chain) {
        Some(coin) => match (acc.utxo_account(coin), live.utxo) {
            (Some(s), Some(l)) => s.xpub == l.xpub && s.fingerprint == l.fingerprint,
            _ => false,
        },
        None if chain == Chain::Zec => match (acc.zec.as_ref(), live.zec) {
            (Some(s), Some(l)) => s.xpub == l.xpub && s.fingerprint == l.fingerprint,
            _ => false,
        },
        None => {
            let stored = match chain {
                Chain::Xrp => acc.xrp.as_ref(),
                Chain::Tron => acc.tron.as_ref(),
                Chain::Stellar => acc.stellar.as_ref(),
                Chain::Cardano => acc.cardano.as_ref(),
                _ => None,
            };
            matches!((stored, live.key), (Some(s), Some(l)) if *s == l)
        }
    })
}

/// What to show on the device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    Utxo {
        coin: UtxoCoin,
        path: Vec<u32>,
    },
    Key(Chain),
    /// Kyro's Cardano base address (payment `…/0/0`, stake `…/2/0`).
    Cardano,
    /// A Zcash transparent address `…/change/index`.
    Zec {
        path: Vec<u32>,
    },
}

fn without_prefix(a: &str) -> &str {
    a.rsplit(':').next().unwrap_or(a)
}

/// Resolves `path` against the stored account; returns the target and Kyro's own address.
pub fn resolve_target(
    acc: &WatchOnlyAccount,
    chain: Chain,
    path: &[u32],
) -> Result<(Target, String), String> {
    let wrong = || "this path does not belong to this hardware wallet account".to_string();
    if let Some(coin) = utxo_coin(chain) {
        let stored = acc.utxo_account(coin).ok_or_else(wrong)?;
        let [a, b, c, change, index] = path else {
            return Err(wrong());
        };
        if path_string(&[*a, *b, *c]) != stored.path || *change > 1 || *index >= H {
            return Err(wrong());
        }
        let expected = wallet_core::utxo_address_from_xpub(
            &stored.xpub,
            acc.network,
            coin,
            *change == 1,
            *index,
        )
        .map_err(|e| e.to_string())?;
        return Ok((
            Target::Utxo {
                coin,
                path: path.to_vec(),
            },
            expected,
        ));
    }
    if chain == Chain::Zec {
        let stored = acc.zec.as_ref().ok_or_else(wrong)?;
        let [a, b, c, change, index] = path else {
            return Err(wrong());
        };
        if path_string(&[*a, *b, *c]) != stored.path || *change > 1 || *index >= H {
            return Err(wrong());
        }
        let expected =
            wallet_core::zec_address_from_xpub(&stored.xpub, acc.network, *change == 1, *index)
                .map_err(|e| e.to_string())?;
        return Ok((
            Target::Zec {
                path: path.to_vec(),
            },
            expected,
        ));
    }
    if chain == Chain::Cardano {
        let stored = acc.cardano.as_ref().ok_or_else(wrong)?;
        if path_string(path) != format!("{}/0/0", stored.path) {
            return Err(wrong());
        }
        return Ok((Target::Cardano, stored.address.clone()));
    }
    let stored = match chain {
        Chain::Xrp => acc.xrp.as_ref(),
        Chain::Tron => acc.tron.as_ref(),
        Chain::Stellar => acc.stellar.as_ref(),
        _ => None,
    }
    .ok_or_else(wrong)?;
    if path_string(path) != stored.path {
        return Err(wrong());
    }
    Ok((Target::Key(chain), stored.address.clone()))
}

/// Shows the target address on the device; returns what the device derived (CashAddr in
/// Kyro's prefixed form when the device answered without the prefix).
pub fn display_address(
    dev: &mut dyn HardwareWallet,
    ctl: &Ctl,
    acc: &WatchOnlyAccount,
    target: &Target,
    expected: &str,
) -> HwResult<String> {
    let net = acc.network;
    match (dev.raw(), target) {
        (RawDevice::Ledger(link), Target::Utxo { coin, path }) => {
            let app = ledger_ensure(link, ctl, chain_of(*coin), net)?;
            let k = ledger_wallet_key(link, ctl, app, *coin, path, true)?;
            Ok(if without_prefix(&k.address) == without_prefix(expected) {
                expected.to_string()
            } else {
                k.address
            })
        }
        (RawDevice::Ledger(link), Target::Key(chain)) => {
            let app = ledger_ensure(link, ctl, *chain, net)?;
            Ok(ledger_key(link, ctl, *chain, app, acc.account, true)?.address)
        }
        (RawDevice::Trezor(t), Target::Utxo { coin, path }) => {
            t.ensure_chain(chain_of(*coin))?;
            let a: protos::Address =
                tsend(t, ctl, &trezor_coins::get_address(*coin, net, path, true)?)?;
            Ok(a.address().to_string())
        }
        (RawDevice::Trezor(t), Target::Key(Chain::Stellar)) => {
            t.ensure_chain(Chain::Stellar)?;
            Ok(trezor_stellar_key(t, ctl, acc.account, true)?.address)
        }
        (RawDevice::Ledger(link), Target::Cardano) => {
            let app = ledger_ensure(link, ctl, Chain::Cardano, net)?;
            let raw = ledger_call(
                link,
                ctl,
                &ledger_cardano::derive_address(net, acc.account, false)?,
                SwContext::General,
                app,
            )?;
            let derived = wallet_core::cardano_address_string(&raw, net)
                .ok_or_else(|| HwError::bad("malformed Cardano address from the device"))?;
            ctl.prompt(Prompt::ConfirmOnDevice);
            ledger_call(
                link,
                ctl,
                &ledger_cardano::derive_address(net, acc.account, true)?,
                SwContext::Signing,
                app,
            )?;
            Ok(derived)
        }
        (RawDevice::Trezor(t), Target::Cardano) => {
            t.ensure_chain(Chain::Cardano)?;
            trezor_cardano::address(t, ctl, net, acc.account, true)
        }
        (RawDevice::Trezor(t), Target::Zec { path }) => {
            t.ensure_chain(Chain::Zec)?;
            ctl.prompt(Prompt::ConfirmOnDevice);
            let a: protos::Address = tsend(t, ctl, &trezor_zcash::get_address(net, path, true))?;
            Ok(a.address().to_string())
        }
        _ => Err(HwError::unsupported(
            "address cannot be shown on this device",
        )),
    }
}

pub fn sign_utxo(
    dev: &mut dyn HardwareWallet,
    ctl: &Ctl,
    net: Network,
    coin: UtxoCoin,
    psbt: &bitcoin::psbt::Psbt,
    plan: &UtxoHwPlan,
) -> HwResult<Vec<HwBtcSignature>> {
    match dev.raw() {
        RawDevice::Ledger(link) => {
            let app = ledger_ensure(link, ctl, chain_of(coin), net)?;
            let mut call = ledger_utxo::caller(link, ctl, app);
            ledger_utxo::sign(&mut call, ctl, coin, psbt, plan)
        }
        RawDevice::Trezor(t) => {
            t.ensure_chain(chain_of(coin))?;
            trezor_coins::sign_utxo(t, ctl, coin, net, psbt, plan)
        }
        RawDevice::None => Err(HwError::unsupported(coin.name())),
    }
}

fn ledger_sign_apdus(
    link: &dyn ApduLink,
    ctl: &Ctl,
    app: &str,
    apdus: &[Vec<u8>],
) -> HwResult<Vec<u8>> {
    ctl.prompt(Prompt::ConfirmOnDevice);
    let mut last = Vec::new();
    for a in apdus {
        last = ledger_call(link, ctl, a, SwContext::Signing, app)?;
    }
    Ok(last)
}

/// DER signature of an unsigned XRP Payment (Ledger).
pub fn sign_xrp(
    dev: &mut dyn HardwareWallet,
    ctl: &Ctl,
    net: Network,
    account: u32,
    blob: &[u8],
) -> HwResult<Vec<u8>> {
    match dev.raw() {
        RawDevice::Ledger(link) => {
            let app = ledger_ensure(link, ctl, Chain::Xrp, net)?;
            let apdus = ledger_coins::xrp_sign(&key_path(Chain::Xrp, account)?, blob)?;
            ledger_sign_apdus(link, ctl, app, &apdus)
        }
        _ => Err(HwError::unsupported("XRP on this device")),
    }
}

/// 65-byte signature of a TRON `raw_data` (Ledger).
pub fn sign_tron(
    dev: &mut dyn HardwareWallet,
    ctl: &Ctl,
    net: Network,
    account: u32,
    raw: &[u8],
) -> HwResult<[u8; 65]> {
    match dev.raw() {
        RawDevice::Ledger(link) => {
            let app = ledger_ensure(link, ctl, Chain::Tron, net)?;
            let apdus = ledger_coins::tron_sign(&key_path(Chain::Tron, account)?, raw)?;
            ledger_coins::tron_parse_signature(&ledger_sign_apdus(link, ctl, app, &apdus)?)
        }
        _ => Err(HwError::unsupported("TRON on this device")),
    }
}

/// Ed25519 signature of a Stellar envelope (Ledger: over the signature base.
pub fn sign_stellar(
    dev: &mut dyn HardwareWallet,
    ctl: &Ctl,
    net: Network,
    account: u32,
    envelope: &str,
) -> HwResult<Vec<u8>> {
    let path = key_path(Chain::Stellar, account)?;
    match dev.raw() {
        RawDevice::Ledger(link) => {
            let app = ledger_ensure(link, ctl, Chain::Stellar, net)?;
            let base = wallet_core::stellar_signature_base(envelope, net)
                .map_err(|e| HwError::bad(e.to_string()))?;
            let apdus = ledger_coins::stellar_sign(&path, &base)?;
            ledger_sign_apdus(link, ctl, app, &apdus)
        }
        RawDevice::Trezor(t) => {
            t.ensure_chain(Chain::Stellar)?;
            Ok(trezor_coins::sign_stellar(t, ctl, &path, net, envelope)?.1)
        }
        RawDevice::None => Err(HwError::unsupported("Stellar")),
    }
}

/// Body hash, payment-key signature, and the witness key when the device reports one.
pub type CardanoDeviceSignature = ([u8; 32], [u8; 64], Option<[u8; 32]>);

/// Cardano payment on the device: `(body hash, payment-key signature, witness key if the
/// device reported one)`, all to be verified by `wallet_core::cardano_hw_assemble`.
pub fn sign_cardano(
    dev: &mut dyn HardwareWallet,
    ctl: &Ctl,
    net: Network,
    account: u32,
    plan: &CardanoHwPlan,
) -> HwResult<CardanoDeviceSignature> {
    match dev.raw() {
        RawDevice::Ledger(link) => {
            ledger_ensure(link, ctl, Chain::Cardano, net)?;
            let (_, version) = ledger_open_app(link, ctl)?;
            ctl.prompt(Prompt::ConfirmOnDevice);
            let mut call =
                |cmd: &[u8]| ledger_call(link, ctl, cmd, SwContext::Signing, ledger_cardano::APP);
            let (hash, sig) = ledger_cardano::sign_tx(&mut call, &version, plan, net, account)?;
            Ok((hash, sig, None))
        }
        RawDevice::Trezor(t) => {
            t.ensure_chain(Chain::Cardano)?;
            let (hash, sig, pk) = trezor_cardano::sign_tx(t, ctl, plan, net, account)?;
            Ok((hash, sig, Some(pk)))
        }
        RawDevice::None => Err(HwError::unsupported("Cardano")),
    }
}

/// Zcash v5 transparent transaction on a Trezor: one DER signature per input (unverified).
pub fn sign_zec(
    dev: &mut dyn HardwareWallet,
    ctl: &Ctl,
    net: Network,
    plan: &ZecHwPlan,
) -> HwResult<Vec<Vec<u8>>> {
    match dev.raw() {
        RawDevice::Trezor(t) => {
            t.ensure_chain(Chain::Zec)?;
            trezor_zcash::sign_tx(t, ctl, plan, net)
        }
        _ => Err(HwError::unsupported(ZEC_LEDGER_REASON)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hw::ledger::Ledger;
    use crate::hw::lock;
    use std::sync::Mutex;
    use std::time::Duration;

    struct Replay(Mutex<Vec<(Vec<u8>, Vec<u8>)>>);

    impl ApduLink for Replay {
        fn exchange(&self, _ctl: &Ctl, a: &[u8]) -> HwResult<(Vec<u8>, u16)> {
            let (req, resp) = lock(&self.0).remove(0);
            assert_eq!(hex::encode(a), hex::encode(req), "unexpected APDU");
            apdu::split_sw(resp)
        }
    }

    fn app(name: &str, version: &str) -> (Vec<u8>, Vec<u8>) {
        let mut r = vec![1, name.len() as u8];
        r.extend(name.as_bytes());
        r.push(version.len() as u8);
        r.extend(version.as_bytes());
        r.extend([0x90, 0x00]);
        (apdu::get_app_and_version(), r)
    }

    fn ctl() -> Ctl {
        Ctl::for_tests(Duration::from_secs(5))
    }

    #[test]
    fn support_tables() {
        assert_eq!(
            ledger_app(Chain::Ltc, Network::Mainnet),
            Some(("Litecoin", "1.4.0"))
        );
        assert_eq!(ledger_app(Chain::Ltc, Network::Testnet), None);
        assert!(ledger_unavailable(Chain::Bch, Network::Testnet).is_some());
        assert!(ledger_unavailable(Chain::Xrp, Network::Testnet).is_none());
        assert!(trezor_support(Chain::Tron, false).is_err());
        assert!(matches!(trezor_support(Chain::Xrp, false), Err(Some(_))));
        assert_eq!(trezor_support(Chain::Dash, true).unwrap().1, "1.10.4");
        assert_eq!(trezor_support(Chain::Cardano, false).unwrap().1, "2.7.2");
        assert!(matches!(trezor_support(Chain::Cardano, true), Err(Some(_))));
        assert_eq!(trezor_support(Chain::Zec, true).unwrap().1, "1.11.1");
        assert_eq!(trezor_support(Chain::Btc, false), Err(None));
        assert!(ledger_unavailable(Chain::Zec, Network::Mainnet).is_some());
        assert_eq!(ledger_app(Chain::Zec, Network::Mainnet), None);
        assert_eq!(
            path_string(&utxo_account_path(
                UtxoCoin::BitcoinCash,
                Network::Mainnet,
                2
            )),
            "m/44'/145'/2'"
        );
        assert_eq!(
            path_string(&utxo_account_path(UtxoCoin::Litecoin, Network::Testnet, 0)),
            "m/84'/1'/0'"
        );
        assert_eq!(
            path_string(&key_path(Chain::Stellar, 1).unwrap()),
            wallet_core::stellar_path(1)
        );
        assert_eq!(
            path_string(&key_path(Chain::Xrp, 1).unwrap()),
            wallet_core::xrp_path(1)
        );
        assert_eq!(
            path_string(&key_path(Chain::Tron, 1).unwrap()),
            wallet_core::tron_path(1)
        );
    }

    #[test]
    fn ledger_stellar_key_and_wrong_app() {
        let seed = wallet_core::Mnemonic::parse(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        )
        .unwrap()
        .to_seed("");
        let pk = wallet_core::stellar_public_key(&seed, 0).unwrap();
        let path = key_path(Chain::Stellar, 0).unwrap();
        let mut resp = pk.to_vec();
        resp.extend([0x90, 0x00]);
        let mut l = Ledger::with_link(Replay(Mutex::new(vec![
            app("Stellar", "5.2.1"),
            (
                ledger_coins::stellar_get_public_key(&path, false).unwrap(),
                resp,
            ),
        ])));
        let k = read_keys(&mut l, &ctl(), Network::Mainnet, Chain::Stellar, 0).unwrap();
        let k = k.key.unwrap();
        assert_eq!(k.address, wallet_core::stellar_address(&seed, 0).unwrap());
        assert_eq!(k.path, "m/44'/148'/0'");
        let mut l = Ledger::with_link(Replay(Mutex::new(vec![
            app("XRP", "2.4.0"),
            (apdu::quit_app(), vec![0x90, 0x00]),
            app("XRP", "2.4.0"),
        ])));
        assert_eq!(
            read_keys(&mut l, &ctl(), Network::Mainnet, Chain::Stellar, 0).unwrap_err(),
            HwError::WrongApp {
                expected: "Stellar".into(),
                open: "XRP".into()
            }
        );
        let mut l = Ledger::with_link(Replay(Mutex::new(vec![app("Stellar", "4.1.0")])));
        assert!(matches!(
            read_keys(&mut l, &ctl(), Network::Mainnet, Chain::Stellar, 0),
            Err(HwError::Unsupported { min: Some(_), .. })
        ));
    }

    /// XRP and TRON: the address the app returns must be the one of the key it returns.
    #[test]
    fn ledger_xrp_tron_keys_are_checked() {
        let seed = wallet_core::Mnemonic::parse(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        )
        .unwrap()
        .to_seed("");
        let pk = wallet_core::xrp_public_key(&seed, 0).unwrap();
        let addr = wallet_core::xrp_address(&seed, 0).unwrap();
        let resp = |a: &str| {
            let mut r = vec![33u8];
            r.extend(pk);
            r.push(a.len() as u8);
            r.extend(a.as_bytes());
            r.extend([0x90, 0x00]);
            r
        };
        let path = key_path(Chain::Xrp, 0).unwrap();
        let get = ledger_coins::xrp_get_address(&path, false).unwrap();
        let mut l = Ledger::with_link(Replay(Mutex::new(vec![
            app("XRP", "2.4.0"),
            (get.clone(), resp(&addr)),
        ])));
        let k = read_keys(&mut l, &ctl(), Network::Mainnet, Chain::Xrp, 0)
            .unwrap()
            .key
            .unwrap();
        assert_eq!(k.address, addr);
        assert_eq!(k.pubkey, hex::encode(pk));
        let other = wallet_core::xrp_address(&seed, 1).unwrap();
        let mut l = Ledger::with_link(Replay(Mutex::new(vec![
            app("XRP", "2.4.0"),
            (get, resp(&other)),
        ])));
        assert!(matches!(
            read_keys(&mut l, &ctl(), Network::Mainnet, Chain::Xrp, 0),
            Err(HwError::BadResponse(_))
        ));
        let raw = vec![0x0a, 0x02, 0x01, 0x02];
        let sign = ledger_coins::tron_sign(&key_path(Chain::Tron, 0).unwrap(), &raw).unwrap();
        let mut l = Ledger::with_link(Replay(Mutex::new(vec![
            app("Tron", "0.5.0"),
            (sign[0].clone(), vec![0x69, 0x85]),
        ])));
        assert_eq!(
            sign_tron(&mut l, &ctl(), Network::Mainnet, 0, &raw),
            Err(HwError::Rejected)
        );
    }

    /// Ledger UTXO account: three GET WALLET PUBLIC KEY (master, parent, account) give the
    /// same xpub and fingerprint as Kyro's own derivation of the same seed.
    #[test]
    fn ledger_utxo_account_matches_kyro_derivation() {
        use std::str::FromStr;
        let seed = wallet_core::Mnemonic::parse(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        )
        .unwrap()
        .to_seed("");
        let secp = bitcoin::secp256k1::Secp256k1::new();
        let master =
            bitcoin::bip32::Xpriv::new_master(bitcoin::NetworkKind::Main, &seed[..]).unwrap();
        let coin = UtxoCoin::Dogecoin;
        let path = utxo_account_path(coin, Network::Mainnet, 0);
        let answer = |p: &[u32]| {
            let dp = bitcoin::bip32::DerivationPath::from(
                p.iter()
                    .map(|i| bitcoin::bip32::ChildNumber::from(*i))
                    .collect::<Vec<_>>(),
            );
            let k = master.derive_priv(&secp, &dp).unwrap();
            let mut r = vec![65u8];
            r.extend(k.private_key.public_key(&secp).serialize_uncompressed());
            r.push(1);
            r.push(b'D');
            r.extend(k.chain_code.to_bytes());
            r.extend([0x90, 0x00]);
            (
                ledger_utxo::get_wallet_public_key(p, false, 0x00).unwrap(),
                r,
            )
        };
        let mut l = Ledger::with_link(Replay(Mutex::new(vec![
            app("Dogecoin", "2.1.0"),
            answer(&[]),
            answer(&path[..2]),
            answer(&path),
        ])));
        let got = read_keys(&mut l, &ctl(), Network::Mainnet, Chain::Doge, 0)
            .unwrap()
            .utxo
            .unwrap();
        let want = wallet_core::utxo_account(&seed, Network::Mainnet, coin, 0).unwrap();
        assert_eq!(got, want);
        let _ = bitcoin::bip32::Xpub::from_str(&got.xpub).unwrap();
        let mut l = Ledger::with_link(Replay(Mutex::new(vec![])));
        assert!(matches!(
            read_keys(&mut l, &ctl(), Network::Testnet, Chain::Doge, 0),
            Err(HwError::Unsupported { .. })
        ));
    }

    #[test]
    fn cashaddr_prefix_is_ignored_when_comparing() {
        assert_eq!(without_prefix("bitcoincash:qq123"), "qq123");
        assert_eq!(without_prefix("qq123"), "qq123");
    }
}
