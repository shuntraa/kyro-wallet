//! Ledger apps of the single-key chains (Sui, Aptos, Algorand, NEAR, Cosmos Hub): what they
//! have in common, and the dispatch to their own modules (`ledger_sui`, `ledger_aptos`,
//! `ledger_algo`, `ledger_near`, `ledger_cosmos`, one per official app protocol).
//!
//! Every operation first checks with GET APP AND VERSION that the right app is open and recent
//! enough, then reads a public key (optionally shown on the device screen) or has the device
//! sign the exact bytes Kyro built. Nothing returned is trusted: callers re-derive addresses
//! with `wallet-core` and verify every signature before using it (`commands_hw_keys.rs`).
//!
//! Trezor firmware has no app for any of these chains (nor for Polkadot, Hedera, Kaspa, TON):
//! they are reported `unsupported` for Trezor.

use wallet_core::HwKeyChain;

use super::ledger::ApduLink;
use super::ledger_apdu::{self as apdu, SwContext, SW_OK};
use super::{
    version_at_least, Chain, ChainState, ChainStatus, Ctl, HardwareWallet, HwError, HwResult,
    Prompt,
};

/// The single-key chain behind a [`Chain`], if it is one.
pub fn key_chain(chain: Chain) -> Option<HwKeyChain> {
    Some(match chain {
        Chain::Sui => HwKeyChain::Sui,
        Chain::Apt => HwKeyChain::Aptos,
        Chain::Algo => HwKeyChain::Algo,
        Chain::Near => HwKeyChain::Near,
        Chain::Cosmos => HwKeyChain::Cosmos,
        _ => return None,
    })
}

pub fn hw_chain(k: HwKeyChain) -> Chain {
    match k {
        HwKeyChain::Sui => Chain::Sui,
        HwKeyChain::Aptos => Chain::Apt,
        HwKeyChain::Algo => Chain::Algo,
        HwKeyChain::Near => Chain::Near,
        HwKeyChain::Cosmos => Chain::Cosmos,
    }
}

/// App name (as GET APP AND VERSION reports it) and minimum version.
///
/// Minimums: Sui 1.0.0 (block protocol, signing of `TransactionData` intents), Aptos 0.6.0
/// (CLA 5B, SIGN_TX of the full signing message), Algorand 2.0.0 (Zondax app: GET_ADDRESS 04,
/// SIGN_MSGPACK 08), NEAR 2.0.0 (Rust app, five-level paths), Cosmos 2.34.0 (amino JSON with
/// `timeout_height`).
pub fn app_for(chain: Chain) -> Option<(&'static str, &'static str)> {
    Some(match key_chain(chain)? {
        HwKeyChain::Sui => ("Sui", "1.0.0"),
        HwKeyChain::Aptos => ("Aptos", "0.6.0"),
        HwKeyChain::Algo => ("Algorand", "2.0.0"),
        HwKeyChain::Near => ("NEAR", "2.0.0"),
        HwKeyChain::Cosmos => ("Cosmos", "2.34.0"),
    })
}

/// Why a chain Kyro supports in its vault is not offered on hardware wallets.
pub fn unavailable(chain: Chain) -> Option<&'static str> {
    Some(match chain {
        Chain::Dot => {
            "Polkadot : l'app Ledger « Polkadot » exige la preuve des métadonnées du runtime \
             (RFC-0078, CheckMetadataHash) et des clés ed25519 m/44'/354'/… ; Kyro signe en \
             sr25519 sans cette preuve, pas encore pris en charge sur hardware wallet"
        }
        Chain::Hbar => {
            "Hedera : l'app Ledger signe avec des clés ed25519 (m/44'/3030'/0'/0'/i') ; les \
             comptes Hedera de Kyro sont des comptes ECDSA secp256k1, pas pris en charge sur \
             hardware wallet"
        }
        Chain::Kas => {
            "Kaspa : le protocole de signature de l'app Ledger n'a pas pu être vérifié contre \
             les règles de transaction actuelles (rusty-kaspa 2.1, Toccata) : pas pris en \
             charge sur hardware wallet"
        }
        Chain::Ton => {
            "TON : l'app Ledger reconstruit elle-même le message (requête de transfert \
             structurée, chemin à six niveaux, identifiant de portefeuille standard) : pas \
             encore pris en charge sur hardware wallet"
        }
        _ => return None,
    })
}

/// Ledger status line of a chain that is not offered on hardware wallets.
pub fn unavailable_status(chain: Chain) -> Option<ChainStatus> {
    let reason = unavailable(chain)?;
    Some(ChainStatus {
        reason: Some(reason.into()),
        ..ChainStatus::new(chain, ChainState::Unsupported)
    })
}

/// Trezor status line of the chains handled here (no Trezor app exists for them).
pub fn trezor_status(chain: Chain) -> Option<ChainStatus> {
    if key_chain(chain).is_none() && unavailable(chain).is_none() {
        return None;
    }
    Some(ChainStatus {
        reason: Some(format!(
            "{} : pas d'app Trezor pour cette chaîne (Ledger seulement)",
            chain.label()
        )),
        ..ChainStatus::new(chain, ChainState::Unsupported)
    })
}

/// The open app, checked, and its link.
pub struct App<'a> {
    link: &'a dyn ApduLink,
    ctl: &'a Ctl,
    name: &'static str,
}

impl<'a> App<'a> {
    /// Fails unless the app of `chain` is open, recent enough.
    pub fn open(link: &'a dyn ApduLink, ctl: &'a Ctl, chain: HwKeyChain) -> HwResult<Self> {
        let (name, min) = app_for(hw_chain(chain)).ok_or_else(|| HwError::unsupported("app"))?;
        let (open, version) = open_app(link, ctl)?;
        if open != name {
            return Err(HwError::WrongApp {
                expected: name.into(),
                open,
            });
        }
        if !version_at_least(&version, min) {
            return Err(HwError::too_old(
                format!("app {name} {version} trop ancienne : mets-la à jour"),
                min,
            ));
        }
        Ok(App { link, ctl, name })
    }

    /// Exchange + status word check (wrong-app codes completed with the open app's name).
    pub fn call(&self, cmd: &[u8], ctx: SwContext) -> HwResult<Vec<u8>> {
        let (data, sw) = self.link.exchange(self.ctl, cmd)?;
        if sw == SW_OK {
            return Ok(data);
        }
        Err(match apdu::sw_error(sw, ctx) {
            HwError::WrongApp { .. } => HwError::WrongApp {
                expected: self.name.into(),
                open: open_app(self.link, self.ctl)
                    .map(|(n, _)| n)
                    .unwrap_or_else(|_| "?".into()),
            },
            e => e,
        })
    }
}

fn open_app(link: &dyn ApduLink, ctl: &Ctl) -> HwResult<(String, String)> {
    let (data, sw) = link.exchange(ctl, &apdu::get_app_and_version())?;
    if sw != SW_OK {
        return Err(apdu::sw_error(sw, SwContext::General));
    }
    apdu::parse_app_and_version(&data)
}

fn link(dev: &dyn HardwareWallet, chain: HwKeyChain) -> HwResult<&dyn ApduLink> {
    dev.apdu_link().ok_or_else(|| {
        HwError::unsupported(format!(
            "{} : pas d'app Trezor pour cette chaîne (Ledger seulement)",
            hw_chain(chain).label()
        ))
    })
}

/// Public key of `chain` at the account's path ([`HwKeyChain::path`]), shown on the device
/// screen when `display` (the user compares it with Kyro's). The app's own address, when it
/// returns one, must be the one of the key.
pub fn pubkey(
    dev: &mut dyn HardwareWallet,
    ctl: &Ctl,
    chain: HwKeyChain,
    account: u32,
    display: bool,
) -> HwResult<Vec<u8>> {
    let app = App::open(link(dev, chain)?, ctl, chain)?;
    if display {
        ctl.prompt(Prompt::ConfirmOnDevice);
    }
    let path = chain.path(account);
    let pk = match chain {
        HwKeyChain::Sui => super::ledger_sui::pubkey(&app, &path, display)?,
        HwKeyChain::Aptos => super::ledger_aptos::pubkey(&app, &path, display)?,
        HwKeyChain::Algo => super::ledger_algo::pubkey(&app, account, display)?,
        HwKeyChain::Near => super::ledger_near::pubkey(&app, &path, display)?,
        HwKeyChain::Cosmos => super::ledger_cosmos::pubkey(&app, &path, display)?,
    };
    // Length and point validity.
    chain
        .address_of(&pk)
        .map_err(|e| HwError::bad(e.to_string()))?;
    Ok(pk)
}

/// Has the device sign `message` (the chain-specific bytes built by `wallet-core`: Sui intent
/// message, Aptos signing message, Algorand msgpack, NEAR Borsh, Cosmos amino JSON) with the
/// account's key. Returns the raw signature (DER for Cosmos), verified by the caller.
pub fn sign(
    dev: &mut dyn HardwareWallet,
    ctl: &Ctl,
    chain: HwKeyChain,
    account: u32,
    message: &[u8],
) -> HwResult<Vec<u8>> {
    let app = App::open(link(dev, chain)?, ctl, chain)?;
    ctl.prompt(Prompt::ConfirmOnDevice);
    let path = chain.path(account);
    match chain {
        HwKeyChain::Sui => super::ledger_sui::sign(&app, &path, message),
        HwKeyChain::Aptos => super::ledger_aptos::sign(&app, &path, message),
        HwKeyChain::Algo => super::ledger_algo::sign(&app, account, message),
        HwKeyChain::Near => super::ledger_near::sign(&app, &path, message),
        HwKeyChain::Cosmos => super::ledger_cosmos::sign(&app, &path, message),
    }
}

/// Plays back a recorded `=> apdu` / `<= response` script (no device attached).
#[cfg(test)]
pub mod replay {
    use std::sync::Mutex;
    use std::time::Duration;

    use super::super::ledger::ApduLink;
    use super::super::ledger_apdu as apdu;
    use super::super::{lock, Ctl, HwError, HwResult};

    pub struct Replay {
        script: Mutex<Vec<(Vec<u8>, Vec<u8>)>>,
    }

    impl Replay {
        pub fn new(lines: &[String]) -> Self {
            let mut script = Vec::new();
            for pair in lines.chunks(2) {
                let req = hex::decode(pair[0].trim_start_matches("=> ")).unwrap();
                let resp = hex::decode(pair[1].trim_start_matches("<= ")).unwrap();
                script.push((req, resp));
            }
            script.reverse();
            Replay {
                script: Mutex::new(script),
            }
        }

        pub fn done(&self) -> bool {
            lock(&self.script).is_empty()
        }
    }

    impl ApduLink for Replay {
        fn exchange(&self, _ctl: &Ctl, apdu_bytes: &[u8]) -> HwResult<(Vec<u8>, u16)> {
            let (req, resp) = lock(&self.script)
                .pop()
                .ok_or_else(|| HwError::bad("script exhausted"))?;
            assert_eq!(hex::encode(apdu_bytes), hex::encode(req), "unexpected APDU");
            apdu::split_sw(resp)
        }
    }

    pub fn ctl() -> Ctl {
        Ctl::for_tests(Duration::from_secs(5))
    }

    /// GET APP AND VERSION exchange answering `name` `version`.
    pub fn app(name: &str, version: &str) -> [String; 2] {
        let mut r = vec![1u8, name.len() as u8];
        r.extend_from_slice(name.as_bytes());
        r.push(version.len() as u8);
        r.extend_from_slice(version.as_bytes());
        r.extend_from_slice(&[1, 0, 0x90, 0x00]);
        ["=> b001000000".into(), format!("<= {}", hex::encode(r))]
    }
}

#[cfg(test)]
mod tests {
    use super::replay::*;
    use super::*;

    #[test]
    fn app_checks() {
        let r = Replay::new(&app("Ethereum", "1.10.0"));
        let ctl = ctl();
        assert_eq!(
            App::open(&r, &ctl, HwKeyChain::Sui).err(),
            Some(HwError::WrongApp {
                expected: "Sui".into(),
                open: "Ethereum".into()
            })
        );
        let r = Replay::new(&app("NEAR", "1.2.1"));
        assert!(matches!(
            App::open(&r, &ctl, HwKeyChain::Near),
            Err(HwError::Unsupported { .. })
        ));
        // Wrong-app status inside a call is completed with the open app's name.
        let mut lines = app("Cosmos", "2.35.0").to_vec();
        lines.push("=> 5504000000".into());
        lines.push("<= 6e00".into());
        lines.extend(app("Bitcoin", "2.1.0"));
        let r = Replay::new(&lines);
        let a = App::open(&r, &ctl, HwKeyChain::Cosmos).unwrap();
        assert_eq!(
            a.call(&[0x55, 0x04, 0, 0, 0], SwContext::General),
            Err(HwError::WrongApp {
                expected: "Cosmos".into(),
                open: "Bitcoin".into()
            })
        );
        assert!(r.done());
    }

    #[test]
    fn statuses() {
        for c in [Chain::Dot, Chain::Hbar, Chain::Kas, Chain::Ton] {
            assert!(!c.implemented());
            assert_eq!(
                unavailable_status(c).unwrap().state,
                ChainState::Unsupported
            );
            assert!(trezor_status(c).is_some());
        }
        for k in HwKeyChain::ALL {
            let c = hw_chain(k);
            assert!(c.implemented());
            assert_eq!(key_chain(c), Some(k));
            assert!(app_for(c).is_some());
            assert!(unavailable(c).is_none());
            assert_eq!(trezor_status(c).unwrap().state, ChainState::Unsupported);
        }
        assert!(trezor_status(Chain::Btc).is_none());
    }
}
