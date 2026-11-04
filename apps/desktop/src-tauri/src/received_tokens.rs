//! Tokens an address holds that Kyro cannot send: Sui coins, Cosmos IBC denoms, CashTokens. Read
//! only, from the hosts each chain already uses. A server can invent or hide such a line, nothing
//! here reaches a signature. Only the fixed tables below give a token its name; everything else
//! is `known: false`, and the interface keeps those folded away.

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Longest list returned for one address.
pub const MAX_TOKENS: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceivedToken {
    /// Coin type, denom or category: what identifies the token on its chain.
    pub id: String,
    pub symbol: Option<String>,
    /// `None`: `amount` is shown in raw units.
    pub decimals: Option<u8>,
    /// Raw units, decimal.
    pub amount: String,
    /// In Kyro's fixed table. Not known = possibly spam.
    pub known: bool,
    /// CashTokens NFTs of this category.
    pub nfts: u32,
}

/// Mainnet Sui coins with a name in Kyro, checked against `coinMetadata` on 2026-11-04.
const SUI_NAMED: [(&str, &str, u8); 5] = [
    (
        "0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS",
        "CETUS",
        9,
    ),
    (
        "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP",
        "DEEP",
        6,
    ),
    (
        "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL",
        "WAL",
        9,
    ),
    (
        "0x5145494a5f5100e645e4b0aa950fa6b68f614e8c59e17bc5ded3495123a79178::ns::NS",
        "NS",
        6,
    ),
    (
        "0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT",
        "USDT",
        6,
    ),
];

/// Cosmos Hub IBC denoms with a name in Kyro: the transfer channel matters as much as the base
/// denom, since any chain can send a coin called `uusdc`. Channels checked against their client's
/// chain id on 2026-11-04 (noble-1, osmosis-1, neutron-1).
const IBC_NAMED: [(&str, &str, &str, u8); 3] = [
    ("channel-536", "uusdc", "USDC", 6),
    ("channel-141", "uosmo", "OSMO", 6),
    ("channel-569", "untrn", "NTRN", 6),
];

/// A symbol from the chain, only if it is plain: no spaces, dots or slashes, so a name can't be a
/// link or a sentence ("claim-at.site").
pub fn plain_symbol(s: &str) -> Option<String> {
    let ok = (1..=12).contains(&s.len())
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '$'));
    ok.then(|| s.to_owned())
}

fn dec(v: &Value) -> Option<u128> {
    match v {
        Value::String(s) => s.parse().ok(),
        Value::Number(n) => n.as_u64().map(u128::from),
        _ => None,
    }
}

/// Known tokens first, then by id, so that the list does not reshuffle.
pub fn finish(mut out: Vec<ReceivedToken>) -> Vec<ReceivedToken> {
    out.sort_by(|a, b| b.known.cmp(&a.known).then_with(|| a.id.cmp(&b.id)));
    out.truncate(MAX_TOKENS);
    out
}

/// `balances.nodes` of the Sui GraphQL API, without the coins Kyro shows and sends (`skip`).
pub fn sui_rows(nodes: &[Value], skip: &[&str], testnet: bool) -> Vec<ReceivedToken> {
    let mut out = Vec::new();
    for n in nodes {
        let (Some(id), Some(amount)) = (n["coinType"]["repr"].as_str(), dec(&n["totalBalance"]))
        else {
            continue;
        };
        if amount == 0 || skip.contains(&id) || id.len() > 512 {
            continue;
        }
        let named = SUI_NAMED
            .iter()
            .find(|k| !testnet && k.0 == id)
            .map(|k| (k.1, k.2));
        out.push(ReceivedToken {
            id: id.to_owned(),
            symbol: named.map(|k| k.0.to_owned()),
            decimals: named.map(|k| k.1),
            amount: amount.to_string(),
            known: named.is_some(),
            nfts: 0,
        });
    }
    finish(out)
}

/// Adds what the coin's own metadata says to an unknown line. Kept apart from `known`: anyone can
/// publish a coin whose symbol is "USDC".
pub fn sui_apply_metadata(t: &mut ReceivedToken, meta: &Value) {
    if t.known {
        return;
    }
    t.symbol = meta["symbol"].as_str().and_then(plain_symbol);
    t.decimals = meta["decimals"]
        .as_u64()
        .and_then(|d| u8::try_from(d).ok())
        .filter(|d| *d <= 30);
}

/// The hash of an `ibc/…` denom, if it has that form.
pub fn ibc_hash(denom: &str) -> Option<&str> {
    denom
        .strip_prefix("ibc/")
        .filter(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// `balances` of the bank module, without the staking coin. Amounts that do not parse are dropped.
pub fn cosmos_rows(balances: &[Value]) -> Vec<ReceivedToken> {
    let mut out = Vec::new();
    for b in balances {
        let (Some(denom), Some(amount)) = (b["denom"].as_str(), dec(&b["amount"])) else {
            continue;
        };
        if denom == "uatom" || amount == 0 || denom.len() > 256 {
            continue;
        }
        out.push(ReceivedToken {
            id: crate::dialog_text::sanitize(denom, 256),
            symbol: None,
            decimals: None,
            amount: amount.to_string(),
            known: false,
            nfts: 0,
        });
    }
    finish(out)
}

/// Names an `ibc/…` line from the server's `denom` answer. The answer only counts if it hashes
/// back to the denom: a server cannot pass a stranger's coin off as USDC from Noble.
pub fn cosmos_apply_trace(t: &mut ReceivedToken, answer: &Value) {
    let denom = &answer["denom"];
    let (Some(base), Some(trace)) = (denom["base"].as_str(), denom["trace"].as_array()) else {
        return;
    };
    let Some(hash) = ibc_hash(&t.id) else { return };
    let path: Vec<String> = trace
        .iter()
        .filter_map(|h| {
            Some(format!(
                "{}/{}",
                h["port_id"].as_str()?,
                h["channel_id"].as_str()?
            ))
        })
        .collect();
    if path.len() != trace.len() {
        return;
    }
    let full = format!("{}/{base}", path.join("/"));
    let got = hex::encode(Sha256::digest(full.as_bytes()));
    if !got.eq_ignore_ascii_case(hash) {
        return;
    }
    let channel = match path.as_slice() {
        [hop] => hop.strip_prefix("transfer/"),
        _ => None,
    };
    match IBC_NAMED
        .iter()
        .find(|k| Some(k.0) == channel && k.1 == base)
    {
        Some(k) => {
            t.symbol = Some(k.2.to_owned());
            t.decimals = Some(k.3);
            t.known = true;
        }
        None => t.symbol = plain_symbol(base),
    }
}

/// `blockchain.scripthash.listunspent` with `tokens_only`, folded by category. Everything is
/// unknown: names live in off-chain registries, on hosts Kyro does not contact.
pub fn cashtoken_rows(utxos: &[Value]) -> Vec<ReceivedToken> {
    let mut by_category: std::collections::BTreeMap<String, (u128, u32)> = Default::default();
    for u in utxos {
        let token = &u["token_data"];
        let Some(category) = token["category"]
            .as_str()
            .filter(|c| c.len() == 64 && c.bytes().all(|b| b.is_ascii_hexdigit()))
        else {
            continue;
        };
        let row = by_category
            .entry(category.to_ascii_lowercase())
            .or_default();
        row.0 = row.0.saturating_add(dec(&token["amount"]).unwrap_or(0));
        row.1 = row.1.saturating_add(u32::from(token["nft"].is_object()));
    }
    finish(
        by_category
            .into_iter()
            .map(|(id, (amount, nfts))| ReceivedToken {
                id,
                symbol: None,
                decimals: None,
                amount: amount.to_string(),
                known: false,
                nfts,
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SUI: &str =
        "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
    const USDC_HASH: &str = "F663521BF1836B00F5F177680F74BFB9A8B5654A694D0D2BC249E03CF2509013";

    #[test]
    fn sui_named_spam_and_skipped() {
        let spam = "0x0808::cn::CN";
        let nodes = [
            json!({ "coinType": { "repr": SUI }, "totalBalance": "5" }),
            json!({ "coinType": { "repr": spam }, "totalBalance": "4012524291" }),
            json!({ "coinType": { "repr": SUI_NAMED[1].0 }, "totalBalance": "1500000" }),
            json!({ "coinType": { "repr": "0x1::a::ZERO" }, "totalBalance": "0" }),
            json!({ "coinType": { "repr": "0x1::a::BAD" }, "totalBalance": "x" }),
        ];
        let rows = sui_rows(&nodes, &[SUI], false);
        assert_eq!(rows.len(), 2);
        assert!(rows[0].known && rows[0].symbol.as_deref() == Some("DEEP"));
        assert_eq!(rows[0].decimals, Some(6));
        assert!(!rows[1].known && rows[1].symbol.is_none() && rows[1].decimals.is_none());
        // The table is mainnet's.
        assert!(!sui_rows(&nodes, &[SUI], true)[0].known);
    }

    #[test]
    fn sui_metadata_never_makes_a_coin_known() {
        let mut row = sui_rows(
            &[json!({ "coinType": { "repr": "0x1::a::USDC" }, "totalBalance": "7" })],
            &[],
            false,
        )
        .remove(0);
        sui_apply_metadata(&mut row, &json!({ "symbol": "USDC", "decimals": 6 }));
        assert!(!row.known);
        assert_eq!(
            (row.symbol.as_deref(), row.decimals),
            (Some("USDC"), Some(6))
        );
        sui_apply_metadata(
            &mut row,
            &json!({ "symbol": "claim.site", "decimals": 200 }),
        );
        assert_eq!((row.symbol, row.decimals), (None, None));
    }

    #[test]
    fn symbols_with_links_or_sentences_are_dropped() {
        assert_eq!(plain_symbol("USD-C_1"), Some("USD-C_1".into()));
        for bad in [
            "",
            "a b",
            "visit.com",
            "x/y",
            "Claim\u{202e}",
            "ABCDEFGHIJKLM",
        ] {
            assert_eq!(plain_symbol(bad), None, "{bad}");
        }
    }

    fn ibc_row(id: &str) -> ReceivedToken {
        cosmos_rows(&[json!({ "denom": id, "amount": "2500000" })]).remove(0)
    }

    fn trace(channel: &str, base: &str) -> Value {
        json!({ "denom": { "base": base, "trace": [{ "port_id": "transfer", "channel_id": channel }] } })
    }

    #[test]
    fn cosmos_names_only_a_trace_that_hashes_back() {
        let id = format!("ibc/{USDC_HASH}");
        let mut usdc = ibc_row(&id);
        cosmos_apply_trace(&mut usdc, &trace("channel-536", "uusdc"));
        assert!(usdc.known);
        assert_eq!(
            (usdc.symbol.as_deref(), usdc.decimals),
            (Some("USDC"), Some(6))
        );

        // A lying server: right words, wrong hash.
        let fake = format!("ibc/{}", "A".repeat(64));
        let mut row = ibc_row(&fake);
        cosmos_apply_trace(&mut row, &trace("channel-536", "uusdc"));
        assert!(!row.known && row.symbol.is_none());

        // A real trace from another channel: same base denom, not Noble's USDC.
        let other = hex::encode(Sha256::digest(b"transfer/channel-9/uusdc"));
        let mut row = ibc_row(&format!("ibc/{other}"));
        cosmos_apply_trace(&mut row, &trace("channel-9", "uusdc"));
        assert!(!row.known);
        assert_eq!((row.symbol.as_deref(), row.decimals), (Some("uusdc"), None));
    }

    #[test]
    fn cosmos_skips_the_staking_coin() {
        let rows = cosmos_rows(&[
            json!({ "denom": "uatom", "amount": "1" }),
            json!({ "denom": "factory/cosmos1x/Nether", "amount": "9" }),
            json!({ "denom": "ibc/AB", "amount": "0" }),
            json!({ "denom": "ibc/AC", "amount": "-1" }),
        ]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "factory/cosmos1x/Nether");
    }

    #[test]
    fn cashtokens_fold_by_category() {
        let cat = "ab".repeat(32);
        let rows = cashtoken_rows(&[
            json!({ "token_data": { "category": cat, "amount": "40" } }),
            json!({ "token_data": { "category": cat, "amount": "2", "nft": { "capability": "none", "commitment": "" } } }),
            json!({ "token_data": { "category": "cd".repeat(32), "amount": "0", "nft": { "capability": "minting", "commitment": "01" } } }),
            json!({ "token_data": { "category": "short", "amount": "9" } }),
            json!({ "height": 5 }),
        ]);
        assert_eq!(rows.len(), 2);
        assert_eq!((rows[0].amount.as_str(), rows[0].nfts), ("42", 1));
        assert_eq!((rows[1].amount.as_str(), rows[1].nfts), ("0", 1));
        assert!(rows.iter().all(|r| !r.known && r.symbol.is_none()));
    }

    /// Real reads over Tor, on public addresses holding spam coins and Noble USDC.
    /// `cargo test received_tokens_live -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn received_tokens_live_over_tor() {
        use crate::tor::TorState;
        use wallet_core::Network::Mainnet;
        let dir = std::env::temp_dir().join("kyro-received-live");
        let net = crate::net::NetClient::new(dir).unwrap();
        tauri::async_runtime::block_on(async {
            net.tor.restart();
            while net.tor.status().state != TorState::Ready {
                assert_ne!(net.tor.status().state, TorState::Error);
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            let sui = crate::sui_backend::SuiCtx::new(&net, Mainnet, true);
            let a = "0xac5bceec1b789ff840d7d4e6ce4ce61c90d190a7f8c4f4ddf0bff6ee2413c33c";
            let rows = crate::sui_backend::received_tokens(&sui, a).await.unwrap();
            eprintln!("sui: {} {:?}", rows.len(), rows.first());
            assert!(rows.iter().any(|r| r.symbol.is_some()));

            let cosmos = crate::cosmos_backend::CosmosCtx {
                net_client: &net,
                network: Mainnet,
                tor: true,
            };
            let a = "cosmos1qqp2aydslhpx4emvqdhsyn8ztrltd4zezcr22h";
            let rows = crate::cosmos_backend::received_tokens(&cosmos, a)
                .await
                .unwrap();
            eprintln!("cosmos: {rows:?}");
            assert!(rows
                .iter()
                .any(|r| r.known && r.symbol.as_deref() == Some("USDC")));

            let bch = crate::utxo_backend::UtxoCtx {
                net_client: &net,
                network: Mainnet,
                coin: wallet_core::UtxoCoin::BitcoinCash,
                tor: true,
                server: Default::default(),
            };
            let a = "bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a";
            let rows = crate::utxo_backend::received_tokens(&bch, a).await.unwrap();
            eprintln!("bch: {rows:?}");
        });
    }
}
