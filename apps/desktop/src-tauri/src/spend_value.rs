// SPDX-License-Identifier: GPL-3.0-or-later
//! What a signature sends out, read from Rust's own decoded summary, and what that is worth.
//!
//! Amounts come from the summary shown in the native dialog and prices from a request Rust makes
//! itself: the interface supplies neither, except for the one case in [`Spend::Undecoded`].

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use wallet_core::{EvmTxKind, Network, SolInstruction, UtxoCoin};

use crate::error::{AppError, AppResult};
use crate::known_tokens::{self, TokenChain};
use crate::net::FetchRequest;
use crate::state::AppState;

const PRICE_TTL: Duration = Duration::from_secs(120);

/// (coin id, currency) → price and when it was read.
type PriceCache = HashMap<(String, String), (f64, Instant)>;

static PRICES: Mutex<Option<PriceCache>> = Mutex::new(None);

/// An unreadable amount is not zero: it must not pass for "nothing leaves".
fn is_zero(raw: &str) -> bool {
    !raw.is_empty() && raw.bytes().all(|b| b == b'0')
}

/// An amount of one coin. `gecko: None` means Kyro has no price for it.
#[derive(Debug, Clone, PartialEq)]
pub struct Coin {
    gecko: Option<String>,
    raw: String,
    decimals: u8,
}

impl Coin {
    pub fn new(gecko: Option<&str>, raw: impl Into<String>, decimals: u8) -> Coin {
        Coin {
            gecko: gecko.filter(|g| !g.is_empty()).map(str::to_owned),
            raw: raw.into(),
            decimals,
        }
    }

    fn empty(&self) -> bool {
        is_zero(&self.raw)
    }

    /// Whole coins, `None` when the amount is not a plain number.
    fn units(&self) -> Option<f64> {
        if self.raw.is_empty() || !self.raw.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let units = self.raw.parse::<f64>().ok()? / 10f64.powi(i32::from(self.decimals));
        units.is_finite().then_some(units)
    }
}

/// What a signature does to the limit.
#[derive(Debug, Clone, PartialEq)]
pub enum Spend {
    /// Nothing leaves: staking, Earn, a trustline, an opt-in, a revoke, a zero-value cancel.
    Free,
    /// Rust read the amounts.
    Coins(Vec<Coin>),
    /// Something leaves and Rust cannot say how much: over the limit whatever the amount.
    Unknown,
    /// Swap calldata Rust cannot read. Without a matching `spend_limit_declare` this is
    /// [`Spend::Unknown`]; with one, the larger of `attached` and the declared amount counts.
    Undecoded {
        attached: Vec<Coin>,
        chain: String,
        payload: String,
    },
}

fn coins(list: Vec<Coin>) -> Spend {
    let list: Vec<Coin> = list.into_iter().filter(|c| !c.empty()).collect();
    if list.is_empty() {
        Spend::Free
    } else {
        Spend::Coins(list)
    }
}

fn one(gecko: &str, raw: &str, decimals: u8) -> Spend {
    coins(vec![Coin::new(Some(gecko), raw, decimals)])
}

fn token(net: Network, chain: TokenChain, id: &str, raw: &str) -> Spend {
    match token_coin(net, chain, id, raw) {
        Some(c) => coins(vec![c]),
        None if is_zero(raw) => Spend::Free,
        None => Spend::Unknown,
    }
}

fn token_coin(net: Network, chain: TokenChain, id: &str, raw: &str) -> Option<Coin> {
    known_tokens::lookup(net, chain, id).map(|t| Coin::new(Some(t.coingecko), raw, t.decimals))
}

/// The two contracts `packages/swap/src/verify.ts` pins as swap entry and ERC-20 spender.
const ZEROX_ALLOWANCE_HOLDER: &str = "0x0000000000001fF3684f28c67538d4D072C22734";
const LIFI_DIAMOND: &str = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";

fn swap_contract(chain_id: u64, address: &str) -> bool {
    let other_diamond = match chain_id {
        14 => Some("0x198FC70Dfe05E755C81e54bd67Bff3F729344B9b"),
        999 => Some("0x0a0758d937d1059c356D4714e57F5df0239bce1A"),
        8_217 => Some("0x1255d17c1BC2f764d087536410879F2d0D8772fD"),
        _ => None,
    };
    [
        Some(ZEROX_ALLOWANCE_HOLDER),
        Some(other_diamond.unwrap_or(LIFI_DIAMOND)),
    ]
    .into_iter()
    .flatten()
    .any(|c| c.eq_ignore_ascii_case(address))
}

fn evm_native(chain_id: u64, raw: &str) -> Coin {
    Coin::new(
        known_tokens::evm_chain(chain_id).map(|c| c.coingecko),
        raw,
        18,
    )
}

/// `earn`: the call is a pinned Earn call (`evm_earn_review`). `data`: the calldata signed.
pub fn evm(net: Network, s: &wallet_core::EvmTxSummary, earn: bool, data: &str) -> Spend {
    if earn {
        return Spend::Free;
    }
    let chain = TokenChain::Evm(s.chain_id);
    let contract = s.token_contract.as_deref().unwrap_or_default();
    match s.kind {
        EvmTxKind::NativeTransfer => coins(vec![evm_native(s.chain_id, &s.amount)]),
        EvmTxKind::Erc20Transfer => match token_coin(net, chain, contract, &s.amount) {
            Some(c) => coins(vec![c, evm_native(s.chain_id, &s.value_wei)]),
            None => Spend::Unknown,
        },
        // An allowance moves nothing by itself, but it lets someone else move funds with no further
        // signature here, so it counts in full. The pinned swap contracts only ever pull from their
        // caller, inside a call that comes back through this gate. So does the pinned Aave pool, and
        // what it pulls stays the user's (Earn does not count).
        EvmTxKind::Erc20Approve => {
            let spender = s.spender.as_deref().unwrap_or_default();
            let aave = crate::earn_evm::aave_pool(s.chain_id)
                .is_some_and(|pool| pool.eq_ignore_ascii_case(spender));
            if aave || swap_contract(s.chain_id, spender) {
                Spend::Free
            } else if s.unlimited_approval {
                Spend::Unknown
            } else {
                token(net, chain, contract, &s.amount)
            }
        }
        EvmTxKind::ContractCall if swap_contract(s.chain_id, &s.to) => Spend::Undecoded {
            attached: vec![evm_native(s.chain_id, &s.value_wei)],
            chain: format!("evm:{}", s.chain_id),
            payload: data.to_owned(),
        },
        EvmTxKind::ContractCall => Spend::Unknown,
    }
}

const BTC: &str = "bitcoin";

/// Outputs that do not come back to this wallet. The fee is not counted.
pub fn btc(s: &wallet_core::BtcTxSummary) -> Spend {
    let sent: u64 = s
        .outputs
        .iter()
        .filter(|o| !o.2)
        .fold(0, |sum, o| sum.saturating_add(o.1));
    one(BTC, &sent.to_string(), 8)
}

pub fn utxo(s: &wallet_core::UtxoTxSummary) -> Spend {
    let gecko = match s.coin {
        UtxoCoin::Litecoin => "litecoin",
        UtxoCoin::Dogecoin => "dogecoin",
        UtxoCoin::BitcoinCash => "bitcoin-cash",
        UtxoCoin::Dash => "dash",
    };
    coins(
        s.outputs
            .iter()
            .filter(|o| !o.is_change)
            .map(|o| Coin::new(Some(gecko), o.amount.as_str(), 8))
            .collect(),
    )
}

/// Reads the instructions Kyro knows. Anything else may move funds: see [`Spend::Undecoded`].
pub fn sol(net: Network, s: &wallet_core::SolTxSummary, me: &str, message: &str) -> Spend {
    let mut out = Vec::new();
    let mut readable = true;
    for i in &s.instructions {
        match i {
            SolInstruction::SystemTransfer { from, lamports, .. } if from == me => {
                out.push(Coin::new(Some("solana"), lamports.as_str(), 9));
            }
            SolInstruction::SystemTransferWithSeed { base, lamports, .. } if base == me => {
                out.push(Coin::new(Some("solana"), lamports.as_str(), 9));
            }
            SolInstruction::TokenTransfer {
                mint: Some(mint),
                amount,
                ..
            } => match token_coin(net, TokenChain::Solana, mint, amount) {
                Some(c) => out.push(c),
                None => readable = false,
            },
            SolInstruction::AtaCreate { .. }
            | SolInstruction::ComputeUnitLimit { .. }
            | SolInstruction::ComputeUnitPrice { .. }
            | SolInstruction::Memo { .. } => {}
            _ => readable = false,
        }
    }
    if readable {
        coins(out)
    } else {
        Spend::Undecoded {
            attached: out,
            chain: "sol".into(),
            payload: message.to_owned(),
        }
    }
}

pub fn algo(s: &wallet_core::AlgoTxSummary) -> Spend {
    match &s.asset {
        None => one("algorand", &s.amount, 6),
        Some(a) if is_zero(&a.amount) => Spend::Free,
        Some(_) => Spend::Unknown,
    }
}

pub fn aptos(net: Network, s: &wallet_core::AptosTxSummary) -> Spend {
    match &s.token {
        None => one("aptos", &s.amount, 8),
        Some(t) => token(net, TokenChain::Aptos, &t.metadata, &s.amount),
    }
}

pub fn ada(s: &wallet_core::CardanoTxSummary) -> Spend {
    let sent: Vec<_> = s.outputs.iter().filter(|o| !o.is_change).collect();
    if sent.iter().any(|o| !o.tokens.is_empty()) {
        return Spend::Unknown;
    }
    coins(
        sent.iter()
            .map(|o| Coin::new(Some("cardano"), o.lovelace.as_str(), 6))
            .collect(),
    )
}

pub fn cosmos(s: &wallet_core::CosmosTxSummary) -> Spend {
    one("cosmos", &s.amount, 6)
}

pub fn dot(s: &wallet_core::DotTxSummary) -> Spend {
    match &s.asset {
        None => one("polkadot", &s.amount, s.decimals),
        Some(_) => Spend::Unknown,
    }
}

pub fn hbar(s: &wallet_core::HbarTxSummary) -> Spend {
    match &s.token {
        None => one("hedera-hashgraph", &s.amount, 8),
        Some(t) if t.associate => Spend::Free,
        Some(_) => Spend::Unknown,
    }
}

pub fn kaspa(s: &wallet_core::KaspaTxSummary) -> Spend {
    one("kaspa", &s.sent, 8)
}

pub fn near(net: Network, s: &wallet_core::NearTxSummary) -> Spend {
    match &s.token {
        None => one("near", &s.deposit, 24),
        Some(t) => token(net, TokenChain::Near, &t.contract, &t.amount),
    }
}

pub fn stellar(net: Network, s: &wallet_core::StellarTxSummary) -> Spend {
    use wallet_core::{StellarAssetView as Asset, StellarOpView as Op};
    match &s.operation {
        Op::CreateAccount {
            starting_balance, ..
        } => one("stellar", starting_balance, 7),
        Op::Payment {
            asset: Asset::Native,
            amount,
            ..
        } => one("stellar", amount, 7),
        Op::Payment {
            asset: Asset::Credit { code, issuer },
            amount,
            ..
        } => token(
            net,
            TokenChain::Stellar,
            &format!("{code}-{issuer}"),
            amount,
        ),
        Op::ChangeTrust { .. } => Spend::Free,
    }
}

pub fn sui(net: Network, s: &wallet_core::SuiTxSummary) -> Spend {
    // "Send everything": the summary does not say how much that is.
    let Some(amount) = &s.amount else {
        return Spend::Unknown;
    };
    match &s.token {
        None => one("sui", amount, 9),
        Some(t) => token(net, TokenChain::Sui, &t.coin_type, amount),
    }
}

pub fn ton(net: Network, s: &wallet_core::TonTxSummary) -> Spend {
    match &s.jetton {
        Some(j) => token(net, TokenChain::Ton, &j.master, &j.amount),
        None if s.send_all => Spend::Unknown,
        None => one("the-open-network", &s.amount, 9),
    }
}

pub fn tron(net: Network, s: &wallet_core::TronTxSummary) -> Spend {
    use wallet_core::TronAction as A;
    match &s.action {
        A::TrxTransfer { amount, .. } => one("tron", amount, 6),
        A::Trc20Transfer {
            contract,
            amount,
            call_value,
            ..
        } => match token_coin(net, TokenChain::Tron, contract, amount) {
            Some(c) => coins(vec![c, Coin::new(Some("tron"), call_value.as_str(), 6)]),
            None => Spend::Unknown,
        },
        A::ContractCall { .. } => Spend::Unknown,
    }
}

pub fn xmr(s: &wallet_core::XmrTxSummary) -> Spend {
    one("monero", &s.amount, 12)
}

pub fn xrp(s: &wallet_core::XrpTxSummary) -> Spend {
    match (&s.amount, &s.send_max) {
        (wallet_core::XrpAmountView::Xrp { drops }, None) => one("ripple", drops, 6),
        _ => Spend::Unknown,
    }
}

pub fn zec(s: &wallet_core::ZecTxSummary) -> Spend {
    one("zcash", &s.amount, 8)
}

/// The coin a swap says it sells: `chain` is `evm:<id>` or `sol`, `contract` the token (none for the
/// native coin). The price id and decimals come from Rust's tables; a token it does not list gets
/// no price, so the swap stays over the limit.
pub fn declared_coin(
    net: Network,
    chain: &str,
    contract: Option<&str>,
    raw: String,
) -> AppResult<Coin> {
    if chain == "sol" {
        return Ok(match contract {
            None => Coin::new(Some("solana"), raw, 9),
            Some(mint) => token_coin(net, TokenChain::Solana, mint, &raw)
                .unwrap_or_else(|| Coin::new(None, raw, 0)),
        });
    }
    let id: u64 = chain
        .strip_prefix("evm:")
        .and_then(|c| c.parse().ok())
        .ok_or_else(|| AppError::InvalidInput("unknown chain".into()))?;
    Ok(match contract {
        None => evm_native(id, &raw),
        Some(c) => {
            token_coin(net, TokenChain::Evm(id), c, &raw).unwrap_or_else(|| Coin::new(None, raw, 0))
        }
    })
}

fn price_of(raw: &serde_json::Value, id: &str, currency: &str) -> Option<f64> {
    let p = raw.get(id)?.get(currency.to_ascii_lowercase())?.as_f64()?;
    (p.is_finite() && p > 0.0).then_some(p)
}

fn cached(id: &str, currency: &str) -> Option<f64> {
    let cache = PRICES.lock().unwrap_or_else(|e| e.into_inner());
    let (price, at) = cache.as_ref()?.get(&(id.to_owned(), currency.to_owned()))?;
    (at.elapsed() < PRICE_TTL).then_some(*price)
}

fn remember(id: &str, currency: &str, price: f64) {
    let mut cache = PRICES.lock().unwrap_or_else(|e| e.into_inner());
    cache.get_or_insert_with(HashMap::new).insert(
        (id.to_owned(), currency.to_owned()),
        (price, Instant::now()),
    );
}

/// Prices of `ids` in `currency`, `None` as soon as one is missing.
async fn prices(state: &AppState, ids: &[&str], currency: &str) -> Option<HashMap<String, f64>> {
    let mut out = HashMap::new();
    let missing: Vec<&str> = ids
        .iter()
        .copied()
        .filter(|id| match cached(id, currency) {
            Some(p) => {
                out.insert((*id).to_owned(), p);
                false
            }
            None => true,
        })
        .collect();
    if !missing.is_empty() {
        let req = FetchRequest {
            url: format!(
                "https://api.coingecko.com/api/v3/simple/price?ids={}&vs_currencies={}",
                missing.join(","),
                currency.to_ascii_lowercase()
            ),
            method: "GET".into(),
            headers: HashMap::new(),
            body: None,
        };
        let settings = state.settings();
        let res = state
            .net
            .fetch(req, &settings, &state.env_keys, state.network)
            .await
            .ok()?;
        if res.status != 200 {
            return None;
        }
        let body: serde_json::Value = serde_json::from_str(&res.body).ok()?;
        for id in missing {
            let p = price_of(&body, id, currency)?;
            remember(id, currency, p);
            out.insert(id.to_owned(), p);
        }
    }
    Some(out)
}

fn total(list: &[Coin], prices: &HashMap<String, f64>) -> Option<f64> {
    let mut sum = 0.0;
    for c in list {
        sum += c.units()? * prices.get(c.gecko.as_deref()?)?;
    }
    sum.is_finite().then_some(sum)
}

/// Value of `list` in `currency`, `None` when any part of it is unknown.
pub async fn fiat_value(state: &AppState, list: &[Coin], currency: &str) -> Option<f64> {
    let list: Vec<Coin> = list.iter().filter(|c| !c.empty()).cloned().collect();
    let mut ids: Vec<&str> = Vec::new();
    for c in &list {
        let id = c.gecko.as_deref()?;
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    if ids.is_empty() {
        return Some(0.0);
    }
    total(&list, &prices(state, &ids, currency).await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    const USDC: &str = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

    fn evm_summary(kind: EvmTxKind) -> wallet_core::EvmTxSummary {
        wallet_core::EvmTxSummary {
            kind,
            to: "0x000000000000000000000000000000000000dEaD".into(),
            token_contract: None,
            amount: "1000000000000000000".into(),
            spender: None,
            unlimited_approval: false,
            max_fee_wei: "0".into(),
            chain_id: 1,
            value_wei: "0".into(),
            warnings: Vec::new(),
            requires_extra_confirmation: false,
        }
    }

    fn eth(raw: &str) -> Coin {
        Coin::new(Some("ethereum"), raw, 18)
    }

    #[test]
    fn an_approval_of_the_pinned_aave_pool_is_free_on_its_own_chain_only() {
        let approval = |chain_id: u64, spender: &str| wallet_core::EvmTxSummary {
            chain_id,
            spender: Some(spender.to_owned()),
            token_contract: Some(USDC.to_owned()),
            ..evm_summary(EvmTxKind::Erc20Approve)
        };
        let pool = crate::earn_evm::AAVE_V3_POOL
            .to_uppercase()
            .replace("0X", "0x");
        assert!(matches!(
            evm(Network::Mainnet, &approval(1, &pool), false, "0x"),
            Spend::Free
        ));
        assert!(!matches!(
            evm(Network::Mainnet, &approval(42_161, &pool), false, "0x"),
            Spend::Free
        ));
    }

    #[test]
    fn value_is_amount_times_price_and_fails_closed() {
        let p = HashMap::from([
            ("ethereum".to_owned(), 2000.0),
            ("usd-coin".to_owned(), 1.0),
        ]);
        let a = eth("1500000000000000000");
        let b = Coin::new(Some("usd-coin"), "2500000", 6);
        assert_eq!(total(&[a.clone(), b], &p), Some(3002.5));

        assert_eq!(total(&[Coin::new(None, "1", 0)], &p), None, "no price id");
        assert_eq!(
            total(&[Coin::new(Some("bitcoin"), "1", 8)], &p),
            None,
            "no price for this coin"
        );
        assert_eq!(total(&[Coin::new(Some("ethereum"), "1.5", 18)], &p), None);
        assert_eq!(total(&[Coin::new(Some("ethereum"), "", 18)], &p), None);
        assert_eq!(
            total(&[a, Coin::new(None, "5", 0)], &p),
            None,
            "one unknown part"
        );
    }

    #[test]
    fn an_unreadable_amount_is_not_free() {
        assert_eq!(
            one("bitcoin", "", 8),
            Spend::Coins(vec![Coin::new(Some("bitcoin"), "", 8)])
        );
        assert_eq!(one("bitcoin", "000", 8), Spend::Free);
    }

    #[test]
    fn huge_amounts_do_not_turn_into_a_small_number() {
        let p = HashMap::from([("ethereum".to_owned(), 2000.0)]);
        let max = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
        assert!(total(&[eth(max)], &p).unwrap() > 1e50);
        assert_eq!(
            total(&[Coin::new(Some("ethereum"), "9".repeat(400), 18)], &p),
            None
        );
    }

    #[test]
    fn a_price_answer_is_read_strictly() {
        let body = serde_json::json!({ "bitcoin": { "eur": 50000.5 }, "dai": { "eur": 0 }, "x": { "eur": "1" } });
        assert_eq!(price_of(&body, "bitcoin", "EUR"), Some(50000.5));
        assert_eq!(price_of(&body, "bitcoin", "USD"), None);
        assert_eq!(price_of(&body, "dai", "EUR"), None);
        assert_eq!(price_of(&body, "x", "EUR"), None);
        assert_eq!(price_of(&body, "solana", "EUR"), None);
    }

    #[test]
    fn evm_sends_are_read_from_the_summary() {
        let n = Network::Mainnet;
        assert_eq!(
            evm(n, &evm_summary(EvmTxKind::NativeTransfer), false, "0x"),
            Spend::Coins(vec![eth("1000000000000000000")])
        );
        let mut zero = evm_summary(EvmTxKind::NativeTransfer);
        zero.amount = "0".into();
        assert_eq!(
            evm(n, &zero, false, "0x"),
            Spend::Free,
            "a cancel moves nothing"
        );

        let mut t = evm_summary(EvmTxKind::Erc20Transfer);
        t.token_contract = Some(USDC.into());
        t.amount = "5000000".into();
        assert_eq!(
            evm(n, &t, false, "0x"),
            Spend::Coins(vec![Coin::new(Some("usd-coin"), "5000000", 6)])
        );
        t.token_contract = Some("0x000000000000000000000000000000000000bEEF".into());
        assert_eq!(evm(n, &t, false, "0x"), Spend::Unknown, "unlisted token");
    }

    #[test]
    fn earn_does_not_count() {
        let s = evm_summary(EvmTxKind::ContractCall);
        assert_eq!(evm(Network::Mainnet, &s, true, "0xdata"), Spend::Free);
    }

    #[test]
    fn a_call_to_an_unknown_contract_is_over_the_limit() {
        let s = evm_summary(EvmTxKind::ContractCall);
        assert_eq!(evm(Network::Mainnet, &s, false, "0xdata"), Spend::Unknown);
    }

    #[test]
    fn only_the_pinned_swap_contracts_can_take_a_declared_amount() {
        let mut s = evm_summary(EvmTxKind::ContractCall);
        s.to = ZEROX_ALLOWANCE_HOLDER.to_lowercase();
        s.value_wei = "7".into();
        assert_eq!(
            evm(Network::Mainnet, &s, false, "0xdata"),
            Spend::Undecoded {
                attached: vec![eth("7")],
                chain: "evm:1".into(),
                payload: "0xdata".into(),
            }
        );
        assert!(swap_contract(8_453, LIFI_DIAMOND));
        assert!(!swap_contract(14, LIFI_DIAMOND), "Flare has its own");
        assert!(swap_contract(
            14,
            "0x198FC70Dfe05E755C81e54bd67Bff3F729344B9b"
        ));
    }

    #[test]
    fn an_allowance_counts_unless_it_goes_to_a_swap_contract() {
        let n = Network::Mainnet;
        let mut a = evm_summary(EvmTxKind::Erc20Approve);
        a.token_contract = Some(USDC.into());
        a.spender = Some("0x000000000000000000000000000000000000bEEF".into());
        a.amount = "5000000".into();
        assert_eq!(
            evm(n, &a, false, "0x"),
            Spend::Coins(vec![Coin::new(Some("usd-coin"), "5000000", 6)])
        );

        a.amount = "0".into();
        assert_eq!(evm(n, &a, false, "0x"), Spend::Free, "a revoke");

        a.amount = "5000000".into();
        a.unlimited_approval = true;
        assert_eq!(evm(n, &a, false, "0x"), Spend::Unknown);

        a.spender = Some(ZEROX_ALLOWANCE_HOLDER.into());
        assert_eq!(evm(n, &a, false, "0x"), Spend::Free);
    }

    #[test]
    fn bitcoin_counts_what_leaves_not_the_change() {
        let s = wallet_core::BtcTxSummary {
            outputs: vec![
                ("bc1a".into(), 10_000, false),
                ("bc1b".into(), 90_000, true),
                ("bc1c".into(), 5_000, false),
            ],
            fee_sats: 300,
            warnings: Vec::new(),
            requires_extra_confirmation: false,
        };
        assert_eq!(
            btc(&s),
            Spend::Coins(vec![Coin::new(Some("bitcoin"), "15000", 8)])
        );
    }

    #[test]
    fn declared_swaps_are_priced_from_rust_tables() {
        let n = Network::Mainnet;
        let c = declared_coin(n, "evm:1", Some(USDC), "5000000".into()).unwrap();
        assert_eq!(c, Coin::new(Some("usd-coin"), "5000000", 6));
        assert_eq!(
            declared_coin(n, "evm:137", None, "1".into()).unwrap(),
            Coin::new(Some("polygon-ecosystem-token"), "1", 18)
        );
        assert_eq!(
            declared_coin(n, "sol", None, "1".into()).unwrap(),
            Coin::new(Some("solana"), "1", 9)
        );
        let unlisted = declared_coin(n, "sol", Some("nope"), "1".into()).unwrap();
        assert_eq!(unlisted.gecko, None);
        assert!(declared_coin(n, "btc", None, "1".into()).is_err());
    }
}
