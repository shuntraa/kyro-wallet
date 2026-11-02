//! Earn on Ethereum (docs/IPC.md §2.8): Lido liquid staking (`submit`) and Aave v3 lending
//! (`supply` / `withdraw`). Rust builds the calldata itself (`earn_evm_build`) and recognises it
//! again in `evm_sign_tx`, so the native window names the contract and the function. Every
//! contract is PINNED here and was checked on-chain (2026-11-03, Ethereum mainnet): the Aave
//! reserves by `Pool.getReserveData(asset).aTokenAddress`, stETH by `symbol() == "stETH"`.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::accounts::account_arg;
use crate::commands::format_units_in;
use crate::error::{AppError, AppResult};
use crate::i18n::Lang;
use crate::state::AppState;

/// Ethereum mainnet (Lido; Aave core market).
pub const EARN_CHAIN_ID: u64 = 1;
/// Lido stETH (ERC-20 + `submit(address)` entry point).
pub const LIDO_STETH: &str = "0xae7ab96520de3a18e5e111b5eaab095312d7fe84";
/// Aave v3 Pool, Ethereum core market.
pub const AAVE_V3_POOL: &str = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2";
/// Aave v3 Pool on Arbitrum One and Polygon PoS (same deployment address on both).
pub const AAVE_V3_POOL_ARB_POLYGON: &str = "0x794a61358d6845594f94dc1db02a252b5b4814ad";
/// Aave v3 Pool on Base.
pub const AAVE_V3_POOL_BASE: &str = "0xa238dd80c259a72e81d7e4664a9801593f98d1c5";

/// The pinned Aave v3 Pool of `chain_id`.
pub fn aave_pool(chain_id: u64) -> Option<&'static str> {
    match chain_id {
        1 => Some(AAVE_V3_POOL),
        42_161 | 137 => Some(AAVE_V3_POOL_ARB_POLYGON),
        8_453 => Some(AAVE_V3_POOL_BASE),
        _ => None,
    }
}

/// An Aave v3 reserve Kyro offers: underlying token and its aToken (pinned, checked on-chain).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AaveReserve {
    pub chain_id: u64,
    pub symbol: &'static str,
    pub decimals: u8,
    pub asset: &'static str,
    pub a_token: &'static str,
}

pub const AAVE_V3_RESERVES: &[AaveReserve] = &[
    AaveReserve {
        chain_id: 1,
        symbol: "USDT",
        decimals: 6,
        asset: "0xdac17f958d2ee523a2206206994597c13d831ec7",
        a_token: "0x23878914efe38d27c4d67ab83ed1b93a74d4086a",
    },
    AaveReserve {
        chain_id: 1,
        symbol: "USDC",
        decimals: 6,
        asset: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        a_token: "0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c",
    },
    AaveReserve {
        chain_id: 1,
        symbol: "DAI",
        decimals: 18,
        asset: "0x6b175474e89094c44da98b954eedeac495271d0f",
        a_token: "0x018008bfb33d285247a21d44e50697654f754e63",
    },
    AaveReserve {
        chain_id: 1,
        symbol: "WETH",
        decimals: 18,
        asset: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        a_token: "0x4d5f47fa6a74757f35c14fd3a6ef8e3c9bc514e8",
    },
    AaveReserve {
        chain_id: 42_161,
        symbol: "USDT",
        decimals: 6,
        asset: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9",
        a_token: "0x6ab707aca953edaefbc4fd23ba73294241490620",
    },
    AaveReserve {
        chain_id: 42_161,
        symbol: "USDC",
        decimals: 6,
        asset: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
        a_token: "0x724dc807b04555b71ed48a6896b6f41593b8c637",
    },
    AaveReserve {
        chain_id: 8_453,
        symbol: "USDC",
        decimals: 6,
        asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        a_token: "0x4e65fe4dba92790696d040ac24aa414708f5c0ab",
    },
    AaveReserve {
        chain_id: 137,
        symbol: "USDT",
        decimals: 6,
        asset: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
        a_token: "0x6ab707aca953edaefbc4fd23ba73294241490620",
    },
    AaveReserve {
        chain_id: 137,
        symbol: "USDC",
        decimals: 6,
        asset: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
        a_token: "0xa4d94019934d8333ef880abffbf2fdd611c762bd",
    },
];

/// `submit(address _referral)`.
pub const SEL_LIDO_SUBMIT: [u8; 4] = [0xa1, 0x90, 0x3e, 0xab];
/// `supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)`.
pub const SEL_AAVE_SUPPLY: [u8; 4] = [0x61, 0x7b, 0xa0, 0x37];
/// `withdraw(address asset, uint256 amount, address to)`.
pub const SEL_AAVE_WITHDRAW: [u8; 4] = [0x69, 0x32, 0x8d, 0xec];

/// Name of a pinned Earn contract (spender label in approvals), `None` otherwise.
pub fn contract_name(chain_id: u64, address: &str) -> Option<&'static str> {
    let a = address.to_ascii_lowercase();
    if aave_pool(chain_id) == Some(a.as_str()) {
        Some("Aave v3 Pool")
    } else if chain_id == EARN_CHAIN_ID && a == LIDO_STETH {
        Some("Lido stETH")
    } else {
        None
    }
}

fn reserve_by_symbol(chain_id: u64, symbol: &str) -> Option<&'static AaveReserve> {
    AAVE_V3_RESERVES
        .iter()
        .find(|r| r.chain_id == chain_id && r.symbol == symbol)
}

fn reserve_by_asset(chain_id: u64, asset: &str) -> Option<&'static AaveReserve> {
    let a = asset.to_ascii_lowercase();
    AAVE_V3_RESERVES
        .iter()
        .find(|r| r.chain_id == chain_id && r.asset == a)
}

fn default_chain() -> u64 {
    EARN_CHAIN_ID
}

/// What the interface asks Rust to build.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EarnAction {
    /// Stake `amount` wei of ETH with Lido (receives stETH).
    LidoStake { amount: String },
    /// Supply `amount` raw units of `asset` (symbol) to Aave v3.
    AaveSupply {
        asset: String,
        amount: String,
        #[serde(default = "default_chain")]
        chain_id: u64,
    },
    /// Withdraw `amount` raw units (`None` = everything) of `asset` from Aave v3.
    AaveWithdraw {
        asset: String,
        amount: Option<String>,
        #[serde(default = "default_chain")]
        chain_id: u64,
    },
}

/// A recognised Earn call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EarnCall {
    LidoSubmit {
        amount_wei: u128,
    },
    AaveSupply {
        reserve: &'static AaveReserve,
        amount: u128,
        on_behalf_of: String,
    },
    /// `amount: None` = `type(uint256).max` (everything).
    AaveWithdraw {
        reserve: &'static AaveReserve,
        amount: Option<u128>,
        to: String,
    },
}

impl EarnCall {
    /// The account that receives the position or the funds (must be the signer).
    pub fn beneficiary(&self) -> Option<&str> {
        match self {
            EarnCall::LidoSubmit { .. } => None,
            EarnCall::AaveSupply { on_behalf_of, .. } => Some(on_behalf_of),
            EarnCall::AaveWithdraw { to, .. } => Some(to),
        }
    }
}

fn parse_amount(s: &str) -> AppResult<u128> {
    if s.is_empty() || s.len() > 39 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return Err(AppError::InvalidInput("amount: decimal integer".into()));
    }
    let v = s
        .parse::<u128>()
        .map_err(|_| AppError::InvalidInput("amount too large".into()))?;
    if v == 0 {
        return Err(AppError::InvalidInput("amount must be > 0".into()));
    }
    Ok(v)
}

fn addr_word(addr: &str) -> AppResult<[u8; 32]> {
    let h = addr
        .strip_prefix("0x")
        .ok_or_else(|| AppError::InvalidInput("address".into()))?;
    let mut w = [0u8; 32];
    hex::decode_to_slice(h, &mut w[12..]).map_err(|_| AppError::InvalidInput("address".into()))?;
    Ok(w)
}

fn u128_word(v: u128) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&v.to_be_bytes());
    w
}

/// Built call: `to`, `0x` calldata, native value in wei.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EarnBuilt {
    pub to: String,
    pub data: String,
    pub value_wei: String,
}

/// Builds the call for `action`, `owner` being the signer's own address.
pub fn build(action: &EarnAction, owner: &str) -> AppResult<EarnBuilt> {
    let owner = owner.to_ascii_lowercase();
    let mut data = Vec::with_capacity(4 + 32 * 4);
    let (to, value) = match action {
        EarnAction::LidoStake { amount } => {
            let v = parse_amount(amount)?;
            data.extend_from_slice(&SEL_LIDO_SUBMIT);
            data.extend_from_slice(&[0u8; 32]); // no referral
            (LIDO_STETH, v)
        }
        EarnAction::AaveSupply {
            asset,
            amount,
            chain_id,
        } => {
            let r = reserve_by_symbol(*chain_id, asset)
                .ok_or_else(|| AppError::InvalidInput("unknown Aave asset".into()))?;
            data.extend_from_slice(&SEL_AAVE_SUPPLY);
            data.extend_from_slice(&addr_word(r.asset)?);
            data.extend_from_slice(&u128_word(parse_amount(amount)?));
            data.extend_from_slice(&addr_word(&owner)?);
            data.extend_from_slice(&[0u8; 32]); // referralCode 0
            (aave_pool(r.chain_id).unwrap_or_default(), 0)
        }
        EarnAction::AaveWithdraw {
            asset,
            amount,
            chain_id,
        } => {
            let r = reserve_by_symbol(*chain_id, asset)
                .ok_or_else(|| AppError::InvalidInput("unknown Aave asset".into()))?;
            data.extend_from_slice(&SEL_AAVE_WITHDRAW);
            data.extend_from_slice(&addr_word(r.asset)?);
            match amount {
                Some(a) => data.extend_from_slice(&u128_word(parse_amount(a)?)),
                None => data.extend_from_slice(&[0xffu8; 32]),
            }
            data.extend_from_slice(&addr_word(&owner)?);
            (aave_pool(r.chain_id).unwrap_or_default(), 0)
        }
    };
    Ok(EarnBuilt {
        to: to.to_owned(),
        data: format!("0x{}", hex::encode(data)),
        value_wei: value.to_string(),
    })
}

fn word_addr(w: &[u8]) -> Option<String> {
    (w[..12].iter().all(|b| *b == 0)).then(|| format!("0x{}", hex::encode(&w[12..])))
}

fn word_u128(w: &[u8]) -> Option<u128> {
    if !w[..16].iter().all(|b| *b == 0) {
        return None;
    }
    Some(u128::from_be_bytes(w[16..].try_into().ok()?))
}

/// Recognises a pinned Earn call (strict ABI shape), `None` for anything else.
pub fn decode(chain_id: u64, to: &str, value_wei: &str, data_hex: &str) -> Option<EarnCall> {
    let to = to.to_ascii_lowercase();
    let data = hex::decode(data_hex.strip_prefix("0x").unwrap_or(data_hex)).ok()?;
    if data.len() < 4 {
        return None;
    }
    let (sel, args) = data.split_at(4);
    let words: Vec<&[u8]> = args.chunks(32).collect();
    if args.len() % 32 != 0 {
        return None;
    }
    if chain_id == EARN_CHAIN_ID && to == LIDO_STETH && sel == SEL_LIDO_SUBMIT && words.len() == 1 {
        // Referral must be the zero address (what Kyro builds).
        if words[0].iter().any(|b| *b != 0) {
            return None;
        }
        let v = value_wei.parse::<u128>().ok().filter(|v| *v > 0)?;
        return Some(EarnCall::LidoSubmit { amount_wei: v });
    }
    if aave_pool(chain_id) != Some(to.as_str()) || value_wei != "0" {
        return None;
    }
    if sel == SEL_AAVE_SUPPLY && words.len() == 4 {
        let reserve = reserve_by_asset(chain_id, &word_addr(words[0])?)?;
        let amount = word_u128(words[1]).filter(|v| *v > 0)?;
        let on_behalf_of = word_addr(words[2])?;
        if words[3].iter().any(|b| *b != 0) {
            return None;
        }
        return Some(EarnCall::AaveSupply {
            reserve,
            amount,
            on_behalf_of,
        });
    }
    if sel == SEL_AAVE_WITHDRAW && words.len() == 3 {
        let reserve = reserve_by_asset(chain_id, &word_addr(words[0])?)?;
        let amount = if words[1].iter().all(|b| *b == 0xff) {
            None
        } else {
            Some(word_u128(words[1]).filter(|v| *v > 0)?)
        };
        let to = word_addr(words[2])?;
        return Some(EarnCall::AaveWithdraw {
            reserve,
            amount,
            to,
        });
    }
    None
}

fn checksum(a: &str) -> String {
    wallet_core::evm_checksum_address(a).unwrap_or_else(|_| a.to_owned())
}

/// Native-window lines: contract (name + address), function, amounts.
pub fn describe(lang: Lang, c: &EarnCall) -> String {
    let units = |v: u128, d: u8| format_units_in(lang, &v.to_string(), d as usize);
    match c {
        EarnCall::LidoSubmit { amount_wei } => format!(
            "{}Lido stETH ({})\n{}submit\n{}{} ETH\n{}",
            lang.pick("Contrat : ", "Contract: "),
            checksum(LIDO_STETH),
            lang.pick("Fonction : ", "Function: "),
            lang.pick("Mise en staking : ", "Stake: "),
            units(*amount_wei, 18),
            lang.pick(
                "Tu reçois du stETH (≈ 1 stETH par ETH), dont le solde augmente avec les récompenses.\n",
                "You receive stETH (≈ 1 stETH per ETH), whose balance grows with the rewards.\n"
            ),
        ),
        EarnCall::AaveSupply { reserve, amount, on_behalf_of } => format!(
            "{}Aave v3 Pool ({})\n{}supply\n{}{} {} ({})\n{}{}\n",
            lang.pick("Contrat : ", "Contract: "),
            checksum(aave_pool(reserve.chain_id).unwrap_or_default()),
            lang.pick("Fonction : ", "Function: "),
            lang.pick("Dépôt : ", "Deposit: "),
            units(*amount, reserve.decimals),
            reserve.symbol,
            checksum(reserve.asset),
            lang.pick("Position au nom de : ", "Position owner: "),
            checksum(on_behalf_of),
        ),
        EarnCall::AaveWithdraw { reserve, amount, to } => format!(
            "{}Aave v3 Pool ({})\n{}withdraw\n{}{} {} ({})\n{}{}\n",
            lang.pick("Contrat : ", "Contract: "),
            checksum(aave_pool(reserve.chain_id).unwrap_or_default()),
            lang.pick("Fonction : ", "Function: "),
            lang.pick("Retrait : ", "Withdraw: "),
            amount.map_or_else(
                || lang.pick("TOUT", "ALL").to_owned(),
                |a| units(a, reserve.decimals)
            ),
            reserve.symbol,
            checksum(reserve.asset),
            lang.pick("Vers : ", "To: "),
            checksum(to),
        ),
    }
}

#[tauri::command]
pub fn earn_evm_build(
    state: State<'_, AppState>,
    action: EarnAction,
    account: Option<u32>,
) -> AppResult<EarnBuilt> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    if state.network != wallet_core::Network::Mainnet {
        return Err(AppError::InvalidInput(
            "Earn (Lido, Aave) is only available on mainnet".into(),
        ));
    }
    let a = account_arg(account)?;
    let owner = state.with_seed(|seed| Ok(wallet_core::evm_address(seed, a)?))?;
    build(&action, &owner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha3::{Digest, Keccak256};

    const ME: &str = "0x1111111111111111111111111111111111111111";

    fn sel(sig: &str) -> [u8; 4] {
        let h = Keccak256::digest(sig.as_bytes());
        [h[0], h[1], h[2], h[3]]
    }

    #[test]
    fn selectors_match_signatures() {
        assert_eq!(SEL_LIDO_SUBMIT, sel("submit(address)"));
        assert_eq!(
            SEL_AAVE_SUPPLY,
            sel("supply(address,uint256,address,uint16)")
        );
        assert_eq!(SEL_AAVE_WITHDRAW, sel("withdraw(address,uint256,address)"));
    }

    #[test]
    fn pinned_addresses() {
        // Checked on Ethereum mainnet on 2026-11-03 (see module docs). Any change must be re-verified.
        assert_eq!(LIDO_STETH, "0xae7ab96520de3a18e5e111b5eaab095312d7fe84");
        assert_eq!(AAVE_V3_POOL, "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2");
        let pinned: Vec<(&str, &str, &str, u8)> = AAVE_V3_RESERVES
            .iter()
            .filter(|r| r.chain_id == 1)
            .map(|r| (r.symbol, r.asset, r.a_token, r.decimals))
            .collect();
        assert_eq!(
            pinned,
            vec![
                (
                    "USDT",
                    "0xdac17f958d2ee523a2206206994597c13d831ec7",
                    "0x23878914efe38d27c4d67ab83ed1b93a74d4086a",
                    6
                ),
                (
                    "USDC",
                    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
                    "0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c",
                    6
                ),
                (
                    "DAI",
                    "0x6b175474e89094c44da98b954eedeac495271d0f",
                    "0x018008bfb33d285247a21d44e50697654f754e63",
                    18
                ),
                (
                    "WETH",
                    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
                    "0x4d5f47fa6a74757f35c14fd3a6ef8e3c9bc514e8",
                    18
                ),
            ]
        );
        for a in [LIDO_STETH, AAVE_V3_POOL]
            .into_iter()
            .chain(AAVE_V3_RESERVES.iter().flat_map(|r| [r.asset, r.a_token]))
        {
            assert!(wallet_core::evm_checksum_address(a).is_ok(), "{a}");
        }
        assert_eq!(
            contract_name(1, "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"),
            Some("Aave v3 Pool")
        );
        assert_eq!(contract_name(137, AAVE_V3_POOL), None);
        // L2 markets, checked on-chain 2026-11-03 (Pool.getReserveData(asset).aTokenAddress).
        let l2: Vec<(u64, &str, &str, &str)> = AAVE_V3_RESERVES
            .iter()
            .filter(|r| r.chain_id != 1)
            .map(|r| (r.chain_id, r.symbol, r.asset, r.a_token))
            .collect();
        assert_eq!(
            l2,
            vec![
                (
                    42_161,
                    "USDT",
                    "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9",
                    "0x6ab707aca953edaefbc4fd23ba73294241490620"
                ),
                (
                    42_161,
                    "USDC",
                    "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
                    "0x724dc807b04555b71ed48a6896b6f41593b8c637"
                ),
                (
                    8_453,
                    "USDC",
                    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
                    "0x4e65fe4dba92790696d040ac24aa414708f5c0ab"
                ),
                (
                    137,
                    "USDT",
                    "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
                    "0x6ab707aca953edaefbc4fd23ba73294241490620"
                ),
                (
                    137,
                    "USDC",
                    "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
                    "0xa4d94019934d8333ef880abffbf2fdd611c762bd"
                ),
            ]
        );
        assert_eq!(
            aave_pool(42_161),
            Some("0x794a61358d6845594f94dc1db02a252b5b4814ad")
        );
        assert_eq!(
            aave_pool(8_453),
            Some("0xa238dd80c259a72e81d7e4664a9801593f98d1c5")
        );
        assert_eq!(aave_pool(10), None);
    }

    #[test]
    fn lido_submit_fixture() {
        let b = build(
            &EarnAction::LidoStake {
                amount: "1000000000000000000".into(),
            },
            ME,
        )
        .unwrap();
        assert_eq!(b.to, LIDO_STETH);
        assert_eq!(b.value_wei, "1000000000000000000");
        assert_eq!(b.data, format!("0xa1903eab{}", "0".repeat(64)));
        assert_eq!(
            decode(1, &b.to, &b.value_wei, &b.data),
            Some(EarnCall::LidoSubmit {
                amount_wei: 10u128.pow(18)
            })
        );
        // Wrong chain, zero value, non-zero referral: not recognised.
        assert_eq!(decode(10, &b.to, &b.value_wei, &b.data), None);
        assert_eq!(decode(1, &b.to, "0", &b.data), None);
        let referral = format!("0xa1903eab{}{}", "0".repeat(24), "22".repeat(20));
        assert_eq!(decode(1, &b.to, "1", &referral), None);
    }

    #[test]
    fn aave_supply_fixture() {
        let b = build(
            &EarnAction::AaveSupply {
                asset: "USDT".into(),
                amount: "25000000".into(),
                chain_id: 1,
            },
            ME,
        )
        .unwrap();
        assert_eq!(b.to, AAVE_V3_POOL);
        assert_eq!(b.value_wei, "0");
        assert_eq!(
            b.data,
            concat!(
                "0x617ba037",
                "000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec7",
                "00000000000000000000000000000000000000000000000000000000017d7840",
                "0000000000000000000000001111111111111111111111111111111111111111",
                "0000000000000000000000000000000000000000000000000000000000000000",
            )
        );
        let c = decode(1, &b.to, "0", &b.data).unwrap();
        assert_eq!(c.beneficiary(), Some(ME));
        assert!(
            matches!(c, EarnCall::AaveSupply { reserve, amount: 25_000_000, .. } if reserve.symbol == "USDT")
        );
        let text = describe(Lang::En, &c);
        assert!(
            text.contains("Aave v3 Pool") && text.contains("supply") && text.contains("25 USDT"),
            "{text}"
        );
        // Unknown reserve, value attached, extra word: not recognised.
        let other = b.data.replace(
            "dac17f958d2ee523a2206206994597c13d831ec7",
            "2222222222222222222222222222222222222222",
        );
        assert_eq!(decode(1, &b.to, "0", &other), None);
        assert_eq!(decode(1, &b.to, "1", &b.data), None);
        assert_eq!(
            decode(1, &b.to, "0", &format!("{}{}", b.data, "0".repeat(64))),
            None
        );
    }

    #[test]
    fn aave_withdraw_fixture() {
        let all = build(
            &EarnAction::AaveWithdraw {
                asset: "USDC".into(),
                amount: None,
                chain_id: 1,
            },
            ME,
        )
        .unwrap();
        assert_eq!(
            all.data,
            format!(
                "0x69328dec000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48{}0000000000000000000000001111111111111111111111111111111111111111",
                "f".repeat(64)
            )
        );
        let c = decode(1, &all.to, "0", &all.data).unwrap();
        assert!(matches!(c, EarnCall::AaveWithdraw { amount: None, .. }));
        assert!(describe(Lang::Fr, &c).contains("TOUT"));
        let some = build(
            &EarnAction::AaveWithdraw {
                asset: "DAI".into(),
                amount: Some("5".into()),
                chain_id: 1,
            },
            ME,
        )
        .unwrap();
        assert!(matches!(
            decode(1, &some.to, "0", &some.data),
            Some(EarnCall::AaveWithdraw {
                amount: Some(5),
                ..
            })
        ));
    }

    #[test]
    fn aave_l2_fixture() {
        // Polygon USDC: pinned pool of that chain, reserve of that chain only.
        let b = build(
            &EarnAction::AaveSupply {
                asset: "USDC".into(),
                amount: "1000000".into(),
                chain_id: 137,
            },
            ME,
        )
        .unwrap();
        assert_eq!(b.to, AAVE_V3_POOL_ARB_POLYGON);
        assert!(b.data.contains("3c499c542cef5e3811e1192ce70d8cc03d5c3359"));
        assert!(matches!(
            decode(137, &b.to, "0", &b.data),
            Some(EarnCall::AaveSupply { reserve, .. }) if reserve.chain_id == 137
        ));
        // Same calldata on another chain or to the Ethereum pool: not recognised.
        assert_eq!(decode(42_161, &b.to, "0", &b.data), None);
        assert_eq!(decode(1, AAVE_V3_POOL, "0", &b.data), None);
        let base = build(
            &EarnAction::AaveWithdraw {
                asset: "USDC".into(),
                amount: None,
                chain_id: 8_453,
            },
            ME,
        )
        .unwrap();
        assert_eq!(base.to, AAVE_V3_POOL_BASE);
        assert!(decode(8_453, &base.to, "0", &base.data).is_some());
        // No USDT reserve on Base (getReserveData returns a zero aToken): refused.
        assert!(build(
            &EarnAction::AaveSupply {
                asset: "USDT".into(),
                amount: "1".into(),
                chain_id: 8_453,
            },
            ME,
        )
        .is_err());
        assert_eq!(
            contract_name(42_161, AAVE_V3_POOL_ARB_POLYGON),
            Some("Aave v3 Pool")
        );
    }

    #[test]
    fn build_refuses_bad_input() {
        assert!(build(&EarnAction::LidoStake { amount: "0".into() }, ME).is_err());
        assert!(build(
            &EarnAction::LidoStake {
                amount: "1e18".into()
            },
            ME
        )
        .is_err());
        assert!(build(
            &EarnAction::AaveSupply {
                asset: "SHIB".into(),
                amount: "1".into(),
                chain_id: 1,
            },
            ME
        )
        .is_err());
    }
}
