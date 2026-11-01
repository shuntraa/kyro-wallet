//! Local matching for the compact-filter backend: which scripts we watch (gap limit over
//! BIP84 + BIP86, receive + change), which transactions of a matching block concern us, and
//! the Esplora-shaped views (UTXOs, history, balance) computed from the stored transactions.

use std::collections::{BTreeMap, HashMap, HashSet};

use bitcoin::{OutPoint, ScriptBuf, Transaction};
use serde_json::{json, Value};
use wallet_core::{BtcKind, Network};

use crate::error::{AppError, AppResult};

/// Unused addresses kept ahead of the last used one (per kind and chain).
pub const GAP_RECEIVE: u32 = 30;
pub const GAP_CHANGE: u32 = 15;

/// Where a watched script comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Slot {
    pub kind: BtcKind,
    pub change: bool,
    pub index: u32,
}

/// The scripts we look for in filters.
pub struct WatchSet {
    net: Network,
    xpubs: Option<(String, String)>,
    scripts: HashMap<ScriptBuf, Option<Slot>>,
    derived: HashMap<(BtcKind, bool), u32>,
    used: HashMap<(BtcKind, bool), u32>,
    extended: bool,
}

fn script_of(addr: &str, net: Network) -> AppResult<ScriptBuf> {
    let spk = wallet_core::btc_script_pubkey(addr, net)?;
    Ok(ScriptBuf::from_bytes(spk.into_bytes()))
}

impl WatchSet {
    pub fn from_xpubs(net: Network, segwit_xpub: &str, taproot_xpub: &str) -> AppResult<Self> {
        let mut w = Self {
            net,
            xpubs: Some((segwit_xpub.to_owned(), taproot_xpub.to_owned())),
            scripts: HashMap::new(),
            derived: HashMap::new(),
            used: HashMap::new(),
            extended: false,
        };
        for kind in [BtcKind::Segwit, BtcKind::Taproot] {
            w.derive_up_to(kind, false, GAP_RECEIVE)?;
            w.derive_up_to(kind, true, GAP_CHANGE)?;
        }
        w.extended = false;
        Ok(w)
    }

    #[cfg(test)]
    pub fn from_addresses(net: Network, addresses: &[&str]) -> AppResult<Self> {
        let mut scripts = HashMap::new();
        for a in addresses {
            scripts.insert(script_of(a, net)?, None);
        }
        Ok(Self {
            net,
            xpubs: None,
            scripts,
            derived: HashMap::new(),
            used: HashMap::new(),
            extended: false,
        })
    }

    fn derive_up_to(&mut self, kind: BtcKind, change: bool, count: u32) -> AppResult<()> {
        let Some((seg, tap)) = self.xpubs.clone() else {
            return Ok(());
        };
        let xpub = match kind {
            BtcKind::Segwit => seg,
            BtcKind::Taproot => tap,
        };
        let next = self.derived.entry((kind, change)).or_insert(0);
        while *next < count {
            let addr = wallet_core::btc_address_from_xpub(&xpub, self.net, kind, change, *next)?;
            self.scripts.insert(
                script_of(&addr, self.net)?,
                Some(Slot {
                    kind,
                    change,
                    index: *next,
                }),
            );
            *next += 1;
            self.extended = true;
        }
        Ok(())
    }

    pub fn scripts(&self) -> impl Iterator<Item = &ScriptBuf> {
        self.scripts.keys()
    }

    pub fn len(&self) -> usize {
        self.scripts.len()
    }

    pub fn contains(&self, s: &ScriptBuf) -> bool {
        self.scripts.contains_key(s)
    }

    pub fn mark_used(&mut self, script: &ScriptBuf) -> AppResult<()> {
        let Some(Some(slot)) = self.scripts.get(script).copied() else {
            return Ok(());
        };
        let used = self.used.entry((slot.kind, slot.change)).or_insert(0);
        *used = (*used).max(slot.index);
        let gap = if slot.change { GAP_CHANGE } else { GAP_RECEIVE };
        let want = slot.index + 1 + gap;
        self.derive_up_to(slot.kind, slot.change, want)
    }

    pub fn take_extended(&mut self) -> bool {
        std::mem::take(&mut self.extended)
    }

    #[cfg(test)]
    pub fn used(&self) -> &HashMap<(BtcKind, bool), u32> {
        &self.used
    }
}

pub fn relevant_txs(
    txs: &[Transaction],
    watch: &mut WatchSet,
    known: &mut HashSet<OutPoint>,
) -> AppResult<Vec<Transaction>> {
    let mut out = Vec::new();
    for tx in txs {
        let txid = tx.compute_txid();
        let spends = tx.input.iter().any(|i| known.contains(&i.previous_output));
        let mut pays = false;
        for (vout, o) in tx.output.iter().enumerate() {
            if watch.contains(&o.script_pubkey) {
                pays = true;
                watch.mark_used(&o.script_pubkey)?;
                known.insert(OutPoint {
                    txid,
                    vout: vout as u32,
                });
            }
        }
        if pays || spends {
            out.push(tx.clone());
        }
    }
    Ok(out)
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredTx {
    pub hex: String,
    pub height: Option<u32>,
    pub block_hash: Option<String>,
    pub time: Option<u32>,
}

pub struct Ledger {
    pub raws: HashMap<String, wallet_core::BtcRawTx>,
    pub meta: HashMap<String, (Option<u32>, Option<u32>)>,
}

impl Ledger {
    pub fn new(txs: &BTreeMap<String, StoredTx>, net: Network) -> AppResult<Self> {
        let mut raws = HashMap::new();
        let mut meta = HashMap::new();
        for (txid, t) in txs {
            let raw = wallet_core::btc_decode_raw_tx(&t.hex, net)?;
            if &raw.txid != txid {
                return Err(AppError::Internal(
                    "cbf: corrupted stored transaction".into(),
                ));
            }
            meta.insert(txid.clone(), (t.height, t.time));
            raws.insert(txid.clone(), raw);
        }
        Ok(Self { raws, meta })
    }

    fn spent(&self) -> HashSet<(String, u32)> {
        self.raws
            .values()
            .flat_map(|t| t.inputs.iter().cloned())
            .collect()
    }

    fn spk_hex(address: &str, net: Network) -> AppResult<String> {
        Ok(hex::encode(
            wallet_core::btc_script_pubkey(address, net)?.as_bytes(),
        ))
    }

    pub fn utxos(&self, address: &str, net: Network) -> AppResult<Value> {
        let spk = Self::spk_hex(address, net)?;
        let spent = self.spent();
        let mut out = Vec::new();
        for (txid, t) in &self.raws {
            for (vout, (_, value, s)) in t.outputs.iter().enumerate() {
                if *s == spk && !spent.contains(&(txid.clone(), vout as u32)) {
                    let height = self.meta.get(txid).and_then(|m| m.0);
                    let mut status = json!({ "confirmed": height.is_some() });
                    if let Some(h) = height {
                        status["block_height"] = json!(h);
                    }
                    out.push(
                        json!({ "txid": txid, "vout": vout, "value": value, "status": status }),
                    );
                }
            }
        }
        out.sort_by(|a, b| {
            a["txid"]
                .as_str()
                .cmp(&b["txid"].as_str())
                .then(a["vout"].as_u64().cmp(&b["vout"].as_u64()))
        });
        Ok(Value::Array(out))
    }

    fn touching(&self, spk: &str) -> Vec<String> {
        let mut ids: Vec<String> = self
            .raws
            .iter()
            .filter(|(_, t)| {
                t.outputs.iter().any(|o| o.2 == spk)
                    || t.inputs.iter().any(|(p, v)| {
                        self.raws
                            .get(p)
                            .and_then(|pt| pt.outputs.get(*v as usize))
                            .is_some_and(|o| o.2 == spk)
                    })
            })
            .map(|(id, _)| id.clone())
            .collect();
        ids.sort_by_key(|id| {
            let h = self.meta.get(id).and_then(|m| m.0);
            (h.is_some(), std::cmp::Reverse(h.unwrap_or(0)), id.clone())
        });
        ids
    }

    pub fn address_info(&self, address: &str, net: Network) -> AppResult<Value> {
        let utxos = self.utxos(address, net)?;
        let (mut conf, mut pending) = (0u64, 0u64);
        for u in utxos.as_array().into_iter().flatten() {
            let v = u["value"].as_u64().unwrap_or(0);
            if u["status"]["confirmed"] == true {
                conf += v;
            } else {
                pending += v;
            }
        }
        let ids = self.touching(&Self::spk_hex(address, net)?);
        let pending_count = ids
            .iter()
            .filter(|id| self.meta.get(*id).and_then(|m| m.0).is_none())
            .count();
        Ok(json!({
            "address": address,
            "chain_stats": { "funded_txo_sum": conf, "spent_txo_sum": 0, "tx_count": ids.len() - pending_count },
            "mempool_stats": { "funded_txo_sum": pending, "spent_txo_sum": 0, "tx_count": pending_count },
        }))
    }

    pub fn address_txs(&self, address: &str, net: Network, max: usize) -> AppResult<Value> {
        let spk = Self::spk_hex(address, net)?;
        let mut order = Vec::new();
        let mut times = HashMap::new();
        for id in self.touching(&spk).into_iter().take(max) {
            let (h, t) = self.meta.get(&id).copied().unwrap_or((None, None));
            let height = h.map_or(0, i64::from);
            if let (Some(h), Some(t)) = (h, t) {
                times.insert(i64::from(h), u64::from(t));
            }
            order.push((id, height));
        }
        Ok(Value::Array(crate::btc_backend::esplora_txs(
            &order, &self.raws, &times,
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bitcoin::absolute::LockTime;
    use bitcoin::transaction::Version;
    use bitcoin::{Amount, Sequence, TxIn, TxOut, Witness};

    const ABANDON_SEGWIT_TPUB: fn() -> (String, String) = || {
        let seed = wallet_core::Mnemonic::parse(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        )
        .unwrap()
        .to_seed("");
        (
            wallet_core::btc_account(&seed, Network::Testnet, BtcKind::Segwit, 0)
                .unwrap()
                .xpub,
            wallet_core::btc_account(&seed, Network::Testnet, BtcKind::Taproot, 0)
                .unwrap()
                .xpub,
        )
    };

    fn pay(scripts: &[ScriptBuf], spends: &[OutPoint]) -> Transaction {
        Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: spends
                .iter()
                .map(|o| TxIn {
                    previous_output: *o,
                    script_sig: ScriptBuf::new(),
                    sequence: Sequence::MAX,
                    witness: Witness::new(),
                })
                .collect(),
            output: scripts
                .iter()
                .map(|s| TxOut {
                    value: Amount::from_sat(1_000),
                    script_pubkey: s.clone(),
                })
                .collect(),
        }
    }

    fn addr_script(a: &str) -> ScriptBuf {
        script_of(a, Network::Testnet).unwrap()
    }

    #[test]
    fn watch_set_covers_both_kinds_and_chains_with_gap() {
        let (seg, tap) = ABANDON_SEGWIT_TPUB();
        let w = WatchSet::from_xpubs(Network::Testnet, &seg, &tap).unwrap();
        assert_eq!(w.len() as u32, 2 * (GAP_RECEIVE + GAP_CHANGE));
        assert!(w.contains(&addr_script("tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl")));
        let seed = wallet_core::Mnemonic::parse(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        )
        .unwrap()
        .to_seed("");
        for kind in [BtcKind::Segwit, BtcKind::Taproot] {
            for change in [false, true] {
                let a =
                    wallet_core::btc_address(&seed, Network::Testnet, kind, 0, change, 3).unwrap();
                assert!(w.contains(&addr_script(&a)), "{kind:?} {change}");
            }
        }
    }

    #[test]
    fn gap_extends_when_an_edge_address_is_used() {
        let (seg, tap) = ABANDON_SEGWIT_TPUB();
        let mut w = WatchSet::from_xpubs(Network::Testnet, &seg, &tap).unwrap();
        assert!(!w.take_extended());
        let seed = wallet_core::Mnemonic::parse(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        )
        .unwrap()
        .to_seed("");
        let edge = wallet_core::btc_address(
            &seed,
            Network::Testnet,
            BtcKind::Taproot,
            0,
            false,
            GAP_RECEIVE - 1,
        )
        .unwrap();
        let mut known = HashSet::new();
        let tx = pay(&[addr_script(&edge)], &[]);
        let found = relevant_txs(&[tx], &mut w, &mut known).unwrap();
        assert_eq!(found.len(), 1);
        assert!(
            w.take_extended(),
            "new scripts were derived and need a rescan"
        );
        let beyond = wallet_core::btc_address(
            &seed,
            Network::Testnet,
            BtcKind::Taproot,
            0,
            false,
            2 * GAP_RECEIVE - 1,
        )
        .unwrap();
        assert!(w.contains(&addr_script(&beyond)));
        assert_eq!(w.used()[&(BtcKind::Taproot, false)], GAP_RECEIVE - 1);
    }

    #[test]
    fn matching_catches_payments_and_spends_in_the_same_block() {
        let me = addr_script("tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl");
        let other = addr_script("tb1qhrw7celkgk34q3p9jx0eqts2de746f24fxj0x9");
        let mut w = WatchSet::from_addresses(
            Network::Testnet,
            &["tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl"],
        )
        .unwrap();
        let mut known = HashSet::new();
        let fund = pay(&[other.clone(), me.clone()], &[]);
        let spend = pay(
            std::slice::from_ref(&other),
            &[OutPoint {
                txid: fund.compute_txid(),
                vout: 1,
            }],
        );
        let unrelated = pay(
            &[other],
            &[OutPoint {
                txid: fund.compute_txid(),
                vout: 0,
            }],
        );
        let found = relevant_txs(
            &[fund.clone(), unrelated, spend.clone()],
            &mut w,
            &mut known,
        )
        .unwrap();
        assert_eq!(found, vec![fund.clone(), spend.clone()]);

        let store: BTreeMap<String, StoredTx> = [(&fund, Some(100u32)), (&spend, None)]
            .into_iter()
            .map(|(t, h)| {
                (
                    t.compute_txid().to_string(),
                    StoredTx {
                        hex: bitcoin::consensus::encode::serialize_hex(t),
                        height: h,
                        block_hash: None,
                        time: h.map(|_| 1_793_333_429),
                    },
                )
            })
            .collect();
        let l = Ledger::new(&store, Network::Testnet).unwrap();
        let a = "tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl";
        assert_eq!(
            l.utxos(a, Network::Testnet).unwrap(),
            json!([]),
            "spent by the pending tx"
        );
        let info = l.address_info(a, Network::Testnet).unwrap();
        assert_eq!(info["chain_stats"]["tx_count"], 1);
        assert_eq!(info["mempool_stats"]["tx_count"], 1);
        let txs = l.address_txs(a, Network::Testnet, 50).unwrap();
        assert_eq!(
            txs[0]["txid"],
            spend.compute_txid().to_string(),
            "pending first"
        );
        assert_eq!(txs[1]["status"]["block_height"], 100);
        assert_eq!(txs[1]["status"]["block_time"], 1_793_333_429);
        assert_eq!(txs[0]["vin"][0]["prevout"]["value"], 1_000);
        let mut only_fund = store.clone();
        only_fund.remove(&spend.compute_txid().to_string());
        let l = Ledger::new(&only_fund, Network::Testnet).unwrap();
        let u = l.utxos(a, Network::Testnet).unwrap();
        assert_eq!(u[0]["vout"], 1);
        assert_eq!(u[0]["status"]["block_height"], 100);
        assert_eq!(
            l.address_info(a, Network::Testnet).unwrap()["chain_stats"]["funded_txo_sum"],
            1_000
        );
    }

    #[test]
    fn corrupted_store_is_detected() {
        let mut store = BTreeMap::new();
        let t = pay(
            &[addr_script("tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl")],
            &[],
        );
        store.insert(
            "00".repeat(32),
            StoredTx {
                hex: bitcoin::consensus::encode::serialize_hex(&t),
                height: None,
                block_hash: None,
                time: None,
            },
        );
        assert!(Ledger::new(&store, Network::Testnet).is_err());
    }
}
