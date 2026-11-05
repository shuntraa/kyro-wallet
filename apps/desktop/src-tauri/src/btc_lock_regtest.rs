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
    btc_account, btc_address, btc_lock_check_window, btc_lock_info, btc_lock_plan_unchecked,
    btc_lock_sign_funding, btc_lock_sign_plan, btc_script_pubkey, BtcKind, BtcLockAddress,
    BtcLockInfo, BtcLockSpend, BtcLockUtxo, Mnemonic, Network, Seed, BTC_LOCK_DAY_SECS,
    BTC_LOCK_MAX_DAYS_AHEAD,
};

use crate::btc_backend::{self, Ctx, Tip};
use crate::btc_lock::{
    core_grid, plan_withdraw, read_status, scan_step, status_of, AddrView, GridAnswer, LockChain,
    Record, Status,
};
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
    fn start(chain: &'static str, port: u16, extra: &[&str]) -> Node {
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
                "-fallbackfee=0.0002".into(),
            ])
            .args(extra)
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

/// The master key for Core to derive from: the path and script below are then Core's work.
fn master_key(kind: bitcoin::NetworkKind) -> String {
    Xpriv::new_master(kind, &seed()[..]).unwrap().to_string()
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

/// `bitcoind` behind the same trait the commands use, through the same Core functions. Only the
/// address format differs: the node wants `bcrt1`.
struct RegChain<'a> {
    ctx: Ctx<'a>,
    client: CoreClient<'a>,
    node: &'a Node,
    wallet: &'a str,
    used: Mutex<HashSet<String>>,
}

impl LockChain for RegChain<'_> {
    async fn tip(&self) -> AppResult<Tip> {
        btc_backend::tip_info(&self.ctx).await
    }

    async fn adopt(&self, locks: &[BtcLockInfo]) -> AppResult<Vec<(String, Vec<BtcLockUtxo>)>> {
        let scripts: Vec<String> = locks.iter().map(|l| l.script_pubkey.clone()).collect();
        btc_backend::core_locks_adopt(&self.client, self.wallet, &scripts).await
    }

    async fn view(&self, info: &BtcLockInfo, known: &[BtcLockUtxo]) -> AppResult<AddrView> {
        let address = regtest_address(&info.script_pubkey);
        btc_backend::core_lock_view(&self.client, self.wallet, &address, known).await
    }

    async fn wallet_address_used(&self, address: &str) -> AppResult<bool> {
        Ok(self.used.lock().unwrap().contains(address))
    }

    async fn grid_used(&self, grid: &[BtcLockAddress]) -> AppResult<Vec<GridAnswer>> {
        core_grid(&self.client, self.wallet, grid).await
    }

    async fn broadcast(&self, hex: &str) -> AppResult<String> {
        self.node
            .cli(&["sendrawtransaction", hex])
            .map_err(AppError::InvalidInput)
    }

    fn chunk_days(&self) -> u32 {
        u32::MAX
    }

    fn keeps_coins(&self) -> bool {
        true
    }
}

fn core_chain<'a>(
    node: &'a Node,
    net_client: &'a NetClient,
    wallet: &'a str,
    auth: &CoreAuth,
) -> RegChain<'a> {
    RegChain {
        ctx: Ctx {
            net_client,
            network: NET,
            tor: false,
            server: BtcServer::Core {
                url: node.url(),
                auth: auth.clone(),
            },
            fingerprint: Some("73c5da0a".into()),
        },
        client: CoreClient::new(net_client, &node.url(), auth, false).unwrap(),
        node,
        wallet,
        used: Mutex::new(HashSet::new()),
    }
}

/// The list as a backup restore or a change of server leaves it: lines the node never heard of.
fn write_list(path: &Path, lines: &[(u32, u64)]) {
    let locks: Vec<Value> = lines
        .iter()
        .map(|(t, sats)| {
            json!({ "account": 0, "t": t, "lastSats": sats, "withdrawn": false, "seen": false,
                    "coins": [] })
        })
        .collect();
    std::fs::write(path, json!({ "version": 1, "locks": locks }).to_string()).unwrap();
}

fn spend_unchecked(t: u32, coins: &[BtcLockUtxo], index: u32) -> BtcLockSpend {
    let plan = btc_lock_plan_unchecked(&seed(), NET, 0, t, coins, index, 2).unwrap();
    btc_lock_sign_plan(&seed(), NET, &plan).unwrap()
}

/// Runs `plan_withdraw` and signs, as the command does once the dialogs are approved.
fn withdraw(chain: &RegChain<'_>, list: &Path, t: u32) -> (wallet_core::BtcLockPlan, String) {
    let w = run(plan_withdraw(chain, list, &seed(), NET, 0, t, 2)).unwrap();
    let spend = btc_lock_sign_plan(&seed(), NET, &w.plan).unwrap();
    let txid = run(chain.broadcast(&spend.hex)).unwrap();
    assert_eq!(txid, spend.txid);
    (w.plan, txid)
}

fn coins_of(chain: &RegChain<'_>, info: &BtcLockInfo) -> Vec<BtcLockUtxo> {
    run(chain.adopt(std::slice::from_ref(info))).unwrap();
    let view = run(chain.view(info, &[])).unwrap();
    view.coins.iter().map(|c| c.utxo.clone()).collect()
}

/// Every `sh` line of the "Withdrawing without Kyro" section, exactly as the document has it.
fn documented_commands() -> Vec<String> {
    let doc = std::fs::read_to_string(repo_root().join("docs/BTC_TIMELOCK.md")).unwrap();
    let section = doc.split("## Withdrawing without Kyro").nth(1).unwrap();
    let section = section.split("\n## ").next().unwrap();
    section
        .split("```sh\n")
        .skip(1)
        .flat_map(|block| block.split("```").next().unwrap().lines())
        .filter(|l| !l.trim().is_empty())
        .map(str::to_owned)
        .collect()
}

/// Runs one line of the document in a real shell, `bitcoin-cli` being the node under test.
fn shell(node: &Node, line: &str, input: &str) -> Result<String, String> {
    use std::io::Write as _;
    let bin = node.bin.display().to_string().replace('\\', "/");
    let prelude = format!(
        "bitcoin-cli() {{ \"{bin}/bitcoin-cli\" -regtest -rpcport={} -rpcuser=k -rpcpassword=x \"$@\"; }}\n",
        node.port
    );
    let mut child = Command::new("bash")
        .current_dir(repo_root())
        .args(["-c", &format!("{prelude}{line}")])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_owned())
    }
}

/// The recovery script refuses exactly what `Mnemonic::parse` refuses.
fn script_agrees_with_the_wallet() {
    let w: Vec<&str> = PHRASE.split(' ').collect();
    let upper = PHRASE.to_uppercase();
    let spaced = format!("  {}\t", w.join("   "));
    let typo = format!("{} abaut", w[..11].join(" "));
    let checksum = format!("{} abandon", w[..11].join(" "));
    let short = w[..11].join(" ");
    let long = format!("{PHRASE} about");
    let fifteen = format!("{}address", "abandon ".repeat(14));
    let unicode = PHRASE.replace(' ', "\u{2003}");
    let cases = [
        PHRASE, &upper, &spaced, &typo, &checksum, &short, &long, "", &fifteen, &unicode,
    ];
    let out = std::env::temp_dir().join(format!("kyro-agree-{}.json", std::process::id()));
    for phrase in cases {
        let _ = std::fs::remove_file(&out);
        use std::io::Write as _;
        let mut child = Command::new("node")
            .arg(repo_root().join("scripts/btc-lock-key.mjs"))
            .args(["--network", "testnet", "--t", "1804982400", "--out"])
            .arg(&out)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let line = format!("{phrase}\n\n");
        child
            .stdin
            .take()
            .unwrap()
            .write_all(line.as_bytes())
            .unwrap();
        let script_ok = child.wait().unwrap().success();
        assert_eq!(script_ok, Mnemonic::parse(phrase).is_ok(), "{phrase:?}");
    }
    let _ = std::fs::remove_file(&out);
    println!(
        "  the script and Mnemonic::parse agree on {} phrases",
        cases.len()
    );
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
    println!("  {label}: node said: {}", answer.replace('\n', " "));
    assert!(answer.contains(expect), "{label}: {answer}");
}

fn block_refused(node: &Node, label: &str, hex: &str, expect: &str) {
    let to = node.wallet("miner", &["getnewaddress"]);
    let txs = json!([hex]).to_string();
    let answer = node
        .cli(&["generateblock", &to, &txs])
        .expect_err("the node mined it");
    let short: String = answer.replace('\n', " ").chars().take(120).collect();
    println!("  {label}: in a block, node said: {short}");
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
    let (t2, t3, t4) = (
        day_time(today + 31),
        day_time(today + 32),
        day_time(today + 33),
    );
    let t_ten = day_time(today + u64::from(BTC_LOCK_MAX_DAYS_AHEAD));
    let t_big = 2_147_558_400u32; // first midnight past 2^31: the script number takes 5 bytes
    let info = |t| btc_lock_info(&seed(), NET, 0, t).unwrap();
    let (lock, lock2, lock3, lock4, ten, big) = (
        info(t),
        info(t2),
        info(t3),
        info(t4),
        info(t_ten),
        info(t_big),
    );

    let work = std::env::temp_dir().join(format!("kyro-regtest-work-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).unwrap();

    // ---- 1. Core's own derivation on the real address formats
    println!("RESULT 1: descriptor against Bitcoin Core");
    let tprv = master_key(bitcoin::NetworkKind::Test);
    let xprv = master_key(bitcoin::NetworkKind::Main);
    {
        let main = Node::start("main", RPC + 1, &[]);
        let test = Node::start("testnet4", RPC + 2, &[]);
        let version = main.json(&["getnetworkinfo"]);
        println!(
            "  node: {} (protocol {})",
            version["subversion"], version["protocolversion"]
        );
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
                "  {}: Kyro {} / Core (Kyro's descriptor) {} / Core (derived by Core) {from_private}",
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
    script_agrees_with_the_wallet();
    let node = Node::start("regtest", RPC, &["-txindex=1"]);
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
    let watch = "kyro-watch-73c5da0a";
    let chain = core_chain(&node, &net_client, watch, &auth);
    let own0 = btc_address(&seed(), NET, BtcKind::Segwit, 0, false, 0).unwrap();
    chain.used.lock().unwrap().insert(own0);
    let list = work.join("v.btclocks");

    // The Core backend's watch wallet: the app imports the script before funding.
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
    let view = run(chain.view(&lock, &[])).unwrap();
    assert_eq!(view.coins.len(), 2);
    let total: u64 = view.coins.iter().map(|c| c.utxo.value).sum();
    assert_eq!(total, 160_000);
    let coins: Vec<BtcLockUtxo> = view.coins.iter().map(|c| c.utxo.clone()).collect();
    println!("  the Core backend's watch wallet sees 2 coins at the lock");

    // ---- A lock the node has never heard of: another server used, or a restored backup.
    println!("RESULT 9: Core adopts a lock it was never told about");
    let reg2 = regtest_address(&lock2.script_pubkey);
    let before = node.wallet(
        watch,
        &["listunspent", "0", "9999999", &json!([reg2]).to_string()],
    );
    let before: Value = serde_json::from_str(&before).unwrap();
    println!(
        "  before: watch wallet shows {} coin at a lock holding 200000 sats",
        before.as_array().unwrap().len()
    );
    assert_eq!(before.as_array().unwrap().len(), 0, "the case to fix");
    write_list(&list, &[(t, 0), (t2, 200_000), (t3, 300_000)]);
    let all = [lock.clone(), lock2.clone(), lock3.clone()];
    let st = run(read_status(&chain, &list, &all, false)).unwrap();
    let body = serde_json::to_value(&st).unwrap();
    for l in body["locks"].as_array().unwrap() {
        println!(
            "  after: {} {} sats {}",
            l["t"], l["amountSats"], l["status"]
        );
    }
    assert_eq!(body["lockedSats"], 660_000);
    assert_eq!(body["stale"], false);
    assert!(body["locks"]
        .as_array()
        .unwrap()
        .iter()
        .all(|l| l["status"] == "locked"));
    println!("  locked_sats {}, none lost", body["lockedSats"]);

    // ---- 3. Before T: refused, up to and including MTP = T
    println!("RESULT 3: before T, the network refuses Kyro's correctly signed spend");
    let early = spend_unchecked(t, &coins, 1);
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
    assert!(run(plan_withdraw(&chain, &list, &seed(), NET, 0, t, 2)).is_err());
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
    let (plan, txid) = withdraw(&chain, &list, t);
    let dest1 = btc_address(&seed(), NET, BtcKind::Segwit, 0, false, 1).unwrap();
    assert_eq!(plan.destination, dest1);
    println!("  accepted: {txid}");
    node.mine();
    chain.used.lock().unwrap().insert(dest1.clone());
    let tx = node.json(&["getrawtransaction", &txid, "1"]);
    let paid = crate::core_rpc::btc_to_sats(&tx["vout"][0]["value"]).unwrap();
    println!(
        "  mined ({} confirmation), pays {paid} sats to {dest1}, locktime {}, fee {}, 160000 in",
        tx["confirmations"], tx["locktime"], plan.fee_sats
    );
    assert_eq!(tx["confirmations"], 1);
    assert_eq!(tx["locktime"], t);
    assert_eq!(tx["vout"].as_array().unwrap().len(), 1);
    assert_eq!(
        tx["vout"][0]["scriptPubKey"]["hex"].as_str().unwrap(),
        hex::encode(btc_script_pubkey(&dest1, NET).unwrap().as_bytes())
    );
    assert_eq!(paid, 160_000 - plan.fee_sats);
    assert_eq!(paid, plan.amount_sats);
    println!(
        "  RESULT 8a: both coins of the date went in one transaction ({} inputs)",
        tx["vin"].as_array().unwrap().len()
    );
    assert_eq!(tx["vin"].as_array().unwrap().len(), 2);
    assert!(run(chain.view(&lock, &[])).unwrap().coins.is_empty());

    // ---- 6. Bitcoin Core alone, every command as docs/BTC_TIMELOCK.md writes it
    node.set_mtp(u64::from(t2) + 1);
    println!("RESULT 6: Bitcoin Core alone, the document's commands, no Kyro code");
    let to = node.wallet("miner", &["getnewaddress"]);
    let wallets = node.dir.join("regtest").join("wallets");
    let wallets = wallets.display().to_string().replace('\\', "/");
    let mut public = String::new();
    let mut core_txid = String::new();
    let commands = documented_commands();
    assert!(commands.len() >= 9, "{commands:?}");
    for line in &commands {
        let line = line
            .replace("--network mainnet", "--network testnet")
            .replace("--t T", &format!("--t {t2}"))
            .replace("\"locktime\":T", &format!("\"locktime\":{t2}"))
            .replace("PUBLIC_DESCRIPTOR", &public)
            .replace("YOUR_ADDRESS", &to)
            .replace("WALLETS_FOLDER", &wallets);
        let answer =
            shell(&node, &line, &format!("{PHRASE}\n\n")).unwrap_or_else(|e| panic!("{line}: {e}"));
        let flat: String = answer.split_whitespace().collect::<Vec<_>>().join(" ");
        let shown: String = flat.chars().take(150).collect();
        println!("  $ {line}");
        println!("    {shown}");
        if line.contains("btc-lock-key.mjs") {
            public = answer
                .lines()
                .find_map(|l| l.strip_prefix("public: "))
                .unwrap()
                .to_owned();
            assert!(!answer.contains("prv"), "no private key on screen");
        }
        if line.contains("deriveaddresses") {
            let list: Value = serde_json::from_str(&answer).unwrap();
            let reg = regtest_address(&lock2.script_pubkey);
            assert_eq!(list[0].as_str().unwrap(), reg);
        }
        if line.contains("listunspent") {
            let list: Value = serde_json::from_str(&answer).unwrap();
            assert_eq!(list[0]["solvable"], true);
            assert_eq!(list[0]["spendable"], true);
        }
        if line.contains("sendall") {
            let sent: Value = serde_json::from_str(&answer).unwrap();
            core_txid = sent["txid"].as_str().unwrap().to_owned();
            node.mine();
        }
    }
    assert!(
        !repo_root().join("import.json").exists(),
        "the key file is gone"
    );
    assert!(
        !std::path::Path::new(&wallets).join("alone").exists(),
        "the wallet is gone"
    );
    let tx = node.json(&["getrawtransaction", &core_txid, "1"]);
    println!(
        "  mined: {core_txid}, locktime {}, sequence {}, {} BTC out; key file and wallet deleted",
        tx["locktime"], tx["vin"][0]["sequence"], tx["vout"][0]["value"]
    );
    assert_eq!(tx["confirmations"], 1);
    assert!(run(chain.view(&lock2, &[])).unwrap().coins.is_empty());

    // ---- 7. Recovery with nothing but the phrase
    println!("RESULT 7: list deleted, scan with the phrase only");
    std::fs::remove_file(&list).unwrap();
    assert!(!list.exists());
    let step = run(scan_step(&chain, &list, &seed(), NET, 0, None, now)).unwrap();
    println!(
        "  walked days {}..{}, found {}, finished {}",
        step.first_day,
        step.last_day,
        step.found,
        step.next_day.is_none()
    );
    let rebuilt: Value = serde_json::from_slice(&std::fs::read(&list).unwrap()).unwrap();
    let records = rebuilt["locks"].as_array().unwrap();
    assert_eq!(records.len(), 1, "the two spent locks hold nothing");
    assert_eq!(records[0]["t"], t3);
    println!(
        "  rebuilt the list: {} {}",
        records[0]["t"], records[0]["coins"][0]["value"]
    );
    node.set_mtp(u64::from(t3) + 1);
    let (plan, txid) = withdraw(&chain, &list, t3);
    node.mine();
    let tx = node.json(&["getrawtransaction", &txid, "1"]);
    println!(
        "  withdrew {} sats in {txid}, {} confirmation",
        plan.amount_sats, tx["confirmations"]
    );
    assert_eq!(tx["confirmations"], 1);
    assert_eq!(plan.amount_sats, 300_000 - plan.fee_sats);

    // ---- 8b: ten years ahead
    println!("RESULT 8b: the date ten years ahead");
    let reg_ten = core_address(&node, &private_descriptor(&tprv, 1, &ten));
    let v = node.json(&["validateaddress", &reg_ten]);
    println!("  Core {reg_ten}, Kyro {}", ten.address);
    assert_eq!(v["scriptPubKey"].as_str().unwrap(), ten.script_pubkey);

    // ---- A funding replaced before it confirmed
    println!("RESULT 10: a funding replaced before it confirmed");
    run(btc_backend::core_lock_watch(
        &chain.client,
        watch,
        &lock4.script_pubkey,
        None,
    ))
    .unwrap();
    let reg4 = regtest_address(&lock4.script_pubkey);
    let first = node.wallet(
        "miner",
        &[
            "-named",
            "sendtoaddress",
            &format!("address={reg4}"),
            "amount=0.002",
            "replaceable=true",
        ],
    );
    let raw = node.json(&["getrawtransaction", &first, "1"]);
    let spent = &raw["vin"][0];
    let prev = node.json(&["getrawtransaction", spent["txid"].as_str().unwrap(), "1"]);
    let value = crate::core_rpc::btc_to_sats(
        &prev["vout"][spent["vout"].as_u64().unwrap() as usize]["value"],
    )
    .unwrap();
    let back = node.wallet("miner", &["getnewaddress"]);
    let out = format!(
        "{}.{:08}",
        (value - 100_000) / 100_000_000,
        (value - 100_000) % 100_000_000
    );
    let inputs =
        json!([{ "txid": spent["txid"], "vout": spent["vout"], "sequence": 0xFFFF_FFFDu32 }]);
    let unsigned = node.ok(&[
        "createrawtransaction",
        &inputs.to_string(),
        &json!([{ back.clone(): out.parse::<f64>().unwrap() }]).to_string(),
    ]);
    let signed: Value =
        serde_json::from_str(&node.wallet("miner", &["signrawtransactionwithwallet", &unsigned]))
            .unwrap();
    let received = |minconf: &str| {
        let r = node.wallet(
            watch,
            &["listreceivedbyaddress", minconf, "true", "true", &reg4],
        );
        let r: Value = serde_json::from_str(&r).unwrap();
        r[0]["txids"].as_array().map_or(0, Vec::len)
    };
    let in_mempool = run(chain.view(&lock4, &[])).unwrap();
    assert_eq!(in_mempool.coins.len(), 1);
    assert!(!in_mempool.coins[0].confirmed);
    println!(
        "  unconfirmed: {} coin, listreceivedbyaddress minconf 0: {}, minconf 1: {}",
        in_mempool.coins.len(),
        received("0"),
        received("1")
    );
    let replacement = node.ok(&["sendrawtransaction", signed["hex"].as_str().unwrap()]);
    println!("  replaced by {replacement}");
    let count_replaced = (received("0"), received("1"));
    println!(
        "  replaced, in the mempool: minconf 0 counts {}, minconf 1 counts {}",
        count_replaced.0, count_replaced.1
    );
    node.mine();
    let count_mined = (received("0"), received("1"));
    println!(
        "  replacement mined: minconf 0 counts {}, minconf 1 counts {}",
        count_mined.0, count_mined.1
    );
    let view = run(chain.view(&lock4, &[])).unwrap();
    let record = Record {
        account: 0,
        t: t4,
        last_sats: 200_000,
        withdrawn: false,
        seen: false,
        coins: Vec::new(),
    };
    let status = status_of(&view, t4, node.mtp(), &record);
    println!(
        "  Kyro's status for that lock: {status:?} (coins {}, tx_count {})",
        view.coins.len(),
        view.tx_count
    );
    assert_eq!(status, Status::NotFound);

    // ---- T above 2^31 on the node
    println!("RESULT extra: T above 2^31 (5-byte script number) on the node");
    println!("  witness script {}", big.witness_script);
    let reg_big = regtest_address(&big.script_pubkey);
    node.wallet("miner", &["sendtoaddress", &reg_big, "0.001"]);
    node.mine();
    let coins = coins_of(&chain, &big);
    let early = spend_unchecked(t_big, &coins, 2);
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

    // ---- A pruned node
    println!("RESULT 11: a pruned node");
    let pruned = Node::start("regtest", RPC + 3, &["-prune=1", "-fastprune"]);
    pruned.ok(&["setmocktime", &now.to_string()]);
    pruned.ok(&["createwallet", "miner"]);
    pruned.wallet("miner", &["-generate", "110"]);
    let reg = regtest_address(&lock.script_pubkey);
    pruned.wallet("miner", &["sendtoaddress", &reg, "0.003"]);
    pruned.mine();
    let funded_at: u64 = pruned.ok(&["getblockcount"]).parse().unwrap();
    for _ in 0..7 {
        pruned.wallet("miner", &["-generate", "400"]);
    }
    // A day of real time: the blocks that stay are not the blocks that go, as on a real chain.
    pruned.ok(&["setmocktime", &(now + 86_400).to_string()]);
    pruned.wallet("miner", &["-generate", "400"]);
    let tip: u64 = pruned.ok(&["getblockcount"]).parse().unwrap();
    let height = pruned.ok(&["pruneblockchain", &(tip - 300).to_string()]);
    let info = pruned.json(&["getblockchaininfo"]);
    println!(
        "  funded at height {funded_at}, tip {tip}, pruned up to {height}, pruneheight {}",
        info["pruneheight"]
    );
    assert!(
        info["pruneheight"].as_u64().unwrap() > funded_at,
        "the funding block is gone"
    );
    let chain = core_chain(&pruned, &net_client, watch, &auth);
    run(chain.client.create_watch_wallet(watch)).unwrap();
    // What Core really answers to a rescan past the pruned height.
    let desc = format!("raw({})", lock.script_pubkey);
    let desc = with_checksum(&pruned, &desc);
    let request = json!([{ "desc": desc, "timestamp": 1 }]).to_string();
    let answer = pruned.cli_in(Some(watch), &["importdescriptors", &request]);
    let flat = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let shown = match &answer {
        Ok(a) => flat(a),
        Err(e) => flat(e),
    };
    println!(
        "  importdescriptors past the pruned height: {}",
        shown.chars().take(260).collect::<String>()
    );
    let listed = pruned.wallet(watch, &["listdescriptors"]);
    println!(
        "  after that failure the wallet {} the script",
        if listed.contains(&lock.script_pubkey) {
            "still holds"
        } else {
            "does not hold"
        }
    );
    // The app's own path, on a fresh wallet.
    let fresh = "kyro-watch-pruned";
    run(chain.client.create_watch_wallet(fresh)).unwrap();
    let chain = core_chain(&pruned, &net_client, fresh, &auth);
    let list = work.join("pruned.btclocks");
    let step = run(scan_step(&chain, &list, &seed(), NET, 0, None, now)).unwrap();
    println!(
        "  scan: found {}, finished {}",
        step.found,
        step.next_day.is_none()
    );
    assert_eq!(step.found, 1);
    assert!(step.next_day.is_none());
    let all = [lock.clone()];
    let st = serde_json::to_value(run(read_status(&chain, &list, &all, false)).unwrap()).unwrap();
    println!(
        "  status: {} {} sats",
        st["locks"][0]["status"], st["locks"][0]["amountSats"]
    );
    assert_eq!(st["locks"][0]["amountSats"], 300_000);
    assert_eq!(st["locks"][0]["status"], "locked");
    pruned.set_mtp(u + 1);
    let (plan, txid) = withdraw(&chain, &list, t);
    pruned.mine();
    println!(
        "  withdrew {} sats on the pruned node: {txid}",
        plan.amount_sats
    );
    let st = serde_json::to_value(run(read_status(&chain, &list, &all, false)).unwrap()).unwrap();
    println!("  status after: {}", st["locks"][0]["status"]);
    assert_eq!(st["locks"][0]["status"], "withdrawn");
    drop(chain);
    drop(pruned);

    let _ = std::fs::remove_dir_all(&work);
    println!("ALL RESULTS PASSED");
}
