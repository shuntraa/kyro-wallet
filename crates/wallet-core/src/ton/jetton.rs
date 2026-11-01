//! TON jettons (TEP-74) Kyro knows: the jetton wallet address is **computed here** from the
//! master's wallet code and our wallet address (never taken from a server), and the
//! `transfer#0f8a7ea5` body sent to it is written and strictly decoded here.
//!
//! Only jettons listed in [`JETTONS`] are accepted: their master address comes from the issuer
//! (Tether's list for USD₮ on TON) and CoinGecko, and the wallet code is the cell the master
//! returns in `get_jetton_data` (for USD₮ a library reference to the audited `stablecoin-contract`
//! jetton wallet). Test vectors: owner → jetton wallet pairs read on mainnet (2026-11-01).

use serde::{Deserialize, Serialize};
use tycho_types::cell::{Cell, CellBuilder, CellSlice};

use super::{cell_err, comment_cell, decode_boc_b64, load_addr, slice, store_addr, TonAddress};
use crate::error::{Error, Result};

/// `transfer` opcode of a jetton wallet (TEP-74).
pub const TON_JETTON_TRANSFER_OP: u32 = 0x0f8a_7ea5;
/// TON attached to a jetton transfer for the jetton wallets' fees; the excess comes back to our
/// wallet (`response_destination`).
pub const TON_JETTON_ATTACHED_NANOTON: u64 = 50_000_000;
/// TON forwarded to the recipient with the `transfer_notification` (1 nanoton, as Tonkeeper):
/// enough for the recipient (an exchange) to see the transfer and its comment.
pub const TON_JETTON_FORWARD_NANOTON: u64 = 1;
/// Most TON Kyro accepts to attach to a jetton transfer.
const MAX_ATTACHED_NANOTON: u64 = 200_000_000;
/// `VarUInteger 16`: at most 15 bytes.
const MAX_JETTON_UNITS: u128 = (1u128 << 120) - 1;

/// How a jetton wallet's initial data is laid out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WalletLayout {
    /// `stablecoin-contract` (USD₮): `status:uint4 balance:Coins owner:MsgAddress master:MsgAddress`.
    Stablecoin,
}

struct JettonDef {
    testnet: bool,
    /// Master, account id (workchain 0).
    master: [u8; 32],
    symbol: &'static str,
    decimals: u8,
    /// `jetton_wallet_code` of `get_jetton_data` (BOC, base64).
    wallet_code: &'static str,
    layout: WalletLayout,
}

/// Jettons Kyro knows. Mainnet only: Tether and Circle publish no testnet jetton on TON.
const JETTONS: &[JettonDef] = &[JettonDef {
    testnet: false,
    // EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs (tether.to, CoinGecko `tether`).
    // 0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe
    master: [
        0xb1, 0x13, 0xa9, 0x94, 0xb5, 0x02, 0x4a, 0x16, 0x71, 0x9f, 0x69, 0x13, 0x93, 0x28, 0xeb,
        0x75, 0x95, 0x96, 0xc3, 0x8a, 0x25, 0xf5, 0x90, 0x28, 0xb1, 0x46, 0xfe, 0xcd, 0xc3, 0x62,
        0x1d, 0xfe,
    ],
    symbol: "USDT",
    decimals: 6,
    wallet_code: "te6cckEBAQEAIwAIQgKPRS16Tf10BmtoI2UXclntBXNENb52tf1L1divK3w9aCBrv3Y=",
    layout: WalletLayout::Stablecoin,
}];

/// A jetton Kyro knows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TonJettonInfo {
    /// Master contract.
    pub master: TonAddress,
    /// Ticker.
    pub symbol: &'static str,
    /// Decimals.
    pub decimals: u8,
}

fn master_of(d: &JettonDef) -> TonAddress {
    TonAddress {
        workchain: 0,
        hash: d.master,
    }
}

/// The jettons Kyro knows on `testnet` / mainnet.
pub fn ton_known_jettons(testnet: bool) -> Vec<TonJettonInfo> {
    JETTONS
        .iter()
        .filter(|d| d.testnet == testnet)
        .map(|d| TonJettonInfo {
            master: master_of(d),
            symbol: d.symbol,
            decimals: d.decimals,
        })
        .collect()
}

fn def(master: &TonAddress, testnet: bool) -> Result<&'static JettonDef> {
    JETTONS
        .iter()
        .find(|d| d.testnet == testnet && master_of(d) == *master)
        .ok_or_else(|| Error::input("TON token (jetton) unknown to Kyro"))
}

/// The jetton Kyro knows at `master`, if any.
pub fn ton_known_jetton(master: &TonAddress, testnet: bool) -> Option<TonJettonInfo> {
    def(master, testnet).ok().map(|d| TonJettonInfo {
        master: master_of(d),
        symbol: d.symbol,
        decimals: d.decimals,
    })
}

/// Address of `owner`'s jetton wallet for the known jetton `master`: hash of the `StateInit`
/// the master deploys (its wallet code, initial data with a zero balance).
pub fn ton_jetton_wallet_address(
    master: &TonAddress,
    owner: &TonAddress,
    testnet: bool,
) -> Result<TonAddress> {
    let d = def(master, testnet)?;
    let (_, code) =
        decode_boc_b64(d.wallet_code).map_err(|_| Error::crypto("jetton wallet code"))?;
    let mut data = CellBuilder::new();
    match d.layout {
        WalletLayout::Stablecoin => {
            data.store_small_uint(0, 4).map_err(cell_err)?; // status
            data.store_small_uint(0, 4).map_err(cell_err)?; // balance: Coins 0
            store_addr(&mut data, owner)?;
            store_addr(&mut data, master)?;
        }
    }
    let mut init = CellBuilder::new();
    init.store_small_uint(0b00110, 5).map_err(cell_err)?;
    init.store_reference(code).map_err(cell_err)?;
    init.store_reference(data.build().map_err(cell_err)?)
        .map_err(cell_err)?;
    Ok(TonAddress {
        workchain: 0,
        hash: init.build().map_err(cell_err)?.repr_hash().0,
    })
}

/// `transfer#0f8a7ea5` body sent by our wallet to our jetton wallet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TonJettonBody {
    /// `query_id` (Kyro: the message's `valid_until`).
    pub query_id: u64,
    /// Jetton units.
    pub amount: u128,
    /// Recipient (its wallet, the jetton wallet of which is credited).
    pub destination: TonAddress,
    /// Where the excess TON goes back (always our wallet).
    pub response_destination: TonAddress,
    /// Nanotons forwarded to the recipient with the notification.
    pub forward_ton_amount: u64,
    /// Text comment in the forward payload (UTF-8, ≤ 123 bytes).
    pub comment: Option<String>,
}

fn store_var16(b: &mut CellBuilder, v: u128) -> Result<()> {
    let bytes = v.to_be_bytes();
    let skip = bytes.iter().take_while(|x| **x == 0).count();
    let len = 16 - skip;
    if len > 15 {
        return Err(Error::input("token amount too large"));
    }
    b.store_small_uint(len as u8, 4).map_err(cell_err)?;
    b.store_raw(&bytes[skip..], (len * 8) as u16)
        .map_err(cell_err)
}

fn load_var16(s: &mut CellSlice<'_>) -> Result<u128> {
    let len = s.load_small_uint(4).map_err(cell_err)?;
    let mut v = 0u128;
    for _ in 0..len {
        v = (v << 8) | u128::from(s.load_u8().map_err(cell_err)?);
    }
    Ok(v)
}

impl TonJettonBody {
    pub(super) fn check(&self, attached: u64, wallet: &TonAddress) -> Result<()> {
        if self.amount == 0 || self.amount > MAX_JETTON_UNITS {
            return Err(Error::input("invalid token amount"));
        }
        if self.destination.workchain != 0 {
            return Err(Error::input(
                "token recipient on the masterchain (-1) refused",
            ));
        }
        if self.response_destination != *wallet {
            return Err(Error::input(
                "the token transfer's excess GRAM must come back to your wallet",
            ));
        }
        if attached == 0 || attached > MAX_ATTACHED_NANOTON || self.forward_ton_amount >= attached {
            return Err(Error::input(
                "GRAM attached to the token transfer refused (0.2 GRAM at most, and more than the forwarded amount)",
            ));
        }
        if let Some(c) = &self.comment {
            super::check_comment(c)?;
        }
        Ok(())
    }

    pub(super) fn cell(&self) -> Result<Cell> {
        let mut b = CellBuilder::new();
        b.store_u32(TON_JETTON_TRANSFER_OP).map_err(cell_err)?;
        b.store_u64(self.query_id).map_err(cell_err)?;
        store_var16(&mut b, self.amount)?;
        store_addr(&mut b, &self.destination)?;
        store_addr(&mut b, &self.response_destination)?;
        b.store_bit_zero().map_err(cell_err)?; // custom_payload: nothing
        store_var16(&mut b, u128::from(self.forward_ton_amount))?;
        match &self.comment {
            // forward_payload: Either Cell ^Cell — right, the comment in a reference.
            Some(c) => {
                b.store_bit_one().map_err(cell_err)?;
                b.store_reference(comment_cell(c)?).map_err(cell_err)?;
            }
            None => b.store_bit_zero().map_err(cell_err)?,
        }
        b.build().map_err(cell_err)
    }

    /// Strict decoding (the caller re-encodes the whole message and compares the bytes).
    pub(super) fn parse(s: &mut CellSlice<'_>) -> Result<Self> {
        if s.load_u32().map_err(cell_err)? != TON_JETTON_TRANSFER_OP {
            return Err(Error::input("token operation expected (transfer)"));
        }
        let query_id = s.load_u64().map_err(cell_err)?;
        let amount = load_var16(s)?;
        let destination = load_addr(s)?;
        let response_destination = load_addr(s)?;
        if s.load_bit().map_err(cell_err)? {
            return Err(Error::input("token custom_payload refused"));
        }
        let forward = load_var16(s)?;
        let forward_ton_amount =
            u64::try_from(forward).map_err(|_| Error::input("forwarded amount too large"))?;
        let comment = if s.load_bit().map_err(cell_err)? {
            let c = s.load_reference_cloned().map_err(cell_err)?;
            let mut p = slice(&c)?;
            if p.size_refs() != 0 || p.size_bits() < 32 || p.size_bits() % 8 != 0 {
                return Err(Error::input(
                    "forward payload refused (only a text comment is accepted)",
                ));
            }
            if p.load_u32().map_err(cell_err)? != 0 {
                return Err(Error::input(
                    "forward payload refused (contract operation, not a text comment)",
                ));
            }
            let mut raw = Vec::with_capacity(usize::from(p.size_bits() / 8));
            while p.size_bits() > 0 {
                raw.push(p.load_u8().map_err(cell_err)?);
            }
            Some(String::from_utf8(raw).map_err(|_| Error::input("TON comment: invalid UTF-8"))?)
        } else {
            None
        };
        if s.size_bits() != 0 || s.size_refs() != 0 {
            return Err(Error::input("unexpected token fields (trailing data)"));
        }
        Ok(Self {
            query_id,
            amount,
            destination,
            response_destination,
            forward_ton_amount,
            comment,
        })
    }
}

/// The jetton part of [`super::TonTxSummary`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TonJettonSummary {
    /// Master contract, bounceable form (`EQ…`): the jetton's verified id.
    pub master: String,
    /// Ticker (Kyro's table).
    pub symbol: String,
    /// Decimals (Kyro's table).
    pub decimals: u8,
    /// Jetton units (decimal string).
    pub amount: String,
    /// Recipient, non-bounceable form (`UQ…`).
    pub recipient: String,
    /// The same account, bounceable form (`EQ…`).
    pub recipient_other: String,
    /// Recipient, raw `0:hex`.
    pub recipient_raw: String,
    /// Our jetton wallet (computed by Kyro), the message's destination.
    pub jetton_wallet: String,
    /// Nanotons forwarded to the recipient.
    pub forward_ton_amount: String,
}

/// The summary of a jetton transfer sent to `to` (must be our jetton wallet of a known jetton).
pub(super) fn summarize(
    body: &TonJettonBody,
    to: &TonAddress,
    wallet: &TonAddress,
    testnet: bool,
) -> Result<TonJettonSummary> {
    let d = JETTONS
        .iter()
        .filter(|d| d.testnet == testnet)
        .find(|d| ton_jetton_wallet_address(&master_of(d), wallet, testnet).is_ok_and(|w| w == *to))
        .ok_or_else(|| {
            Error::input("token transfer to a contract that is not your wallet for a known token")
        })?;
    Ok(TonJettonSummary {
        master: master_of(d).to_friendly(true, testnet),
        symbol: d.symbol.into(),
        decimals: d.decimals,
        amount: body.amount.to_string(),
        recipient: body.destination.to_friendly(false, testnet),
        recipient_other: body.destination.to_friendly(true, testnet),
        recipient_raw: body.destination.to_raw(),
        jetton_wallet: to.to_friendly(true, testnet),
        forward_ton_amount: body.forward_ton_amount.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ton::ton_parse_raw_address;

    fn raw(s: &str) -> TonAddress {
        ton_parse_raw_address(s).unwrap()
    }

    #[test]
    fn usdt_jetton_wallets_match_mainnet() {
        let usdt = raw("0:B113A994B5024A16719F69139328EB759596C38A25F59028B146FECDC3621DFE");
        assert_eq!(
            usdt.to_friendly(true, false),
            "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"
        );
        // (owner, jetton wallet) pairs read on mainnet (toncenter v3 `jetton/transfers`).
        for (owner, wallet) in [
            (
                "0:23FA979918F1FE702DB9100BF843E87C7015ECCD39A4721E9B6BAC170BC04CE3",
                "0:2626CF30B702BDDED845EFC883EFA45029FF59DEFDACC4CE7B8B0A5966D75002",
            ),
            (
                "0:049E810FE8D7FBF42CC80814C5F493B97A6AA55AA99CEC5FE71BD308603DA904",
                "0:5D654A2DB3DAFFC121DA712AB70499C34668A12BD4EF9007E5D9BBC8FE707D8F",
            ),
        ] {
            assert_eq!(
                ton_jetton_wallet_address(&usdt, &raw(owner), false).unwrap(),
                raw(wallet)
            );
        }
        assert!(ton_jetton_wallet_address(&usdt, &raw(wallet_zero()), true).is_err());
        assert_eq!(ton_known_jettons(false).len(), 1);
        assert!(ton_known_jettons(true).is_empty());
    }

    fn wallet_zero() -> &'static str {
        "0:0000000000000000000000000000000000000000000000000000000000000000"
    }

    #[test]
    fn body_round_trip_and_checks() {
        let me = raw("0:23FA979918F1FE702DB9100BF843E87C7015ECCD39A4721E9B6BAC170BC04CE3");
        let to = raw("0:049E810FE8D7FBF42CC80814C5F493B97A6AA55AA99CEC5FE71BD308603DA904");
        for comment in [None, Some("dépôt 42".to_string())] {
            let b = TonJettonBody {
                query_id: 7,
                amount: 12_500_000,
                destination: to,
                response_destination: me,
                forward_ton_amount: 1,
                comment,
            };
            b.check(TON_JETTON_ATTACHED_NANOTON, &me).unwrap();
            let c = b.cell().unwrap();
            let mut s = slice(&c).unwrap();
            assert_eq!(TonJettonBody::parse(&mut s).unwrap(), b);
        }
        let mut bad = TonJettonBody {
            query_id: 0,
            amount: 1,
            destination: to,
            response_destination: to,
            forward_ton_amount: 1,
            comment: None,
        };
        assert!(bad.check(TON_JETTON_ATTACHED_NANOTON, &me).is_err());
        bad.response_destination = me;
        assert!(bad.check(1, &me).is_err());
        assert!(bad.check(MAX_ATTACHED_NANOTON + 1, &me).is_err());
        bad.amount = 0;
        assert!(bad.check(TON_JETTON_ATTACHED_NANOTON, &me).is_err());
    }
}
