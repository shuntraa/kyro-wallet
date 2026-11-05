// SPDX-License-Identifier: GPL-3.0-or-later
//! Proof of the Bitcoin time lock against a real `bitcoind`, not a mock. Starts its own nodes on
//! temp datadirs (regtest, plus empty offline mainnet and testnet4 nodes that only derive
//! addresses) and prints what the node answers.
//!
//! ```text
//! KYRO_BITCOIN_BIN=<folder with bitcoind and bitcoin-cli> \
//!   cargo test -p kyro-desktop btc_lock_regtest -- --ignored --nocapture --test-threads=1
//! ```
//!
//! Funding goes through the app's TypeScript (`packages/chains/test/lock-regtest.test.ts`) and
//! Rust; withdrawals through the same `plan_withdraw` and `scan_step` the commands call. Bad
//! transactions are built here with rust-bitcoin directly, on purpose not with Kyro's code.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::str::FromStr;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use bitcoin::absolute::LockTime;
use bitcoin::bip32::{DerivationPath, Xpriv};
use bitcoin::consensus::encode::{deserialize_hex, serialize_hex};
use bitcoin::hashes::Hash;
use bitcoin::secp256k1::{Message, Secp256k1};
use bitcoin::sighash::{EcdsaSighashType, SighashCache};
use bitcoin::transaction::Version;
use bitcoin::{
    Address, Amount, Network as BtcNet, OutPoint, ScriptBuf, Sequence, Transaction, TxIn, TxOut,
    Txid, Witness,
};
use serde_json::{json, Value};
use wallet_core::{
    btc_account, btc_address, btc_lock_check_window, btc_lock_info, btc_lock_sign_funding,
    btc_lock_spend_unchecked, btc_script_pubkey, BtcKind, BtcLockAddress, BtcLockInfo, BtcLockUtxo,
    Mnemonic, Network, Seed, BTC_LOCK_DAY_SECS, BTC_LOCK_MAX_DAYS_AHEAD,
};

use crate::btc_backend::{self, Ctx, Tip};
use crate::btc_lock::{plan_withdraw, scan_step, AddrView, Coin, LockChain};
use crate::core_rpc::CoreClient;
use crate::error::{AppError, AppResult};
use crate::net::NetClient;
use crate::servers::{BtcServer, CoreAuth};

const PHRASE: &str =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const NET: Network = Network::Testnet;
const RPC: u16 = 28_443;

fn seed() -> Seed {
    Mnemonic::parse(PHRASE).unwrap().to_seed("")
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .unwrap()
        .to_path_buf()
}

struct Node {
    child: Child,
    bin: PathBuf,
    chain: &'static str,
    port: u16,
    dir: PathBuf,
}

impl Node {
    fn start(chain: &'static str, port: u16) -> Node {
        let bin = PathBuf::from(std::env::var("KYRO_BITCOIN_BIN").expect("KYRO_BITCOIN_BIN"));
        let dir = std::env::temp_dir().join(format!(
            "kyro-regtest-{chain}-{}-{}",
            std::process::id(),
            port
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let child = Command::new(bin.join("bitcoind"))
            .args([
                format!("-chain={chain}"),
                format!("-datadir={}", dir.display()),
                format!("-rpcport={port}"),
                "-rpcuser=k".into(),
                "-rpcpassword=x".into(),
                "-server=1".into(),
                "-listen=0".into(),
                "-connect=0".into(),
                "-dnsseed=0".into(),
                "-txindex=1".into(),
                "-fallbackfee=0.0002".into(),
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let node = Node {
            child,
            bin,
            chain,
            port,
            dir,
        };
        let start = Instant::now();
        while node.cli(&["getblockcount"]).is_err() {
            assert!(
                start.elapsed() < Duration::from_secs(120),
                "node did not start"
            );
            std::thread::sleep(Duration::from_millis(300));
        }
        node
    }

    fn cli_in(&self, wallet: Option<&str>, args: &[&str]) -> Result<String, String> {
        let mut c = Command::new(self.bin.join("bitcoin-cli"));
        c.arg(format!("-chain={}", self.chain))
            .arg(format!("-rpcport={}", self.port))
            .args(["-rpcuser=k", "-rpcpassword=x"]);
        if let Some(w) = wallet {
            c.arg(format!("-rpcwallet={w}"));
        }
        let out = c.args(args).output().unwrap();
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_owned())
        }
    }

    fn cli(&self, args: &[&str]) -> Result<String, String> {
        self.cli_in(None, args)
    }

    fn ok(&self, args: &[&str]) -> String {
        self.cli(args)
            .unwrap_or_else(|e| panic!("{}: {e}", args.join(" ")))
    }

    fn wallet(&self, w: &str, args: &[&str]) -> String {
        self.cli_in(Some(w), args)
            .unwrap_or_else(|e| panic!("{}: {e}", args.join(" ")))
    }

    fn json(&self, args: &[&str]) -> Value {
        serde_json::from_str(&self.ok(args)).unwrap()
    }

    fn mtp(&self) -> u64 {
        self.json(&["getblockchaininfo"])["mediantime"]
            .as_u64()
            .unwrap()
    }

    /// Mines blocks stamped `time` until the median time past is exactly there.
    fn set_mtp(&self, time: u64) {
        self.ok(&["setmocktime", &time.to_string()]);
        while self.mtp() < time {
            self.mine();
        }
        assert_eq!(self.mtp(), time);
    }

    fn mine(&self) {
        self.wallet("miner", &["-generate", "1"]);
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

impl Drop for Node {
    fn drop(&mut self) {
        let _ = self.cli(&["stop"]);
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(20) {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        let _ = self.child.kill();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn regtest_address(spk_hex: &str) -> String {
    let spk = ScriptBuf::from_hex(spk_hex).unwrap();
    Address::from_script(&spk, BtcNet::Regtest)
        .unwrap()
        .to_string()
}

/// The master key from the phrase, by a script that shares no code with Kyro.
fn master_tprv(network: &str) -> String {
    use std::io::Write as _;
    let mut child = Command::new("node")
        .arg(repo_root().join("scripts/btc-phrase-to-xprv.mjs"))
        .arg(network)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(PHRASE.as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

fn with_checksum(node: &Node, desc: &str) -> String {
    let info = node.json(&["getdescriptorinfo", desc]);
    format!("{desc}#{}", info["checksum"].as_str().unwrap())
}

fn core_address(node: &Node, desc: &str) -> String {
    let list = node.json(&["deriveaddresses", &with_checksum(node, desc)]);
    list[0].as_str().unwrap().to_owned()
}

fn private_descriptor(tprv: &str, coin: u32, info: &BtcLockInfo) -> String {
    format!(
        "wsh(and_v(v:pk({tprv}/84h/{coin}h/{}h/2/{}),after({})))",
        info.account, info.day, info.t
    )
}

fn job_run(job: &Value, dir: &Path, name: &str) -> Value {
    let job_path = dir.join(format!("{name}.json"));
    let out_path = dir.join(format!("{name}.out.json"));
    let mut job = job.clone();
    job["out"] = json!(out_path.to_string_lossy());
    std::fs::write(&job_path, job.to_string()).unwrap();
    let pnpm = if cfg!(windows) { "pnpm.cmd" } else { "pnpm" };
    let mut c = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/c", pnpm]);
        c
    } else {
        Command::new(pnpm)
    };
    let out = c
        .current_dir(repo_root().join("packages/chains"))
        .args(["exec", "vitest", "run", "test/lock-regtest.test.ts"])
        .env("KYRO_LOCK_JOB", &job_path)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "vitest: {}",
        String::from_utf8_lossy(&out.stdout)
    );
    serde_json::from_slice(&std::fs::read(&out_path).unwrap()).unwrap()
}

fn accounts() -> Value {
    let one = |kind: BtcKind| {
        let a = btc_account(&seed(), NET, kind, 0).unwrap();
        json!({ "kind": a.kind, "xpub": a.xpub, "fingerprint": a.fingerprint, "path": a.path,
                "address": btc_address(&seed(), NET, kind, 0, false, 0).unwrap() })
    };
    json!({ "segwit": one(BtcKind::Segwit), "taproot": one(BtcKind::Taproot) })
}

/// Pays the wallet's first address from the miner, then funds a lock the way the app does.
fn fund_like_the_app(node: &Node, dir: &Path, info: &BtcLockInfo, sats: u64) -> String {
    let own = btc_address(&seed(), NET, BtcKind::Segwit, 0, false, 0).unwrap();
    let own_spk = hex::encode(btc_script_pubkey(&own, NET).unwrap().as_bytes());
    let coin_sats = sats + 10_000;
    let amount = format!("{}.{:08}", coin_sats / 100_000_000, coin_sats % 100_000_000);
    let txid = node.wallet(
        "miner",
        &["sendtoaddress", &regtest_address(&own_spk), &amount],
    );
    node.mine();
    let tx = node.json(&["getrawtransaction", &txid, "1"]);
    let vout = tx["vout"]
        .as_array()
        .unwrap()
        .iter()
        .position(|o| o["scriptPubKey"]["hex"] == json!(own_spk))
        .unwrap();
    let name = format!("job-{}-{sats}", info.day);
    let built = job_run(
        &json!({ "stage": "build", "accounts": accounts(), "to": info.address, "amount": sats,
                 "satPerVb": 2, "utxos": { own.clone(): [{ "txid": txid, "vout": vout, "value": coin_sats }] } }),
        dir,
        &format!("{name}-build"),
    );
    let (signed, summary) = btc_lock_sign_funding(
        &seed(),
        NET,
        0,
        info.t,
        sats,
        built["psbt"].as_str().unwrap(),
    )
    .unwrap();
    assert_eq!(summary.outputs[0].0, info.address);
    let finished = job_run(
        &json!({ "stage": "finish", "accounts": accounts(), "psbt": built["psbt"], "amount": sats,
                 "signed": signed, "t": info.t }),
        dir,
        &format!("{name}-finish"),
    );
    let funding = node.ok(&["sendrawtransaction", finished["hex"].as_str().unwrap()]);
    assert_eq!(funding, finished["txid"].as_str().unwrap());
    node.mine();
    funding
}

/// `bitcoind` behind the same trait the commands use. `tip` is the app's Core code path.
struct RegChain<'a> {
    ctx: Ctx<'a>,
    client: CoreClient<'a>,
    node: &'a Node,
    used: Mutex<HashSet<String>>,
}

impl LockChain for RegChain<'_> {
    async fn tip(&self) -> AppResult<Tip> {
        btc_backend::tip_info(&self.ctx).await
    }

    async fn view(&self, info: &BtcLockInfo) -> AppResult<AddrView> {
        let scan = self.node.json(&[
            "scantxoutset",
            "start",
            &json!([format!("raw({})", info.script_pubkey)]).to_string(),
        ]);
        let coins: Vec<Coin> = scan["unspents"]
            .as_array()
            .unwrap()
            .iter()
            .map(|u| Coin {
                utxo: BtcLockUtxo {
                    txid: u["txid"].as_str().unwrap().to_owned(),
                    vout: u["vout"].as_u64().unwrap() as u32,
                    value: crate::core_rpc::btc_to_sats(&u["amount"]).unwrap(),
                },
                confirmed: true,
            })
            .collect();
        Ok(AddrView {
            tx_count: coins.len() as u64,
            coins,
        })
    }

    async fn wallet_address_used(&self, address: &str) -> AppResult<bool> {
        Ok(self.used.lock().unwrap().contains(address))
    }

    async fn grid_used(&self, grid: &[BtcLockAddress]) -> AppResult<Vec<bool>> {
        let scripts: Vec<String> = grid.iter().map(|g| g.script_pubkey.clone()).collect();
        let found = btc_backend::core_lock_scan(&self.client, &scripts).await?;
        Ok(scripts
            .iter()
            .map(|s| found.iter().any(|f| f.script_pubkey == *s))
            .collect())
    }

    async fn broadcast(&self, hex: &str) -> AppResult<String> {
        self.node
            .cli(&["sendrawtransaction", hex])
            .map_err(AppError::InvalidInput)
    }

    fn chunk_days(&self) -> u32 {
        u32::MAX
    }
}

/// A spend of `coins` built here, independent from Kyro's builder, with whatever fields a test wants.
fn hand_spend(
    info: &BtcLockInfo,
    coins: &[BtcLockUtxo],
    lock_time: u32,
    sequence: u32,
    key_path: &str,
    dest: &ScriptBuf,
) -> String {
    let secp = Secp256k1::new();
    let master = Xpriv::new_master(bitcoin::NetworkKind::Test, &seed()[..]).unwrap();
    let key = master
        .derive_priv(&secp, &DerivationPath::from_str(key_path).unwrap())
        .unwrap();
    let script = ScriptBuf::from_hex(&info.witness_script).unwrap();
    let total: u64 = coins.iter().map(|c| c.value).sum();
    let mut tx = Transaction {
        version: Version::TWO,
        lock_time: LockTime::from_consensus(lock_time),
        input: coins
            .iter()
            .map(|c| TxIn {
                previous_output: OutPoint {
                    txid: Txid::from_str(&c.txid).unwrap(),
                    vout: c.vout,
                },
                script_sig: ScriptBuf::new(),
                sequence: Sequence(sequence),
                witness: Witness::new(),
            })
            .collect(),
        output: vec![TxOut {
            value: Amount::from_sat(total - 2_000),
            script_pubkey: dest.clone(),
        }],
    };
    let mut witnesses = Vec::new();
    {
        let mut cache = SighashCache::new(&tx);
        for (i, c) in coins.iter().enumerate() {
            let h = cache
                .p2wsh_signature_hash(i, &script, Amount::from_sat(c.value), EcdsaSighashType::All)
                .unwrap();
            let msg = Message::from_digest(h.to_byte_array());
            let sig = secp.sign_ecdsa(&msg, &key.private_key);
            let mut w = Witness::new();
            w.push_ecdsa_signature(&bitcoin::ecdsa::Signature {
                signature: sig,
                sighash_type: EcdsaSighashType::All,
            });
            w.push(script.as_bytes());
            witnesses.push(w);
        }
    }
    for (i, w) in tx.input.iter_mut().zip(witnesses) {
        i.witness = w;
    }
    serialize_hex(&tx)
}

fn refused(node: &Node, label: &str, hex: &str, expect: &str) {
    let answer = node
        .cli(&["sendrawtransaction", hex])
        .expect_err("the node accepted it");
    println!("  {label}: node said: {answer}");
    assert!(answer.contains(expect), "{label}: {answer}");
}

fn block_refused(node: &Node, label: &str, hex: &str, expect: &str) {
    let to = node.wallet("miner", &["getnewaddress"]);
    let txs = json!([hex]).to_string();
    let answer = node
        .cli(&["generateblock", &to, &txs])
        .expect_err("the node mined it");
    println!("  {label}: in a block, node said: {answer}");
    assert!(answer.contains(expect), "{label}: {answer}");
}

fn run<F: std::future::Future>(f: F) -> F::Output {
    tauri::async_runtime::block_on(f)
}

fn day_time(day: u64) -> u32 {
    u32::try_from(day * u64::from(BTC_LOCK_DAY_SECS)).unwrap()
}

#[test]
#[ignore = "needs bitcoind: see the top of the file"]
fn btc_lock_regtest() {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let today = now / u64::from(BTC_LOCK_DAY_SECS);
    let t = day_time(today + 30);
    let (t2, t3) = (day_time(today + 31), day_time(today + 32));
    let t_ten = day_time(today + u64::from(BTC_LOCK_MAX_DAYS_AHEAD));
    let t_big = 2_147_558_400u32; // first midnight past 2^31: the script number takes 5 bytes
    let info = |t| btc_lock_info(&seed(), NET, 0, t).unwrap();
    let (lock, lock2, lock3, ten, big) = (info(t), info(t2), info(t3), info(t_ten), info(t_big));

    let work = std::env::temp_dir().join(format!("kyro-regtest-work-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).unwrap();

    // ---- 1. Core's own derivation on the real address formats
    println!("RESULT 1: descriptor against Bitcoin Core");
    let tprv = master_tprv("testnet");
    let xprv = master_tprv("mainnet");
    {
        let main = Node::start("main", RPC + 1);
        let test = Node::start("testnet4", RPC + 2);
        for (node, coin, net, root) in [(&main, 0, Network::Mainnet, &xprv), (&test, 1, NET, &tprv)]
        {
            let kyro = btc_lock_info(&seed(), net, 0, t).unwrap();
            let d = node.json(&["getdescriptorinfo", &kyro.descriptor]);
            assert_eq!(
                kyro.descriptor.split('#').nth(1).unwrap(),
                d["checksum"].as_str().unwrap(),
                "checksum"
            );
            assert_eq!(d["isrange"], false);
            assert_eq!(d["issolvable"], true);
            let from_public = node.json(&["deriveaddresses", &kyro.descriptor]);
            let from_private = core_address(node, &private_descriptor(root, coin, &kyro));
            println!(
                "  {}: Kyro {} / Core (Kyro's descriptor) {} / Core (from the phrase) {from_private}",
                node.chain, kyro.address, from_public[0]
            );
            assert_eq!(from_public[0].as_str().unwrap(), kyro.address);
            assert_eq!(from_private, kyro.address);
            // Account 1 too, and the date ten years ahead (result 8).
            let far = btc_lock_info(&seed(), net, 1, t_ten).unwrap();
            let far_core = core_address(node, &private_descriptor(root, coin, &far));
            println!("  {}: account 1, {t_ten}: {far_core}", node.chain);
            assert_eq!(far_core, far.address);
            let five = btc_lock_info(&seed(), net, 0, t_big).unwrap();
            let refused = node
                .cli(&["getdescriptorinfo", &private_descriptor(root, coin, &five)])
                .expect_err("after(2^31 or more) has no descriptor");
            println!(
                "  {}: after({t_big}): {}",
                node.chain,
                refused.replace(root.as_str(), "KEY").replace('\n', " ")
            );
            assert!(refused.contains("A function is needed within P2WSH"));
            let last = day_time(u64::from(wallet_core::BTC_LOCK_LAST_DESCRIBABLE_DAY));
            let edge = btc_lock_info(&seed(), net, 0, last).unwrap();
            let edge_core = core_address(node, &private_descriptor(root, coin, &edge));
            println!("  {}: last allowed date {last}: {edge_core}", node.chain);
            assert_eq!(edge_core, edge.address);
        }
    }
    let node = Node::start("regtest", RPC);
    node.ok(&["setmocktime", &now.to_string()]);
    node.ok(&["createwallet", "miner"]);
    node.wallet("miner", &["-generate", "110"]);
    let core_reg = core_address(&node, &private_descriptor(&tprv, 1, &lock));
    let v = node.json(&["validateaddress", &core_reg]);
    println!(
        "  regtest: Core {core_reg}, script {} / Kyro script {}",
        v["scriptPubKey"], lock.script_pubkey
    );
    assert_eq!(v["scriptPubKey"].as_str().unwrap(), lock.script_pubkey);

    let net_client = NetClient::new(work.join("net")).unwrap();
    let auth = CoreAuth::Userpass {
        user: "k".into(),
        password: Some("x".into()),
        has_password: true,
    };
    let ctx = Ctx {
        net_client: &net_client,
        network: NET,
        tor: false,
        server: BtcServer::Core {
            url: node.url(),
            auth: auth.clone(),
        },
        fingerprint: Some("73c5da0a".into()),
    };
    let client = CoreClient::new(&net_client, &node.url(), &auth, false).unwrap();
    let chain = RegChain {
        ctx,
        client,
        node: &node,
        used: Mutex::new(HashSet::new()),
    };
    let own0 = btc_address(&seed(), NET, BtcKind::Segwit, 0, false, 0).unwrap();
    chain.used.lock().unwrap().insert(own0);

    // The Core backend's watch wallet: the app imports the script before funding.
    let watch = "kyro-watch-73c5da0a";
    run(chain.client.create_watch_wallet(watch)).unwrap();
    run(btc_backend::core_lock_watch(
        &chain.client,
        watch,
        &lock.script_pubkey,
        None,
    ))
    .unwrap();

    // ---- 2. Funding by the real code path, and 8a: a second lock on the same date
    println!("RESULT 2: funding with the app's TypeScript and Rust");
    let tip = run(chain.tip()).unwrap();
    btc_lock_check_window(t, now, tip.time).unwrap();
    let f1 = fund_like_the_app(&node, &work, &lock, 100_000);
    println!("  funded {} with 100000 sats in {f1}", lock.address);
    let f2 = fund_like_the_app(&node, &work, &lock, 60_000);
    println!("  RESULT 8a: second lock, same date, same address, 60000 sats in {f2}");
    fund_like_the_app(&node, &work, &lock2, 200_000);
    fund_like_the_app(&node, &work, &lock3, 300_000);
    let view = run(chain.view(&lock)).unwrap();
    assert_eq!(view.coins.len(), 2);
    let total: u64 = view.coins.iter().map(|c| c.utxo.value).sum();
    assert_eq!(total, 160_000);
    let reg_lock = regtest_address(&lock.script_pubkey);
    let seen = node.wallet(
        watch,
        &[
            "listunspent",
            "0",
            "9999999",
            &json!([reg_lock]).to_string(),
        ],
    );
    let seen: Value = serde_json::from_str(&seen).unwrap();
    println!(
        "  the Core backend's watch wallet sees {} coins at the lock",
        seen.as_array().unwrap().len()
    );
    assert_eq!(seen.as_array().unwrap().len(), 2);
    let coins: Vec<BtcLockUtxo> = view.coins.iter().map(|c| c.utxo.clone()).collect();

    // ---- 3. Before T: refused, up to and including MTP = T
    println!("RESULT 3: before T, the network refuses Kyro's correctly signed spend");
    let early = btc_lock_spend_unchecked(&seed(), NET, 0, t, &coins, 1, 2).unwrap();
    let u = u64::from(t);
    println!("  MTP {} is {} s under T", node.mtp(), u - node.mtp());
    refused(&node, "days before", &early.hex, "non-final");
    block_refused(&node, "days before", &early.hex, "bad-txns-nonfinal");
    node.set_mtp(u - 1);
    println!("  MTP {} = T - 1", node.mtp());
    refused(&node, "MTP = T - 1", &early.hex, "non-final");
    block_refused(&node, "MTP = T - 1", &early.hex, "bad-txns-nonfinal");
    node.set_mtp(u);
    println!("  MTP {} = T", node.mtp());
    refused(&node, "MTP = T", &early.hex, "non-final");
    assert!(run(plan_withdraw(&chain, &seed(), NET, 0, t, 2)).is_err());
    println!("  Kyro itself refuses to build it at MTP = T");

    // ---- 4. After T, what does not satisfy the script is refused by the script
    node.set_mtp(u + 1);
    println!("RESULT 4: at MTP = T + 1, wrong spends are refused by script");
    let dest = btc_script_pubkey(
        &btc_address(&seed(), NET, BtcKind::Segwit, 0, false, 9).unwrap(),
        NET,
    )
    .unwrap();
    let right = format!("m/84'/1'/0'/2/{}", lock.day);
    let wrong = format!("m/84'/1'/0'/2/{}", lock.day + 1);
    let cases = [
        ("nLockTime T - 1", t - 1, 0xFFFF_FFFD, right.as_str()),
        ("nLockTime 0", 0, 0xFFFF_FFFD, right.as_str()),
        ("sequence final", t, 0xFFFF_FFFF, right.as_str()),
        ("another key", t, 0xFFFF_FFFD, wrong.as_str()),
    ];
    for (label, lt, seq, key) in cases {
        let hex = hand_spend(&lock, &coins, lt, seq, key, &dest);
        let tx: Transaction = deserialize_hex(&hex).unwrap();
        assert_eq!(tx.lock_time.to_consensus_u32(), lt);
        refused(&node, label, &hex, "script-verify-flag");
        block_refused(&node, label, &hex, "script-verify-flag");
    }
    // The same hand-built transaction with the right fields passes: the refusals were about them.
    let control = hand_spend(&lock, &coins, t, 0xFFFF_FFFD, &right, &dest);
    let test: Value =
        serde_json::from_str(&node.ok(&["testmempoolaccept", &json!([control]).to_string()]))
            .unwrap();
    println!("  control, right fields: allowed = {}", test[0]["allowed"]);
    assert_eq!(test[0]["allowed"], true);

    // ---- 5. Kyro's spend after T
    println!("RESULT 5: at MTP past T, Kyro's withdrawal");
    let spend = run(plan_withdraw(&chain, &seed(), NET, 0, t, 2)).unwrap();
    let dest1 = btc_address(&seed(), NET, BtcKind::Segwit, 0, false, 1).unwrap();
    assert_eq!(spend.destination, dest1);
    let txid = run(chain.broadcast(&spend.hex)).unwrap();
    println!("  accepted: {txid}");
    assert_eq!(txid, spend.txid);
    node.mine();
    chain.used.lock().unwrap().insert(dest1.clone());
    let tx = node.json(&["getrawtransaction", &txid, "1"]);
    let paid = crate::core_rpc::btc_to_sats(&tx["vout"][0]["value"]).unwrap();
    println!(
        "  mined ({} confirmation), pays {paid} sats to {dest1}, locktime {}, fee {}, 160000 in",
        tx["confirmations"], tx["locktime"], spend.fee_sats
    );
    assert_eq!(tx["confirmations"], 1);
    assert_eq!(tx["locktime"], t);
    assert_eq!(tx["vout"].as_array().unwrap().len(), 1);
    assert_eq!(
        tx["vout"][0]["scriptPubKey"]["hex"].as_str().unwrap(),
        hex::encode(btc_script_pubkey(&dest1, NET).unwrap().as_bytes())
    );
    assert_eq!(paid, 160_000 - spend.fee_sats);
    assert_eq!(paid, spend.amount_sats);
    println!(
        "  RESULT 8a: both coins of the date went in one transaction ({} inputs)",
        tx["vin"].as_array().unwrap().len()
    );
    assert_eq!(tx["vin"].as_array().unwrap().len(), 2);
    assert!(run(chain.view(&lock)).unwrap().coins.is_empty());

    // ---- 6. Bitcoin Core alone
    node.set_mtp(u64::from(t2) + 1);
    println!("RESULT 6: Bitcoin Core alone, from the phrase's xprv, no Kyro code");
    node.ok(&["createwallet", "alone", "false", "true"]);
    let desc = with_checksum(&node, &private_descriptor(&tprv, 1, &lock2));
    let import = json!([{ "desc": desc, "timestamp": 0 }]).to_string();
    let imported = node.wallet("alone", &["importdescriptors", &import]);
    println!(
        "  importdescriptors: {}",
        imported.split_whitespace().collect::<String>()
    );
    let list: Value = serde_json::from_str(&node.wallet("alone", &["listunspent"])).unwrap();
    println!(
        "  listunspent: {} BTC, solvable {}, spendable {}",
        list[0]["amount"], list[0]["solvable"], list[0]["spendable"]
    );
    assert_eq!(list.as_array().unwrap().len(), 1);
    let to = node.wallet("miner", &["getnewaddress"]);
    let opts = json!({ "locktime": t2 }).to_string();
    let sent = node.cli_in(
        Some("alone"),
        &[
            "-named",
            "sendall",
            &format!("recipients={}", json!([to])),
            "fee_rate=2",
            &format!("options={opts}"),
        ],
    );
    println!(
        "  sendall: {:?}",
        sent.as_ref()
            .map(|s| s.split_whitespace().collect::<String>())
    );
    let sent: Value = serde_json::from_str(&sent.unwrap()).unwrap();
    let core_txid = sent["txid"].as_str().unwrap();
    node.mine();
    let tx = node.json(&["getrawtransaction", core_txid, "1"]);
    println!(
        "  mined: {core_txid}, locktime {}, sequence {}, {} BTC out",
        tx["locktime"], tx["vin"][0]["sequence"], tx["vout"][0]["value"]
    );
    assert_eq!(tx["confirmations"], 1);
    assert!(run(chain.view(&lock2)).unwrap().coins.is_empty());

    // ---- 7. Recovery with nothing but the phrase
    println!("RESULT 7: list deleted, scan with the phrase only");
    let store = work.join("v.btclocks");
    let _ = std::fs::remove_file(&store);
    assert!(!store.exists());
    let step = run(scan_step(&chain, &store, &seed(), NET, 0, None, now)).unwrap();
    println!(
        "  walked days {}..{}, found {}, finished {}",
        step.first_day,
        step.last_day,
        step.found,
        step.next_day.is_none()
    );
    let rebuilt: Value = serde_json::from_slice(&std::fs::read(&store).unwrap()).unwrap();
    let records = rebuilt["locks"].as_array().unwrap();
    assert_eq!(records.len(), 1, "the two spent locks hold nothing");
    assert_eq!(records[0]["t"], t3);
    assert_eq!(records[0]["address"].as_str().unwrap(), lock3.address);
    println!("  rebuilt the list: {} on {t3}", records[0]["address"]);
    let spk3 = [lock3.script_pubkey.clone()];
    let found = run(btc_backend::core_lock_scan(&chain.client, &spk3));
    let height = found.unwrap()[0].height;
    run(btc_backend::core_lock_watch(
        &chain.client,
        watch,
        &lock3.script_pubkey,
        Some(height),
    ))
    .unwrap();
    let reg3 = regtest_address(&lock3.script_pubkey);
    let seen = node.wallet(
        watch,
        &["listunspent", "0", "9999999", &json!([reg3]).to_string()],
    );
    let seen: Value = serde_json::from_str(&seen).unwrap();
    println!(
        "  watch wallet after the rescan from its height: {} coin",
        seen.as_array().unwrap().len()
    );
    assert_eq!(seen.as_array().unwrap().len(), 1);
    node.set_mtp(u64::from(t3) + 1);
    let spend = run(plan_withdraw(&chain, &seed(), NET, 0, t3, 2)).unwrap();
    let txid = run(chain.broadcast(&spend.hex)).unwrap();
    node.mine();
    let tx = node.json(&["getrawtransaction", &txid, "1"]);
    println!(
        "  withdrew {} sats in {txid}, {} confirmation",
        spend.amount_sats, tx["confirmations"]
    );
    assert_eq!(tx["confirmations"], 1);
    assert_eq!(spend.amount_sats, 300_000 - spend.fee_sats);

    // ---- 8b and extra: ten years ahead is in the grid; a 5-byte time really spends
    println!("RESULT 8b: the date ten years ahead");
    let reg_ten = core_address(&node, &private_descriptor(&tprv, 1, &ten));
    let v = node.json(&["validateaddress", &reg_ten]);
    println!("  Core {reg_ten}, Kyro {}", ten.address);
    assert_eq!(v["scriptPubKey"].as_str().unwrap(), ten.script_pubkey);

    println!("RESULT extra: T above 2^31 (5-byte script number) on the node");
    println!("  witness script {}", big.witness_script);
    let reg_big = regtest_address(&big.script_pubkey);
    node.wallet("miner", &["sendtoaddress", &reg_big, "0.001"]);
    node.mine();
    let view = run(chain.view(&big)).unwrap();
    let coins: Vec<BtcLockUtxo> = view.coins.iter().map(|c| c.utxo.clone()).collect();
    let early = btc_lock_spend_unchecked(&seed(), NET, 0, t_big, &coins, 2, 2).unwrap();
    node.set_mtp(u64::from(t_big) - 1);
    refused(&node, "MTP = T - 1", &early.hex, "non-final");
    node.set_mtp(u64::from(t_big) + 1);
    let right = format!("m/84'/1'/0'/2/{}", big.day);
    let low = hand_spend(&big, &coins, t_big - 1, 0xFFFF_FFFD, &right, &dest);
    refused(&node, "nLockTime T - 1", &low, "script-verify-flag");
    let txid = node.ok(&["sendrawtransaction", &early.hex]);
    node.mine();
    println!("  accepted at MTP = T + 1: {txid}");

    drop(chain);
    drop(node);
    let _ = std::fs::remove_dir_all(&work);
    println!("ALL RESULTS PASSED");
}
