# Kyro Interface Contract

This document fixes the boundaries between the three layers. Every change is made here first.

```
React (apps/desktop/src)  ──invoke()──►  Tauri shell (apps/desktop/src-tauri)  ──►  wallet-core (crates/wallet-core)
   no secret                             session, network, native dialogs            pure crypto, no I/O
```

Rules:
- **No secret ever goes up to the frontend, recovery phrase included**: at creation (`vault_backup_show`) as on demand (`vault_reveal_mnemonic`), Rust displays it in the **phrase window** (`phrase_window.rs`): a separate window with its own origin (`kyrophrase` scheme), a page written by Rust without any script, no capability, content protection on; the interface never receives the words. The one unavoidable exception: an **imported** phrase is typed into the interface (`vault_import`).
- **Any text coming from outside** (memos, account, token, validator, pool and device names, hosts) goes through a single sanitizer before any native window (`dialog_text.rs`): control characters replaced (line breaks included), bidi and invisible characters removed, length capped, value wrapped in "…" quotes, memos displayed **after** the amounts and fees.
- **Navigation**: the webview can only load the app's origin (`tauri://localhost`, `http(s)://tauri.localhost`, `devUrl` in debug); `window.open` is denied (`nav_guard.rs`).
- Every signature requires the **password** (re-verified by Argon2id) **and** a **native confirmation** (system dialog) showing the summary decoded by Rust. Hardware wallet (§2.3): no password (no key in Kyro), but the same native dialog, **then** confirmation on the device screen, then Rust's verification of what the device returns.
- The frontend has **no direct network access**: CSP `connect-src ipc: http://ipc.localhost`. Everything goes through `net_fetch`, which applies a domain allowlist.
- Amounts travel as **decimal strings in the smallest unit** (sats, wei, lamports) to avoid floats.

## 1. wallet-core (Rust, `crates/wallet-core`)

Pure crate: no network, no files, no Tauri. Errors via `wallet_core::Error` (thiserror), never a panic on user input.

```rust
// --- mnemonic ---
pub struct Mnemonic(/* zeroized on drop */);
impl Mnemonic {
    pub fn generate(words: WordCount) -> Result<Mnemonic>;          // WordCount::W12 | W24, OsRng
    pub fn parse(phrase: &str) -> Result<Mnemonic>;                  // English BIP39, checksum verified, whitespace normalized
    pub fn words(&self) -> Zeroizing<Vec<String>>;
    pub fn to_seed(&self, passphrase: &str) -> Seed;                 // Seed = Zeroizing<[u8; 64]>
}

// --- vault ---
#[derive(Serialize, Deserialize)]
pub struct VaultFile { pub version: u8, pub kdf: KdfParams, pub salt: String /*b64*/, pub nonce: String /*b64, 24 B*/, pub ciphertext: String /*b64*/ }
pub struct KdfParams { pub m_cost_kib: u32, pub t_cost: u32, pub p_cost: u32 }     // default: 262144, 3, 4
impl KdfParams { pub fn production() -> Self; pub fn minimum() -> Self /*65536, 2, 1: tests*/; }   // insecure_for_tests: wallet-core unit tests only
pub fn seal(mnemonic: &Mnemonic, password: &str, kdf: KdfParams) -> Result<VaultFile>; // AAD = version||kdf||salt
pub fn open(file: &VaultFile, password: &str) -> Result<Mnemonic>;                    // Error::WrongPassword if the tag is invalid
// seal AND open: Error::InvalidVault if m < 64 MiB, t < 2, p = 0, or m > 1 GiB, t > 10, p > 16 (checked before any derivation;
// a weaker vault is refused, not re-encrypted)

// --- networks & derivation ---
pub enum Network { Mainnet, Testnet }   // Testnet = BTC testnet4 (tb1…), Sepolia (chainId 11155111), Solana devnet
pub enum BtcKind { Segwit /* BIP84 */, Taproot /* BIP86 */ }
pub struct BtcAccount { pub kind: BtcKind, pub xpub: String, pub fingerprint: String /*hex 8*/, pub path: String /*m/84'/1'/0'*/ }
pub fn btc_account(seed: &Seed, net: Network, kind: BtcKind, account: u32) -> Result<BtcAccount>;
pub fn btc_address(seed: &Seed, net: Network, kind: BtcKind, account: u32, change: bool, index: u32) -> Result<String>;
pub fn evm_address(seed: &Seed, index: u32) -> Result<String>;          // m/44'/60'/0'/0/i, EIP-55 — EVM account no. i = address index (see "Accounts" below)
pub fn evm_path(index) -> String;  pub fn sol_path(account) -> String;  pub fn tron_path(account) -> String;
pub fn xrp_path(account) -> String;  pub fn cardano_account_path(account) -> String;  pub fn stellar_path(account) -> String;  pub fn algo_path(account) -> String;   // displayed paths (native dialog, UI)
pub fn sol_address(seed: &Seed, account: u32) -> Result<String>;        // m/44'/501'/i'/0' (SLIP-10 ed25519), base58

// --- signing (keys derived on demand, zeroized immediately) ---
pub fn btc_sign_psbt(seed: &Seed, net: Network, account: u32, psbt_b64: &str) -> Result<(String /*signed b64*/, BtcTxSummary)>;
// signs ONLY the inputs of account `account` (origin m/84'|86'/coin'/account'/…); those of the other accounts of the same vault
// are foreign (ForeignInput → 2nd dialog) and change is only recognized within that account
pub struct EvmTxRequest { pub chain_id: u64, pub nonce: u64, pub to: String, pub value_wei: String, pub data: String /*0x…*/,
                          pub gas_limit: u64, pub max_fee_per_gas: String, pub max_priority_fee_per_gas: String }
pub fn evm_sign_tx(seed: &Seed, index: u32, tx: &EvmTxRequest, net: Network) -> Result<(String /*raw 0x… EIP-1559*/, String /*tx hash*/)>;
// refuses a chain_id from the other family than `net` (EVM_KNOWN_CHAINS), like evm_decode
pub fn sol_sign_message(seed: &Seed, account: u32, message: &[u8]) -> Result<[u8; 64]>; // ed25519 over the message bytes; NEVER call without sol_decode_message first

// --- decoding ("plain-language" summary, independent of the frontend) ---
pub struct EvmTxSummary { pub kind: EvmTxKind /*NativeTransfer|Erc20Transfer|Erc20Approve|ContractCall*/,
                          pub to: String, pub token_contract: Option<String>, pub amount: String, pub spender: Option<String>,
                          pub unlimited_approval: bool /*≥ 2^128, same rule as Approval.unlimited*/, pub max_fee_wei: String, pub chain_id: u64, pub value_wei: String,
                          pub warnings: Vec<EvmWarning>, pub requires_extra_confirmation: bool }
pub enum EvmWarning {   // JSON { "kind": "contractCall" | "approval" | … } → 2nd reinforced window
    ContractCall /*any call other than a decoded ERC-20 transfer*/,
    Approval { spender, amount, unlimited /*≥ 2^128: displayed as UNLIMITED*/ },
    ValueToContract { value_wei } /*native value with a call (non-empty calldata)*/,
    UnknownChain { chain_id } /*outside EVM_KNOWN_CHAINS (with its family): mainnet 1, 42161, 10, 8453, 137, 56, 43114, 25, 5000, 146, 14, 8217, 100, 999, 1329, 1030; test 11155111*/,
    HighFee { max_fee_wei } /*gas_limit × max_fee_per_gas > evm_high_fee_threshold_wei(chain)*/ }
// Fee threshold: 0.05 of the native currency (ETH, Sepolia, Arbitrum, Optimism, Base, BNB Chain, HyperEVM, unknown chains),
// 50 POL (Polygon), 1 AVAX (Avalanche), ≈ 10 USD on chains with a cheap currency (10/31/2026): 200 CRO (Cronos),
// 20 MNT (Mantle), 250 S (Sonic), 2,000 FLR (Flare), 300 KAIA, 10 XDAI (Gnosis), 200 SEI, 200 CFX (Conflux eSpace).
// The dialog names the chain and its native currency from the table generated from registry.ts (`known_tokens.rs` of the shell). Limitation: a value transfer WITHOUT calldata to a contract address
// is not detected (it would require eth_getCode; Rust does not contact the RPC to sign).
pub fn evm_decode(tx: &EvmTxRequest, net: Network) -> Result<EvmTxSummary>;
pub const EVM_KNOWN_CHAINS: &[(u64, Network)];   // THE list: mainnet 1, 42161, 10, 8453, 137, 56, 43114, 25, 5000, 146, 14, 8217, 100, 999, 1329, 1030; testnet 11155111
pub fn evm_chain_network(chain_id) -> Option<Network>;
// evm_decode / evm_sign_tx REFUSE (INVALID_INPUT) a known chain id from the other family than `net` (test mode ↔ mainnet);
// an unknown chain id is still accepted with UnknownChain (2nd dialog).
pub struct BtcTxSummary { pub outputs: Vec<(String /*address*/, u64 /*sats*/, bool /*is_change*/)>, pub fee_sats: u64,
                          pub warnings: Vec<BtcWarning>, pub requires_extra_confirmation: bool }
pub enum BtcWarning {   // JSON { "kind": "unknownScript" | "opReturn" | "foreignInput" | "highFee" | "changeIndexOutOfRange", … } → 2nd reinforced window
    UnknownScript { output } /*including witness v2+ and non-taproot v1, rendered as "script:<hex>"*/, OpReturn { output },
    ForeignInput { input } /*input not signed by us*/,
    HighFee { sat_per_vb } /*> BTC_HIGH_FEE_SAT_PER_VB = 100 sat/vB (100 × the relay minimum), or fees > total outputs*/,
    ChangeIndexOutOfRange { output } /*output to our keys at an index > MAX_CHANGE_INDEX = 1000: is_change = false*/ }
// A sighash other than ALL / DEFAULT on one of our inputs is not a warning: the signature is REFUSED.
pub fn btc_decode_psbt(net: Network, psbt_b64: &str, own: &[String] /*our addresses*/) -> Result<BtcTxSummary>;
pub fn btc_psbt_summary(seed, net, account, psbt_b64) -> Result<BtcTxSummary>;   // btc_sign_psbt's summary without signing (change and inputs by key origin)

// --- Bitcoin, public data for a chosen server (B2b) ---
pub fn btc_scripthash(address: &str, net: Network) -> Result<String>;   // Electrum: reversed sha256(scriptPubKey), hex
pub fn btc_scripthash_of_script(script: &[u8]) -> String;
pub fn btc_script_pubkey(address: &str, net: Network) -> Result<ScriptBuf>;
pub fn btc_address_of_script(script: &[u8], net: Network) -> Option<String>;
pub fn btc_genesis_hash(net: Network) -> String;                         // mainnet / testnet4
pub struct BtcRawTx { pub txid: String, pub inputs: Vec<(String, u32)>, pub outputs: Vec<(Option<String>, u64, String /*spk hex*/)> }
pub fn btc_decode_raw_tx(raw_hex: &str, net: Network) -> Result<BtcRawTx>;
pub fn verify_tx_hex(raw_hex: &str, txid: &str) -> Result<()>;           // a single complete transaction whose txid (double SHA-256 of the serialization without witness) = txid; otherwise error (BTC, LTC, DOGE)
pub struct BtcDescriptor { pub kind: BtcKind, pub internal: bool, pub descriptor: String /*without checksum*/ }
pub fn btc_descriptors(seed: &Seed, net: Network, account: u32) -> Result<Vec<BtcDescriptor>>;
// wpkh([fp/84h/coin'h/0h]xpub/{0,1}/*) and tr([fp/86h/coin'h/0h]xpub/{0,1}/*) — public keys only

// --- Litecoin (BIP84 P2WPKH), Dogecoin, Bitcoin Cash and Dash (BIP44 P2PKH): `bitcoin` 0.32 crate reused (keys,
//     PSBT, sighash), address encodings built with its own `bech32` / `base58` and the parameters from
//     chainparams.cpp; CashAddr (`cashaddr.rs`) = the `bech32` crate's generic checksum engine configured
//     with the specification's generator (all the spec's vectors verified)
pub enum UtxoCoin { Litecoin, Dogecoin, BitcoinCash, Dash }               // JSON "litecoin" | "dogecoin" | "bitcoincash" | "dash"
pub struct UtxoAccount { pub coin: UtxoCoin, pub xpub: String /*xpub/tpub*/, pub fingerprint: String, pub path: String }
pub fn utxo_account(seed, net, coin, account) -> Result<UtxoAccount>;   // m/84'/2'/a' (LTC) · m/44'/3'/a' (DOGE) · m/44'/145'/a' (BCH) · m/44'/5'/a' (DASH) · testnet: coin type 1
pub fn utxo_address(seed, net, coin, account, change, index) -> Result<String>;   // ltc1…/tltc1… · D…/n… · bitcoincash:q…/bchtest:q… · X…/y…
pub fn utxo_address_from_xpub(xpub, net, coin, change, index) -> Result<String>;
pub fn utxo_script_pubkey(address, net, coin) -> Result<ScriptBuf>;     // LTC: ltc1 (v0/v1+), L…, M… (testnet m/n…, Q…); refuses 3…/2… (legacy P2SH = Bitcoin) and MWEB. DOGE: D…, 9…/A… (testnet n…, 2…). DASH: X…, 7… (testnet y…, 8…/9…). BCH: CashAddr only (optional prefix, mixed case refused, token types z…/r… = same scripts, P2SH32 refused); the legacy 1…/3… form is refused (indistinguishable from a Bitcoin address)
pub fn utxo_address_of_script(script, net, coin) -> Option<String>;
pub fn utxo_genesis_hash(net, coin) -> &'static str;                    // LTC mainnet 12a765e3…, testnet4 4966625a… · DOGE mainnet 1a91e3da…, testnet bb0a7826… · BCH = Bitcoin's genesis (chipnet: testnet4's) · DASH mainnet 00000ffd…, testnet 00000bad…
pub fn utxo_checkpoint(net, coin) -> Option<(u64, &'static str)>;       // BCH only: block 478,559 (000…651ef99c…5eec, 1st block after the split) · chipnet 200,000 (000…5d7d9946…7c05)
pub fn utxo_header_hash(header_hex) -> Result<String>;                  // hash (double SHA-256) of an 80-byte header, for the checkpoint
pub fn utxo_decode_raw_tx(raw_hex, net, coin) -> Result<BtcRawTx>;      // DOGE/BCH/DASH: witness data refused · DASH: DIP2 special transaction decoded (payload skipped, covered by the txid)
pub fn utxo_is_special_tx(raw_hex, coin) -> bool;                       // DASH: special transaction (type ≠ 0, version ≥ 3): displayed, never spent
pub fn bch_forkid_sighash(tx, input, script_code, value, sighash_type) -> Result<[u8; 32]>;   // BIP143 digest + 32-bit type (FORKID mandatory, SIGHASH_UTXOS refused); Kyro only signs with 0x41
pub fn utxo_dust_threshold(coin, script) -> u64;                        // LTC: GetDustThreshold at 30,000 lit/kvB (P2WPKH 2,940) · DOGE: 0.001 DOGE (hard dust) · BCH/DASH: 3,000/kB (P2PKH 546, P2SH 540)
pub fn utxo_psbt_summary(seed, net, coin, account, psbt_b64) -> Result<UtxoTxSummary>;     // decoding for the dialog, without signing
pub fn utxo_sign_psbt(seed, net, coin, account, psbt_b64) -> Result<(String /*signed PSBT, not finalized*/, UtxoTxSummary)>;   // like Bitcoin: account `account` only
// Refused: malformed PSBT; LTC input without witness_utxo; DOGE/BCH/DASH input without a non_witness_utxo whose txid = the outpoint, or with a witness;
// key origin "ours" that does not match the key or the script; sighash ≠ ALL; output below dust; negative fees; no input of ours;
// BCH: version ≠ 1/2; DASH: special transaction (type ≠ 0) — and a coin coming from a special transaction cannot be spent (the PSBT
// does not carry its payload, so its txid never matches).
// Signature: LTC BIP143 (P2WPKH), DOGE/DASH legacy (P2PKH), SIGHASH_ALL; BCH BIP143 digest with SIGHASH_ALL|FORKID (0x41, amounts committed);
// each signature verified before being kept. BCH: a 0x41 signature does not fit in a PSBT partial signature, so the input is
// FINALIZED by wallet-core (final_script_sig = <DER‖41> <key>, key origins removed); LTC/DOGE/DASH: partial signatures, not finalized.
pub struct UtxoTxSummary {                     // serde camelCase; amounts as decimal strings (smallest unit)
    pub coin, pub outputs: Vec<UtxoOutput { address: Option<String>, script /*hex*/, amount, is_change, kind: Address|OpReturn|Unknown }>,
    pub inputs: usize, pub our_inputs: usize, pub fee: String,
    pub size: u64 /*vB (LTC) or bytes (DOGE/BCH/DASH), longest signature*/, pub fee_per_kb: u64 /*lit/kvB, koinus/kB, sat/kB, duffs/kB*/,
    pub has_change: bool /*false: everything not sent — dust included — goes to fees*/,
    pub warnings: Vec<UtxoWarning>, pub requires_extra_confirmation: bool }
pub enum UtxoWarning {                         // JSON { "kind": "softDust", "index": 2 }
    UnknownOutput { index } /*including witness v2+ LTC*/, OpReturn { index }, ForeignInput { index }, SoftDust { index } /*DOGE < 0.01*/, HighFee /*> 100× the usual rate or > total sent*/,
    ChangeIndexOutOfRange { index } /*our keys beyond index 1000: is_change = false*/,
    FeeBelowMinimum { minimum } /*informational*/ }
// requires_extra_confirmation = any warning except FeeBelowMinimum.
// Constants: LTC_MIN_RELAY_FEE_PER_KVB 1,000, LTC_DUST_RELAY_FEE_PER_KVB 30,000; DOGE_RECOMMENDED_FEE_PER_KB 1,000,000 (0.01 DOGE/kB),
// DOGE_MIN_RELAY_FEE_PER_KB 100,000, DOGE_SOFT_DUST 1,000,000, DOGE_HARD_DUST 100,000; BCH_DASH_MIN_RELAY_FEE_PER_KB 1,000,
// BCH_DASH_DUST_RELAY_FEE_PER_KB 3,000, BCH_SIGHASH_ALL_FORKID 0x41. Very high fees (HighFee): > 100 sat/B (BCH), > 100 duffs/B (DASH).

// --- Zcash, TRANSPARENT ONLY: BIP44 m/44'/133'/a'/c/i (testnet m/44'/1'/…), P2PKH t1… (0x1cb8) / tm… (0x1d25); P2SH t3… / t2…;
//     v5 format (ZIP 225), txid and signature digest ZIP 244, activation branches and heights, ZIP 317 fees: librustzcash crates
//     (zcash_primitives 0.31.0-pre.2, zcash_transparent 0.11.0-pre.2, zcash_protocol 0.11.0-pre.1); ECDSA libsecp256k1 (bitcoin crate)
pub fn zec_account(seed, net, account) -> Result<ZecAccount { xpub, fingerprint, path }>;
pub fn zec_address(seed, net, account, change, index) -> Result<String>;          // t1… / tm…
pub fn zec_address_from_xpub(xpub, net, change, index) -> Result<String>;
pub fn zec_parse_address(address, net) -> Result<(Vec<u8> /*scriptPubKey*/, ZecAddressKind /*P2pkh|P2sh|Tex*/)>;  // refuses zs…, zc…, u1… ("shielded … or unified: not yet supported"), other network
pub fn zec_address_of_script(script, net) -> Option<String>;
pub fn zec_genesis_hash(net) -> &'static str;                                      // mainnet 00040fe8…, testnet 05a60a92…
pub fn zec_decode_raw_tx(raw_hex, net) -> Result<ZecRawTx { txid, version, branch_id, inputs, outputs, shielded, coinbase }>;  // any version, txid recomputed
pub fn zec_header_branch_id(raw: &[u8]) -> Option<u32>;                            // nConsensusBranchId of a v5+ transaction (bytes 8..12), even if unknown
pub fn zec_consensus(net, tip_height, observed_height, observed_branch_id) -> Result<ZecConsensus>;  // refusal: unknown branch, or ≠ the zcash_protocol table at that height; expiry +40, shortened before a known upgrade
pub fn zec_tx_summary(seed, net, account, &ZecSendRequest) -> Result<ZecTxSummary>; // builds (selection, ZIP 317, change to us) without signing
pub fn zec_sign(seed, net, account, &ZecSendRequest) -> Result<(String /*signed v5 hex*/, ZecTxSummary)>;  // SIGHASH_ALL, each signature verified, encoding re-read
pub fn zec_input_sighash(raw_hex, prevouts, index) -> Result<[u8; 32]>;            // ZIP 244 digest of an input (verification of real transactions)
pub struct ZecSendRequest { coins: Vec<ZecCoin { prev_tx /*hex*/, vout, change, index }>, to, amount /*zatoshis*/, max, change_index, tip_height, network_branch_height, network_branch_id }
// Refused: shielded/unified/other-network recipient; unknown or inconsistent branch; unreadable previous transaction; missing output or one that does not pay
// the account's key at the announced index; coinbase; duplicate coin; amount < 54 zatoshis; insufficient balance; change index > 1000.
// ZecWarning: HighFee (fees > 10 × ZIP 317 or > amount: 2nd window) · ExpiryCapped { next_upgrade_height } (informational).
// Constants: ZEC_EXPIRY_DELTA 40, ZEC_DUST 54, ZEC_MIN_CHANGE 5,000, ZEC_MAX_INPUTS 50.

// --- TRON: m/44'/195'/a'/0/0 (one account = one address, like Ledger Live; account 0 = the legacy m/44'/195'/0'/0/0), address = base58check(0x41 || keccak256(pubkey)[12..]); protobuf raw_data
//     (hand-written, strict codec: refused if re-encoding differs by a single byte)
pub fn tron_address(seed, account) -> Result<String>;                   // T…, m/44'/195'/account'/0/0
pub fn tron_address_at(seed, account, index) -> Result<String>;         // m/44'/195'/account'/0/index (vectors from other wallets)
pub fn tron_address_bytes(address) -> Result<[u8; 21]>; pub fn tron_address_from_bytes(&[u8; 21]) -> String;
pub fn tron_address_of_pubkey(sec1) -> Result<String>;
pub struct TronRaw { ref_block_bytes: [u8; 2], ref_block_hash: [u8; 8], expiration: i64, memo: Vec<u8>,
                     contract: TronContract, timestamp: i64, fee_limit: i64 }
pub enum TronContract { Transfer { owner, to, amount }, Trigger { owner, contract, call_value, data } }   // types 1 and 31 only
impl TronRaw { pub fn encode(&self) -> Vec<u8>; pub fn decode(raw) -> Result<TronRaw>; pub fn txid(&self) -> [u8; 32] /*sha256(raw)*/ }
// decode refuses: unknown field, ref_block_num, auths, scripts, provider, ContractName, Permission_id, TRC-10 value,
// other contract type, ≠ 1 contract, negative integer, non-canonical encoding (order, duplicate, non-minimal varint).
pub fn tron_ref_block(number, block_id_hex) -> Result<([u8; 2], [u8; 8])>;   // bytes 6..8 of the number, 8..16 of the id; id must start with the number
pub fn tron_trc20_transfer_data(to, amount /*decimal uint256*/) -> Result<Vec<u8>>;   // a9059cbb || to || amount
pub fn tron_decode_raw(raw_hex, our_address) -> Result<TronTxSummary>;  // + refuses: owner ≠ us, TRX amount ≤ 0, TRX to self,
// expiration > system clock + 24 h (TRON_MAX_EXPIRATION_MS, also in tron_decode_stake_raw, hence at signing)
pub struct TronTxSummary { txid, owner, action: TronAction, fee_limit, expiration, timestamp, ref_block_bytes, ref_block_hash,
                           memo /*hex*/, memo_text: Option<String> /*cleaned UTF-8 (sanitize_text, 256 chars)*/, raw_size,
                           warnings: Vec<TronWarning>, requires_extra_confirmation }   // serde camelCase
pub enum TronAction { TrxTransfer { to, amount }, Trc20Transfer { contract, to, amount, call_value },
                      ContractCall { contract, selector, data, call_value } }   // JSON { "type": "trxTransfer", … }
pub enum TronWarning { UnknownCall { selector }, CallValue, Memo, HighFeeLimit /*> 100 TRX*/, UnusualText /*cleaned memo*/ }   // all → reinforced confirmation
pub fn tron_sign(seed, account, raw_hex) -> Result<([u8; 65] /*r‖s‖v, v = 27 + recid*/, TronTxSummary)>;   // decodes first; libsecp256k1 RFC 6979
pub fn tron_recover_signer(raw_hex, sig65 /*v ∈ 0,1,27,28*/) -> Result<String>;
pub fn tron_signed_transaction(raw_hex, sig) -> Result<String>;          // Transaction { raw_data = 1, signature = 2 }, for broadcasthex

// --- XRP Ledger: m/44'/144'/a'/0/0, account 0 = the legacy m/44'/144'/0'/0/0 (BIP44 route of Ledger, Trezor, Xaman — not rippled's "family seed"),
//     r… address = base58 (Ripple alphabet) of 0x00 || RIPEMD160(SHA256(pubkey)) + SHA-256d checksum; hand-written strict binary
//     Payment codec (identical re-encoding required)
pub fn xrp_address(seed, account) -> Result<String>; pub fn xrp_public_key(seed, account) -> Result<[u8; 33]>;   // m/44'/144'/account'/0/0
pub fn xrp_address_at(seed, account, index); pub fn xrp_public_key_at(seed, account, index); pub fn xrp_sign_at(seed, account, index, blob);   // …/0/index (Trezor vectors)
pub fn xrp_account_id(address) -> Result<[u8; 20]>;        // X-addresses refused (classic address + separate tag)
pub fn xrp_address_from_id(&[u8; 20]) -> String; pub fn xrp_address_of_pubkey(sec1) -> Result<String>;
pub enum XrpAmount { Xrp(u64 /*drops*/), Issued { mantissa, exponent, negative, currency: [u8; 20], issuer: [u8; 20] } }   // STAmount
pub fn xrp_issued_amount(value /*decimal*/, currency /*3 chars or 40 hex*/, issuer) -> Result<XrpAmount>;   // ≤ 16 significant digits
pub struct XrpPayment { flags: Option<u32>, source_tag, sequence, destination_tag, last_ledger_sequence, invoice_id,
                        amount, fee /*drops*/, send_max, signing_pub_key, txn_signature, account, destination, memos }
impl XrpPayment { pub fn encode(&self, with_signature) -> Vec<u8>; pub fn decode(raw) -> Result<Self>;
                  pub fn signing_hash(&self) -> [u8; 32] /*SHA-512Half("STX\0"||…)*/; pub fn hash(&self) -> [u8; 32] /*SHA-512Half("TXN\0"||…)*/ }
// decode refuses: other TransactionType (AccountSet, SetRegularKey, SignerListSet, TrustSet…), NetworkID, TicketSequence,
// Paths, DeliverMin, MPT amounts, unknown field, non-canonical encoding.
pub fn xrp_decode_tx(blob_hex, our_address, our_pubkey) -> Result<XrpTxSummary>;   // + refuses: already signed, Account / SigningPubKey ≠ us,
// tfPartialPayment, unknown flag, payment to self, amount ≤ 0, fee 0, LastLedgerSequence missing
pub struct XrpTxSummary { account, destination, destination_tag: Option<u32>, amount: XrpAmountView, fee, sequence,
                          last_ledger_sequence, flags, send_max, source_tag, invoice_id, memos, warnings: Vec<XrpWarning>,
                          requires_extra_confirmation }          // serde camelCase
pub enum XrpAmountView { Xrp { drops }, Issued { value, currency, issuer } }   // JSON { "kind": "xrp", … }
pub enum XrpWarning { SendMax, PathFlags /*tfNoRippleDirect, tfLimitQuality*/, Memo, HighFee /*> 1 XRP*/, InvoiceId,
                      UnusualText /*cleaned MemoData: memos[].text is the cleaned version (256 chars), memo_data the exact hexadecimal*/ }   // → reinforced
pub fn xrp_sign(seed, account, blob_hex) -> Result<(String /*signed blob*/, String /*hash*/, XrpTxSummary)>;   // DER low-S, verified
pub fn xrp_verify_signed(blob_hex) -> Result<String /*hash*/>;   // DER low-S signature of SigningPubKey, key = Account

// --- Stellar: SEP-0005 m/44'/148'/a' (SLIP-10 ed25519, like Solana: ed25519-dalek-bip32; Lobstr, Freighter, Ledger,
//     Trezor), account 0 = m/44'/148'/0'; G… address = SEP-0023 strkey (version byte 6 << 3 ‖ key ‖ CRC16-XModem,
//     unpadded base32, canonical round trip required); hand-written, strict XDR codec (identical re-encoding required)
pub fn stellar_address(seed, account) -> Result<String>; pub fn stellar_public_key(seed, account) -> Result<[u8; 32]>;
pub fn stellar_path(account) -> String;                     // m/44'/148'/account'
pub fn stellar_account_id(address) -> Result<[u8; 32]>;     // G… only; M… (muxed) and S… (SECRET KEY pasted by mistake) rejected with their own message
pub fn stellar_address_from_key(&[u8; 32]) -> String; pub fn stellar_muxed_parts(m) -> Result<(String, u64)>;
pub fn stellar_asset(code /*1–12 alphanumeric, "XLM" rejected*/, issuer) -> Result<StellarAsset>;
pub fn stellar_network_passphrase(Network) -> &'static str;  // "Public Global Stellar Network ; September 2015" / "Test SDF Network ; September 2015"
pub struct StellarTransaction { source: [u8; 32], fee: u32 /*stroops*/, sequence: i64, time_bounds: Option<(u64, u64)>, memo: StellarMemo,
                                operations: Vec<StellarOp> }   // Transaction v1; hash(net) = SHA-256(SHA-256(network passphrase) ‖ ENVELOPE_TYPE_TX ‖ XDR)
pub struct StellarEnvelope { tx, signatures }   // TransactionEnvelope ENVELOPE_TYPE_TX; encode / decode / to_base64 / from_base64
pub enum StellarOperation { CreateAccount { destination, starting_balance }, Payment { destination, asset, amount }, ChangeTrust { asset, limit } }
// decode rejects: v0 and fee bump envelopes, muxed accounts (M…), PRECOND_V2, Soroban (ext ≠ 0), any other operation
// (SetOptions, AccountMerge, ManageData, offers, path payments, claimable balances, InvokeHostFunction…), pool shares,
// non-canonical asset codes, non-zero padding, extra bytes, non-canonical encoding.
pub fn stellar_decode_tx(envelope_b64, our_address, net) -> Result<StellarTxSummary>;   // + rejects: already signed, source ≠ us,
// no time bounds (or maxTime 0), fee 0, sequence ≤ 0, anything other than ONE operation, operation with its own source,
// payment / creation to self, amount ≤ 0, trust limit < 0, trustline to one's own asset
pub struct StellarTxSummary { network, source, fee, sequence, min_time, max_time, memo: StellarMemoView, operation: StellarOpView,
                              warnings: Vec<StellarWarning>, requires_extra_confirmation }   // serde camelCase, amounts in stroops (strings)
pub enum StellarWarning { HighFee /*> 0.01 XLM*/, UnusualText /*memo sanitized or non-UTF-8*/, MemoReturn, RemoveTrustline }   // → enhanced
pub fn stellar_sign(seed, account, envelope_b64, net) -> Result<(String /*signed envelope*/, String /*hash*/, StellarTxSummary)>;   // ed25519, verified (verify_strict)
pub fn stellar_verify_signed(envelope_b64, net) -> Result<String /*hash*/>;   // one signature, from the source, hint = last 4 bytes of the key, valid ON THIS NETWORK

// --- Sui: m/44'/784'/a'/0'/0' (SLIP-10 ed25519, all levels hardened; account 0 = that of Sui Wallet / Slush, `sui keytool`
//     and the official SDKs), address = 0x + hex(BLAKE2b-256(0x00 || 32 B public key)), no checksum;
//     hand-written BCS for the ONLY SUI transfer built by Kyro, strict (identical re-encoding required)
pub fn sui_address(seed, account) -> Result<String>; pub fn sui_public_key(seed, account) -> Result<[u8; 32]>; pub fn sui_path(account) -> String;
pub fn sui_parse_address(s) -> Result<[u8; 32]>;   // 0x + exactly 64 hex; short form (0x2) and SuiNS names rejected
pub struct SuiObjectRef { object_id: [u8; 32], version: u64, digest: [u8; 32] }   // gas coin (ObjectRef)
pub enum SuiTransferAmount { Mist(u64), All }
pub struct SuiTransfer { sender, recipient, amount, gas_payment: Vec<SuiObjectRef>, gas_price, gas_budget, expiration_epoch: Option<u64> }
impl SuiTransfer { pub fn encode(&self) -> Result<Vec<u8>>; pub fn decode(bcs) -> Result<Self> }
// TransactionData::V1 { ProgrammableTransaction { inputs: [Pure(u64), Pure(address)],
//   commands: [SplitCoins(GasCoin, [Input(0)]), TransferObjects([NestedResult(0,0)], Input(1))] }   <- amount
// | { inputs: [Pure(address)], commands: [TransferObjects([GasCoin], Input(0))] }                    <- entire balance
// sender, GasData { payment, owner = sender, price, budget }, expiration None | Epoch(e) }
// decode rejects everything else: Object input, MoveCall, MergeCoins, Publish, Result(0) instead of NestedResult(0,0),
// sponsor (owner ≠ sender), gas paid from the address balance (empty payment), ValidDuring expiration, extra byte, non-canonical ULEB.
pub fn sui_decode_tx(bcs_b64, our_address) -> Result<SuiTxSummary>;   // + sender = us
pub struct SuiTxSummary { sender, recipient, coin_type /*"0x2::sui::SUI"*/, amount: Option<String> /*MIST; None = all*/, gas_budget,
                          gas_price, gas_coins: Vec<{ object_id, version, digest }>, expiration_epoch, digest /*base58*/, warnings, requires_extra_confirmation }
pub enum SuiWarning { SendAll, SelfTransfer, HighGasBudget /*> 0.1 SUI*/, NoExpiration }   // -> enhanced
pub fn sui_sign(seed, account, bcs_b64) -> Result<(String /*flag 0x00 || sig 64 || pk 32, base64*/, SuiTxSummary)>;
//   signs ed25519(BLAKE2b-256([0,0,0] || bcs)) (IntentMessage TransactionData/V0/Sui), verified (verify_strict)
pub fn sui_verify_signed(bcs_b64, signature_b64) -> Result<String /*digest*/>;   // ed25519 flag, key = sender, verify_strict
pub fn sui_tx_digest(bcs) -> String;   // base58(BLAKE2b-256("TransactionData::" || bcs))

// --- Hedera: ECDSA secp256k1 m/44'/3030'/0'/0/a ("standard" ECDSA path of the Hedera SDKs, toStandardECDSAsecp256k1PrivateKey(pass, a),
//     the one used by HashPack for an ECDSA account; account 0 = m/44'/3030'/0'/0/0); "address" = the key's EVM address (alias: the first
//     HBAR received creates the 0.0.x account 0, HIP-583); ED25519 (m/44'/3030'/0'/0'/a', Ledger, old HashPack accounts) not supported;
//     hand-written protobuf for the ONLY HBAR CryptoTransfer, strict (identical re-encoding required), cross-checked against Google's protobuf runtime
pub fn hbar_path(account) -> String; pub fn hbar_public_key(seed, account) -> Result<[u8; 33]>; pub fn hbar_evm_address(seed, account) -> Result<String>;
pub fn hbar_checksum(net, num) -> String;                 // HIP-15 (0.0.123-vfmkw mainnet, -esxsf testnet)
pub fn hbar_parse_account_id(s, net) -> Result<u64>;      // 0.0.n, HIP-15 checksum optional but verified; other shard / realm rejected
pub fn hbar_parse_recipient(s, net) -> Result<HbarRecipient>;   // 0.0.n or 0x… (EIP-55 if mixed case; "long-zero" → 0.0.n; zero address rejected)
pub enum HbarRecipient { Id(u64), Evm([u8; 20]) }
pub struct HbarTransfer { payer, valid_start_secs, valid_start_nanos, node, max_fee /*tinybars*/, valid_duration, memo, to: HbarRecipient, amount }
impl HbarTransfer { pub fn encode(&self) -> Vec<u8> /*TransactionBody*/; pub fn decode(raw) -> Result<Self>; pub fn transaction_id(&self) /*0.0.p@s.n*/; pub fn mirror_transaction_id(&self) /*0.0.p-s-n*/ }
// decode rejects: any TransactionBody field other than transactionID (1), nodeAccountID (2), transactionFee (3), transactionValidDuration (4),
// memo (6), cryptoTransfer (14) — hence any other transaction type, batch_key, max_custom_fees…; scheduled, nonce, generateRecord;
// HTS token transfers; is_approval (spending via allowance); hooks; anything other than a debit of the payer followed by an equal credit;
// long-zero alias; shard / realm ≠ 0; non-canonical encoding.
pub fn hbar_check_memo(memo) -> Result<()>;               // ≤ 100 bytes, no control / invisible / bidi characters
pub fn hbar_decode_tx(bodies_hex: &[String], our_account: u64, our_pubkey, allowed_nodes: &[u64]) -> Result<HbarTxSummary>;
// + rejects: differing copies (apart from the node), node outside the list or duplicated, payer ≠ us, transfer to self (0.0.x or our EVM address),
// amount 0, max fee 0, validity outside 1–180 s
pub struct HbarTxSummary { from, to, to_is_evm, amount, max_fee, memo /*sanitized*/, memo_hex, transaction_id, mirror_transaction_id,
                           valid_start, valid_duration, nodes, warnings: Vec<HbarWarning>, requires_extra_confirmation }   // serde camelCase
pub enum HbarWarning { HighFee /*max fee > 2 HBAR*/, UnusualText /*memo sanitized*/ }   // → enhanced
pub fn hbar_sign(seed, account, our_account, bodies_hex, allowed_nodes) -> Result<(Vec<String> /*Transaction signed per node*/, HbarTxSummary)>;
// ECDSA libsecp256k1 over keccak256(bodyBytes), compact r‖s low-S, verified; SignaturePair { pubKeyPrefix = full 33 B key, ECDSA_secp256k1 }
pub fn hbar_verify_signed(tx_hex) -> Result<HbarSignedTransfer { transfer, public_key }>;   // Transaction { signedTransactionBytes } only, one signature
pub fn hbar_decode_precheck(raw) -> Result<(u32 /*code*/, u64 /*cost*/)>; pub fn hbar_response_name(code) -> String;

// --- Polkadot (Asset Hub): sr25519 from the BIP39 ENTROPY (substrate-bip39, like Polkadot.js / Nova / Talisman /
//     SubWallet), schnorrkel (ExpansionMode::Ed25519, "substrate" context); account 0 = root key of the phrase,
//     account a ≥ 1 = hard derivation `//a`; SS58 (prefix 0 Polkadot, 42 Westend), blake2b-512 "SS58PRE";
//     SCALE (parity-scale-codec); V15 metadata decoded by frame-metadata + scale-info (Parity crates)
pub struct PolkadotRoot(/* sr25519 mini-secret, erased */);  impl PolkadotRoot { pub fn from_mnemonic(&Mnemonic, passphrase) -> Result<PolkadotRoot>; }
pub fn dot_chain(Network) -> &'static DotChain;   // PINNED: genesis, spec_name, SS58, decimals, Balances = 10, transfer_keep_alive = 3
pub fn dot_public_key(root, account) -> Result<[u8; 32]>;  pub fn dot_address(root, account, Network) -> Result<String>;  pub fn dot_path(account) -> String;
pub fn dot_ss58_encode(&[u8; 32], prefix) -> String;  pub fn dot_ss58_decode(address) -> Result<(u8, [u8; 32])>;
pub fn dot_account_id(address, Network) -> Result<[u8; 32]>;   // network's SS58 prefix required (Kusama, "5…" on mainnet: rejected)
pub fn dot_runtime(Network, state_call_result) -> Result<DotRuntime>;   // Option<V15 metadata> from the node, verified against DotChain:
//   spec_name, SS58Prefix, index of Balances and of transfer_keep_alive (+ arguments dest: MultiAddress, value: Compact<u128>),
//   extrinsic v4, MultiAddress / MultiSignature::Sr25519, layout of System.Account, transaction extensions
//   ALL known with the expected types (otherwise rejected: "Kyro must be updated"), ExistentialDeposit
pub struct DotTransfer { dest, value /*planck*/, era: DotEra /*mortal*/, block_hash, nonce, tip /*always 0*/ }
pub fn dot_transfer_payload(&DotRuntime, &DotTransfer, from) -> Result<String /*hex: call ‖ extra ‖ additional*/>;
pub fn dot_decode_payload(&DotRuntime, payload_hex, from) -> Result<DotTxSummary>;   // rejects: other call, MultiAddress other
//   than Id, zero amount, send to self, tip, fees in another asset, CheckMetadataHash enabled, immortal era
//   or > 4096 blocks, other genesis / spec / transaction_version, extra bytes, different re-encoding
pub fn dot_sign(root, account, &DotRuntime, payload_hex) -> Result<(String /*signed extrinsic*/, String /*blake2-256*/, DotTxSummary)>;
pub fn dot_verify_extrinsic(&DotRuntime, extrinsic_hex, block_hash) -> Result<([u8; 32] /*signer*/, String /*hash*/, DotTxSummary)>;
pub fn dot_fee_probe_extrinsic(&DotRuntime, payload_hex, from) -> Result<Vec<u8>>;   // null signature, for query_info only
pub fn dot_account_storage_key(&[u8; 32]) -> Vec<u8>;  pub fn dot_decode_account_info(&[u8]) -> Result<DotAccountInfo>;   // System.Account, 80 bytes
pub fn dot_decode_fee_info(&[u8]) -> Result<u128>;   // TransactionPaymentApi_query_info → partial_fee

// --- Algorand: m/44'/283'/a'/0/0 derived like the Ledger Algorand app (HMAC-SHA512 "ed25519 seed" root re-hashed as long as
//     the 3rd highest bit of kL is 1, HMAC-SHA256 chain; BIP32-Ed25519 V2 children (44'/283'/a' hardened, 0/0 non-hardened) via the ed25519-bip32 crate;
//     the 32 bytes kL of the last node = RFC 8032 ed25519 secret key, signed by ed25519-dalek). Not the Pera 25-word format.
//     Address = unpadded base32 (data-encoding) of pk ‖ last 4 bytes of SHA-512/256(pk), 58 characters.
//     Hand-written canonical msgpack for the ONLY `pay` type, strict (identical re-encoding required); signed: ed25519("TX" ‖ msgpack)
pub fn algo_address(seed, account) -> Result<String>; pub fn algo_public_key(seed, account) -> Result<[u8; 32]>;
pub fn algo_address_bytes(address) -> Result<[u8; 32]>;   // 58 uppercase base32 chars, checksum (key, or application / program hash)
pub fn algo_address_of_pubkey(&[u8; 32]) -> String; pub fn algo_genesis(net) -> Result<(&str /*gen*/, [u8; 32] /*gh*/)>;
pub struct AlgoPayment { amount, close_remainder_to: Option<[u8; 32]>, fee, first_valid, genesis_id, genesis_hash, group, last_valid,
                         lease, note: Vec<u8>, receiver, rekey_to, sender }   // close / rekey / grp / lx decoded in order to be rejected
impl AlgoPayment { pub fn encode(&self) -> Vec<u8> /*canonical msgpack*/; pub fn decode(raw) -> Result<Self>;
                   pub fn signing_bytes(&self) -> Vec<u8> /*"TX" ‖ msgpack*/; pub fn txid(&self) -> String /*base32(SHA-512/256(…))*/ }
pub fn algo_encode_signed(&AlgoPayment, &[u8; 64]) -> Vec<u8>; pub fn algo_decode_signed(raw) -> Result<(AlgoPayment, [u8; 64])>;
pub fn algo_decode_tx(blob_hex, net, our_address) -> Result<AlgoTxSummary>;   // rejects: other type, close, rekey, grp, lx, unknown field,
// non-canonical encoding, sender ≠ us, other network (gen/gh), zero receiver or us, amount 0, fee < 1000, window > 1000, note > 1024 B
pub struct AlgoTxSummary { sender, receiver, amount, fee /*µALGO*/, first_valid, last_valid, genesis_id, genesis_hash /*b64*/,
                           note_len, note_hex, note_text /*sanitized*/, txid, warnings: Vec<AlgoWarning>, requires_extra_confirmation }
pub enum AlgoWarning { Note, BinaryNote, UnusualText, HighFee /*> 0.01 ALGO*/ }   // → enhanced
pub fn algo_sign(seed, account, net, blob_hex) -> Result<(String /*signed, hex*/, String /*txid*/, AlgoTxSummary)>;   // verify_strict
pub fn algo_verify_signed(signed_hex, net, our_address) -> Result<(String /*txid*/, Vec<u8> /*to broadcast*/)>;

// --- TON: SLIP-10 ed25519 m/44'/607'/a' (Trust Wallet's BIP39 route: account 0 = its address; Tonkeeper / Tonhub have
//     their own phrase format and Ledger a 6-level path, hence different addresses), standard v4R2 wallet
//     (official code, hash feb5ff68…dabd5c0 verified on every use), wallet id 698983191 on mainnet and 0x4B59524F
//     ("KYRO") on testnet: a v4R2 signature does not name the network, a distinct id makes it impossible to replay a
//     testnet transfer on mainnet. Cells and BOC: tycho-types crate; TL-B layouts written here (external
//     message, v4R2 body, internal message, text comment), strict decoding with **byte-for-byte** re-encoding.
pub fn ton_path(account) -> String;  pub fn ton_public_key(seed, account) -> Result<[u8; 32]>;  pub fn ton_wallet_id(testnet) -> u32;
pub fn ton_wallet_address(pubkey, wallet_id) -> Result<TonAddress>;        // 0: ‖ hash of the v4R2 StateInit
pub fn ton_address(seed, account, testnet) -> Result<String>;              // user-friendly non-bounceable form UQ… (testnet 0Q…)
pub fn ton_parse_address(s) -> Result<TonFriendly>;   // 48 chars base64url or base64, CRC16-XModem, tag 0x11/0x51 (+0x80 testnet), wc 0 or -1;
                                                      // raw form "0:…" rejected (no checksum)
pub fn ton_parse_raw_address(s) -> Result<TonAddress>;   // "wc:hex" from server responses only
pub struct TonTransfer { public_key, wallet_id, valid_until, seqno, mode /*3 or 130*/, destination: TonAddress, bounce, amount /*nanotons*/,
                         comment: Option<String> /*≤ 123 bytes*/, with_state_init /*seqno 0 only*/ }
impl TonTransfer { pub fn encode_unsigned(&self) -> Result<String /*base64 BOC, null signature*/>; pub fn signing_hash(&self);
                   pub fn estimate_parts(&self) -> Result<TonEstimateParts>;
                   pub fn decode(boc, our_pubkey, wallet_id) -> Result<(TonTransfer, [u8; 64] /*signature*/)>; }   // strict (below)
pub fn ton_decode_tx(boc, our_pubkey, testnet) -> Result<TonTxSummary>;   // unsigned (null signature); rejects: external message recipient
//     other than our wallet, other wallet id (other network), StateInit that is not ours or with seqno ≠ 0, op ≠ 0 (plugins),
//     ≠ 1 message, mode ≠ 3 (amount > 0) / 130 (amount 0), internal message bounced / with IHR / with other currencies / that deploys a
//     contract, body other than empty or text comment (op 0 + valid UTF-8, one cell), masterchain, special cell, extra data,
//     non-canonical BOC (re-encoding must yield the same bytes, CRC included)
pub struct TonTxSummary { wallet, destination /*form according to the bounce flag*/, destination_other /*the other form*/, destination_raw, amount,
                          send_all, bounce, comment /*sanitized*/, seqno, valid_until, deploys_wallet, wallet_id, warnings: Vec<TonWarning>,
                          requires_extra_confirmation }
pub enum TonWarning { UnusualText }   // JSON { "kind": "unusualText" }
pub fn ton_sign(seed, account, boc, testnet) -> Result<TonSigned { boc, hash, normalized_hash, summary }>;   // ed25519 of the hash of the signed
//     part, verified (verify_strict); hash = hash of the external message, normalized_hash = TEP-467 (without StateInit), what explorers index
pub fn ton_verify_signed(boc, our_pubkey, testnet) -> Result<(TonTransfer, String /*hash*/, String /*normalized*/)>;

// --- Cosmos Hub: m/44'/118'/a'/0/0 (Keplr, Leap, Ledger Live, gaiad), cosmos1… address = bech32 (BIP-173, not bech32m) of
//     RIPEMD160(SHA256(compressed key)); uatom MsgSend in SIGN_MODE_DIRECT only. Protobuf: the SDK messages
//     (Coin, MsgSend, Any, TxBody, PubKey, ModeInfo, SignerInfo, Fee, AuthInfo, SignDoc, TxRaw) declared by hand with the derive
//     of `prost` (no protoc), only the fields used: every decoded byte must re-encode identically, at every
//     level (the unknown field, duplicate or non-minimal varint that prost would accept are thus rejected)
pub const COSMOS_CHAIN_ID_MAINNET = "cosmoshub-4"; pub const COSMOS_CHAIN_ID_TESTNET = "provider";   pub fn cosmos_chain_id(net) -> &str;
pub fn cosmos_path(account) -> String; pub fn cosmos_public_key(seed, account) -> Result<[u8; 33]>; pub fn cosmos_address(seed, account) -> Result<String>;
pub fn cosmos_address_bytes(address) -> Result<Vec<u8>>;     // bech32 verified, cosmos prefix, 20 or 32 bytes, mixed case rejected
pub fn cosmos_normalize_address(address) -> Result<String>;  // canonical lowercase form; cosmos_address_of_pubkey(sec1), cosmos_address_from_bytes(&[u8])
pub struct CosmosSendRequest { chain_id, account_number, sequence, public_key: [u8; 33], to, amount /*uatom*/, fee /*uatom*/, gas_limit, memo, timeout_height }
pub fn cosmos_send_sign_doc(&CosmosSendRequest) -> Result<Vec<u8>>;   // serialized SignDoc, re-verified by the decoder
pub fn cosmos_simulation_tx(sign_doc) -> Result<Vec<u8>>;               // TxRaw with an empty signature (for /simulate)
pub fn cosmos_decode_sign_doc(sign_doc_hex, our_pubkey, net) -> Result<CosmosTxSummary>;
// rejects: chain-id ≠ the network's, any message other than a single MsgSend, denomination other than uatom, several coins, non-canonical
// or zero amount or fee, sender ≠ us, send to self, non-canonical recipient, several signers, key ≠ ours, mode ≠ SIGN_MODE_DIRECT,
// payer / granter, gas_limit 0, missing timeout_height, memo > 512 characters, TxBody.unordered,
// timeout_timestamp, extension_options, AuthInfo.tip (undeclared fields → different re-encoding)
pub struct CosmosTxSummary { chain_id, account_number, sequence, from, to, amount, fee, gas_limit, memo /*sanitized, 256 chars*/,
                             memo_hex /*exact*/, timeout_height, warnings: Vec<CosmosWarning>, requires_extra_confirmation }   // serde camelCase
pub enum CosmosWarning { HighFee /*> 0.1 ATOM*/, UnusualText /*memo sanitized*/ }   // → enhanced (the memo alone does not trigger it: it is framed)
pub fn cosmos_sign(seed, account, sign_doc_hex, net) -> Result<(String /*TxRaw base64*/, String /*SHA-256 hash hex*/, CosmosTxSummary)>;
// decodes first; SHA-256(SignDoc), libsecp256k1 RFC 6979, low-S, 64 bytes r‖s, verified
pub fn cosmos_verify_signed(tx_b64, net, account_number) -> Result<(String /*hash*/, CosmosTxSummary)>;
// same rules + a single 64-byte, low-S signature, from the signer's key over the reconstructed SignDoc (network's chain-id,
// account_number read live)

// --- Aptos: m/44'/637'/a'/0'/0' (SLIP-10 ed25519, all levels hardened: Petra, Aptos CLI and SDKs, Ledger; account 0 = m/44'/637'/0'/0'/0'),
//     address = authentication key = SHA3-256(32 B public key || 0x00), written 0x + 64 hex (AIP-40 long form, no checksum);
//     hand-written BCS, strict (canonical ULEB128, known variants only, no extra bytes, identical re-encoding required)
pub fn aptos_path(account) -> String; pub fn aptos_address(seed, account) -> Result<String>; pub fn aptos_public_key(seed, account) -> Result<[u8; 32]>;
pub fn aptos_address_of_pubkey(&[u8]) -> Result<String>; pub fn aptos_parse_address(&str) -> Result<[u8; 32]>;   // 0x + exactly 64 hex: short form (0x1, leading zeros omitted) and ANS names (.apt) rejected
pub struct AptosTransfer { sender, sequence_number, recipient, amount /*octas*/, max_gas_amount, gas_unit_price, expiration_timestamp_secs, chain_id }
impl AptosTransfer { pub fn encode(&self) -> Result<Vec<u8>> /*RawTransaction BCS*/; pub fn decode(bcs) -> Result<Self>; pub fn max_fee(&self) -> u64;
                     pub fn signed_bytes(&self, pubkey, sig) -> Result<Vec<u8>> /*raw || 0x00 Ed25519 || uleb 32 || pk || uleb 64 || sig*/ }
// decode accepts ONLY RawTransaction { payload: EntryFunction(0x1::aptos_account::transfer, no type argument, [bcs(address), bcs(u64)]) };
// rejected: script, multisig, "Payload" payload (sequence-less transactions), other module / function, type arguments, zero amount / gas / price / chain_id.
pub fn aptos_signing_message(raw) -> Vec<u8>;     // SHA3-256("APTOS::RawTransaction") || raw
pub fn aptos_tx_hash(signed) -> String;           // 0x + hex(SHA3-256(SHA3-256("APTOS::Transaction") || 0x00 || signed))
pub fn aptos_decode_tx(raw_hex, our_address) -> Result<AptosTxSummary>;   // + rejects: sender ≠ us
pub struct AptosTxSummary { sender, recipient, function, amount, sequence_number, max_gas_amount, gas_unit_price, max_fee,
                            expiration_timestamp_secs, chain_id, warnings: Vec<AptosWarning>, requires_extra_confirmation }   // serde camelCase
pub enum AptosWarning { SelfTransfer, HighFee /*maximum fee > 0.02 APT*/ }   // → enhanced
pub fn aptos_sign(seed, account, raw_hex) -> Result<(String /*signed, hex*/, String /*hash*/, AptosTxSummary)>;   // decodes first; verify_strict
pub fn aptos_verify_signed(signed_hex) -> Result<(String /*hash*/, AptosTransfer)>;   // a single ed25519 key, address(key) = sender, verify_strict
pub fn aptos_simulation_bytes(raw_hex, pubkey) -> Result<Vec<u8>>;   // null signature, for /transactions/simulate (which rejects a real signature)
// Vectors: "shoot island …" wallet from the official TypeScript SDK (public key, address), two real mainnet transfers
// (versions 7851560271 and 7851558238) rebuilt byte for byte: the chain's signature verifies and the hash is identical.

// --- Cardano: CIP-1852 m/1852'/1815'/0'/{0,2}/i, CIP-0003 "Icarus" root (PBKDF2-HMAC-SHA512, 4096 iterations,
//     salt = BIP39 ENTROPY, then clamping), BIP32-Ed25519 V2 derivation by the ed25519-bip32 crate (no crypto written
//     here), ed25519-dalek signature (hazmat::raw_sign with the extended scalar kL ‖ kR) verified (verify_strict);
//     CBOR: hand-written subset, strict (identical re-encoding required, minimal forms, canonical order)
pub struct CardanoRoot;   // 96 B XPrv, erased on drop; created when the session opens (the vault does not change)
impl CardanoRoot { pub fn from_mnemonic(&Mnemonic, passphrase) -> CardanoRoot }
pub fn cardano_address(root, net, account, index) -> Result<String>;       // base address (type 0): payment …/0/index + staking …/2/0
pub fn cardano_payment_public_key(root, account, index) -> Result<[u8; 32]>;
pub fn cardano_account_xpub(root, account) -> Result<String>;              // public key ‖ chain code of m/1852'/1815'/account', hex
pub fn cardano_account_stake_address(root, net, account) -> Result<String>; // stake1… / stake_test1… (display; no staking)
pub fn cardano_base_address(net, pay_pk, stake_pk); pub fn cardano_enterprise_address(net, pay_pk); pub fn cardano_stake_address(net, stake_pk);
pub fn cardano_address_bytes(address, net) -> Result<Vec<u8>>;   // recipient: key base (types 0, 2) or key enterprise (6), right network.
// Rejected: Byron (Ae2…, DdzFF…), script as payment (1, 3, 5, 7: funds locked without datum), pointer (4, 5: obsolete in Conway),
// staking (14, 15), other network, wrong bech32 checksum.
pub struct CardanoBody { inputs: Vec<CardanoInput { tx_hash, index }>, tagged_sets /*tag 258*/, outputs: Vec<CardanoOutput { address, coin, assets, map_form }>,
                         fee, ttl: Option<u64>, aux_hash: Option<[u8; 32]>, validity_start: Option<u64> }   // keys 0, 1, 2, 3, 7, 8 only
impl CardanoBody { pub fn encode(&self) -> Vec<u8>; pub fn decode(raw) -> Result<Self>; pub fn tx_id(&self) -> [u8; 32] /*blake2b-256(body)*/ }
pub fn cardano_min_utxo(address, assets, coins_per_utxo_byte) -> u64;      // (160 + output size) × coinsPerUTxOByte; u64::MAX on overflow (hence rejection)
pub fn cardano_cip20_aux(message) -> Result<Vec<u8>>;                      // {674: {"msg": [lines ≤ 64 B]}}, 1,024 B max.
pub fn cardano_unsigned_tx(body, aux) -> Result<Vec<u8>>;                  // [body, {}, true, aux | null]
pub fn cardano_signed_size(body, aux, keys) -> Result<usize>;               // signed size (fee = a × size + b)
pub struct CardanoContext<'a> { net, own: &[String], verified_tokens: &[(policy_hex, name_hex)], coins_per_byte }
pub fn cardano_decode_tx(tx_hex, ctx) -> Result<CardanoTxSummary>;  pub fn cardano_tx_body(tx_hex, ctx) -> Result<CardanoBody>;
// decode rejects: certificates (4), withdrawals (5), updates (6), mint (9), script_data_hash (11), collateral (13, 16, 17),
// required signers (14), network id (15), reference inputs (18), votes (19), proposals (20), treasury (21, 22), unknown field;
// outputs with datum / datum hash / reference script; output below its min-UTxO; zero token quantity; metadata other
// than a CIP-20 message or with a wrong hash; duplicate input; witnesses already present; any non-canonical CBOR (indefinite length, non-minimal
// integer, key or token order, duplicate, extra bytes); more than 16,384 bytes.
pub struct CardanoTxSummary { tx_id, inputs /*"hash#i"*/, outputs: Vec<CardanoOutputView { address, kind /*base|enterprise*/, is_change,
                              lovelace, tokens: Vec<CardanoTokenView { policy, name /*hex*/, name_text?, quantity, verified }>, min_lovelace }>,
                              fee, ttl, valid_from, memo: Option<Vec<String>>, warnings: Vec<CardanoWarning>, requires_extra_confirmation }   // serde camelCase
pub enum CardanoWarning { Memo, UnknownToken { policy, name }, HighFee /*> 5 ADA*/, NoTtl,
                          UnusualText /*CIP-20 line sanitized, or token name to sanitize (name_text = None: hex only)*/ }   // → enhanced confirmation
// memo: lines passed through sanitize_text. Staking (cardano_decode_stake_tx / cardano_sign_stake): a single output, to ctx.own, otherwise rejected.
pub fn cardano_sign(root, account, index, tx_hex, ctx) -> Result<(String /*signed tx*/, String /*tx id*/, CardanoTxSummary)>;
// vkey witness = (public key, Ed25519 over blake2b-256(CBOR body)), verified; dalek public key = ed25519-bip32 key otherwise error
pub fn cardano_signed_witnesses(tx_hex) -> Result<(String /*tx id*/, Vec<[u8; 32]>)>;   // each witness verified against the tx id
pub fn cardano_verify(pk, msg, sig) -> Result<()>; pub fn cardano_blake2b256(data) -> [u8; 32];

// --- Kaspa (crates/wallet-core/src/kaspa.rs; rules of rusty-kaspa v2.1.0, official vectors in tests/kaspa.rs) ---
// "gen1" derivation (Kaspa NG, Kaspium): m/44'/111111'/account'/0/i (receive), …/1/i (change), SAME path on testnet-10.
pub fn kaspa_path(account, change, index) -> String; pub fn kaspa_account_path(account) -> Result<String>;
pub fn kaspa_public_key(seed, account, change, index) -> Result<[u8; 32] /*x-only*/>;
pub fn kaspa_address(seed, net, account, change, index) -> Result<String>;       // P2PK Schnorr, kaspa: / kaspatest:
pub fn kaspa_own_keys(seed, net, account, window) -> Result<Vec<KaspaOwnKey { change, index, xonly, address }>>;   // receive then change
pub fn kaspa_address_encode(net, kind, payload); pub fn kaspa_address_decode(net, address) -> Result<(KaspaAddressKind, Vec<u8>)>;
// decode: lowercase only, network prefix required (clear message if it is the other network), checksum (CashAddr polymod),
// version 0 (P2PK Schnorr, 32 B) / 1 (P2PK ECDSA, 33 B) / 8 (P2SH, 32 B), canonical form (identical re-encoding).
pub fn kaspa_script_pubkey(net, address) -> Result<Vec<u8>>;  pub fn kaspa_address_of_script(net, version, script) -> Option<String>;
pub struct KaspaTx { version, inputs: Vec<KaspaInput { outpoint, signature_script, sequence, sig_op_count }>,
                     outputs: Vec<KaspaOutput { value, script_version, script }>, lock_time, subnetwork_id: [u8; 20], gas, payload }
pub fn kaspa_tx_id(tx) -> Result<[u8; 32]>;        // keyed BLAKE2b "TransactionID", without signature scripts (version 0 only)
pub fn kaspa_tx_hash(tx) -> Result<[u8; 32]>;      // "TransactionHash", full encoding (vectors)
pub fn kaspa_sighash(tx, entries, index, hash_type) -> Result<[u8; 32]>;   // calc_schnorr_signature_hash ("TransactionSigningHash"); all 6 types (vectors), Kyro only signs 0x01
pub fn kaspa_mass(tx, entries) -> Result<KaspaMass { compute, transient, storage, relay, total }>;   // generalized KIP-9 (pluralities)
pub fn kaspa_storage_mass(inputs: &[(amount, script length)], outputs) -> Option<u64>;
pub fn kaspa_priority_feerate(estimate) -> u64;    // 0 if the server's estimate is at the minimum (100), otherwise min(estimate, 10,000)
pub fn kaspa_build_send(coins, to_script, KaspaAmount::Exact(sompi) | Max, change_script, priority) -> Result<KaspaBuilt { tx, entries }>;
// coins by decreasing amount, ≤ 84 entries, recipient ≥ 0.2 KAS (KIP-9), fees = max(100 × relay mass, priority × total mass),
// change never created beyond 100,000 g: added to the fees if ≤ 0.2 KAS, otherwise additional coins.
pub fn kaspa_tx_summary(net, tx, entries, ours) -> Result<KaspaTxSummary>;
// rejects: version ≠ 0, non-native subnetwork, gas, payload, lock time ≠ 0, sequence ≠ 0, sig-op ≠ 1, input not in `ours` (P2PK of this account),
// duplicate input, 0 or > 2 outputs, zero output, script version ≠ 0, outputs > inputs, mass > 100,000, fees < relay minimum.
pub struct KaspaTxSummary { tx_id, outputs: Vec<KaspaOutputView { address?, script, amount, is_change, kind /*address|unknown*/ }>, inputs,
                            input_total, sent, fee, mass, minimum_fee, fee_rate, has_change, warnings: Vec<KaspaWarning>, requires_extra_confirmation }   // serde camelCase
pub enum KaspaWarning { UnknownOutput { index }, HighFee /*> 1 KAS or > 10 × minimum*/ }   // serde tag "kind" → enhanced confirmation
pub fn kaspa_sign(seed, net, account, tx, entries) -> Result<(KaspaTx /*signed*/, KaspaTxSummary)>;   // BIP340 libsecp256k1, auxiliary randomness, each signature re-verified; summary identical before/after
pub fn kaspa_verify_signed(tx, entries) -> Result<()>;   // signature script = OP_DATA_65 ‖ sig64 ‖ 0x01, Schnorr against the coin's key
pub fn kaspa_tx_to_json(tx) -> Result<String>; pub fn kaspa_tx_from_json(json) -> Result<KaspaTx>;   // SubmitTxModel form of the API, unknown fields rejected, lowercase hex

// --- Monero (monero-oxide / monero-wallet 0.2, MIT, Cypher Stack audit May 2025; no in-house crypto):
//     k = BIP32-secp256k1(seed, m/44'/128'/a'/0/0) ; spend = sc_reduce32(keccak256(k)) ; view = sc_reduce32(keccak256(spend))
//     (scheme of Ledger's Monero app; the 25-word phrase of `spend` restores the same wallet in Monero GUI, Feather, Cake).
//     Kyro's testnet = Monero **stagenet**.
pub fn xmr_path(account) -> String; pub fn xmr_view_pair(seed, account) -> Result<ViewPair>;
pub fn xmr_address(seed, net, account, index) -> Result<String>;   // 0 = main address, n ≥ 1 = subaddress (0, n)
pub fn xmr_addresses(seed, net, account, range) -> Result<Vec<String>>; pub fn xmr_public_keys(seed, account) -> Result<(String, String)>;
pub fn xmr_seed_words(seed, account) -> Result<Zeroizing<Vec<String>>>; pub fn xmr_words_to_key(phrase) -> Result<Zeroizing<[u8; 32]>>;   // 25 English words + CRC32 checksum
pub fn xmr_parse_address(address, net) -> Result<XmrDestination { address, kind: standard | subaddress | integrated { paymentId } }>;
                                                                   // other network, "featured" address, non-canonical encoding: rejected
pub fn xmr_scanner(seed, account, subaddresses) -> Result<Scanner>;   // private view key in memory, never sent
pub fn xmr_key_images(seed, account, outputs) -> Result<Vec<[u8; 32]>>;   // checks that each output really is ours
pub fn xmr_cache_seal(seed, net, account, plain) / xmr_cache_open(...);   // encrypted scan state (XChaCha20-Poly1305, key derived from the view key)
pub fn xmr_build(seed, net, account, inputs: Vec<OutputWithDecoys>, to, amount, fee_rate, own) -> Result<XmrUnsigned>;   // ring 16, CLSAG + Bulletproofs+
pub struct XmrTxSummary { network, account, destination, amount, fee, change, inputsTotal, inputCount, ringSize, feePerWeight,
                          warnings: Vec<XmrWarning /*integratedAddress | highFee (> 0.01 XMR) | feeAboveAmount | ownAddress*/>, requiresExtraConfirmation }
pub fn xmr_sign(seed, account, unsigned) -> Result<XmrSigned { tx, txid, key_images, summary }>;
                                                                   // then Eventuality: exactly the expected outputs (payment + change), fees = the ones displayed

// --- Solana: decoding of legacy and v0 messages (hand-written parser, documented wire format) ---
pub struct SolLookupTable { pub key: String, pub addresses: Vec<String> }            // base58
pub fn sol_message_lookup_tables(message: &[u8]) -> Result<Vec<String>>;             // tables to fetch (v0)
pub fn sol_parse_lookup_table(account_data: &[u8]) -> Result<Vec<String>>;           // AddressLookupTable account: 56 B header + n×32; rejects uninitialized / deactivated
pub const SOL_LOOKUP_TABLE_PROGRAM: &str;                                            // expected owner of the table account
pub fn sol_decode_message(message: &[u8], tables: &[SolLookupTable], our_address: &str) -> Result<SolTxSummary>;
// Failure (Error) if: truncated message / non-canonical short-vec / out-of-bounds index / extra bytes /
// duplicate keys / version ≠ 0 / missing table or table index absent / malformed data for a recognized program.
pub struct SolTxSummary {                       // serde camelCase; u64 amounts as decimal strings
    pub version: String /*"legacy"|"v0"*/, pub fee_payer: String, pub signers: Vec<String>, pub our_signer_index: Option<usize>,
    pub recent_blockhash: String, pub instructions: Vec<SolInstruction>, pub lookup_tables: Vec<String>,
    pub base_fee_lamports: String /*5000 × signatures*/, pub compute_unit_limit: Option<u32>,
    pub compute_unit_price_micro_lamports: Option<String>, pub priority_fee_lamports: Option<String> /*ceil(price × limit / 1e6)*/,
    pub warnings: Vec<SolWarning>, pub requires_extra_confirmation: bool }
pub enum SolInstruction {                       // JSON: { "type": "systemTransfer", ...camelCase fields }
    SystemTransfer { from, to, lamports }, SystemTransferWithSeed { from, base, to, lamports, seed },
    SystemCreateAccount { from, new_account, lamports, space, owner },
    SystemCreateAccountWithSeed { from, new_account, base, seed, lamports, space, owner },
    TokenTransfer { token_program /*token|token2022*/, checked, source, destination, authority, mint?, amount, decimals?, multisig_signers },
    TokenApprove { token_program, checked, source, delegate, owner, mint?, amount, decimals?, multisig_signers },   // DELEGATION
    AtaCreate { idempotent, payer, account, owner, mint, token_program? },
    ComputeUnitLimit { units }, ComputeUnitPrice { micro_lamports }, Memo { text },
    Unknown { program_id, accounts, account_keys, data_len } }
pub enum SolWarning {                           // JSON: { "kind": "feePayerNotUs", ... }
    FeePayerNotUs { fee_payer }, ExtraWritableSigner { address }, AuthorityNotUs { instruction, authority },
    Delegation { instruction }, UnknownInstruction { instruction, program_id },
    Token2022ExtensionsUnverified { instruction } /*informational*/, PriorityFeeEstimated /*informational*/,
    UnknownOwnerProgram { instruction, owner, space } /*CreateAccount(WithSeed) for a program outside the closed list*/,
    UncheckedTokenTransfer { instruction } /*SPL Transfer tag 3, without mint or decimals*/,
    UnusualText { instruction } /*memo or seed sanitized, or memo > 80 characters*/ }
// requires_extra_confirmation = unknown instruction, delegation, payer ≠ us, other writable signer, authority ≠ us,
// UnknownOwnerProgram, UncheckedTokenTransfer, UnusualText. Memo.text and the seeds are sanitized (sanitize_text; memo 566 chars max).
// Closed list of owners: System; Token (165 or 82 bytes); Token-2022 (82, or 165 to 1024 bytes); Stake (staking rules).

// --- Text coming from the chain: ONE single sanitizer, exported for the shell ---
pub fn sanitize_text(s: &str, max_chars: usize) -> SanitizedText { text, altered, truncated };   // control characters (\n \r \t → space, others → U+FFFD),
// bidi / invisible characters removed (U+200B–200F, U+202A–202E, U+2060–206F, U+FEFF, U+00AD, U+061C, U+180E, U+FFF9–FFFB, tags U+E0000–E007F),
// length bounded with "…"; altered = something changed → warning + 2nd dialog on the caller's side.

// --- Staking (§2.8). Solana: program Stake11111111111111111111111111111111111111, decoded in sol_decode_message ---
// SolInstruction gains 4 variants (JSON "type"): StakeInitialize { stake_account, staker, withdrawer },
//   StakeDelegate { stake_account, vote_account, authority }, StakeDeactivate { stake_account, authority },
//   StakeWithdraw { stake_account, to, lamports, authority }.
// sol_decode_message REJECTS (Error, not "unknown"): any other instruction of the Stake program (Authorize*, SetLockup*,
// Split, Merge, InitializeChecked, Redelegate, MoveStake, MoveLamports, DeactivateDelinquent, GetMinimumDelegation);
// Initialize with staker or withdrawer ≠ us, or a non-zero lockup / custodian; Delegate / Deactivate / Withdraw whose
// authority ≠ us, a Withdraw to another address (or a custodian ≠ us); an unexpected sysvar / StakeConfig / number of
// accounts; an account created for the Stake program with a size ≠ 200 bytes or not initialized in the same
// transaction; a CreateAccountWithSeed whose address is not sha256(base ‖ seed ‖ owner).
pub enum SolStakeOp { CreateAndDelegate { seed, lamports /*stake + rent reserve*/, vote_account },
                      Delegate { stake_account, vote_account }, Deactivate { stake_account }, Withdraw { stake_account, lamports } }
pub fn sol_stake_message(me, op: &SolStakeOp, blockhash) -> Result<Vec<u8>>;  // legacy message, a single signer (us); creation
// by CreateAccountWithSeed (base = us, owner = Stake, 200 B) + Initialize (staker = withdrawer = us, zero lockup) + DelegateStake
pub fn sol_create_with_seed(base, seed /*≤ 32 B*/, owner) -> Result<String>;
pub fn sol_parse_stake_account(data /*200 B*/) -> Result<SolStakeAccount { state, rent_exempt_reserve, staker, withdrawer,
    lockup_unix_timestamp, lockup_epoch, lockup_custodian, delegation: Option<SolDelegation { vote_account, stake, activation_epoch,
    deactivation_epoch }> }>;
pub fn sol_parse_stake_history(data) -> Result<Vec<SolStakeHistoryEntry { epoch, effective, activating, deactivating }>>;
pub fn sol_stake_activation(delegation, target_epoch, history) -> SolStakeActivation { effective, activating, deactivating };
// = Delegation::stake_activating_and_deactivating of the Stake program (rate 9%/epoch); getStakeActivation no longer exists (Agave 2.0)
pub fn sol_stake_withdrawable(account, balance, epoch, history) -> (u64 /*max partial withdrawal*/, bool /*full withdrawal (close) possible*/);

// --- Cardano staking (Conway): CardanoBody gains `certs: Vec<CardanoCert>` (key 4, set 258 if tagged_sets) and
//     `withdrawals: Vec<(Vec<u8> /*reward address*/, u64)>` (key 5). cardano_decode_tx (payments) still rejects them.
pub enum CardanoCert { StakeRegistration { stake, deposit } /*cert 7*/, StakeDeregistration { stake, refund } /*8*/,
                       StakeDelegation { stake, pool } /*2*/, VoteDelegation { stake, drep: CardanoDrep } /*9*/ }   // KEY identifier only
pub enum CardanoDrep { Key([u8; 28]), Script([u8; 28]), AlwaysAbstain, AlwaysNoConfidence }
pub fn cardano_decode_stake_tx(tx_hex, ctx, stake_pk, key_deposit) -> Result<CardanoStakeSummary>;
pub fn cardano_stake_tx_body(tx_hex, ctx, stake_pk, key_deposit) -> Result<CardanoBody>;
pub fn cardano_sign_stake(root, account, index, stake_account, tx_hex, ctx, key_deposit) -> Result<(String, String, CardanoStakeSummary)>;
// witnesses: payment key …/account'/0/index then staking key …/stake_account'/2/0, each verified (verify_strict)
// cardano_decode_stake_tx REJECTS: certificates 0, 1 (old formats), 3, 4 (pools), 5, 6 (genesis, MIR), 10–13 (combined),
// 14–18 (committee, DRep); script identifier; a certificate or a withdrawal for a key other than stake_pk; deposit ≠ key_deposit;
// duplicate certificate; registration + deregistration, or delegation + deregistration, together; registration not first;
// several withdrawals; withdrawal of 0; metadata; no staking operation. Votes (19) and proposals (20) remain rejected.
pub struct CardanoStakeSummary { tx: CardanoTxSummary, stake_address, certificates: Vec<CardanoCertView>, withdrawals:
    Vec<CardanoWithdrawalView { reward_address, lovelace }>, deposit, refund, withdrawn }   // serde camelCase, amounts as strings
pub enum CardanoCertView { StakeRegistration { deposit }, StakeDeregistration { refund }, StakeDelegation { pool_id /*pool1…*/,
    pool_hash }, VoteDelegation { drep: CardanoDrepView } }          // JSON { "type": "stakeDelegation", … }
pub enum CardanoDrepView { Key { id /*CIP-129 drep1…*/, hash }, Script { id, hash }, AlwaysAbstain, AlwaysNoConfidence }   // JSON { "kind": … }
pub fn cardano_stake_public_key(root, account) -> Result<[u8; 32]>; pub fn cardano_blake2b224(data) -> [u8; 28];
pub fn cardano_reward_address_bytes(net, stake_hash) -> Vec<u8>;    // 0xE0 | network ‖ hash
pub fn cardano_pool_id(s /*pool1… or 56 hex*/) -> Result<[u8; 28]>; pub fn cardano_pool_bech32(hash) -> Result<String>;
pub fn cardano_drep_parse(s /*alwaysAbstain | alwaysNoConfidence | drep1… (CIP-129 or CIP-105) | drep_script1…*/) -> Result<CardanoDrep>;
pub fn cardano_drep_id(drep) -> Option<String>;                     // CIP-129

// --- TRON staking (Stake 2.0): TronContract gains FreezeV2 { owner, amount, resource }, UnfreezeV2 { … }, WithdrawExpireUnfreeze,
//     CancelAllUnfreezeV2, VoteWitness { owner, votes: Vec<([u8; 21], i64)> }, WithdrawBalance (types 54, 55, 56, 59, 4, 13).
//     TronRaw::decode still rejects DelegateResource / UnDelegateResource (57, 58), TRON_POWER, the `support` field.
//     tron_decode_raw (payments) rejects these staking contracts.
pub enum TronResource { Bandwidth, Energy }                          // JSON "BANDWIDTH" | "ENERGY"
pub fn tron_decode_stake_raw(raw_hex, our_address) -> Result<TronStakeSummary>;   // + rejects: owner ≠ us, amount ≤ 0, memo,
// fee_limit ≠ 0, 0 or more than 30 votes (TRON_MAX_VOTES), an SR twice, a zero vote, a contract transfer / call
pub fn tron_stake_sign(seed, account, raw_hex) -> Result<([u8; 65], TronStakeSummary)>;
pub struct TronStakeSummary { txid, owner, action: TronStakeAction, expiration, timestamp, ref_block_bytes, ref_block_hash, raw_size }
pub enum TronStakeAction { Freeze { resource, amount }, Unfreeze { resource, amount }, WithdrawUnfrozen, CancelAllUnfreeze,
                           Vote { votes: Vec<TronVote { address, count }>, total }, ClaimRewards }   // JSON { "type": "freeze", … }

// --- hardware wallets (B3): no private key; the device is never trusted ---
pub enum HwDeviceKind { Ledger, Trezor }                                  // JSON "ledger" | "trezor"
pub struct WatchOnlyAccount { pub id: String /*"hw-"+16 hex*/, pub label: String, pub device: HwDeviceKind,
    pub model: String, pub network: Network, pub account: u32 /*≤ 100*/,
    pub btc: Vec<BtcAccount> /*≤ 1 per type, same fingerprint*/, pub evm: Option<WatchEvm { xpub /*node m/44'/60'/0'/0*/, path }>,
    pub sol: Option<WatchSol { address, path /*m/44'/501'/account'/0'*/ }> }   // serde camelCase, deny_unknown_fields
pub struct WatchOnlyStore { pub version: u8 /*1*/, pub accounts: Vec<WatchOnlyAccount> }
impl WatchOnlyStore { pub fn from_json(json, network) -> Result<Self>; pub fn validate(&self, network); pub fn to_json(&self) }
// File separate from the vault (the VaultFile v1 format is unchanged); full validation on read.
pub fn btc_hw_plan(net, psbt_b64, accounts: &[BtcAccount]) -> Result<HwBtcPlan>;   // our inputs/change, verified against the xpub
pub struct HwBtcPlan { pub inputs: Vec<HwBtcInput { index, kind, path: Vec<u32>, pubkey, amount, has_prev_tx }>,
    pub external_inputs: Vec<usize>, pub change: Vec<HwBtcChange { index, kind, path }>, pub summary: BtcTxSummary }
pub struct HwBtcSignature { pub input: usize, pub pubkey: Option<Vec<u8>>, pub signature: Vec<u8> }
pub fn btc_hw_finalize(net, psbt_b64, accounts, sigs: &[HwBtcSignature]) -> Result<(String /*signed PSBT*/, BtcTxSummary)>;
// Recomputes each sighash (BIP143 / BIP341) and verifies each signature against the key derived from the xpub;
// missing signature, duplicate, for a foreign input, other key, sighash ≠ ALL/DEFAULT, high-S → Error::Device.
pub fn btc_hw_own_addresses(net, accounts, gap) -> Result<Vec<String>>;
pub fn evm_signing_payload(tx) -> Result<Vec<u8>>;          // 0x02 || rlp(unsigned fields) — what the Ledger receives
pub fn evm_tx_fields(tx) -> Result<EvmTxFields>;              // minimal big-endian integers (Trezor)
pub fn evm_hw_finalize(tx, r, s, expected_address) -> Result<(String /*raw*/, String /*hash*/)>; // v ignored, low-S required, recovery = expected address
pub fn evm_xpub_from_node(sec1, chain_code) -> Result<String>; pub fn evm_address_from_xpub(xpub, index) -> Result<String>;
pub fn evm_address_of_pubkey(sec1) -> Result<String>;       pub fn evm_checksum_address(addr) -> Result<String>;
pub fn sol_address_of_pubkey(bytes) -> Result<String>;      pub fn sol_verify_signature(address, message, sig) -> Result<[u8; 64]>; // verify_strict
pub struct LedgerErc20Descriptor { chain_id, contract: [u8; 20], ticker, decimals, signature /*DER*/ }
pub fn ledger_erc20_lookup(chain_id, contract) -> Option<LedgerErc20Descriptor>;   // embedded table (see §2.3)
pub fn ledger_erc20_verify(d) -> Result<()>;                // against LEDGER_ERC20_SIGNER (key published by Ledger)
pub fn ledger_erc20_payload(d) -> Result<Vec<u8>>;          // data of the PROVIDE ERC 20 TOKEN INFORMATION APDU
// Error::Device(String): response from a device rejected by an independent check (code HW_BAD_RESPONSE).
```

## 2. Tauri commands (exposed to the frontend)

Reference TypeScript types: `packages/shared/src/ipc.ts`. Names in `snake_case`, arguments in `camelCase` (Tauri convention).

| Command | Arguments | Return | Notes |
|---|---|---|---|
| `vault_status` | — | `{ exists, unlocked, autoLockSecs, lockInSecs \| null }` | |
| `vault_create` | `{ password, words: 12 \| 24 }` | `{ wordCount }` | creates the vault (lock held from the existence check until the session starts, file created without ever overwriting: `INVALID_INPUT` if a vault exists); **the words are not returned**: Rust keeps them until verification (or until lock) |
| `vault_backup_show` | — | `{ checks: [i, j, k] }` | shows the phrase of the just-created vault in the **phrase window** (returns when it is closed), then randomly draws (OS) the 3 positions (0-based) to verify; `INVALID_INPUT` if there is no pending phrase anymore |
| `vault_backup_verify` | `{ answers: string[3] }` | `{ ok, attemptsLeft }` | compares against the positions drawn by Rust; answers only yes/no; on the 5th failure the pending phrase is forgotten (`attemptsLeft: 0`: show it again from Settings › Security) |
| `vault_import` | `{ password, phrase, xmrRestore? }` | `void` | `xmrRestore`: start of the first Monero scan — `{ kind: 'kyro' }` (default, Kyro's first release), `{ kind: 'date', date }` or `{ kind: 'genesis' }` (phrase already used with Monero on a Ledger); kept in `monero/<network>-restore-<key>.json` |
| `vault_unlock` | `{ password }` | `void` | 5 attempts then an increasing delay; each attempt is **reserved** (counted) under the same lock as the delay check, before Argon2id (parallel calls do not get around the limit), and the counter + `retry_after` are saved next to the vault (`coffre-<network>.attempts`): restarting the app does not reset the delay. Same rule for any command that asks for the password. After a successful unlock, Rust may schedule the anonymous weekly count in the background (`weekly_count.rs`, docs/NETWORK.md); nothing is returned to the UI |
| `vault_lock` | — | `void` | zeroize the session |
| `vault_reveal_mnemonic` | `{ password }` | `void` | password (rate-limited as above, 10 s between two requests), then **native confirmation** ("Show" / "Cancel" → `USER_REJECTED`; French: « Afficher » / « Annuler »), then the words in the **phrase window** (separate, capture-protected; see the rules at the top); nothing is returned to the interface (which knows the password it had typed in). Screen-capture blocking does not apply to the native confirmation dialog |
| `session_touch` | — | `void` | user activity → postpones the auto-lock |
| `accounts_get` | `{ account? }` | `Accounts` | public addresses only, of account `account` (absent = 0) of each chain; also contains `ltc`, `doge`, `bch` and `dash` (§2.4). Multiple accounts: §2.9 |
| `vault_accounts_get` / `vault_account_add` / `vault_account_rename` / `vault_account_remove` | see §2.9 | `VaultAccountLists` | the vault's account lists, per chain |
| `btc_address` | `{ kind, change, index, account? }` | `string` | `m/84'\|86'/coin'/account'/change/index` |
| `evm_decode_tx` | `{ tx: EvmTxRequest }` | `EvmTxSummary` | for the preview before the password; `INVALID_INPUT` if the chainId belongs to a main network in test mode (or Sepolia on mainnet) |
| `evm_sign_tx` | `{ tx, password, account? }` | `{ rawTx, hash }` | key `m/44'/60'/0'/0/{account}`; native dialog mandatory (signing account and "From" address at the top, §2.9); a token's symbol and decimals **only** from the Rust table `known_tokens.rs` (network + chainId + contract) — a `token` sent by an old interface is ignored; token not in the table: contract + **raw units**, "UNKNOWN TOKEN" (French: « JETON INCONNU »), and a 2nd dialog; native currency named per chain (ETH, POL, BNB, AVAX); **hardened 2nd dialog** if `requiresExtraConfirmation` or unknown token: contract call other than an ERC-20 transfer, **any** approval (`approve`: beneficiary and amount, "UNLIMITED" (French: « ILLIMITÉ ») if ≥ 2^128), native value sent with a call, unknown chainId, maximum fee above the threshold (see §1); chainId of the other family of networks: refused (`INVALID_INPUT`) |
| `btc_sign_psbt` | `{ psbt, password, account? }` | `{ psbt, summary }` | signs only the inputs of account `account` (those of other accounts: `foreignInput`); native dialog mandatory (`btc_psbt_summary` summary, signing account at the top); **hardened 2nd dialog** if `summary.requiresExtraConfirmation` (unknown script, OP_RETURN, input that is not ours, fees > 100 sat/vB or > total of the outputs); the signature's summary must be identical to the one displayed |
| `sol_decode_tx` | `{ message /*b64, message serialized without signatures*/, account? }` | `SolTxSummary` | preview before the password; decoded in Rust, address tables (v0) fetched by Rust (`getAccountInfo`) — never supplied by the UI; unlocked session required; `requiresExtraConfirmation` is also set when a recognized instruction uses an account **read from a table** (see `sol_sign_tx`) |
| `sol_sign_tx` | `{ message /*b64*/, password, account? }` | `{ signature /*b64*/, summary: SolTxSummary }` | same decoding; refuses if our address is not a signer; native dialog built from the Rust summary, each address absent from the message's static keys (hence supplied by the RPC's table) marked "[read from an address table]" (French: « [lu dans une table d'adresses] »), mint named by `known_tokens.rs` or "unknown token", memo last; then a 2nd dialog "Unrecognised or unusual instruction — sign anyway?" (French: « Instruction non reconnue — signer quand même ? ») if `requiresExtraConfirmation` (which includes: a recipient, an authority, a token account… coming from a table, listed); the signature goes at index `summary.ourSignerIndex`. Staking (`sol_stake_*`) refuses any account coming from a table |
| `net_fetch` | `{ req: { url, method, headers?, body? } }` | `{ status, body }` | allowlist + cache + rate-limit; only `accept`, `content-type`, `0x-version` are forwarded, API keys are added by Rust. **Via Tor if `settings.tor.enabled` (default)**: waits for Tor to start (60 s max) then fails with `TOR_UNAVAILABLE` — never a fallback to clear. In Tor mode, `https://mempool.space/…` is transparently served by mempool's onion service (same path, same response); the UI keeps calling `https://mempool.space/…`. Any `.onion` URL is refused (`HOST_NOT_ALLOWED`) in clear mode |
| `tor_status` | — | `TorStatus` | current state of the built-in Tor |
| `tor_retry` | — | `TorStatus` | restarts the startup from scratch (whatever the state: useful after `error`); refused (`INVALID_INPUT`) if Tor is disabled |
| `settings_get` / `settings_set` | — / `{ settings: SettingsInput }` | `Settings` (without secrets: `hasPassword` instead of the Core password, `apiKeysSet` instead of the API keys) | stored in the app folder (`settings.json`, 0600 on Unix); switching `tor.enabled` from `true` to `false` turns Tor off after a **native confirmation** ("Turn Tor off" / "Keep Tor" → `USER_REJECTED`; French: « Désactiver Tor » / « Garder Tor »), the reverse starts it; each **new** custom server host (neither saved, nor already allowed in this session) is shown in a **native window** ("New server" (French: « Nouveau serveur »): purpose, `scheme://host:port`) **before any request** — refusal = `USER_REJECTED`, nothing is sent or saved; a new `.cookie` path is accepted only if it comes from `btc_core_pick_cookie`; **`settings_set` is asynchronous** and then verifies live each modified custom server (see §2.1) before saving — typed errors `SERVER_INVALID`, `SERVER_WRONG_NETWORK`, `SERVER_UNREACHABLE`, `TOR_UNAVAILABLE`, `USER_REJECTED`, nothing is saved on failure; if the object sent has no `servers` key, the saved servers are kept |
| `server_test` | `{ target: ServerTestTarget }` | `ServerTestResult` | tests a server **without saving it** (same checks as `settings_set`, including the native "New server" window before any request and the `.cookie` rule). Bitcoin Core `userpass` sent **without** `password`: the saved password is reused if it is the same slot (same network), same URL and same user; otherwise `SERVER_INVALID` (missing password) |
| `electrum_fetch_cert` | `{ host, port }` | `{ sha256, webpkiValid }` | SHA-256 fingerprint of an Electrum server's TLS certificate, for the TOFU confirmation; a host that is neither saved nor allowed is first confirmed in a **native window** (its name alone would go out to DNS / an exit relay); the handshake is aborted as soon as the certificate is received (no data sent) |
| `btc_core_pick_cookie` | — | `{ path: string \| null }` | opens the **system file picker** (handled by Rust) to choose Bitcoin Core's `.cookie`; the file must be named exactly `.cookie`, not be a symbolic link, be at most 256 bytes and contain `__cookie__:<64 hex>`; it becomes the only new path accepted by `settings_set` / `server_test`; `null` = cancelled |
| `btc_backend_info` | — | `{ kind, network, label, tor }` | active Bitcoin server: `kind` = `default` \| `esplora` \| `electrum` \| `core` \| `cbf`, `network` = `mainnet` \| `testnet4`, `label` = host (never credentials) |
| `btc_address_info` | `{ address }` | Esplora `GET /address/{a}` shape | see §2.2 |
| `btc_address_utxos` | `{ address }` | Esplora `GET /address/{a}/utxo` shape | see §2.2 |
| `btc_address_txs` | `{ address }` | Esplora `GET /address/{a}/txs` shape | see §2.2 (50 most recent at most) |
| `btc_fee_rates` | — | mempool `GET /v1/fees/recommended` shape | sat/vB |
| `btc_tip_height` | — | `number` | |
| `btc_tx_hex` | `{ txid }` | `string` (raw transaction, hex) | full transaction, for example the `non_witness_utxo` of a SegWit v0 input for a hardware wallet. Esplora/default `GET /tx/{txid}/hex`; Electrum `blockchain.transaction.get`; Core `gettransaction` (watch-only wallet) then `getrawtransaction` — outside the wallet and without `-txindex=1`: explicit `INVALID_INPUT`; compact filters: transactions kept from the synced blocks, otherwise explicit `INVALID_INPUT`. **Always**: Rust checks that the response is a transaction whose txid (double SHA-256 of the serialization without witness) = `txid`, otherwise `SERVER_UNREACHABLE`; malformed `txid`: `INVALID_INPUT` |
| `btc_broadcast` | `{ hex }` | `string` (txid) | the txid returned by the server must match the transaction, otherwise error |
| `ltc_*`, `doge_*`, `bch_*`, `dash_*` | see §2.4 | | Litecoin, Dogecoin, Bitcoin Cash, Dash: same Esplora shapes as `btc_*`, signing with native dialog |
| `ada_*` | see §2.7 | | Cardano: transaction built **by Rust** from the UTxOs and the protocol parameters, each output detailed (ADA, tokens, min-ADA) |
| `stellar_*` | see §2.11 | | Stellar: transaction built **by Rust** (sequence, bounded fees, time limits; Payment of XLM or USDC (Circle), CreateAccount, ChangeTrust of USDC), memo highlighted, reserve, network passphrase verified |
| `xrp_*` | see §2.6 | | XRP Ledger: payment built **by Rust** (Sequence, Fee, LastLedgerSequence), destination tag highlighted, reserve |
| `sui_*` | see §2.11 | | Sui: SUI or USDC (Circle) transfer built **by Rust** (gas coins, reference price, simulated budget, BCS), full address in the native dialog |
| `hbar_*` | see §2.11 | | Hedera: CryptoTransfer built **by Rust** (one copy per node, same identifier), memo highlighted, gRPC-web broadcast |
| `kas_*` | see §2.11 | | Kaspa: transaction built **by Rust** from the account's coins (20 receive addresses + 20 change), KIP-9 mass and fees computed, coins re-read before signing |
| `dot_*` | see §2.11 | | Polkadot Asset Hub: `transfer_keep_alive` transfer built **by Rust** (metadata verified, nonce, era), existential deposit, sr25519 signature |
| `algo_*` | see §2.11 | | Algorand: `pay` payment built **by Rust** (fees, validity window, genesis), canonical msgpack, minimum balance, close-remainder-to and rekey refused |
| `xmr_*` | see §2.11 | | Monero: blocks parsed **locally** by Rust (view key in memory only), transfer built **by Rust** (ring of 16, CLSAG, Bulletproofs+, monero-wallet), native dialog |
| `ton_*` | see §2.11 | | TON: v4R2 transfer built **by Rust** (seqno, account state, emulated fees), comment highlighted, both address forms |
| `cosmos_*` | see §2.11 | | Cosmos Hub: MsgSend built **by Rust** (account number, sequence, timeout height, simulated gas, fee market price), SignDoc strictly decoded, memo fenced |
| `aptos_*` | see §2.11 | | Aptos: APT transfer (`0x1::aptos_account::transfer`) or USDC / USDt transfer (`0x1::primary_fungible_store::transfer`) built **by Rust** (sequence, gas price, simulated gas, expiration), strictly decoded, re-simulated before the native dialog |
| `tron_*` | see §2.5 | | TRON: transaction built **by Rust** from the latest block, signing with native dialog (resources, TRX burned) |
| `sol_stake_*`, `ada_stake_*`, `tron_stake_*` | see §2.8 | | Staking: native Solana, Cardano delegation, TRON Stake 2.0; operations built **by Rust**, decoded and verified live before the native dialog |
| `btc_core_setup` | `{ rescanFrom: 'now' \| number /*UNIX timestamp in s*/ }` | `CoreStatus` (`state: 'importing'`) | Bitcoin Core only, unlocked session. **Synchronous pre-check** (errors returned by the call itself): node reachable (`SERVER_UNREACHABLE`), authentication (`SERVER_INVALID`), right chain (`SERVER_WRONG_NETWORK`), wallet `kyro-watch-<fingerprint8>` created or loaded and indeed without private keys (`SERVER_INVALID`), descriptor checksums. Only `importdescriptors` (and its rescan) then runs in the background. No Core node configured for this network: `INVALID_INPUT` |
| `btc_core_status` | — | `CoreStatus` | rescan progress (`getwalletinfo.scanning`). The import state is specific to **(network, URL, wallet)**: another node or another network does not see the import of a first one. No Core node configured: normal response `{ state: 'not-configured', wallet: '', walletLoaded: false }` (no error) |
| `btc_cbf_status` | — | `CbfStatus` | compact filters mode (`cbf` feature); build without the feature: `FEATURE_DISABLED` |
| `btc_cbf_sync` | — | `CbfStatus` | starts (or joins) a background sync; progress through the `cbf-status` event; requires the vault to be unlocked (reads the xpubs) — a read with the vault locked does not start a sync; build without the feature: `FEATURE_DISABLED` |
| `set_capture_protection` | `{ enabled }` | `void` | `set_content_protected` on the calling (main) window; stays on while the phrase window is open, and the last value asked is restored when it closes |
| `open_fees_page` | — | `void` | opens `https://kyrowallet.com/frais` (fixed URL in Rust) in the system browser; no argument, no other URL possible |
| `update_status` | — | `{ version: string, updatedTo: string \| null, store: boolean }` | `store`: running as a Microsoft Store (MSIX) package, Kyro's own updater is off and the Settings toggle is replaced by "Updates are handled by the Microsoft Store"; current version; `updatedTo` = the version installed by an **automatic update**, returned **only once** after the startup that applied it (the interface shows "Kyro updated to {version}" (French: « Kyro a été mis à jour en version X »)). The rest (check, download, signature, installation) is done by Rust alone, without a command: see SECURITY.md "Automatic updates" (French: « Mises à jour automatiques ») |
| `alert_notify` | `{ note: { kind: 'priceAbove' \| 'priceBelow', symbol, price } \| { kind: 'received', symbol, amount: string \| null } \| { kind: 'test' } }` | — | Local alert (`alerts.rs`, `tauri-plugin-notification` called from Rust; no plugin permission for the webview). Rust writes the text from fixed EN/FR templates; `symbol` and the figures are checked (`INVALID_INPUT` on free text). At most 6 per minute, the rest dropped silently. No network. |
| `config_get` | — | `{ network, hasCoingeckoKey, hasZeroxKey, hasTrongridKey, systemLanguage }` | `systemLanguage`: `'fr' \| 'en'`, the computer's language (what `settings.language = 'auto'` uses); never the keys themselves; each `hasXKey` = environment variable **or** key saved in the settings (e.g. TronGrid: `KYRO_TRONGRID_API_KEY` or `apiKeys.trongrid`) |
| `network_get` / `network_set` | — / `{ network: 'mainnet' \| 'testnet' }` | `NetworkInfo` / `boolean` | network choice from within the application, applied by **restarting** the app: see §2.10 |
| `wallets_get` | — | `{ active, wallets: { id, name }[] }` | the wallets of this device (§2.9b); works locked: names are plain text and opening one still takes its password |
| `wallet_switch` | `{ id }` | `WalletsInfo` | ends the session, the next `vault_unlock` goes to `id`; refused while a native window is open |
| `wallet_new` | `{ name }` | `void` | unlocked session. Ends it and points `vault_create` / `vault_import` at a new vault file; `vault_status.creating` holds the name until the vault is written |
| `wallet_new_cancel` | — | `void` | back to the previous wallet (locked); nothing was written |
| `wallet_rename` | `{ id, name }` | `WalletsInfo` | unlocked session |
| `wallet_remove` | `{ id, password }` | `WalletsInfo` | added wallet only, while it is open, with its password. Back to the first wallet; the encrypted file stays as `.kyrovault.removed` |
| `watch_addresses_get` | — | `WatchAddress[]` | public addresses and xpubs followed without a key (§2.3b); `LOCKED` if a vault exists and is locked |
| `watch_address_add` | `{ family, value, label }` | `WatchAddress` | §2.3b. Rust refuses a private key (xprv, WIF), a phrase, a duplicate, Monero |
| `watch_address_rename` | `{ id, label }` | `WatchAddress` | |
| `watch_address_remove` | `{ id }` | `void` | nothing changes on the network |
| `kas_watch_account` / `kas_watch_txs` | `{ address }` | `KaspaAccountInfo` / `KaspaHistoryEntry[]` | Kaspa reads of a watch address (the other chains already read by address) |
| `hw_list` | — | `DeviceInfo[]` | detects connected Ledger (HID) and Trezor (WebUSB) devices; ids stable for the session (`ledger-1`, `trezor-1`…) as long as the device stays on the same port; 10 s max. See §2.3 |
| `hw_open` | `{ id }` | `DeviceStatus` | opens the device and reads its state: locked, Ledger app open, Trezor firmware, per-chain state. **The only command that can pair a Trezor Safe 7** (THP, §2.3): `hw-prompt` `thp-confirm-pairing` then `thp-pairing-code` → `hw_thp_pairing_code`; 180 s timeout |
| `hw_thp_pairing_code` | `{ id, code /*6 digits*/ }` | `void` | Trezor Safe 7, after `hw-prompt` `thp-pairing-code`: the code displayed **on the device's screen**, copied by the user. Anything other than 6 ASCII digits: `INVALID_INPUT` (the `hw_open` call keeps waiting); no pairing pending: `HW_BAD_RESPONSE`. Wrong code: `hw_open` fails with `HW_PAIRING_FAILED` |
| `hw_thp_pairings` | — | `{ key /*hex, device's static public key*/; model /*"T3W1"*/; added /*UNIX s*/ }[]` | THP devices paired with this installation (public data) |
| `hw_thp_forget` | `{ key? }` | `number` | unlocked session if a vault exists. Forgets a device's pairing (`key` from `hw_thp_pairings`), or **all** of them without `key` (also deletes Kyro's THP key: new key at the next pairing). Closes idle Trezor connections. On the device side, Kyro remains known until it is reset |
| `hw_cancel` | `{ id }` | `boolean` | abandons the operation in progress on `id` (`true` if there was one); it ends with `USER_REJECTED` |
| `hw_pin_matrix` | `{ id, positions /*"1"…"9"*/ }` | `void` | Trezor One only, after the `hw-prompt` `pin-matrix` event: **positions** in the blank 3×3 grid, never the PIN; layout of the Trezor numeric keypad: top row 7 8 9, middle 4 5 6, bottom 1 2 3 (top-left cell = "7"), transmitted as is |
| `hw_get_xpub` | `{ id, chain: 'btc' \| 'evm' \| 'sol', account }` | `HwXpub` | reads the public keys on the device, without displaying or saving anything |
| `hw_accounts_get` | — | `WatchOnlyAccount[]` | saved hardware wallet accounts (read-only, public keys); `LOCKED` if a vault exists and is locked (the xpubs give all your addresses); without a vault (hardware-wallet-only mode): always readable |
| `hw_account_add` | `{ id, chain, account, accountId?, label? }` | `WatchOnlyAccount` | reads the keys of `chain` on the device and saves them (new account, or addition to `accountId`: same brand, same number, same fingerprint otherwise `HW_WRONG_DEVICE`) |
| `hw_account_remove` | `{ accountId }` | `void` | |
| `hw_verify_address` | `{ id, accountId, chain, path }` | `{ address, path }` | **displays the address on the device's screen**; beforehand, re-reads the device's keys (`HW_WRONG_DEVICE` if it is not the right one); the displayed address must be identical to the one Kyro derives from the saved xpub, otherwise `HW_ADDRESS_MISMATCH` (blocking error: do not use the address) |
| `hw_sign_btc_psbt` | `{ id, accountId, psbt }` | `{ psbt, summary }` | Rust decoding → Kyro native dialog (+ 2nd dialog if unknown output) → confirmation on the device → verification of each signature. PSBT signed, **not finalized** |
| `hw_sign_evm_tx` | `{ id, accountId, tx: EvmTxRequest }` | `{ rawTx, hash }` | same; a pinned Earn call (Lido, Aave v3: `earn_evm::decode`) is named exactly as in `evm_sign_tx` (contract + function, beneficiary = the hardware account, else refused) before the device shows it; Ledger with blind signing off → `HW_UNSUPPORTED` with the hint; token named by a Ledger descriptor verified offline, otherwise by `known_tokens.rs`, never by the interface; 2nd dialog if contract call, unknown token or if the device cannot display the detail (blind signing); signs for the address `m/44'/60'/0'/0/{account}` |
| `hw_sign_sol_tx` | `{ id, accountId, message /*b64*/, recipient? }` | `{ signature /*b64*/, summary: SolTxSummary }` | same decoding as `sol_sign_tx`; signature verified (strict ed25519) against the saved address. SPL: `recipient` (typed wallet) and the holder of an ATA created in the message are kept only if the transfer destination IS their associated token account; then the native window names the wallet and a Trezor gets `SolanaTxTokenAccountInfo`. Ledger `6808` → "Enable Blind signing in the Solana app settings" |
| `hw_sign_utxo_psbt` | `{ id, accountId, chain: 'ltc' \| 'doge' \| 'bch' \| 'dash', psbt }` | `{ psbt, summary: UtxoTxSummary }` | `utxo_hw_plan` (same decoding as `…_sign_psbt`, with only the saved xpub) → keys re-read (`HW_WRONG_DEVICE`) → native dialog (+ hardened) → device → `utxo_hw_finalize` (each signature verified against the recomputed sighash and the key derived from the xpub). All inputs must belong to the account and carry `non_witness_utxo` (Litecoin too). Partial signatures; Bitcoin Cash: finalized inputs (FORKID) |
| `hw_xrp_build_tx` | `{ accountId, to, amount, destinationTag?, issued? }` | like `xrp_build_tx` | built with the address and key of the hardware wallet account (no vault needed) |
| `hw_sign_xrp_tx` | `{ id, accountId, blob }` | like `xrp_sign_tx` | same checks as `xrp_sign_tx` → native dialog → **Ledger** ("XRP" app) → DER signature verified (low-S) on the signing hash computed by Kyro, attached to Kyro's blob (`xrp_hw_assemble`) |
| `hw_xrp_broadcast` | `{ accountId, blob }` | `string` (hash) | like `xrp_broadcast` |
| `hw_tron_build_tx` | `{ accountId, to, amount, token? }` | `TronBuilt` | like `tron_build_tx`, address of the hardware wallet account |
| `hw_sign_tron_tx` | `{ id, accountId, raw }` | like `tron_sign_tx` | **Ledger only** ("Tron" app), TRX and TRC-20; the signature must yield the account's address again (`tron_recover_signer`). Tron app `6A8B` / `6A8D` → "Enable 'Allow data'" / "Enable 'Custom contracts'" in the Tron app settings |
| `hw_tron_broadcast` | `{ accountId, raw, signature }` | `string` (txid) | like `tron_broadcast` |
| `hw_stellar_build_tx` | `{ accountId, to, amount, memo? }` | like `stellar_build_tx` | address of the hardware wallet account |
| `hw_sign_stellar_tx` | `{ id, accountId, envelope }` | like `stellar_sign_tx` | Ledger ("Stellar" app, on the *signature base*) or Trezor (`StellarSignTx` + operation, the firmware rebuilds the XDR); ed25519 signature strictly verified on **Kyro's hash** for this network, attached to Kyro's envelope (`stellar_hw_assemble`) |
| `hw_stellar_build_asset_tx` / `hw_stellar_build_trust_tx` | `{ accountId, asset, to, amount, memo? }` / `{ accountId, asset, enable }` | like `stellar_build_asset_tx` / `stellar_build_trust_tx` | built for the hardware wallet account; signed with `hw_sign_stellar_tx` (Trezor: `StellarPaymentOp` with the asset, `StellarChangeTrustOp`) |
| `hw_stellar_broadcast` | `{ accountId, envelope }` | `string` (hash) | like `stellar_broadcast` |
| `hw_key_add` | `{ id, chain: 'sui' \| 'apt' \| 'algo' \| 'near' \| 'cosmos', account, accountId?, label? }` | `WatchOnlyAccount` | **Ledger only** (§2.3, "Single-key chains"): reads the public key of `chain` in the corresponding Ledger app and saves it (`keys[]` of the account; new account or addition to `accountId`: same brand, same number; another key already saved for this chain: `HW_WRONG_DEVICE`) |
| `hw_key_verify` | `{ id, accountId, chain }` | `{ address, path }` | re-reads the key (`HW_WRONG_DEVICE` if it is not the same), then **displays it on the device** (address; NEAR: `ed25519:…` key); displayed key ≠ saved key: `HW_ADDRESS_MISMATCH` |
| `hw_sui_build_tx` / `hw_sui_build_token_tx` / `hw_sign_sui_tx` / `hw_sui_broadcast` | like `sui_*` with `accountId` instead of `account`; signing: `{ id, accountId, bcs, coinType? }` (token: the coin objects go to the app as its third parameter, each checked against its digest) | like `sui_*` | construction and broadcast for the hardware wallet account's address; signing: same checks as `sui_sign_tx`, native dialog, "Sui" app (intent message `00 00 00 ‖ BCS`), serialized signature verified (`sui_verify_signed`) |
| `hw_aptos_build_tx` / `hw_aptos_build_token_tx` / `hw_sign_aptos_tx` / `hw_aptos_broadcast` | same (`{ id, accountId, raw }`) | like `aptos_*` | "Aptos" app: signing message `SHA3-256("APTOS::RawTransaction") ‖ BCS`; signed transaction verified (`aptos_verify_signed`) |
| `hw_algo_build_tx` / `hw_algo_build_optin_tx` / `hw_algo_build_asset_tx` / `hw_sign_algo_tx` / `hw_algo_broadcast` | same (`{ id, accountId, blob }`) | like `algo_*` | "Algorand" app: canonical msgpack (the app prefixes `TX`); verified (`algo_verify_signed`) |
| `hw_near_build_tx` / `hw_near_build_token_tx` / `hw_sign_near_tx` / `hw_near_broadcast` / `hw_near_tx_status` | same (`{ id, accountId, tx }`) | like `near_*` | "NEAR" app: Borsh of the transaction (the app signs its SHA-256); verified (`near_verify_signed`). Implicit account of the key `m/44'/397'/0'/0'/(account+1)'` |
| `hw_hbar_account` / `hw_hbar_build_tx` / `hw_sign_hbar_tx` / `hw_hbar_broadcast` | like `hbar_account` / `hbar_*` with `accountId` instead of `account`; signing: `{ id, accountId, bodies }` | like `hbar_*` (status: `hbar_tx_status`) | "Hedera" app ≥ 1.9.0: **ED25519** account `m/44'/3030'/0'/0'/account'` (different from the vault's, ECDSA), found on the mirror node by its key (`address` = DER key `302a…`); **one copy** (one node); the device receives `index (LE) ‖ TransactionBody` (≤ 251 bytes) and signs the body; ED25519 signature verified (`hbar_hw_signed`, then `hbar_verify_signed_ed25519` before broadcast) |
| `hw_ton_build_tx` / `hw_ton_build_jetton_tx` / `hw_sign_ton_tx` / `hw_ton_broadcast` | like `ton_*` with `accountId` instead of `account` (jetton: `{ accountId, master, to, amount }`, no comment: the device cannot show it); signing: `{ id, accountId, boc }` | like `ton_*` (status: `ton_tx_status`) | "TON" app ≥ 2.1.0, v4R2 wallet of the key `m/44'/607'/0'/0'/account'/0'` (different from the vault's), network wallet id; the device receives the structured request (tag 1) built by `ton_hw_request`, rebuilds and displays the order, signs its hash; Kyro requires **its own** hash, verifies the signature (`ton_hw_signed`, then `ton_verify_signed` before broadcast). Comment: printable ASCII ≤ 120 |
| `hw_cosmos_build_tx` / `hw_sign_cosmos_tx` / `hw_cosmos_broadcast` | same (`{ id, accountId, signDoc }`) | like `cosmos_*` | "Cosmos" app: SignDoc in **LEGACY_AMINO_JSON** mode (the app does not sign DIRECT); the device signs the canonical amino JSON (sorted keys, integers as strings); DER signature normalized to low-S and verified, TxRaw re-verified before broadcast |
| `hw_ada_build_tx` | `{ accountId, to, lovelace?, token?, memo? }` | like `ada_build_tx` | built for the hardware wallet account's address (base `…/0/0` + `…/2/0`, derived from the saved account key) |
| `hw_sign_ada_tx` | `{ id, accountId, tx }` | like `ada_sign_tx` | same live checks as `ada_sign_tx` (inputs ours and unspent, balance, fees, ttl) → `cardano_hw_plan` → keys re-read → native dialog (+ hardened) → Ledger ("Cardano ADA" app) or Trezor T / Safe (`CardanoSignTx*`) → `cardano_hw_assemble`: the body hash computed by the device must be Kyro's identifier, and the witness must verify (strict ed25519) with the `…/0/0` key derived from the saved account key |
| `hw_ada_broadcast` | `{ accountId, tx }` | `string` (tx id) | like `ada_broadcast` (only witness: our payment key) |
| `hw_zec_send_preview` | `{ accountId, request: ZecSendArgs }` | `ZecTxSummary` | like `zec_send_preview`, built with the hardware wallet account's xpub |
| `hw_sign_zec_tx` | `{ id, accountId, request: ZecSendArgs }` | `{ hex, txid, summary }` | **Trezor only**: same construction as `zec_sign` (`zec_hw_plan`, saved xpub) → keys re-read → native dialog (+ hardened) → Zcash v5 `SignTx` → `zec_hw_finalize` (each signature verified against the ZIP-244 digest computed by Kyro and the key derived from the xpub, low-S). Broadcast: `zec_broadcast` |

```ts
type Accounts = {                 // accounts_get({ account? }) : everything belongs to the account `account` (0 = the legacy one)
  network: 'mainnet' | 'testnet';
  account: number;
  // evm, sol, tron, xrp, cardano, stellar, sui, hbar, cosmos : { address, path } (hbar : EVM address of m/44'/3030'/0'/0/a) (path = key path, e.g. m/44'/60'/0'/0/1)
  btc: { segwit: { address: string; xpub: string; fingerprint: string; path: string };
         taproot: { address: string; xpub: string; fingerprint: string; path: string } };
  evm: { address: string };
  sol: { address: string };
  ltc: { address: string; xpub: string; fingerprint: string; path: string };   // m/84'/2'/0' (testnet m/84'/1'/0'), address = …/0/0
  doge: { address: string; xpub: string; fingerprint: string; path: string };  // m/44'/3'/0' (testnet m/44'/1'/0')
  bch: { address: string; xpub: string; fingerprint: string; path: string };   // m/44'/145'/0' (chipnet m/44'/1'/0'), CashAddr bitcoincash:q… / bchtest:q…
  dash: { address: string; xpub: string; fingerprint: string; path: string };  // m/44'/5'/0' (testnet m/44'/1'/0'), X… / y…
  tron: { address: string };                                                    // m/44'/195'/0'/0/0 (same path on Nile)
  xrp: { address: string };                                                     // m/44'/144'/0'/0/0
  stellar: { address: string };                                                 // m/44'/148'/0' (SEP-0005, same key on testnet), G…
  cardano: { address: string };   // base address m/1852'/1815'/0'/0/0 + staking …/2/0 (CIP-1852, Icarus); addr_test1… on preprod
  sui: { address: string };       // m/44'/784'/0'/0'/0' (SLIP-10 ed25519, same path on testnet), 0x + 64 hex (§2.11)
  algo: { address: string };      // m/44'/283'/0'/0/0 (derivation of Ledger's Algorand app, same path on testnet), 58 characters
  ton: { address: string };       // v4R2 of m/44'/607'/0', UQ… (testnet 0Q…, different wallet id so different address)
  cosmos: { address: string };    // m/44'/118'/0'/0/0, cosmos1… (same path on the testnet)
};
type ApiKeyName = 'coingecko' | 'zerox' | 'trongrid';   // every key that Settings knows about (1inch removed: an old key is ignored, then erased)
// coingecko : header x-cg-demo-api-key / x-cg-pro-api-key (api / pro-api.coingecko.com) ; zerox : 0x-api-key (api.0x.org) ;
// trongrid : TRON-PRO-API-KEY (api.trongrid.io, nile.trongrid.io, §2.5).
// (LI.FI and Jupiter: environment variables only, no key in Settings.)
type Settings = { currency: Currency /* FIAT_CURRENCIES (26 CoinGecko currencies), default at first launch = region of the system locale (fiat.rs), never the IP */; autoLockSecs: number; hideBalancesOnStart: boolean;   // what settings_get / settings_set RETURN
                  captureProtection: boolean; clipboardGuard: boolean;
                  servers: Servers;               // replaces the old `rpc` (still accepted as input, migrated, never returned)
                  apiKeysSet: { [K in ApiKeyName]: boolean };   // key saved or not; NEVER the value (no `apiKeys` field)
                  tor: { enabled: boolean };     // default: { enabled: true }
                  language: 'auto' | 'fr' | 'en';   // default: 'auto' (see below)
                  autoUpdate: boolean;     // default: true; false = no check, a pending update is removed
                  weeklyCount: boolean };  // default: true; false = the anonymous weekly count (weekly_count.rs, docs/NETWORK.md) is never sent
// `language`: language of the interface AND of the native windows (signature, warnings, phrase,
// servers, .cookie picker). `auto` = the computer's language (French if it is French,
// English otherwise), read by Rust (crate `sys-locale`) and returned by `config_get.systemLanguage`.
// Any other value in settings_set → INVALID_INPUT; in an existing settings.json, an unknown
// value is read as `auto` (the other settings are kept). Applied as soon as it is saved:
// the interface re-renders, the next native window uses the new language.
type SettingsInput = Omit<Settings, 'apiKeysSet'> & {   // what settings_set ACCEPTS (`apiKeysSet` sent back is ignored)
                  apiKeys?: { [K in ApiKeyName]?: string | null } };
// Merge rule for `apiKeys.<name>` in settings_set: absent (or null) = unchanged; "" = deleted;
// non-empty string = saved after trim (empty after trim or control character → INVALID_INPUT; unknown name → INVALID_INPUT).
// `config_get.hasXKey` = environment key (KYRO_…) OR saved key; environment keys are never returned either.
// ---- custom servers (B2b) ----
// Key absent = default server. A custom server is only allowed for its own family
// and uses that family's isolated Tor circuits; the default server of the same chain
// is then REFUSED (`DEFAULT_SERVER_DISABLED`): never a silent fallback.
type Servers = {
  bitcoin: { mainnet?: BtcServer; testnet4?: BtcServer };
  evm: { [chainId: string]: { url: string } };          // key = decimal chainId, e.g. "11155111"
  solana: { 'devnet'?: { url: string }; 'mainnet-beta'?: { url: string } };
  litecoin: { mainnet?: UtxoServer; testnet?: UtxoServer };   // testnet = Litecoin testnet4
  dogecoin: { mainnet?: UtxoServer; testnet?: UtxoServer };
  bitcoincash: { mainnet?: UtxoServer; testnet?: UtxoServer };   // testnet = chipnet
  dash: { mainnet?: UtxoServer; testnet?: UtxoServer };
  tron: { mainnet?: TronServer; testnet?: TronServer };       // testnet = Nile
  xrp: { mainnet?: XrpServer; testnet?: XrpServer };          // testnet = XRPL Testnet
  cardano: { mainnet?: CardanoServer; testnet?: CardanoServer };  // testnet = preprod
};
type UtxoServer = { kind: 'default' }       // Litecoin: litecoinspace.org ; Dogecoin / Dash mainnet: Komodo's ElectrumX ; Bitcoin Cash mainnet and chipnet: public Fulcrum servers ; Dogecoin / Dash testnet: NONE (reads → SERVER_INVALID, see §2.4)
                | { kind: 'esplora'; url: string };   // same type as the default server (Esplora: electrs, mempool)
type BtcServer =
  | { kind: 'default' }                                   // mempool.space (its .onion in Tor mode)
  | { kind: 'esplora'; url: string }                      // e.g. "https://mon-noeud.example/api"
  | { kind: 'electrum'; host: string; port: number;
      tls: 'webpki' | 'pinned' | 'none'; certSha256?: string /*64 hex, required if 'pinned'*/ }
  | { kind: 'core'; url: string;                          // e.g. "http://127.0.0.1:48332"
      auth: { kind: 'cookie'; cookiePath: string /*absolute path of ".cookie", chosen by btc_core_pick_cookie; local/LAN node only*/ }
          | { kind: 'userpass'; user: string; password?: string; hasPassword?: boolean } }
  | { kind: 'cbf';                                        // BIP157/158 compact filters (feature `cbf`)
      peers?: string[] /*"onion:port" or "ip:port", never a hostname*/; birthHeight?: number };
// `kind: 'cbf'` in a build without the `cbf` feature: refused by `settings_set` / `server_test` with
// `FEATURE_DISABLED` (display "available after review (≥ 2026-11-11)").
type CbfStatus = { state: 'idle' | 'connecting' | 'headers' | 'filters' | 'synced' | 'error';
                   tipHeight: number | null; scannedHeight: number | null; birthHeight: number; progress: number /*0..1*/;
                   peers: string[]; tor: boolean; lastSyncUnix: number | null; watchedScripts: number;
                   matchedBlocks: number; message?: string };
// No separate "blocks" phase: matching blocks are downloaded during `filters` (counter `matchedBlocks`).
// Core password: `settings_get` NEVER returns it (`hasPassword: true` instead).
// In `settings_set`: `password` absent = keep the saved one (same URL and same user),
// `password: ""` = erase it, a value = replace it.
type ServerTestTarget =
  | { family: 'bitcoin'; network: 'mainnet' | 'testnet4'; server: BtcServer }
  | { family: 'evm'; chainId: number; server: { url: string } }
  | { family: 'solana'; cluster: 'devnet' | 'mainnet-beta'; server: { url: string } }
  | { family: 'litecoin' | 'dogecoin' | 'bitcoincash' | 'dash'; network: 'mainnet' | 'testnet'; server: UtxoServer }   // { kind: 'default' } Dogecoin / Dash testnet: SERVER_INVALID
  | { family: 'tron'; network: 'mainnet' | 'testnet'; server: TronServer }
  | { family: 'xrp'; network: 'mainnet' | 'testnet'; server: XrpServer }       // detected.chainId = XRPL network_id (0 mainnet, 1 testnet)
  | { family: 'cardano'; network: 'mainnet' | 'testnet'; server: CardanoServer };   // detected.chainId = networkmagic (764824073 / 1)
type CardanoServer = { kind: 'default' }    // Koios: preprod.koios.rest / api.koios.rest (free public tier, no key)
                   | { kind: 'koios'; url: string };   // Koios instance, base URL of the API, e.g. "https://koios.example/api/v1"
type XrpServer = { kind: 'default' }        // s.altnet.rippletest.net:51234 (testnet) / xrplcluster.com (mainnet)
               | { kind: 'jsonRpc'; url: string };   // rippled JSON-RPC, same type as the default servers
type TronServer = { kind: 'default' }       // TronGrid: api.trongrid.io / nile.trongrid.io
                | { kind: 'http'; url: string };   // java-tron HTTP API (FullNode), same type as TronGrid; history additionally requires TronGrid's /v1 API
type ServerTestResult = { latencyMs: number; detected: { network?: string; genesisHash?: string;
                          chainId?: number; serverVersion?: string; blockHeight?: number } };
type CoreStatus = { wallet: string; state: 'not-configured' | 'idle' | 'importing' | 'ready' | 'error'; walletLoaded: boolean;
                    scanProgress?: number /*0..1*/; scanDurationSecs?: number; error?: string };
type TorStatus = { state: 'off' | 'bootstrapping' | 'ready' | 'error'; progress: number /*0..100*/; message?: string };
```

Events:
- `vault-locked` (no payload) emitted by Rust on auto-lock;
- `cbf-status` (`CbfStatus`) during a compact-filter synchronization (at most 2 per second);
- `tor-status` (`TorStatus`) emitted on every state or progress change of the Tor startup. A stuck startup switches to `error` after 120 s (never an endless `bootstrapping`).
- `hw-prompt` (`{ id, kind: 'confirm-on-device' | 'pin-on-device' | 'passphrase-on-device' | 'pin-matrix' | 'thp-confirm-pairing' | 'thp-pairing-code' | 'thp-confirm-connection' }`) during a hardware wallet operation: what the UI must tell the user (see §2.3; the three `thp-*`: Trezor Safe 7).

Errors: the promise is rejected with `{ code: 'WRONG_PASSWORD' | 'LOCKED' | 'RATE_LIMITED' | 'USER_REJECTED' | 'HOST_NOT_ALLOWED' | 'INVALID_INPUT' | 'INTERNAL' | 'TOR_UNAVAILABLE' | 'SERVER_INVALID' | 'SERVER_WRONG_NETWORK' | 'SERVER_UNREACHABLE' | 'DEFAULT_SERVER_DISABLED' | 'FEATURE_DISABLED' | 'HW_NOT_FOUND' | 'HW_LOCKED' | 'HW_WRONG_APP' | 'HW_APP_MISSING' | 'HW_REJECTED' | 'HW_DISCONNECTED' | 'HW_UNSUPPORTED' | 'HW_PAIRING_REQUIRED' | 'HW_PAIRING_FAILED' | 'HW_BUSY' | 'HW_TIMEOUT' | 'HW_BAD_RESPONSE' | 'HW_ADDRESS_MISMATCH' | 'HW_WRONG_DEVICE', message, data? }`. `data` exists only for `HW_WRONG_APP` (`{ expected, open }`), `HW_APP_MISSING` (`{ app }`), `HW_UNSUPPORTED` (`{ min: string | null }`) and `HW_ADDRESS_MISMATCH` (`{ device, expected }`); the hardware wallet codes are detailed in §2.3. `TOR_UNAVAILABLE`: Tor is enabled but not ready (startup too slow, failure, stopped) — the request was **not** sent. `message`: user-facing text in the language of `settings.language` (the same as the native windows); the beginning of the message ("Tor indisponible :" / "Tor unavailable:"…) is always translated, a free-form detail with no English version stays in French. `INVALID_INPUT` has no prefix: its message is the detail alone, as a sentence (capital first letter, final period: "The password must be at least 10 characters long."). The UI decides on `code`; when an error is left with only its message, it recognizes the prefixes in both languages (`isTorUnavailable`, `isCustomServerDown`).

- `SERVER_INVALID`: configuration refused before any network access (URL, scheme, credentials in the URL, `.onion` without Tor, malformed fingerprint, missing password, `.cookie` file refused — name other than `.cookie`, non-local node, symbolic link, invalid content, path not chosen by the picker; the message never contains the path or the system error —, RPC authentication refused, `kyro-watch-…` wallet missing).
- `USER_REJECTED` (settings): native "New server" window (French "Nouveau serveur") or "Disable Tor?" window (French "Désactiver Tor ?") refused; nothing was sent.
- `SERVER_WRONG_NETWORK`: the server responds but is not on the right chain (Bitcoin genesis, `getblockchaininfo.chain`, `eth_chainId`, `getGenesisHash`, XRPL `network_id`, TRON block 0, Cardano `networkmagic`).
- `SERVER_UNREACHABLE`: a server does not respond (connection, TLS, mismatched pinning, timeout, invalid response). Rust uses this code for a custom server **and** for a default server. The UI shows "your server is not responding" only when the chain has a custom server in `settings.servers` (`hasCustomServer`); for a default server it shows a neutral "Can't reach the network right now, retrying…" and retries on its own (5 s, 10 s, 20 s, then the regular 30 s poll). With a custom server, **Kyro never falls back to the default server.**
- `FEATURE_DISABLED`: feature absent from this build (today: `cbf` compact filters, disabled by default until review).
- `DEFAULT_SERVER_DISABLED`: request to the default server of a chain for which a custom server is configured (a sign that the UI is not using the right server yet).

### 2.1 Server checks (on save and in `server_test`)

| Type | URL rules | Live check |
|---|---|---|
| Esplora | `https://`; `http://` only for a `.onion`, via Tor; never credentials in the URL | `GET {url}/block-height/0` = genesis of the network (mainnet `000000000019d6…e26f`, testnet4 `00000000da84f2…f043`) |
| Electrum | `host` + `port`; `tls: 'none'` only for a `.onion` via Tor; `pinned` requires `certSha256` | `server.version` (protocol 1.4) then `server.features.genesis_hash` = genesis of the network |
| Bitcoin Core | `http://` only for a local/LAN address (127.0.0.0/8, ::1, RFC 1918, fc00::/7, fe80::/10, `localhost`); otherwise `https://` or `.onion` via Tor; **`.cookie` authentication only toward a local/LAN address** (never a remote node nor a `.onion`: use `userpass`) | `getblockchaininfo.chain` = `main` or `testnet4` |
| XRP (`jsonRpc`) | same as Esplora | `server_info` → `info.network_id` = 0 (mainnet) or 1 (testnet); devnet (2) and other networks are named in the error. `server_test` returns this `network_id` in `detected.chainId` (and `detected.blockHeight` = last validated ledger) |
| Cardano (`koios`) | same as Esplora | `GET {url}/genesis` → `networkmagic` = 764824073 (mainnet) or 1 (preprod); preview (2) and others are named in the error. `server_test` returns this `networkmagic` in `detected.chainId`. `detected.chainId` = `networkmagic`, `detected.blockHeight` = `GET {url}/tip` |
| TRON (`http`) | same as Esplora | `POST {url}/wallet/getblockbynum {num:0}` → `blockID` = mainnet `00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc` or Nile `0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc`; Shasta (`…de1aa882…a9059e`) is recognized and named in the error |
| Esplora Litecoin / Dogecoin | same as Esplora | `GET {url}/block-height/0` = genesis of the chain (Litecoin mainnet `12a765e3…04bfe2`, testnet4 `4966625a…3e29a0`; Dogecoin mainnet `1a91e3da…355691`, testnet `bb0a7826…50559e`); the message names the chain found if it is a known one |
| EVM | same as Esplora | `eth_chainId` = the key (`chainId`) |
| Solana | same as Esplora; key `devnet` or `mainnet-beta` | `getGenesisHash` = devnet `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`, mainnet-beta `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` |

Before any check, each new host is confirmed in a native window (see `settings_set`). If Tor is enabled, the checks go through Tor (a local Core node, however, is reached directly). Changing `tor.enabled` and a server in the same `settings_set`: the check uses the new mode, but Tor only starts after saving — make the two changes separately.

### 2.2 Bitcoin: what the TypeScript side must change

All Bitcoin reads and broadcasting now go through Rust commands that return **exactly the Esplora shapes** already consumed by `packages/chains/src/bitcoin/adapter.ts`, whatever the server (default, Esplora, Electrum, Core). The choice of server and the absence of fallback are therefore guaranteed by Rust. In `BitcoinAdapter`, replace:

| Today (`net_fetch`) | Now (`call`) | Returned shape |
|---|---|---|
| `fetchJson(`${base}/address/${a}`)` | `call('btc_address_info', { address: a })` | `{ address, chain_stats: { funded_txo_sum, spent_txo_sum, tx_count }, mempool_stats: { … } }` |
| `fetchJson(`${base}/address/${a}/utxo`)` | `call('btc_address_utxos', { address: a })` | `[{ txid, vout, value, status: { confirmed, block_height? } }]` |
| `fetchJson(`${base}/address/${a}/txs`)` | `call('btc_address_txs', { address: a })` | `[{ txid, fee?, status: { confirmed, block_height?, block_time? }, vin: [{ txid, vout, prevout: { scriptpubkey, scriptpubkey_address?, value } \| null }], vout: [{ scriptpubkey, scriptpubkey_address?, value }] }]` |
| `fetchJson(`${base}/v1/fees/recommended`)` | `call('btc_fee_rates')` | `{ fastestFee, halfHourFee, hourFee, economyFee, minimumFee }` (sat/vB) |
| `fetchText(`${base}/blocks/tip/height`)` | `call('btc_tip_height')` | `number` |
| `fetchText(`${base}/tx`, POST hex)` | `call('btc_broadcast', { hex })` | `string` (txid) |

Differences to be aware of:
- With Electrum and Core, `funded_txo_sum` / `spent_txo_sum` carry the **net balance** (funded = balance, spent = 0, or the negative part of an unconfirmed balance); `tx_count` is exact. The existing computation (`funded − spent`, `tx_count > 0` = used address) remains correct.
- `btc_address_txs` returns, **for all servers**, at most the 50 most recent transactions, unconfirmed first, then confirmed from newest to oldest (no `truncated` field: 50 entries = there may be more). With Esplora (default or custom), Rust follows the `/txs` pagination then `/txs/chain/{last_txid}` up to 50. `prevout` is `null` when the input comes from a transaction the server does not provide (Core: transaction outside the wallet); `fee` is then absent.
- With Core, the `kyro-watch-…` wallet must exist: otherwise `SERVER_INVALID` ("run the setup") → the UI offers `btc_core_setup`, then follows `btc_core_status`.
- `esploraUrl` (registry) and `settings.rpc.esplora` are no longer used: remove the `esploraUrl` option from the adapter. Address scanning and PSBT construction do not change.
- Compact filters (`cbf`): the same commands answer from local state (never a network request during the call) and restart a background synchronization if the last one is more than 2 min old. Before the first synchronization: `SERVER_UNREACHABLE` ("not synced yet"). **Unconfirmed** incoming payments are not visible (no mempool); only our own broadcasts appear as pending. `btc_fee_rates` adds `source: 'block-average'` (average of the fees paid in the latest blocks, see NETWORK.md).
- EVM and Solana stay on `net_fetch`: the UI uses `servers.evm[chainId].url` or `servers.solana[cluster].url` if they exist, otherwise the registry's default URL.

### 2.3 Hardware wallets (Ledger, Trezor)

USB transport in Rust: Ledger over HID (hidapi), Trezor over WebUSB (libusb via rusb, compiled and statically linked); Trezor Safe 7 on top of the same WebUSB with the encrypted **THP** protocol (see "Trezor Safe 7" below). Nothing goes through the UI or the network. Each device has **one lock** (a 2nd simultaneous operation: `HW_BUSY`); each call runs off the UI thread with a **timeout** (key reading 90 s, Trezor PIN included; address display and signing 180 s; `hw_list` 10 s). The transports read in 100 ms slices: an exceeded timeout, `hw_cancel` or unplugging end the call cleanly (Trezor receives `Cancel`), the connection is closed then reopened on the next call, and nothing is returned.

With a vault on this computer, all `hw_*` commands that read keys, save or sign require an unlocked session (`LOCKED`); a "hardware wallet only" user has no vault and no Kyro password (confirmation is done on the device). Hardware wallet signatures do **not** ask for the vault password.

```ts
type DeviceInfo = { id: string; kind: 'ledger' | 'trezor'; model: string; transport: 'hid' | 'webusb' };
type Chain = 'btc' | 'evm' | 'sol' | 'ltc' | 'doge' | 'bch' | 'dash' | 'xrp' | 'tron' | 'stellar'
  | 'sui' | 'apt' | 'algo' | 'near' | 'cosmos' | 'ton' | 'hbar'  // Ledger only, hw_key_* commands (see below)
  | 'cardano' | 'zec'                                // zec: Trezor only; cardano: not on the Trezor One
  | 'dot' | 'kas';                                   // no hardware wallet (reason in `reason`)
type DeviceStatus = { id: string; kind: 'ledger' | 'trezor'; model: string; locked: boolean;
  app?: { name: string; version: string };        // Ledger: open app ("Tableau de bord" = dashboard)
  firmware?: string; passphrase?: boolean;        // Trezor
  protocol?: 'thp';                               // Trezor Safe 7: encrypted and paired THP channel
  chains: { chain: Chain; state: 'ready' | 'open-app' | 'unlock' | 'unsupported';
            app?: string /*Ledger app to open*/; min?: string /*minimum version*/; reason?: string }[] };
type HwXpub = { chain: Chain; account: number;
  btc?: { kind: 'segwit' | 'taproot'; xpub: string; fingerprint: string; path: string }[];   // BIP84 + BIP86
  evm?: { xpub: string /*node m/44'/60'/0'/0*/; path: string; address: string /*…/0/{account}*/ };
  sol?: { address: string; path: string /*m/44'/501'/{account}'/0'*/ };
  utxo?: UtxoKey;   // ltc, doge, bch, dash
  key?: ChainKey;   // xrp, tron, stellar ; cardano: pubkey = account key ‖ chain code (64 B)
  zec?: ZecKey };   // Trezor
type ZecKey = { xpub: string; fingerprint: string; path: string /*m/44'/133'/a' ; testnet m/44'/1'/a'*/ };
type UtxoKey = { coin: 'litecoin' | 'dogecoin' | 'bitcoincash' | 'dash'; xpub: string /*standard xpub/tpub*/;
  fingerprint: string; path: string /*m/84'/2'/a', m/44'/3'/a', m/44'/145'/a', m/44'/5'/a' ; testnet …/1'/a'*/ };
type ChainKey = { address: string; pubkey: string /*hex: XRP 33 B, TRON 65 B, Stellar 32 B*/;
  path: string /*m/44'/144'/a'/0/0, m/44'/195'/a'/0/0, m/44'/148'/a'*/ };
type WatchOnlyAccount = { id: string; label: string; device: 'ledger' | 'trezor'; model: string;
  network: 'mainnet' | 'testnet'; account: number; btc?: HwXpub['btc']; evm?: { xpub: string; path: string };
  sol?: { address: string; path: string };
  utxo?: UtxoKey[];   // one per chain, same master fingerprint as btc
  xrp?: ChainKey; tron?: ChainKey; stellar?: ChainKey;   // address = that of the key, standard path (verified on load)
  keys?: { chain: 'sui' | 'apt' | 'algo' | 'near' | 'cosmos' | 'ton' | 'hbar'; pubkey: string /*hex*/; address: string; path: string }[];
  cardano?: ChainKey;   // m/1852'/1815'/a' ; base address …/0/0 + …/2/0, recomputed on load
  zec?: ZecKey };       // same master fingerprint as btc / utxo
```

**Signing flow**: (1) Rust decodes (`btc_hw_plan` / `evm_decode` / `sol_decode_message`); (2) Rust re-reads the device's keys and compares them with the saved account (`HW_WRONG_DEVICE`); (3) Kyro native dialog with the decoded summary + "check the same information on the device", then a 2nd reinforced dialog if something is "unknown" (undecoded BTC output, EVM contract call, unknown Solana instruction) or if the device will not be able to display the detail (blind signing); (4) final confirmation on the device's screen (`hw-prompt: confirm-on-device`); (5) Rust verifies each signature (sighash recomputed, key derived from the saved xpub; EVM: recovered address = expected address, low-S; Solana: strict ed25519) before replying. A device response that does not pass: `HW_BAD_RESPONSE`, nothing is returned.

**PSBT for hardware wallet**: each input must have `witness_utxo` and the derivation (`bip32_derivation` or `tap_key_origins`, fingerprint and account path); each SegWit v0 input must also have **`non_witness_utxo`** (full previous transaction: required by Trezor, "unverified inputs" warning on Ledger otherwise) — otherwise `INVALID_INPUT` before any exchange with the device. Change outputs must carry their derivation to be recognized (otherwise the device displays them as recipients). Foreign inputs: `HW_UNSUPPORTED`. Ledger: a single kind of input (SegWit **or** Taproot) per transaction.

**Applications and minimum versions**

| | Ledger (app to open, min. version) | Trezor (min. firmware) |
|---|---|---|
| Bitcoin (BIP84, BIP86, PSBT) | "Bitcoin Test" (testnet) / "Bitcoin" (mainnet) ≥ 2.1.0 | One ≥ 1.10.4; T, Safe 3, Safe 5, Safe 7 ≥ 2.4.3 (Safe 7: any published firmware, ≥ 2.9.3) |
| EVM (EIP-1559) | "Ethereum" ≥ 1.9.0 (all EVM chains) | One ≥ 1.10.4; T/Safe ≥ 2.4.2 |
| ERC-20 in clear | Ledger-signed descriptor required: embedded for USDC and USDT (mainnet) and tUSDC (Sepolia); otherwise blind signing (app setting) + reinforced dialog | transfer: recipient, raw amount and contract displayed ("Unknown token" outside the list); `approve` and other calls: reinforced dialog |
| Solana | "Solana" ≥ 1.3.1 (blind signing required for the instructions it does not decode: `HW_UNSUPPORTED`) | T/Safe ≥ 2.6.4; not on the One |
| Litecoin, Dogecoin, Bitcoin Cash, Dash | "Litecoin", "Dogecoin", "Bitcoin Cash", "Dash" ≥ 1.4.0 (legacy Bitcoin protocol, trusted inputs); **mainnet only** (no Ledger test app) | One ≥ 1.10.4; T/Safe ≥ 2.4.3 (`Capability_Bitcoin_like`); no Dogecoin testnet |
| XRP | "XRP" ≥ 2.0.0 (secp256k1) | **no**: the firmware does not give the public key before signing |
| TRON | "Tron" ≥ 0.5.0 (TRC-20: app settings depending on the token) | **no** (absent from the Trezor firmware) |
| Stellar | "Stellar" ≥ 5.0.0 (`6C66`: "Hash signing" disabled → `HW_UNSUPPORTED`) | One ≥ 1.10.4; T/Safe ≥ 2.4.3 |
| Cardano (ADA + native tokens, CIP-20 memo) | "Cardano ADA" ≥ 7.0.0 (Conway tag 258 sets); protocol v7 (one APDU per element) or v8 (streamed body) depending on the app version | T/Safe ≥ 2.7.2 (ICARUS derivation); not on the One |
| Zcash transparent (v5, ZIP 244) | **no** (see below) | One ≥ 1.11.1; T/Safe ≥ 2.5.1 |
| Sui | "Sui" ≥ 1.0.0, `m/44'/784'/a'/0'/0'` (= vault) | no Trezor app |
| Aptos | "Aptos" ≥ 0.6.0, `m/44'/637'/a'/0'/0'` (= vault) | no Trezor app |
| Algorand | "Algorand" ≥ 2.0.0 (Zondax), `m/44'/283'/a'/0/0` (= vault) | no Trezor app |
| NEAR | "NEAR" ≥ 2.0.0, **`m/44'/397'/0'/0'/(a+1)'`** (Ledger Live's path: the app only accepts 5 levels; the vault uses `m/44'/397'/a'` → different implicit account) | no Trezor app |
| Cosmos Hub | "Cosmos" ≥ 2.34.0, `m/44'/118'/a'/0/0` (= vault), amino JSON | no Trezor app |
| TON | "TON" ≥ 2.1.0, **`m/44'/607'/0'/0'/a'/0'`** (Ledger Live's path; the vault uses `m/44'/607'/a'` → different wallet), v4R2, network wallet id | no Trezor app |
| Hedera | "Hedera" ≥ 1.9.0, **ED25519 account `m/44'/3030'/0'/0'/a'`** (the vault is ECDSA → different account, to be created outside Kyro), found by its key | no Trezor app |
| Polkadot, Kaspa | not offered (reasons below) | no Trezor app |
| Not supported | — | bootloader mode, One < 1.7 (HID); Safe 7: pairing other than by code (QR, NFC: not offered by the production firmware) |

PIN and passphrase: a Ledger is unlocked on the device (`HW_LOCKED` → the UI asks the user to unlock it, then retry). Trezor T/Safe: PIN and passphrase are entered **on the device** (`hw-prompt`). Trezor One: PIN through the blind grid (`pin-matrix` → `hw_pin_matrix`); a passphrase that would have to be typed on the computer → refused (`HW_UNSUPPORTED`): no secret passes through the UI.

**Trezor Safe 7 (THP, Trezor Host Protocol)** — `hw/thp.rs`, `hw/thp_store.rs`. Same USB identifier as the T/Safe (`1209:53c1`, WebUSB interface 0, 64-byte packets): `hw_list` lists it as `model: "Trezor"`, and `hw_open` recognizes it by its `Failure(InvalidProtocol)` response to the first v1 message (trezorlib's method), then switches to THP. The actual model ("Trezor Safe 7") is in `DeviceStatus.model`, with `protocol: 'thp'`. Once connected, **all existing commands** work as they do for a Safe 5 (same protobuf messages, same Rust checks): `hw_get_xpub`, `hw_account_add`, `hw_verify_address`, `hw_sign_btc_psbt` / `evm_tx` / `sol_tx`. What Rust does:
1. **Channel**: allocation on the broadcast channel, `Noise_XX_25519_AESGCM_SHA256` handshake (`snow` crate), then everything is encrypted (AES-256-GCM). Locked device: `hw-prompt` `pin-on-device`, the PIN is typed on the device during the handshake.
2. **Already-paired device** (THP credential stored): no code; the device usually asks you to **confirm the connection** of "Kyro Wallet" on its screen (`hw-prompt` `thp-confirm-connection`). Kyro never requests the "autoconnect" option (connection without confirmation).
3. **Unknown device**: only in `hw_open` (any other command answers `HW_PAIRING_REQUIRED`). (a) the device asks to allow "Kyro Wallet" to pair → `hw-prompt` `thp-confirm-pairing`. Kyro identifies itself with the fixed label "Kyro Wallet" (`host_name` and `app_name` fields of `ThpPairingRequest`), **never the computer's name**; no installation identifier is needed (the THP credential is bound to Kyro's key, not to the label); (b) it displays a **6-digit code** → `hw-prompt` `thp-pairing-code`: the UI shows an input field and calls `hw_thp_pairing_code { id, code }`; (c) Rust verifies via CPace that the device knows the same code, then that its secret matches the commitment sent **before** Kyro's challenge; (d) the device issues a credential, stored in `trezor-thp.json` (see SECURITY.md); (e) optional connection confirmation (`thp-confirm-connection`). Wrong code, or a device that does not prove the code: `HW_PAIRING_FAILED` (nothing is stored; rerun `hw_open`: the device displays a new code). Refusal on the device: `HW_REJECTED`. Nobody types the code: `HW_TIMEOUT` after 180 s, and the device receives `Cancel` to leave the code screen. `hw_cancel`: `USER_REJECTED`, same behavior.
4. Credential rejected by the device (reset, hosts forgotten): Kyro erases it and the device must be re-paired (`HW_PAIRING_REQUIRED` outside `hw_open`).
5. **Sessions**: `GetFeatures` on session 0 (no seed), then `ThpCreateNewSession` (session 1): passphrase **on the device** if it is enabled, otherwise an empty passphrase. Session forgotten by the device (`ThpUnallocatedSession`) or channel lost (`UNALLOCATED_CHANNEL`, `DECRYPTION_FAILED`): `HW_DISCONNECTED`, reconnection on the next call (with the credential: no new code).
6. **Authenticity**: THP authenticates the device **to Kyro** through pairing (the code seen on the physical screen), not through a manufacturer certificate. Trezor's "authentic device" check (`AuthenticateDevice`: X.509 Optiga P-256, Tropic Ed25519, MCU ML-DSA-44 chains up to the Trezor root keys) is a separate message, also available on Safe 3/5, **not implemented** by Kyro (see SECURITY.md); do it in Trezor Suite.

*What the UI must add (nothing is done on the UI side)*:
- Handle the three new `hw-prompt`s in the hardware wallet operation screen: `thp-confirm-pairing` ("Allow Kyro Wallet on your Trezor"; French: « Sur ton Trezor, autorise Kyro Wallet à s'appairer »), `thp-pairing-code` (input screen: 6 numeric boxes, numeric keypad, "Confirm" button (French: « Valider ») → `hw_thp_pairing_code`; "Cancel" button (French: « Annuler ») → `hw_cancel`), `thp-confirm-connection` ("Confirm the connection on your Trezor"; French: « Confirme la connexion sur ton Trezor »).
- On `INVALID_INPUT` from `hw_thp_pairing_code`: leave the input open. On `HW_PAIRING_FAILED`: explain "wrong code" and offer to start over (`hw_open`, new code).
- On `HW_PAIRING_REQUIRED` (any command): send the user to "Connect" (French: « Connecter ») (`hw_open`).
- A small "Paired Trezor devices" list (French: « Appareils Trezor appairés ») (`hw_thp_pairings`) with "Forget" (`hw_thp_forget { key }`) and "Forget all" (`hw_thp_forget {}`), specifying that the device itself keeps Kyro in its list until it is reset.
- Display `DeviceStatus.protocol === 'thp'` ("encrypted, paired channel") if useful; no other change to the BTC / EVM / Solana screens.

**Errors**

| Code | When | `data` |
|---|---|---|
| `HW_NOT_FOUND` | unknown id (rerun `hw_list`) or device not found on open | |
| `HW_LOCKED` | device locked (Ledger `5515`, or `6982` outside signing); incorrect Trezor PIN | |
| `HW_WRONG_APP` | Ledger: wrong app still open after Kyro tried to switch (Kyro quits the open app with `B0 A7` and opens the right one from the dashboard with `E0 D8`, `hw-prompt` `open-app` with `app`; or `6E00`, `6E01`, `6D00`, `6D02`, `6511` mid-flow) | `{ expected, open }` |
| `HW_APP_MISSING` | Ledger: the app is not installed (`6807` on open) | `{ app }` |
| `HW_REJECTED` | refusal on the device (Ledger `6985`, `5501` — also when opening an app —, `6982` during signing; Trezor `ActionCancelled` / `PinCancelled`) | |
| `HW_DISCONNECTED` | USB error / unplugging, including during a signature: operation aborted, connection closed | |
| `HW_UNSUPPORTED` | chain not offered on this device (Zcash on Ledger; Cardano on the Trezor One; XRP / TRON on Trezor; LTC / DOGE / BCH / DASH on Ledger in testnet), firmware/app too old, "Hash signing" disabled (Stellar app `6C66`), blind signing disabled (Ledger `6A80` in EVM signing, `6808` Solana), Trezor One passphrase, Ledger mixed inputs; Safe 7: THP version ≠ 2.x, pairing by code not offered | `{ min }` |
| `HW_BUSY` | another operation in progress on this device; USB interface taken by another application (Trezor Suite, Ledger Live); Linux without udev rules | |
| `HW_TIMEOUT` | no response within the time limit: operation aborted | |
| `HW_BAD_RESPONSE` | malformed response, or signature/address/key that fails Kyro's verification | |
| `HW_ADDRESS_MISMATCH` | the address shown by the device ≠ the one Kyro derived from the stored xpub: **do not use the address** | `{ device, expected }` |
| `HW_WRONG_DEVICE` | the device's keys are not the account's keys (different device, different passphrase, modified stored account) | |
| `HW_PAIRING_REQUIRED` | Trezor Safe 7 not (or no longer) paired with Kyro, and the command is not `hw_open`: pair first through `hw_open` | |
| `HW_PAIRING_FAILED` | THP pairing failed: wrong code (rejected by the device), or the device did not prove the code (inconsistent commitment/secret); nothing is stored | |
| `INTERNAL` | (hardware wallet) `trezor-thp.json` file unreadable or not writable, system randomness unavailable; `hw_thp_forget {}` resets the file | |
| `USER_REJECTED` | refusal in Kyro's native dialog, or `hw_cancel` | |

**Litecoin, Dogecoin, Bitcoin Cash, Dash, XRP, TRON, Stellar** (`hw/chains.rs`, `hw/ledger_utxo.rs`, `hw/ledger_coins.rs`, `hw/trezor_coins.rs`, `commands_hw_coins.rs`). `hw_get_xpub` / `hw_account_add` / `hw_verify_address` accept these chains; signing goes through the `hw_sign_utxo_psbt`, `hw_sign_xrp_tx`, `hw_sign_tron_tx`, `hw_sign_stellar_tx` commands above, and building / broadcasting through `hw_*_build_tx` / `hw_*_broadcast` (a "hardware wallet only" user has no vault). Same steps as for Bitcoin: Rust decoding, device keys re-read and compared with the account, native dialog (+ reinforced), device screen, signature verification in wallet-core.
- **Ledger, LTC / DOGE / BCH / DASH**: apps built on `lib-app-bitcoin` = **old Bitcoin protocol** (`doc/btc.asc` from ledger-app-btc, `@ledgerhq/hw-app-btc`): `GET WALLET PUBLIC KEY` (`E0 40`, address format P2 `00` legacy, `02` bech32, `03` CashAddr; the xpub is rebuilt from the master key — fingerprint —, the parent, and the account node), `GET TRUSTED INPUT` (`E0 42`, each previous transaction sent element by element, scripts in 50-byte blocks; the app returns a 56-byte *trusted input* that proves the amount), `UNTRUSTED HASH TRANSACTION INPUT START` (`E0 44`, P2 `02` Litecoin, `03` Bitcoin Cash, `00` Dogecoin / Dash, `80` to continue), `FINALIZE FULL` (`E0 4A`, change path first with P1 `FF`, then the outputs that the user verifies on the screen), `UNTRUSTED HASH SIGN` (`E0 48`, `SIGHASH_ALL`, Bitcoin Cash `ALL|FORKID`). BIP143 flow (Litecoin, Bitcoin Cash): all inputs once, outputs once, then one pseudo-transaction per input; legacy flow (Dogecoin, Dash): the whole transaction for each input, script on the signed input only. Mainnet only.
- **Trezor, LTC / DOGE / BCH / DASH**: `GetPublicKey` (xpub rebuilt from `node`, standard version), `GetAddress`, `SignTx` / `TxRequest` like Bitcoin with `coin_name` "Litecoin" / "Dogecoin" / "Bcash" / "Dash" (testnet: "Litecoin Testnet", "Bcash Testnet", "Dash Testnet"), `SPENDWITNESS` (Litecoin) or `SPENDADDRESS`; previous transactions taken from the PSBT, txid recomputed.
- **Ledger XRP / Stellar / Tron** (`hw-app-xrp`, `hw-app-str`, `hw-app-trx`): key read with `E0 02` (XRP and Tron also return the address, which must be the key's), signature `E0 04`: XRP = unsigned binary transaction in 150-byte blocks; Stellar = *signature base* (`networkId ‖ ENVELOPE_TYPE_TX ‖ XDR`) in 255-byte blocks; Tron = `raw_data` split between protobuf fields (≤ 250 bytes per APDU, P1 `10` / `00` / `80` / `90`).
- **Trezor Stellar**: `StellarGetAddress`, then `StellarSignTx` + the operation (XLM payment or account creation); the firmware rebuilds the XDR itself: if its reconstruction differed from Kyro's, the signature would not verify against Kyro's hash (`HW_BAD_RESPONSE`).
- **Ledger Cardano** (`hw/ledger_cardano.rs`, based on `@cardano-foundation/ledgerjs-hw-app-cardano` 8.1.0): CLA `D7`; account key `10` (`m/1852'/1815'/a'` → key ‖ chain code), address `11` (P1 `01` return, `02` display; parameters: base, payment `…/0/0`, staking "path" `…/2/0`), signature `21` in "ordinary transaction" mode. App 7.x: INIT (`01`, all Conway fields), metadata hash (`08`, "arbitrary hash" type: the CIP-20 memo), inputs (`02`), outputs (`03`: `30` base data, `31` asset group, `32` token, `33` end), fees (`04`), ttl (`05`), validity start (`09`), confirmation (`0A` → body hash), witness (`0F` → signature). App ≥ 8: INIT (`10`) with the counters and the length, then the serialized stream of the same elements in 250-byte blocks (`11`, last one `12` → body hash), witness (`0F`). Our change is sent as a device address (two paths): the device derives it itself. Statuses: `6E09` / `6985` refusal, `6E11` locked, `6E10` app policy, `6Bxx` read impossible.
- **Trezor Cardano** (`hw/trezor_cardano.rs`, order from `trezorlib/cardano.py`): `CardanoGetPublicKey` / `CardanoGetAddress` (ICARUS), `CardanoSignTxInit` (`tag_cbor_sets`), inputs, outputs followed by their `CardanoAssetGroup` / `CardanoToken`, `CardanoTxAuxiliaryData` (hash), `CardanoTxWitnessRequest` (`…/0/0`), `CardanoTxHostAck` → `CardanoTxBodyHash`, `CardanoTxHostAck` → `CardanoSignTxFinished`. A Trezor and the Kyro vault give the same Cardano account for the same phrase (without passphrase); a Ledger does not (its own derivation from the seed).
- **Trezor Zcash** (`hw/trezor_zcash.rs`): `GetPublicKey` / `GetAddress` / `SignTx` with `coin_name` "Zcash" ("Zcash Testnet"), `version` 5, `version_group_id` `0x26A7270A`, `branch_id`, `expiry`; inputs: outpoint, path, amount (the firmware does not request previous transactions: ZIP 244 commits to the amounts and scripts of all inputs); change as `address_n`.
- **Not offered**: XRP on Trezor (the firmware only delivers the address, not the public key that Kyro needs to build and verify the Payment); TRON on Trezor (absent from the firmware); Cardano on the Trezor One (absent from the firmware); **Zcash on Ledger**: Ledger's Zcash (transparent) app uses the old Bitcoin protocol, which requires each previous transaction **in full** through `GET TRUSTED INPUT`, including, for a v5 previous transaction, its Sapling / Orchard parts whose ZIP 244 txid the app recomputes (`@ledgerhq/hw-app-btc`, `getTrustedInput`, `splitTransaction`); Kyro does not read those parts, Ledger does not publish recorded v5 exchanges to test against, and its own library already rejects v6 previous transactions: not done without a device.

**Single-key chains (Ledger only)** — `hw/ledger_apps.rs` (shared), one module per official app: `hw/ledger_sui.rs` (the Sui app's block protocol: parameters split into 180-byte blocks chained by SHA-256, `GET_CHUNK` / `PUT_CHUNK` / `RESULT_*`), `hw/ledger_aptos.rs` (CLA 5B), `hw/ledger_algo.rs` (CLA 80, account number), `hw/ledger_near.rs` (CLA 80, 5-level path without length), `hw/ledger_cosmos.rs` (CLA 55, little-endian path), `hw/ledger_hbar.rs` (CLA E0, little-endian key index, body in one APDU), `hw/ledger_ton.rs` (CLA E0, structured transfer request: the device rebuilds the cell and returns the signature **and** the hash, compared with Kyro's). The account stores one public key per chain (`WatchOnlyAccount.keys`, `wallet_core::WatchKey`: the address is recomputed from the key, the path from the account number). Flow of a send: `hw_<chain>_build_tx` (built for the stored address, like the vault) → `hw_sign_<chain>_tx`: (1) the key is re-read on the device = the stored key (`HW_WRONG_DEVICE`); (2) the same live checks as the vault command; (3) native dialog (summary decoded by Rust + "verify on the device"), 2nd reinforced dialog on the same triggers; (4) the device displays and signs the bytes built by `wallet-core`; (5) Rust verifies the signature (strict ed25519 / ECDSA low-S) and assembles the transaction → `hw_<chain>_broadcast` (re-verified). No private key on the host side, no hand-written crypto.

**Not offered on hardware wallet**: **Polkadot** — the generic "Polkadot" app requires the `CheckMetadataHash` extension with a metadata proof (RFC-0078) attached to each transaction, and ed25519 `m/44'/354'/…` keys (Kyro: Polkadot.js sr25519, without proof); the proof would be built with `merkleized-metadata` (Parity, crates.io) from the V15 metadata read at each send: not integrated; **Kaspa** — the app (LedgerHQ/app-kaspa) signs version 0 transactions with the same signature hash as Kyro (`sighash.c` = `calc_schnorr_signature_hash` v0) and returns that hash with each signature, so it is compatible and verifiable; but it spends from several addresses `m/44'/111111'/a'/0|1/i` (≤ 255 inputs, 1 or 2 outputs, the 2nd = change at a given path): this requires an extended-key hardware wallet account (like Bitcoin) and the traversal of its addresses, not yet written. `hw_open` reports them as `unsupported` with this reason; Trezor has no app for any of these nine chains.

### 2.3b Watch addresses

`WatchAddress = { id /*wa-…*/, label, family, value }`, stored in `watch-addresses-<network>.json` next to the vault: public data, like `hw-accounts-<network>.json`. `value` is a public address, or an account xpub for Bitcoin, Litecoin, Dogecoin, Bitcoin Cash, Dash and Zcash (`xpub`, `ypub`, `zpub`, `Ltub`, `Mtub`, `dgub` and the testnet forms). No command signs for an entry: there is no key, and `createAdapters` seals every `build*`, `sign*`, `broadcast*`, `prepare*`, `send*` and `submit*` method of a watch adapter. Reads use the same typed commands as any other account, so they go through the same server rules (Tor, allowlist). Monero cannot be watched: an address alone shows nothing.

### 2.4 Litecoin, Dogecoin, Bitcoin Cash and Dash

Same principles as Bitcoin (§2.2): Rust chooses the server (`servers.litecoin` / `servers.dogecoin` / `servers.bitcoincash` / `servers.dash`, otherwise the default), goes through the Tor circuits of the chain's family, never falls back; reads return **exactly the Esplora shapes** of §2.2. TS adapters: `LitecoinAdapter`, `DogecoinAdapter`, `BitcoinCashAdapter`, `DashAdapter` (`packages/chains/src/litecoin/`, `dogecoin/`, `bitcoincash/`, `dash/`), created by `createUtxoAdapters(accounts)`. Bitcoin Cash: CashAddr addresses (TS codec `@kyro/shared` `cashaddr.ts`, a mirror of Rust, same spec vectors), outputs added by script.

| Command (`ltc_…` / `doge_…` / `bch_…` / `dash_…`) | Arguments | Return | Notes |
|---|---|---|---|
| `…_backend_info` | — | `{ kind: 'default' \| 'esplora', network: 'mainnet' \| 'testnet', label, available, tor }` | `kind` = the setting (`default` even when the Dogecoin mainnet default speaks Electrum); `label` = host (Dogecoin mainnet default: `doge.electrum1.cipig.net`); `available: false` = Dogecoin **testnet** with no server configured |
| `…_address` | `{ change, index, account? }` | `string` | vault unlocked; `m/84'/2'/account'/…` (LTC), `m/44'/3'/account'/…` (DOGE) |
| `…_address_info` / `…_address_utxos` / `…_address_txs` | `{ address }` | Esplora shapes (§2.2) | address validated by Rust for the chain and the network before any request; `txs`: 50 at most, unconfirmed first. **Dogecoin mainnet default (ElectrumX)**: `get_balance` + `get_history` (`funded_txo_sum`/`spent_txo_sum` carry the net balance, like Electrum Bitcoin); `listunspent` then **each UTXO checked against its previous transaction** (`transaction.get`, hash recomputed; the output must exist, pay our script and be worth exactly the announced amount, otherwise `SERVER_UNREACHABLE` for the whole list; 1,000 coins at most); history: `get_history` + `transaction.get` of the transactions and their inputs + `block.header`, any transaction that does not touch the address is discarded. Strict types: 64-hex txid, integer amounts in koinus, `tx_pos` u32 |
| `…_tx_hex` | `{ txid }` | `string` | `GET /tx/{txid}/hex` (Electrum: `blockchain.transaction.get`), verified: recomputed txid = `txid` (and no witness for Dogecoin), otherwise `SERVER_UNREACHABLE` |
| `…_fee_rates` | — | `{ fastestFee, halfHourFee, hourFee, economyFee, minimumFee, source? }` | smallest unit **per vbyte** (litoshis/vB; koinus/byte). `/v1/fees/recommended` then `/fee-estimates`. Dogecoin: bounds [0.01; 1] DOGE/kB (1,000–100,000 koinus/B); server without estimation (404) → 0.01 DOGE/kB, `source: 'policy'`. Electrum (Dogecoin mainnet): `estimatefee` at 2 / 30 / 60 / 144 blocks (≈ 2 min / ½ h / 1 h / 1 d) + `relayfee`, same bounds; no estimation → `source: 'policy'` |
| `…_tip_height` | — | `number` | |
| `…_broadcast` | `{ hex }` | `string` (txid) | transaction decoded first; server's txid = ours, otherwise error (Electrum: `blockchain.transaction.broadcast`) |
| `…_sign_psbt` | `{ psbt, password, account? }` | `{ psbt /*signed, not finalized — finalized for Bitcoin Cash*/, summary: UtxoTxSummary }` | password → `utxo_psbt_summary` → native dialog (recipients, amounts, change, fees, rate, size; "No change…" if none; foreign inputs) → **2nd reinforced dialog** if `requiresExtraConfirmation` (unknown output "UNKNOWN" (French: « INCONNUE »), OP_RETURN, foreign input, DOGE soft dust, very high fees) → signature; the signing summary must be identical to the one displayed |

Construction rules (TS) verified by Rust:
- **Litecoin**: each input has `witness_utxo` + `bip32_derivation` (`m/84'/2'|1'/0'/…`); the change carries its derivation (otherwise it is displayed as a recipient); dust = Litecoin Core's `GetDustThreshold` at 30,000 lit/kvB (P2WPKH 2,940 litoshis, P2PKH 5,460): a recipient below it is refused, change below it is added to the fees; minimum 1 litoshi/vB.
- **Dogecoin**: each input has **`non_witness_utxo`** (full previous transaction, `doge_tx_hex`) — this is what proves the amounts, which the legacy sighash does not commit to — and **no** `witness_utxo`; fees by size (0.01 DOGE/kB recommended = Kyro's minimum; relay 0.001 DOGE/kB); no output below 0.01 DOGE (soft dust: each output below it costs an extra 0.01 DOGE in fees; below 0.001 DOGE, non-standard → Rust refuses).
- Size (identical TS/Rust, longest signature): P2WPKH 10.5 + 68 per input + outputs (31 P2WPKH) vB; P2PKH 10 + 148 per input + 34 per output bytes.
- **Dogecoin default server**: mainnet → Komodo's public ElectrumX servers (`doge.electrum1.cipig.net:20060`, fallback `doge.electrum2.cipig.net:20060`, allowlist `net::ELECTRUM_HOSTS`, TLS validated, genesis verified at each session, `dogecoin` Tor circuits); **testnet → none**: `{ kind: 'default' }` → every read `SERVER_INVALID` ("configure your Esplora server (electrs-dogecoin)"). See NETWORK.md.
- **Before any Dogecoin signature** (and any Litecoin input that carries `non_witness_utxo`), Rust (`wallet-core`) recomputes the previous transaction's hash: it must equal the outpoint's txid; the `vout` must exist; its script must be ours; **the amount (and therefore the native dialog's fees) comes only from this transaction**, never from the server's UTXO list. Otherwise: refusal (`INVALID_INPUT`), before the dialog.
- JSON amounts: an output above 2⁵³ units (≈ 90 million DOGE) cannot be read losslessly in JS: the adapter refuses it (the signature, for its part, takes the amounts from the previous transactions, in Rust).
- **Bitcoin Cash** (`bch_*`, `bitcoincash` Tor family): like Dogecoin, each input carries `non_witness_utxo` (`bch_tx_hex`) and Rust takes only the amount and script from it, even though the FORKID digest already commits to the amounts; CashAddr addresses only (`bitcoincash:q…`, chipnet `bchtest:q…`); dust 546 sat (P2PKH), minimum 1 sat/B, estimates bounded to [1; 100] sat/B (`estimatefee` at 1 / 3 / 6 / 144 blocks); `SIGHASH_ALL|FORKID` signature and PSBT **returned finalized**. Default servers: public Fulcrum `bch.imaginary.cash:50002` (fallback `bch.loping.net:50002`, `cashnode.bch.ninja:50002`), chipnet `chipnet.imaginary.cash:50002` (fallback `chipnet.bch.ninja:50002`). Since Bitcoin Cash shares Bitcoin's genesis (chipnet: testnet4's), each session **also** verifies `blockchain.block.header` at the checkpoint (`utxo_checkpoint`, hash recomputed by Rust): a Bitcoin server is refused (`SERVER_WRONG_NETWORK`); same check for a custom Esplora (`GET /block-height/478559`). `get_balance` and `listunspent` are called with `token_filter = "exclude_tokens"` (Fulcrum): a coin carrying CashTokens is neither counted nor spent (spending it would burn the tokens); if a server slips one in anyway, its script (token prefix) does not match ours → list refused, and wallet-core refuses to sign it.
- **Dash** (`dash_*`, `dash` Tor family): Dogecoin path (legacy sighash, `non_witness_utxo` mandatory and verified, amounts taken only from the previous transaction); dust 546 duffs, minimum 1 duff/B, bounds [1; 100] duffs/B (`estimatefee` at 1 / 12 / 24 / 144 blocks). DIP2 special transactions (version 3, type ≠ 0: CbTx coinbase, ProTx, Platform withdrawals…) are decoded (txid over the full serialization) but their outputs are **excluded** from `dash_address_utxos` and `dash_tx_hex` refuses them (`INVALID_INPUT`): a PSBT cannot carry their payload. Default server: Komodo's ElectrumX `dash.electrum1.cipig.net:20061` (fallback `dash.electrum2.cipig.net:20061`) on mainnet; **testnet: none** (`SERVER_INVALID`).
- Custom Bitcoin Cash / Dash server: only the "Esplora" type is accepted (like Litecoin / Dogecoin); there is hardly any public Esplora API for these chains, and a **custom Electrum server** for UTXO chains is not yet supported.

**Done on the UI side** (commit of the Litecoin / Dogecoin UI): `Commands` types of `@kyro/shared` (`ltc_*`, `doge_*`, `btc_tx_hex`, `Accounts.ltc/doge`, `Servers.litecoin/dogecoin`, `ServerTestTarget`), demo backend, Send/Receive/Asset/History screens for these families, server settings, "Outgoing connections" list, removal from `WATCH_ONLY_CHAINS`.

### 2.4b Zcash (transparent addresses only)

**Transparent only**: `t1…` (P2PKH) and `t3…` (P2SH) addresses on mainnet, `tm…` / `t2…` on testnet; as a recipient, also `tex1…` (ZIP 320: a P2PKH that only accepts funds coming from transparent inputs — which is the case for all of Kyro's transactions). **Shielded** (Sapling `zs…`, Sprout `zc…`) and **unified** (`u1…`) addresses are **refused** by Rust (`INVALID_INPUT`, "shielded Zcash address … or unified …: not yet supported"), and the UI says so beforehand (Send, Receive). Kyro neither builds nor reads any shielded part.

BIP44 keys `m/44'/133'/a'/c/i` (testnet `m/44'/1'/a'/…`, zcashd convention), P2PKH, standard `xpub`/`tpub`. **Rust builds the transaction itself** (like TRON, XRP, Cardano): the interface only supplies the candidate coins (outpoint + which of our addresses), the recipient, the amount, and the index of the next change. Rust (`wallet-core` `zcash.rs`, official librustzcash crates `zcash_primitives` / `zcash_transparent` / `zcash_protocol`):
- itself reads the **previous transaction of each coin** from the server, re-parses it and recomputes its txid (ZIP 244 for v5+, double SHA-256 before): it must be the outpoint's; the output must exist and pay **this account's key** at the announced index; amount and script come from this transaction, never from the interface or the server's list; mined coin (coinbase) refused (Zcash requires it to be shielded);
- selects the coins (largest first, 50 at most), computes the **ZIP 317 fees** (`zip317::FeeRule::standard()`: 5,000 zatoshis per logical action, 2 minimum = 10,000), sends the change to **our** address `…/1/changeIndex` (index ≤ 1000); change below 5,000 zatoshis is added to the fees; a recipient below 54 zatoshis (dust) is refused;
- **reads the consensus branch from the chain**: `headers.subscribe` then `transaction.id_from_pos` + `transaction.get` of a v5+ transaction from the last 3 blocks (the coinbase first), whose header carries the `nConsensusBranchId`; it must be known to `zcash_protocol` **and** equal to what its activation table gives for that height, otherwise refusal ("the Zcash network uses branch … unknown to this version of Kyro …: update Kyro") — never a hard-coded branch; the transaction is signed for the next block's branch;
- builds a **v5** transaction (ZIP 225), `lock_time` 0, expiry = next block + 40 (ZIP 203), shortened before a known upgrade; `SIGHASH_ALL` signature over the **ZIP 244 digest** computed by `zcash_primitives` (it commits to the amount and script of **each** input), libsecp256k1 ECDSA (`bitcoin` crate), low-S, each signature verified; the final encoding is re-read by `zcash_primitives` and must say exactly what the dialog shows.

| Command (`zec_…`) | Arguments | Return | Notes |
|---|---|---|---|
| `zec_backend_info` | — | `{ kind: 'default', network, label, available, tor }` | `label` = `zec.electrum1.cipig.net` on mainnet; testnet: `''`, `available: false` (no public server) |
| `zec_address` | `{ change, index, account? }` | `string` | vault unlocked; `t1…` / `tm…` |
| `zec_address_info` / `zec_address_utxos` / `zec_address_txs` | `{ address }` | Esplora forms (§2.2) | transparent address of this network (canonical `t…` form) checked before any request. Electrum: `get_balance` + `get_history`; `listunspent`, then **each UTXO is checked against its previous transaction** (re-hashed by `zcash_primitives`, existing output, our script, exact amount; otherwise `SERVER_UNREACHABLE` for the whole list; 1,000 at most; `coinbase: true` = mining coin, not spendable by Kyro); history: 50 at most, a transaction that does not touch the address is discarded, `shielded: true` (without `fee`) when the transaction also moves a shielded value; block time read from the Zcash header (`nTime`, bytes 100..104) |
| `zec_tip_height` | — | `number` | |
| `zec_send_preview` | `{ request: ZecSendArgs, account? }` | `ZecTxSummary` | vault unlocked, no password: the same construction as `zec_sign` (network reads included) |
| `zec_sign` | `{ request: ZecSendArgs, password, account? }` | `{ hex, txid, summary: ZecTxSummary }` | password → construction and decoding by Rust → **native dialog** (signing account, recipient — for a TEX, the `t1…` address it encodes —, amount, change and its address, fees and ZIP 317 fee, remainder added to the fees, inputs, upgrade and branch, expiry, "Transparent: … public") → **2nd reinforced dialog** if `requiresExtraConfirmation` (fees > 10 × ZIP 317 or > amount) → signature; the signature's summary must be identical to the one displayed |
| `zec_broadcast` | `{ hex }` | `string` (txid) | transaction decoded first (refused if it has a shielded part); `blockchain.transaction.broadcast`; server txid = ours (ZIP 244), otherwise error |

```ts
type ZecSendArgs = {
  to: string;                       // t1… / t3… / tex1… (refused: zs…, zc…, u1…)
  amount: string;                   // zatoshis (decimal integer); ignored with max
  max: boolean;                     // send everything minus the fees, no change
  coins: { txid: string; vout: number; change: boolean; index: number }[];   // candidates, 200 at most, NO amount (deny_unknown_fields)
  changeIndex: number;              // m/44'/133'/a'/1/changeIndex, ≤ 1000
};
type ZecTxSummary = {
  to: string; toKind: 'p2pkh' | 'p2sh' | 'tex'; toAddress: string;
  amount: string; change: { address: string; amount: string; index: number } | null;
  fee: string; zip317Fee: string; folded: string;            // zatoshis
  inputs: number; inputTotal: string;
  upgrade: string; branchId: string;                          // 'NU6.3', '0x37a5165b'
  targetHeight: number; expiryHeight: number; txid: string;
  warnings: ({ kind: 'highFee' } | { kind: 'expiryCapped'; nextUpgradeHeight: number })[];
  requiresExtraConfirmation: boolean;
};
```

- **Servers**: mainnet → public Komodo ElectrumX servers (`zec.electrum1.cipig.net:20058`, fallback `zec.electrum2.cipig.net:20058`, allowlist `net::ELECTRUM_HOSTS` `zcash` family, TLS validated normally, Zcash genesis checked at every session, `zcash` Tor circuits, never in clear if Tor is enabled); **testnet → none**: every read is `SERVER_INVALID`. No custom Zcash server for now. See NETWORK.md.
- **Network upgrade**: the activation table comes from `zcash_protocol` 0.11.0-pre.1 (NU6.3 since block 3,428,143 on mainnet, in force on 01/11/2026; NU7: known branch, **mainnet height absent** from this version). When the network moves to a branch that this table does not give for the height, Kyro will refuse to sign (nothing is lost: no invalid transaction) until the crates are updated.
- Hardware wallets: Trezor (`hw_zec_send_preview`, `hw_sign_zec_tx`, §2.3; `WatchOnlyAccount.zec` account); not Ledger (§2.3).
- **Accounts** (§2.9): `zec` chain, `m/44'/133'/a'`.

**Done on the UI side**: `ZecCommands` types of `@kyro/shared` (`Accounts.zec`, `AccountChain` `zec`), `ZcashAdapter` (`packages/chains/src/zcash/`, address scan with gap limit, history, candidate coins, Rust preview), `zcash` chain of the registry (CoinGecko `zcash` price), Send screens (clear refusal of shielded and unified addresses, ZIP 317 fees "nothing to choose", decoded summary), Receive (`t1…` address, ZIP 321 `zcash:` URI, warning "shielded addresses not supported yet"), Asset, address book, Outgoing connections; demo backend (`mock-zec.ts`).

### 2.5 TRON (TRX, TRC-20)

Rust chooses the server (`servers.tron`, otherwise TronGrid), `tron` Tor family, never a fallback. **Rust builds `raw_data` itself** (wallet-core `TronRaw`) from `/wallet/getnowblock`: `ref_block_bytes` = bytes 6..8 of the number, `ref_block_hash` = bytes 8..16 of the `blockID` (checked: the id starts with the number), `timestamp` = block timestamp, `expiration` = block + 10 min. The server's `createtransaction` is **never** used for what is signed (the real test only compares Kyro's encoding with its own: identical byte for byte).

| Command | Arguments | Return | Notes |
|---|---|---|---|
| `tron_backend_info` | — | `{ kind: 'default' \| 'http', network: 'mainnet' \| 'testnet', label, tor }` | |
| `tron_address` | `{ account?, index? }` | `string` | `m/44'/195'/{account}'/0/0`, vault unlocked; one address per account (`index` ≠ 0 refused); `tron_build_tx`, `tron_sign_tx`, `tron_broadcast` and `tron_stake_*` take the same `account?` |
| `tron_account` | `{ address }` | `{ address, exists, balance /*sun*/, freeBandwidthLimit, freeBandwidthUsed, bandwidthLimit, bandwidthUsed, energyLimit, energyUsed }` | `getaccount` + `getaccountresource`; `exists: false` = account never activated |
| `tron_trc20_balance` | `{ contract, address }` | `string` (raw units) | `balanceOf` via `triggerconstantcontract` |
| `tron_txs` | `{ address }` | `[{ txid, kind: 'trx' \| 'trc20', from, to, amount, token?: { contract, symbol, decimals }, timestamp, status: 'confirmed' \| 'failed' }]` | TronGrid `/v1` API (50 TRX + 50 TRC-20 at most, most recent first); a java-tron node alone has no history → explicit `SERVER_UNREACHABLE`; no fees in the response, and TRC-20 transfers are always marked `confirmed` (the /v1 API does not give their result) |
| `tron_build_tx` | `{ to, amount /*sun or token units*/, token? /*T… contract*/, account? }` | `{ raw /*hex*/, txid, summary: TronTxSummary, estimate: TronEstimate }` | TRX: `TransferContract`. TRC-20: `transfer(to, amount)`, energy **simulated** (`triggerconstantcontract`, `energy_used + energy_penalty`); a transfer that would fail (insufficient token balance) is refused; `fee_limit` = energy × price × 1.3, at least 1 TRX, at most `getMaxFeeLimit`. Rust re-decodes what it built |
| `tron_sign_tx` | `{ raw, password, account? }` | `{ signature /*65 bytes hex*/, txid, summary, estimate }` | decodes (`tron_decode_raw`, owner = us), refuses expired or expiration > 24 h, password, **re-reads live** account, chain parameters, recipient existence and simulated energy → native dialog: recipient, amount (token named by `known_tokens.rs` only: USDT mainnet `TR7NHq…`, Nile `TXYZop…`; other token: raw units and "UNKNOWN TOKEN", 2nd dialog; a `token` sent by an old interface is ignored), **bandwidth needed / available (free, frozen) and TRX burned**, **estimated energy / available, estimated and maximum TRX burned (`fee_limit`)**, **activation of a non-existent account** (creation 1 TRX + 0.1 TRX without frozen bandwidth, values read from `getchainparameters`), estimated and maximum total, balance, memo (one line between "…", after the amounts), expiration, reference block, txid; 2nd reinforced dialog if `requiresExtraConfirmation` (call other than `transfer`, TRX sent to the contract, memo, `fee_limit` > 100 TRX); signature summary = displayed summary |
| `tron_broadcast` | `{ raw, signature, account? }` | `string` (txid) | the signature must give back our address; `/wallet/broadcasthex`; server txid = `sha256(raw)` otherwise `SERVER_UNREACHABLE`; network refusal → `INVALID_INPUT` with the decoded message |

**History and personal node**: `tron_txs` uses TronGrid's own `/v1` API. A java-tron node alone (custom `http` server) does not have it: the command then fails with `SERVER_UNREACHABLE` and an explicit message ("history requires TronGrid's /v1 API"), without ever falling back to TronGrid. Balances, resources, building, signing and broadcasting work with any java-tron node.

**TronGrid key (optional)**: `KYRO_TRONGRID_API_KEY` (env, development) or `settings.apiKeys.trongrid`. Rust adds it as the `TRON-PRO-API-KEY` header **only** to `api.trongrid.io` and `nile.trongrid.io` (never to a personal node or another host); the UI never sees the key (`config_get.hasTrongridKey`). Without a key: reduced quotas, and Tor exit relays may receive a 403.

Refused before any signature: any contract type other than TRX / contract call (**resource delegation**, **permission changes**…; freeze, unfreeze, vote and rewards go only through `tron_stake_*`, §2.8), `Permission_id` (multisig), other owner, `auths`, `scripts`, TRC-10 value, non-canonical encoding. Bandwidth estimate: signed size + 64 bytes (like java-tron). Hardware wallets: Ledger ("Tron" app, `hw_sign_tron_tx`, §2.3); not Trezor.

**Done on the UI side** (TRON UI commit): `Family` `'tron'`, `Commands` types (`tron_*`, `Accounts.tron`, `Servers.tron`, `ServerTestTarget`), demo backend, Send screens (show `estimate` before the password: bandwidth, energy, activation), Receive, Asset (TRX, USDT), History, TRON server setting, "Outgoing connections", removal of TRON from `WATCH_ONLY_CHAINS`. Adapter: `TronAdapter` (`packages/chains/src/tron/`), `tronChain(network)`, `TRON_USDT`.

### 2.6 XRP Ledger (XRP payments and issued currencies)

Rust chooses the server (`servers.xrp`, otherwise the default), `xrp` Tor family, never a fallback. **Rust builds the Payment**: `Sequence` (`account_info`, current ledger), `Fee` (`fee`: open ledger fee, at least the reference fee), `LastLedgerSequence` = current ledger + 20 (≈ 1 min), `Flags` = `tfFullyCanonicalSig`, `SigningPubKey` = our key; encoded by wallet-core. A blob built by the server is never signed.

| Command | Arguments | Return | Notes |
|---|---|---|---|
| `xrp_backend_info` | — | `{ kind: 'default' \| 'jsonRpc', network: 'mainnet' \| 'testnet', label, tor }` | |
| `xrp_address` | `{ account?, index? }` | `string` | `m/44'/144'/{account}'/0/0`, vault unlocked; one address per account (`index` ≠ 0 refused); `xrp_build_tx`, `xrp_sign_tx`, `xrp_broadcast` take the same `account?` |
| `xrp_account` | `{ address }` | `{ address, exists, balance /*drops*/, sequence, ownerCount, flags, requireDestTag, disallowXrp, reserve, spendable }` | `account_info` + reserves from `server_info.validated_ledger` (`reserve_base_xrp`, `reserve_inc_xrp`: **1 XRP and 0.2 XRP**, read live on 30/10/2026 on testnet and mainnet); `reserve` = base + 0.2 × owned objects; `spendable` = balance − reserve; non-existent account: `exists: false` |
| `xrp_lines` | `{ address }` | `[{ currency, issuer, balance, limit }]` | trust lines (issued currencies) |
| `xrp_txs` | `{ address }` | `[{ hash, from, to, destinationTag, amount, fee, ledger, time, result }]` | last 50 Payments; `amount` = **amount actually delivered** (`delivered_amount`) |
| `xrp_build_tx` | `{ to, amount /*drops, or decimal value if issued*/, destinationTag?, issued?: { currency, issuer }, account? }` | `{ blob /*unsigned, hex*/, summary: XrpTxSummary, context: { account, destination, reserveBase, reserveInc } }` | refused before any construction: recipient with `lsfRequireDestTag` **without a tag**; non-existent recipient account and XRP amount < base reserve (`tecNO_DST_INSUF_XRP`); issued currency to a non-existent account (`tecNO_DST`); amount + fees > available; our account not activated |
| `xrp_sign_tx` | `{ blob, password, account? }` | `{ blob /*signed*/, hash, summary, context }` | decodes (strict, Account and key = us), refuses exceeded `LastLedgerSequence` and stale sequence, **re-reads live** both accounts and the reserves and redoes the checks above, password → native dialog: recipient, **DESTINATION TAG boxed on its own line** (or "NO DESTINATION TAG" with the warning), amount, SendMax, creation of the recipient account, fees, balance, locked reserve (base + objects), available, limit ledger, memos; 2nd reinforced dialog if `requiresExtraConfirmation`; signature summary = displayed summary |
| `xrp_broadcast` | `{ blob, account? }` | `string` (hash) | `xrp_verify_signed` (DER low-S, key = Account = us) then `submit`; `tesSUCCESS` or `terQUEUED` accepted, otherwise `INVALID_INPUT` with the code; server hash = `SHA-512Half("TXN\0"‖blob)` otherwise `SERVER_UNREACHABLE` |
| `xrp_tx_status` | `{ hash }` | `{ validated, result }` | `tx`: `validated: true` and `result: 'tesSUCCESS'` once in a validated ledger |

Refused before any signature: any other transaction type (AccountSet, SetRegularKey, SignerListSet, TrustSet, OfferCreate, EscrowCreate…), **partial payment** (`tfPartialPayment`: the delivered amount could be almost zero), `Paths`, `DeliverMin`, `TicketSequence`, `NetworkID`, unknown flags, unknown fields. Stricter than "unknown → reinforced confirmation": a field that Kyro cannot decode is never signed. Hardware wallets: Ledger ("XRP" app, `hw_sign_xrp_tx`, §2.3); not Trezor (no public key before signing).

**For the UI**: the **Destination tag** field must be permanently visible on the Send XRP screen (not hidden in "options"), with `parseDestinationTag` (integer 0 … 4,294,967,295); if it is empty, show the warning; if `xrp_account(destination).requireDestTag`, make it **mandatory** (Rust refuses anyway); show `spendable` (not only the balance) and, for a non-existent recipient, "at least 1 XRP"; after `xrp_broadcast`, follow `xrp_tx_status`. **Done on the UI side** (commit 158b505): `Family` `'xrp'`, `Commands` types (`xrp_*`, `Accounts.xrp`, `Servers.xrp`, `ServerTestTarget`), demo backend, Send / Receive (address + optional tag) / Asset (XRP, trust lines) / History screens, XRPL server setting, "Outgoing connections", removal of XRP from `WATCH_ONLY_CHAINS`. Adapter: `XrpAdapter` (`packages/chains/src/xrp/`), `xrpChain(network)`.

### 2.7 Cardano (ADA and native tokens)

Rust chooses the server (`servers.cardano`, otherwise Koios: `preprod.koios.rest` / `api.koios.rest`, free public tier with no key), `cardano` Tor family, never a fallback. Blockfrost is not used: Koios provides everything needed (UTxOs, parameters, tip, history, `submittx`). **Rust builds the transaction**: UTxOs of our address (`address_utxos`), parameters (`epoch_params`: `min_fee_a`, `min_fee_b`, `coins_per_utxo_size`, `max_tx_size`, bounded against a hostile server), UTxO selection (those carrying the requested token first, then ADA-only by decreasing value, those with tokens last), one recipient output + one change output that returns **all** the remaining tokens, fees = `min_fee_a × signed size + min_fee_b` (iterated), each output ≥ its min-UTxO, `ttl` = current slot + 3,600 (≈ 1 h), tagged sets 258 (Conway), no collateral, no certificate. Encoded by wallet-core; a transaction built by the server is never signed.

**Single-address mode** (per account): receiving and change on `m/1852'/1815'/a'/0/0` (staking `…/a'/2/0`) of account `a` (0 = the legacy `m/1852'/1815'/0'/0/0`), like "single address" wallets; simpler and safer to verify, but all payments are linked to one visible address (and one staking key). Staking (registration, delegation, vote, withdrawals): §2.8, always with this `…/0'/2/0` key; `ada_sign_tx` still refuses certificates and withdrawals.

| Command | Arguments | Return | Notes |
|---|---|---|---|
| `ada_backend_info` | — | `{ kind: 'default' \| 'koios', network: 'mainnet' \| 'testnet', label, tor }` | |
| `ada_address` | `{ index, account? }` | `{ address, path, stakeAddress, accountXpub }` | vault unlocked; **signing uses only index 0** of the account: the UI must display only this address; `accountXpub` = public key ‖ chain code of `m/1852'/1815'/{account}'` (hex); `ada_build_tx`, `ada_sign_tx`, `ada_broadcast` and `ada_stake_*` take the same `account?` |
| `ada_account` | `{ address }` | `{ address, balance /*lovelace*/, tokens: [{ policy, name /*hex*/, nameText, quantity, verified, ticker?, decimals? }], utxoCount, lockedWithTokens }` | `lockedWithTokens` = ADA immobilized by the tokens (min-UTxO of their outputs): what cannot leave without them |
| `ada_txs` | `{ address }` | `[{ hash, time, blockHeight, fee, lovelaceDelta /*signed*/, tokenDeltas: [{ policy, name, nameText, delta }], memo }]` | last 20 (`address_txs` + `tx_info`), most recent first; `memo` = CIP-20 message |
| `ada_tx_status` | `{ hash }` | `{ confirmations: number \| null }` | `null`: not yet seen by the indexer |
| `ada_build_tx` | `{ to, lovelace?, token?: { policy, name, quantity }, memo?, account? }` | `{ tx /*unsigned, CBOR hex*/, summary: CardanoTxSummary, context: { account, params, tip, leaving } }` | **always keeps a change output** (at least its min-UTxO, ≈ 1 ADA): "send everything" therefore leaves about 1 ADA on the address; `lovelace` absent with a token = exactly the output's min-UTxO; refused before any construction: refused address (see §1), amount under the min-UTxO (the message gives the minimum), insufficient token or ADA, change under its min-UTxO, transaction > `max_tx_size`. `leaving` = outputs to other addresses + fees |
| `ada_sign_tx` | `{ tx, password, account? }` | `{ tx /*signed*/, txId, summary, context }` | decodes (strict), refuses exceeded `ttl`, **re-reads live** our UTxOs: each input must be one of our unspent UTxOs, and inputs = outputs + fees (ADA and each token); fees ≥ minimum; password → Icarus root re-derived from the vault → native dialog: **each output** (recipient or change, full address, ADA, "of which X ADA mandatory minimum with the tokens", each token: quantity, text name and hex, policy id, verified or UNVERIFIED), fees, total leaving the wallet, validity (slot, ≈ minutes), message; 2nd reinforced dialog if `requiresExtraConfirmation` (CIP-20 message, token outside the verified table, fees > 5 ADA, no ttl); signature summary = displayed summary |
| `ada_broadcast` | `{ tx, account? }` | `string` (tx id) | `cardano_signed_witnesses` (each signature verified on blake2b-256 of the body, **a single witness: our payment key**) then Koios `POST /submittx` (raw CBOR, `application/cbor`); the returned id must be blake2b-256(body), otherwise `SERVER_UNREACHABLE`; node refusal → `INVALID_INPUT` with its message |

Verified token table (mainnet only, verified on 30/10/2026 via Koios `asset_info` / Cardano token registry): DJED (`8db269c3…cd61` / `446a65644d6963726f555344`), USDM (`c48cbb3d…47ad` / `0014df105553444d`), iUSD (`f66d78b4…9880` / `69555344`). On preprod: none, every token requires the reinforced confirmation. Anyone can create a token with the same name: only the policy id counts.

Hardware wallets: Ledger ("Cardano ADA" app ≥ 7.0.0) and Trezor T / Safe, payments only (`hw_ada_build_tx`, `hw_sign_ada_tx`, `hw_ada_broadcast`, §2.3; staking stays with the vault). The device rebuilds the body from the elements that Kyro sends it; the hash it returns must be Kyro's identifier and the witness must verify with the `…/0/0` key derived from the registered account key (`cardano_hw_assemble`). Derivation: Ledger uses its own (≠ Icarus); Trezor ICARUS, like the vault.

**Done on the UI side** (commit 45208d5): `Family` `'ada'` (today `CardanoChain` / `cardanoChain(network)` exist in the registry but outside `Family` and `allChains()`), `Commands` types of `@kyro/shared` (`ada_*`, `Accounts.cardano`, `Servers.cardano`, `CardanoServer`, `ServerTestTarget` `cardano`; the types are today in `packages/chains/src/cardano/adapter.ts`, to be moved to `ipc.ts`), `WalletAccounts.cardano` and `AdapterSet.cardano` (`createAdapters`), demo backend, Send screens (address, ADA amount with `adaToLovelace`, optional token with quantity, optional public message, preview of the `summary` before the password: outputs, min-ADA, fees), Receive (base address only), Asset (ADA, `spendable` = balance − `lockedWithTokens`, token list with policy id and "unverified" mention), History (`lovelaceDelta`, tokens, message), Cardano server setting (Koios), "Outgoing connections" (`preprod.koios.rest` / `api.koios.rest`), removal of Cardano from `WATCH_ONLY_CHAINS`. Adapter: `CardanoAdapter` (`packages/chains/src/cardano/`), `isCardanoAddress`, `isByronAddress`.

### 2.8 Staking (Solana, Cardano, TRON, NEAR)

**Chains concerned.** Solana (native staking, Stake program), Cardano (delegation to a pool + vote delegation, Conway) and TRON (Stake 2.0 + votes for SRs). **No staking** for Bitcoin, Litecoin, Dogecoin and XRP Ledger: these protocols do not have it. **Ethereum (and EVM chains): out of scope** — native staking requires 32 ETH and a validator running permanently; "liquid staking" (Lido, Rocket Pool…) is merely a call to a third party's contract (contract and custody risk), which Kyro does not decode: it is not offered.

**Common principle.** The UI builds nothing: it chooses an operation, `*_stake_build({ action })` has it **built by Rust** (data read live via Tor, `solana` / `cardano` / `tron` families, no new host) and returns the result **decoded by wallet-core** with the live context (validator / pool / SR, amounts, schedule) to display **before** the password. `*_stake_sign({ …, password })` re-decodes, **re-reads everything live** and redoes every check, asks for the password, opens the **native window** (text built by Rust), then the **2nd reinforced window** if `requiresExtraConfirmation`, signs and verifies the signature; the signed summary must be identical to the one displayed. Any operation that is not exactly one of those listed here is refused (`INVALID_INPUT`). Amounts: decimal strings in the smallest unit (lamports, lovelace, sun). Vault locked: `LOCKED`. Server down or invalid response: `SERVER_UNREACHABLE` (never a fallback). No hardware wallet for staking (`HW_UNSUPPORTED` is not returned: the `hw_*` commands simply do not offer it).

#### Solana (`sol_stake_*`) — staking account derived from your address (`createWithSeed(you, "kyro-stake-N", Stake)`), you as staker **and** withdrawer, no lockup

| Command | Arguments | Return | Notes |
|---|---|---|---|
| `sol_stake_overview` | — | `SolStakeOverview` | staking accounts of which you are the **withdrawer** (`getProgramAccounts`, `memcmp` filter offset 44, re-checked by Rust after reading), state computed by Rust from the StakeHistory sysvar, epoch, delegation minimum (`getStakeMinimumDelegation`: **1 SOL on devnet** on 30/10/2026), rent reserve of a new account (`getMinimumBalanceForRentExemption(200)`) |
| `sol_stake_validators` | `{ withNames?: boolean /*default true*/ }` | `{ validators: SolValidator[], namesAvailable: boolean }` | `getVoteAccounts` (current then delinquent), sorted by active stake; names from the validator-info accounts (Config program, **declared, not verified**); mainnet: ≈ 2 MiB to read via Tor, `withNames: false` to skip it (`namesAvailable: false` if the read fails) |
| `sol_stake_build` | `{ action: SolStakeRequest }` | `{ message /*b64, legacy, unsigned*/, summary: SolTxSummary, stake: SolStakePreview }` | refused before construction: amount < delegation minimum, balance < amount + rent + fees, vote account unknown to `getVoteAccounts`, staking account not entirely yours (staker, withdrawer, lockup), delegation of an account that is not inactive, deactivation of an undelegated account, withdrawal beyond `withdrawable` (or the whole balance while stake remains active) |
| `sol_stake_sign` | `{ message, password }` | `{ signature /*b64*/, summary, stake }` | wallet-core decoding (`sol_decode_message`); the message must be **exactly** one of the 4 Kyro operations (payer and only signer = you, no address table); re-reads live the epoch, the rent, the balance, the staking account and the validator; native dialog: operation, account, amounts (delegated, rent reserve, total), validator (vote account, identity, declared name, commission, active stake, delinquent or not), authorities, current epoch and time remaining, activation at epoch N+1 or cooldown, fees, "no slashing"; **reinforced** if the validator is delinquent (`delinquent`) or keeps more than 10% commission |
| `sol_stake_broadcast` | `{ message, signature }` | `string` (base58 signature = id) | the message must be a Kyro staking operation, the signature must verify for your address; `sendTransaction` (preflight); the returned id must be the signature; network refusal → `INVALID_INPUT` with its message. Tracking: `getSignatureStatuses` via `net_fetch`, like sends |

```ts
type SolStakeRequest =
  | { kind: 'createAndDelegate'; lamports: string /*delegated amount; Kyro adds the rent reserve*/; voteAccount: string }
  | { kind: 'delegate'; stakeAccount: string; voteAccount: string }        // "initialized" or "inactive" account only
  | { kind: 'deactivate'; stakeAccount: string }                           // "activating" or "active" account
  | { kind: 'withdraw'; stakeAccount: string; lamports?: string };         // absent = the maximum (the whole balance if canClose)
type SolEpoch = { epoch: number; slotIndex: number; slotsInEpoch: number; absoluteSlot: number; secondsLeft: number /*≈, 400 ms per slot*/ };
type SolStakePosition = {
  address: string; lamports: string; state: 'initialized' | 'activating' | 'active' | 'deactivating' | 'inactive';
  rentExemptReserve: string; staker: string; withdrawer: string;
  ours: boolean /*staker = withdrawer = you and no lockup in force: manageable by Kyro*/; lockupInForce: boolean;
  voteAccount: string | null; delegated: string | null; activationEpoch: number | null; deactivationEpoch: number | null;
  effective: string; activating: string; deactivating: string;   // lamports
  withdrawable: string /*max partial withdrawal without closing the account*/; canClose: boolean /*the whole balance is withdrawable (closes the account)*/ };
type SolStakeOverview = { address: string; balance: string; epoch: SolEpoch; minimumDelegation: string; rentExemptReserve: string;
                          accounts: SolStakePosition[] };
type SolValidator = { voteAccount: string; identity: string; name: string | null /*declared, not verified*/; commission: number /*%*/;
                      activatedStake: string; delinquent: boolean; lastVote: number; epochVoteAccount: boolean };
type SolStakeWarning = { kind: 'delinquent' } | { kind: 'highCommission'; commission: number };
type SolStakePreview = {
  kind: 'createAndDelegate' | 'delegate' | 'deactivate' | 'withdraw'; stakeAccount: string; seed: string | null;
  lamports: string | null /*paid into the new account, or withdrawn*/; delegated: string | null; rentExemptReserve: string;
  validator: SolValidator | null; account: SolStakePosition | null /*current state of an existing account*/;
  balance: string; fee: string; epoch: SolEpoch; closesAccount: boolean;
  warnings: SolStakeWarning[]; requiresExtraConfirmation: boolean };
```
`summary.instructions` contains the `stakeInitialize`, `stakeDelegate`, `stakeDeactivate`, `stakeWithdraw` variants (§1), plus `systemCreateAccountWithSeed` for a creation.

Timeline: a delegation activates at the start of the next epoch (≈ 2 days per epoch on devnet and mainnet: 432,000 slots), or later if the network limits the ramp-up (9% of the total stake per epoch); the same applies to the cooldown after `deactivate`, during which there is no reward. **Useful exception**: if deactivated in the very epoch of its delegation, the stake was never active and can be withdrawn immediately (`canClose: true`). Rewards are added to the staking account (they are withdrawn with `withdraw`).

#### Cardano (`ada_stake_*`) — staking key `m/1852'/1815'/0'/2/0` (the one of your unique address), Conway certificates

| Command | Arguments | Return | Notes |
|---|---|---|---|
| `ada_stake_overview` | — | `AdaStakeOverview` | Koios `account_info` (registered, pool, DRep, rewards, deposit), `pool_info` of the current pool, `epoch_params` (`key_deposit`: **2 ADA**), `tip` + `genesis` (epoch, end) |
| `ada_stake_pools` | `{ limit?: number /*default 50, max 200*/ }` | `AdaPool[]` | `pool_list` (registered pools, by decreasing active stake) then `pool_info` |
| `ada_stake_pool` | `{ poolId /*pool1… or 56 hex*/ }` | `AdaPool` | for an entered id; unknown → `INVALID_INPUT` |
| `ada_stake_build` | `{ action: AdaStakeRequest }` | `{ tx /*unsigned CBOR hex*/, summary: CardanoStakeSummary, context: AdaStakeContext }` | Rust picks the UTxOs (ADA-only first), **a single output: the change back to your address**, fees computed for 2 witnesses, `ttl` = slot + 1 h; then exactly the checks of `ada_stake_sign` |
| `ada_stake_sign` | `{ tx, password }` | `{ tx /*signed*/, txId, summary, context }` | wallet-core decoding (`cardano_decode_stake_tx` with **your** staking key and the `key_deposit` read live); also refused: an output that is not your address, an unknown or spent input, an imbalance (inputs + withdrawal + refund ≠ output + fees + deposit), fees below the minimum, expired ttl, registration of an already registered key (or an operation on an unregistered key), refund ≠ deposit paid, withdrawal ≠ all available rewards, **withdrawal without a vote delegation** (network rule since Plomin), deregistration without withdrawing the rewards, unknown or retired pool, unregistered DRep; native dialog: each certificate (2 ADA deposit, pool: ticker, declared name, margin, fixed cost, pledge, saturation, delegators; DRep), withdrawal, change, fees, net cost or gain, epoch, timeline (account at epoch N+2, first rewards at the start of N+4), "no lockup, no slashing"; **reinforced** if the pool is retiring, has a margin > 10% or is saturated (> 100%), or if the DRep is inactive |
| `ada_stake_broadcast` | `{ tx }` | `string` (tx id) | witnesses = **exactly** your payment key and your staking key, each one verified; `submittx`; returned id = blake2b-256(body); tracking: `ada_tx_status` (§2.7) |

```ts
type AdaStakeRequest =
  | { kind: 'delegate'; poolId: string; drep?: string }    // registers the key first if needed (2 ADA deposit); drep optional
  | { kind: 'voteDelegate'; drep: string }                  // same; drep = 'alwaysAbstain' | 'alwaysNoConfidence' | 'drep1…' | 'drep_script1…'
  | { kind: 'withdraw' }                                    // all the rewards (the network does not accept a partial withdrawal)
  | { kind: 'deregister' };                                 // withdraws the rewards and refunds the deposit
type AdaStakeAccount = { stakeAddress: string; registered: boolean; delegatedPool: string | null;
                         delegatedDrep: string | null /*'alwaysAbstain' | 'alwaysNoConfidence' | 'drep1…'*/;
                         rewardsAvailable: string; deposit: string; totalBalance: string };
type AdaEpoch = { epoch: number; slotInEpoch: number; epochLength: number; secondsLeft: number; slot: number };
type AdaPool = { poolId: string; poolHash: string; ticker: string | null; name: string | null; homepage: string | null /*declared*/;
                 margin: number /*0..1*/; fixedCost: string; pledge: string; activeStake: string | null; liveStake: string | null;
                 liveSaturation: number | null /*%*/; liveDelegators: number | null; status: 'registered' | 'retiring' | 'retired' | string;
                 retiringEpoch: number | null };
type AdaStakeOverview = { address: string; stake: AdaStakeAccount; pool: AdaPool | null; keyDeposit: string; epoch: AdaEpoch;
                          canWithdraw: boolean /*rewards > 0 and vote delegated*/ };
type CardanoDrepView = { kind: 'key' | 'script'; id: string /*CIP-129*/; hash: string } | { kind: 'alwaysAbstain' } | { kind: 'alwaysNoConfidence' };
type CardanoCertView = { type: 'stakeRegistration'; deposit: string } | { type: 'stakeDeregistration'; refund: string }
                     | { type: 'stakeDelegation'; poolId: string; poolHash: string } | { type: 'voteDelegation'; drep: CardanoDrepView };
type CardanoStakeSummary = { tx: CardanoTxSummary /*§2.7*/; stakeAddress: string; certificates: CardanoCertView[];
                             withdrawals: { rewardAddress: string; lovelace: string }[]; deposit: string; refund: string; withdrawn: string };
type AdaStakeWarning = { kind: 'poolRetiring'; epoch: number } | { kind: 'highMargin'; margin: number /*%*/ }
                     | { kind: 'poolSaturated'; saturation: number } | { kind: 'drepInactive' };
type AdaStakeContext = { account: CardanoAccount /*§2.7*/; stake: AdaStakeAccount /*before the transaction*/; pool: AdaPool | null;
                         drep: { drep: CardanoDrepView; registered: boolean; active: boolean } | null; params: { minFeeA: number; minFeeB: number; coinsPerByte: number; maxTxSize: number };
                         keyDeposit: string; epoch: AdaEpoch; netCost: string /*signed: fees + deposit − refund − withdrawal*/;
                         warnings: AdaStakeWarning[]; requiresExtraConfirmation: boolean };
```
The delegated ADA **stay on your address and remain spendable**; the delegation covers everything controlled by the staking key (`totalBalance`). Rewards accumulate on the reward account (`stake…`) and can only be spent after `withdraw`.

#### TRON (`tron_stake_*`) — Stake 2.0, address `m/44'/195'/0'/0/0`

| Command | Arguments | Return | Notes |
|---|---|---|---|
| `tron_stake_overview` | — | `TronStakeAccount` | `getaccount` (`frozenV2`, `unfrozenV2`, `votes`, `latest_withdraw_time`), `getaccountresource` (TRON Power, energy, bandwidth), `getReward`, `getchainparameters` (`getUnfreezeDelayDays`: **14 days on mainnet, 1 day on Nile**, read on 2026-10-30), `getnextmaintenancetime` |
| `tron_stake_witnesses` | — | `TronWitness[]` | `listwitnesses`, ranked by votes; `url` = the only "name" of an SR, **declared, not verified**; `brokerage` is only read for the SRs of a vote (in `context`) |
| `tron_stake_build` | `{ action: TronStakeRequest }` | `{ raw /*hex*/, txid, summary: TronStakeSummary, context: TronStakeContext }` | `raw_data` built by Rust (latest block, expiration + 10 min, **no `fee_limit`, no memo**); refused: stake < 1 TRX or > balance, unfreeze > staked for this resource, 32 unfreezes already pending, nothing to withdraw, no unfreeze to cancel, zero reward or claimed less than 24 h ago, 0 or > 30 SRs, votes > TRON Power, address that is not an SR candidate |
| `tron_stake_sign` | `{ raw, password }` | `{ signature /*65 bytes, hex*/, txid, summary, context }` | wallet-core decoding (`tron_decode_stake_raw`, owner = you), expiration checked, **re-reads live** account, resources, SRs and `getBrokerage`; native dialog: operation, amount and resource, network unfreeze delay, TRON Power, votes (replace **all** current votes) with url, rank, share kept by the SR, bandwidth and TRX burned, "no slashing", expiration, txid; **reinforced** if an SR is outside the top 127 (no reward), keeps 100%, or if an unfreeze will reduce your votes |
| `tron_broadcast` | `{ raw, signature, account? }` | `string` (txid) | the existing command (§2.5): signature → your address, txid = sha256(raw) |

```ts
type TronResource = 'BANDWIDTH' | 'ENERGY';
type TronStakeRequest =
  | { kind: 'freeze'; resource: TronResource; amount: string /*sun, ≥ 1 TRX*/ }
  | { kind: 'unfreeze'; resource: TronResource; amount: string }
  | { kind: 'withdrawUnfrozen' }                      // withdraws the unfreezes whose delay is over
  | { kind: 'cancelAllUnfreeze' }                     // cancels all pending unfreezes (re-stake; finished unfreezes are withdrawn)
  | { kind: 'vote'; votes: { address: string; count: string /*TRON Power*/ }[] }   // 1 to 30 SRs; replaces all votes
  | { kind: 'claimRewards' };                         // WithdrawBalance: voting rewards, once per 24 h
type TronStakeAccount = { address: string; balance: string; stakedBandwidth: string; stakedEnergy: string;
  unfreezing: { resource: TronResource; amount: string; expireTime: number /*ms*/ }[]; withdrawableNow: string;
  tronPowerLimit: number; tronPowerUsed: number /*1 = 1 staked TRX*/; votes: { address: string; count: string }[];
  reward: string; nextClaimTime: number /*ms, 0 = now*/; unfreezeDelayDays: number; nextMaintenanceTime: number /*ms*/;
  energyLimit: number; energyUsed: number; bandwidthLimit: number; bandwidthUsed: number };
type TronWitness = { address: string; url: string; voteCount: number; rank: number; isSr: boolean /*≤ 27*/; isPaid: boolean /*≤ 127*/;
                     producing: boolean; brokerage: number | null /*% kept by the SR*/ };
type TronStakeAction = { type: 'freeze' | 'unfreeze'; resource: TronResource; amount: string } | { type: 'withdrawUnfrozen' }
  | { type: 'cancelAllUnfreeze' } | { type: 'vote'; votes: { address: string; count: string }[]; total: string } | { type: 'claimRewards' };
type TronStakeSummary = { txid: string; owner: string; action: TronStakeAction; expiration: number; timestamp: number;
                          refBlockBytes: string; refBlockHash: string; rawSize: number };
type TronStakeWarning = { kind: 'srNotPaid'; address: string; rank: number } | { kind: 'brokerageAll'; address: string } | { kind: 'votesReduced' };
type TronStakeContext = { account: TronStakeAccount /*before*/; estimate: TronEstimate /*§2.5: bandwidth*/; witnesses: TronWitness[];
                          warnings: TronStakeWarning[]; requiresExtraConfirmation: boolean };
```
Refused by wallet-core before any signature: `DelegateResource` / `UnDelegateResource` (lending your energy or bandwidth to **another account**), the `TRON_POWER` resource, the obsolete `support` field of a vote, any other contract. There is no dedicated TRON tracking command: refresh `tron_stake_overview` after the broadcast.

#### NEAR (`near_stake_*`) — staking pools, implicit account `m/44'/397'/a'`

| Command | Arguments | Return | Notes |
|---|---|---|---|
| `near_stake_overview` | — | `NearStakeOverview` | pools of the account from FastNEAR (`api.fastnear.com/v1/account/{id}/staking`, only pools of a known factory kept, at most 20), then per pool the views `get_account` (staked, unstaked, `can_withdraw`) and `get_reward_fee_fraction`; epoch from `validators` + `block` (seconds per block measured over the current epoch) |
| `near_stake_validators` | — | `NearValidators` | `validators` (current set, largest stake first; `supported` = pool of a known factory) and `grossApy` = `max_inflation_rate` × (1 − `protocol_reward_rate`) × `total_supply` / total stake, **an estimate before the pool fee**; the UI keeps it on disk (`persist`) |
| `near_stake_build` | `{ action: NearStakeRequest }` | `{ tx /*Borsh hex*/, summary: NearStakeSummary, context: NearStakeContext }` | Rust builds a `TransactionV0` with **one** `FunctionCall` to the pool, 125 Tgas; refused: pool outside `*.poolv1.near`, `*.pool.near` (testnet `*.pool.f863973.m0`), pool whose live `code_hash` is not the one of its factory, amount + fee bound > spendable, unstake > staked, nothing to withdraw |
| `near_stake_sign` | `{ tx, password }` | `{ signed, hash, summary, context }` | wallet-core decoding (`near_stake_decode`: signer and key = ours, known factory, method in the closed list, exact arguments, gas, deposit only on `deposit_and_stake`), nonce and block age checked, **re-reads live** code hash, account, position, fee and validator set; native dialog, then the reinforced one if `requiresExtraConfirmation` |
| `earn_evm_build` | `{ action: { kind: "lidoStake", amount } \| { kind: "lidoRequestWithdrawal", amount } \| { kind: "lidoClaim", requestId } \| { kind: "aaveSupply", asset, amount } \| { kind: "aaveWithdraw", asset, amount? } }` (Aave: optional `chainId` 1, 42161, 8453, 137) + account | `{ to, data, valueWei }` | Ethereum mainnet only. Rust builds the call to a PINNED contract (`earn_evm.rs`: Lido stETH `submit(0x0)`, Lido WithdrawalQueueERC721 `requestWithdrawals` (split into ≤ 1000 stETH requests, owner = signer; preceded by an exact stETH `approve` to the queue, named in the native window) and `claimWithdrawal`, Aave v3 Pool `supply` / `withdraw`, reserves USDT, USDC, DAI, WETH on Ethereum, USDT + USDC on Arbitrum and Polygon, USDC on Base, each with its chain's Pool and aToken, checked on-chain); `evm_sign_tx` recognises it again and names contract + function in the native window, refusing a beneficiary other than the signer. Approvals: exact amount (`approve`, spender labelled "Aave v3 Pool") |
| `earn_staking_rates` | — | `{ sol, ada, trx }` (percent a year, `null` if unreadable) | Read only, existing hosts only (Solana RPC, Koios, TronGrid; no new host). Network-wide estimates **before** the validator / pool / SR commission (`earn_rates.rs`): Solana `getInflationRate.validator` × `getSupply.total` / activated stake (`getVoteAccounts`); Cardano `reserves` × ρ × (1 − τ) × 73 / (`maxLovelaceSupply` − `reserves`) / (1 + a0) (Koios `tip`, `epoch_params`, `totals`, `genesis`); TRON `getWitness127PayPerBlock` × blocks a year / votes of the 127 paid SRs (`getchainparameters`, `listwitnesses`) |
| `near_stake_broadcast` | `{ signed }` | `NearTxOutcome` | strict decode + strict ed25519, signer = our account, then `send_tx` (§2.5) |

```ts
type NearStakeRequest = { kind: 'stake'; pool: string; amount: string /*yocto*/ } | { kind: 'unstake'; pool: string; amount: string }
  | { kind: 'unstakeAll'; pool: string } | { kind: 'withdrawAll'; pool: string };
type NearPoolPosition = { poolId: string; staked: string; unstaked: string; canWithdraw: boolean; feePct: number | null };
type NearEpoch = { height: number; startHeight: number; length: number; blockSecs: number; secondsLeft: number };
type NearStakeOverview = { accountId: string; spendable: string; positions: NearPoolPosition[]; epoch: NearEpoch; unlockEpochs: 4 };
type NearValidators = { validators: { poolId: string; stake: string; supported: boolean }[]; grossApy: number | null };
type NearStakeAction = { type: 'stake' | 'unstake'; amount: string } | { type: 'unstakeAll' } | { type: 'withdrawAll' };
type NearStakeSummary = { signerId; publicKey; nonce; poolId; testnet: boolean; action: NearStakeAction; gas; attached; blockHash; hash };
type NearStakeWarning = { kind: 'highFee'; pct: number /* > 20 */ } | { kind: 'notValidating' };
type NearStakeContext = { account: NearAccountInfo; position: NearPoolPosition /*before*/; validating: boolean; epoch: NearEpoch; unlockEpochs: number;
  gasPrice: string; feeEstimate: string; feeBound: string; warnings: NearStakeWarning[]; requiresExtraConfirmation: boolean };
```
Rewards are added to `staked` by the pool (no separate claim). Unstaked NEAR are withdrawable after 4 epochs (`withdraw_all`). Refused by wallet-core before any signature: `deposit`, `stake`, `withdraw`, `ping`, any other method, several actions, extra JSON fields, NEAR attached to anything but `deposit_and_stake`, another gas value. Hardware accounts: not offered (the Staking screen is disabled for them).

#### What the UI must do (Staking screens)

- **Staking home**: one card per chain (Solana, Cardano, TRON); BTC / LTC / DOGE / XRP: "No native staking"; EVM: "Not offered (32 ETH or third-party contract)".
- **Solana**: `sol_stake_overview` → list of accounts (state, delegated, effective / activating / cooling down, validator, withdrawable) and an epoch countdown (`secondsLeft`); "Stake": amount (≥ `minimumDelegation`, additionally show the `rentExemptReserve` reserve) + choice of the validator in `sol_stake_validators` (commission, active stake, delinquent, name marked "declared"); buttons per account depending on `state`: `active`/`activating` → Deactivate; `initialized`/`inactive` → Delegate; `withdrawable > 0` or `canClose` → Withdraw; an `ours: false` account is read-only.
- **Cardano**: `ada_stake_overview` (registered? current pool, DRep, rewards, deposit); "Delegate": `ada_stake_pools` list (ticker, declared name, margin, fixed cost, saturation) or entry of a `pool1…` (`ada_stake_pool`), and choice of the vote ("Always abstain" offered by default, "Always no confidence", or a `drep1…`); show the **2 ADA deposit** when `registered: false`; "Withdraw" only if `canWithdraw` (otherwise explain that the vote must be delegated first); "Stop staking" = `deregister` (refunds the deposit).
- **TRON**: `tron_stake_overview` (staked per resource, unfreezes with `expireTime` date, withdrawable now, TRON Power used / total, votes, reward and `nextClaimTime`); "Stake" / "Unfreeze" (resource + amount; remind the `unfreezeDelayDays` delay); "Vote": `tron_stake_witnesses` list (rank, declared url, votes) and distribution of the TRON Power (the total ≤ `tronPowerLimit`) while reminding that **the vote replaces the current votes**; "Withdraw" (`withdrawableNow > 0`), "Cancel unfreezes", "Claim" (`reward > 0` and `nextClaimTime` passed).
- In all cases: show `summary` + `stake`/`context` **before** the password, then `*_stake_sign` (the native windows, including the reinforced one, are opened by Rust), then the broadcast; never build or modify a message, a CBOR or a `raw_data` on the UI side.

### 2.9 Multiple vault accounts (Ledger Live model)

All the keys come from the phrase: an "account" is just a **public bookmark** (number + name) per chain, stored in `settings.json` (`accounts.<mainnet|testnet>.<chain>`), never returned by `settings_get` nor accepted by `settings_set` (which always keeps the stored lists). Removing an account only removes the bookmark: adding it again gives back the same addresses. **Account 0** of each chain always exists (it is the legacy one: its paths and addresses have not changed, tests `crates/wallet-core/tests/accounts.rs`); it can be renamed, not removed.

| Chain (`chain`) | Account `a` | Account 0 (unchanged) |
|---|---|---|
| `btc` | BIP84 `m/84'/c'/a'` + BIP86 `m/86'/c'/a'` (addresses `…/0\|1/i`) | `m/84'/c'/0'`, `m/86'/c'/0'` |
| `ltc` / `doge` / `bch` / `dash` | `m/84'/2'/a'` / `m/44'/3'/a'` / `m/44'/145'/a'` / `m/44'/5'/a'` (testnet: `c` = 1) | `…/0'` |
| `zec` | `m/44'/133'/a'` (testnet `m/44'/1'/a'`), transparent only | `m/44'/133'/0'` |
| `evm` | **`m/44'/60'/0'/0/a`** (address index: MetaMask, Trezor Suite and Kyro's hardware wallet accounts; not Ledger Live's `m/44'/60'/a'/0/0` — identical for account 0, and a phrase imported from MetaMask finds its accounts in the same order); a single list for all EVM chains | `m/44'/60'/0'/0/0` |
| `sol` | `m/44'/501'/a'/0'` (Phantom, Solflare) | `m/44'/501'/0'/0'` |
| `tron` | `m/44'/195'/a'/0/0` (Ledger Live) | `m/44'/195'/0'/0/0` |
| `xrp` | `m/44'/144'/a'/0/0` (Ledger Live, Trezor Suite) | `m/44'/144'/0'/0/0` |
| `ada` | CIP-1852 `m/1852'/1815'/a'/0/0` + staking `…/a'/2/0` | `m/1852'/1815'/0'/…` |
| `xlm` | SEP-0005 `m/44'/148'/a'` (Lobstr, Freighter, Ledger, Trezor; SEP-0005 vectors) | `m/44'/148'/0'` |
| `sui` | `m/44'/784'/a'/0'/0'` (Sui Wallet / Slush, `sui keytool`) | `m/44'/784'/0'/0'/0'` |
| `algo` | `m/44'/283'/a'/0/0` (Ledger's Algorand app) | `m/44'/283'/0'/0/0` |
| `ton` | `m/44'/607'/a'` (Trust Wallet), v4R2 wallet | `m/44'/607'/0'` |
| `cosmos` | `m/44'/118'/a'/0/0` (Keplr, Leap, Ledger Live) | `m/44'/118'/0'/0/0` |

| Command | Arguments | Return | Notes |
|---|---|---|---|
| `vault_accounts_get` | — | `VaultAccountLists` | lists for the current network; each chain has at least `{ index: 0, name }` |
| `vault_account_add` | `{ chain, account, name }` | `VaultAccountLists` | vault unlocked; `account` ≤ 100, at most 20 accounts per chain, name 1–32 characters with no control character (leading and trailing spaces removed); already present → `INVALID_INPUT`. The UI first previews the account with `accounts_get({ account })` (address, path) and its balance |
| `vault_account_rename` | `{ chain, account, name }` | `VaultAccountLists` | vault unlocked; not in the list → `INVALID_INPUT` |
| `vault_account_remove` | `{ chain, account }` | `VaultAccountLists` | vault unlocked; account 0 → `INVALID_INPUT` |

```ts
type AccountChain = 'btc' | 'evm' | 'sol' | 'ltc' | 'doge' | 'tron' | 'xrp' | 'ada' | 'xlm' | 'bch' | 'dash' | 'sui' | 'algo' | 'ton' | 'cosmos' | 'zec';
type VaultAccountLists = { [C in AccountChain]: { index: number; name: string }[] };   // sorted by index; default name "Bitcoin 2" for index 1
```

**`account?` on vault commands.** All the commands that derive one of our addresses or sign take `account?` (absent = 0, so an old UI works unchanged; > 100 → `INVALID_INPUT`): `accounts_get`, `btc_address`, `btc_sign_psbt`, `evm_sign_tx`, `sol_decode_tx`, `sol_sign_tx`, `ltc_*`/`doge_*` `_address` and `_sign_psbt`, `zec_address` / `_send_preview` / `_sign`, `tron_address` / `_build_tx` / `_sign_tx` / `_broadcast`, `xrp_address` / `_build_tx` / `_sign_tx` / `_broadcast`, `ada_address` / `_build_tx` / `_sign_tx` / `_broadcast`, `cosmos_address` / `_build_tx` / `_sign_tx` / `_broadcast`, `algo_address` / `_build_tx` / `_sign_tx` / `_broadcast`, `stellar_address` / `_build_tx` / `_sign_tx` / `_broadcast`, `sui_address` / `_build_tx` / `_sign_tx` / `_broadcast`, `sol_stake_overview` / `_build` / `_sign` / `_broadcast`, `ada_stake_overview` / `_build` / `_sign` / `_broadcast`, `tron_stake_overview` / `_build` / `_sign`, `kas_address` / `_account` / `_txs` / `_build_tx` / `_sign_tx` / `_broadcast` (Kaspa reads the account's addresses, so its reads too). The read commands by address (`*_address_info`, `*_txs`, `tron_account`…) do not need it. `btc_core_setup` imports the descriptors of **all** the Bitcoin accounts in the list (an account added afterwards requires re-running the setup); the compact filters (`cbf`, disabled by default) still only watch account 0.

**Native dialog.** The first line of every vault signing window says **which account is signing**: "Signing account: Bitcoin 2 — m/84'/1'/1' (SegWit), m/86'/1'/1' (Taproot)" (EVM: plus the "From" address). An account that is **not** in the user's list is shown as "unknown" ("no. N, not in your list") with its path, and the signature requires a **2nd reinforced window** ("Warning: unknown account"). Bitcoin, Litecoin, Dogecoin: only the inputs of the chosen account are signed; an input from another vault account is foreign (2nd window already existing) and the change is only recognized within the chosen account.

**Done on the UI side** (commit of the accounts UI): Settings › Accounts (list per chain, "Add an account" which previews `accounts_get({ account })` and its balance, rename, remove), a set of adapters per account (`createAdapters(…, account)`, each adapter passes `account` to its signing commands), the account chosen per chain (remembered per network in `localStorage`, public data) used by Send / Receive / Swap / Staking / Asset, an "Account" selector always displayed for the vault (even with a single account; not for a hardware wallet), one row per account in Assets (totals added up), history of all accounts. **Demo mode**: lists, addresses, balances and signatures for BTC / EVM / Solana / LTC / DOGE per account; TRON, XRP, Stellar, Cardano and staking simulated for the first account only (explicit error otherwise).

**Many addresses, easily** (no new command: `vault_account_add` called once per account, Rust checks every rule). The "Account" selector (Send, Receive, Swap, Staking, Asset) has a **"New account"** entry: it creates the next free number with its default name ("Bitcoin 2"), selects it and shows its address (read with `accounts_get({ account })` before the selection). Receive also has a visible "New account" button (the BTC/LTC "New address" stays) and shows the derivation path of the chosen account (`path` field of `accounts_get`, e.g. `m/44'/60'/0'/0/1` for "Ethereum 2"). Settings › Accounts: **"Create several…"** (1 to 10 at once, within the limit of 20 per chain; a failure along the way keeps the accounts already created). Send: **"My accounts"** next to "Address book" lists the **other** accounts of the same chain (name, short address, balance) and can create a new one as the recipient; choosing an account fills in the address, then it is an ordinary send (Rust decoding, native dialog, same checks). The summary names the recipient "Your account “X”" when the address belongs to one of your accounts. Pure functions tested: `planNewAccounts`, `otherOwnAccounts`, `ownAccountOf` (`apps/desktop/src/lib/accounts.ts`). Account 0's addresses do not change.

**Hardware wallets.** Already multi-account in their own way: `hw_account_add({ account })` registers one account per number (BTC `m/84'|86'/c'/a'`, EVM `m/44'/60'/0'/0/a`, Solana `m/44'/501'/a'/0'`), displayed as a separate wallet in the title bar selector; they are not (yet) grouped by chain like the vault accounts.

### 2.9c Simulation before signing (EVM)

`EvmAdapter.simulateBeforeSigning(tx, known)` runs in the review of a swap or an Earn call, before the password and the native window. Everything goes through the chain's RPC by `net_fetch`: no new host, no third-party service. Calls, in order of what the node offers: `eth_simulateV1` with `traceTransfers`, then `debug_traceCall` (`callTracer`, `withLog`), then `eth_call`; alongside, `eth_estimateGas`, and `eth_getCode` at `latest` and about 7 days back. It returns a `SimReport`: `status` (`traced`, `checked`, `failed`, `unavailable`), what you send and receive (net per asset), approvals (from the logs and the calldata) and warnings. It never blocks and never replaces the decoded review; Rust's native window does not read it.

### 2.9b Several wallets

A wallet is a recovery phrase with its own password. The first one stays in `coffre-<network>.kyrovault`, unchanged; added ones are `wallets-<network>/<id>.kyrovault`, written by the same `wallet_core::seal` (same format, no migration). `wallets-<network>.json` holds names and the last wallet opened; if it is missing or broken, only the first wallet shows and no file is touched.

- One wallet open at a time: every `wallet_*` that changes the active wallet ends the session first, so one seed at most is in memory. `vault_status.walletId` says which one is active.
- An unlock begun before a switch cannot open a session (`wallet_epoch`).
- Per wallet: password attempts (`<id>.attempts`), account lists (`settings.json` `walletAccounts`), and in the webview transactions, approvals, backup state, account choice and balance cache (key suffix `@<id>`). Monero caches and Bitcoin Core wallets were already keyed by the keys.
- Shared by the device: settings, servers, contacts, hardware-wallet accounts and watch addresses.

### 2.10 Network choice (mainnet / testnet)

The network is fixed **at launch** and never changes while the app is running. Order of priority (`src-tauri/src/network.rs`):

1. `KYRO_NETWORK` environment variable (`mainnet` or `testnet`, case-insensitive; any other value is ignored) — reserved for development;
2. the choice stored by `network_set` in `network.json` (app folder, public data: `{ "network": "mainnet" }`);
3. with no stored choice, if a vault exists on **only one** of the two networks (installation predating the choice): that network, so that an update never shows "Welcome" to someone who already has a vault;
4. otherwise the build default: **mainnet in release**, **testnet in debug** (`cfg!(debug_assertions)`).

Each network has its own files: `coffre-{mainnet|testnet}.kyrovault`, `hw-accounts-{mainnet|testnet}.json`, and its own account lists (`settings.json › accounts.<network>`). Switching networks **deletes nothing**: the other network's vault is kept and found again when you switch back. The settings (`settings.json`) are shared, custom servers are stored per network.

| Command | Arguments | Return | Notes |
|---|---|---|---|
| `network_get` | — | `NetworkInfo` | read-only, vault locked or not |
| `network_set` | `{ network }` | `boolean` (`true` = restart requested) | stores the choice; if it differs from the current network: locks the session (zeroize) then restarts the app (`AppHandle::request_restart`). Same network: only stores (`false`). Refused (`INVALID_INPUT`, nothing is stored): value other than `mainnet`/`testnet`; network imposed by `KYRO_NETWORK`; **a native signing window is open** (counter kept by `confirm_native`); a hardware wallet operation is in progress. No new network host |

```ts
type NetworkInfo = {
  network: 'mainnet' | 'testnet';                       // network of this run
  source: 'env' | 'saved' | 'vault' | 'default';        // where it comes from (order above)
  saved: 'mainnet' | 'testnet' | null;                  // content of network.json
  default: 'mainnet' | 'testnet';                       // build default
  canSwitch: boolean;                                   // false if KYRO_NETWORK imposes the network
  otherVaultExists: boolean;                            // a vault already exists on the other network (kept)
};
```

**Done on the UI side**: Settings › Networks and servers › "Network" (Main network — Real funds / Test network — Worthless tokens), a confirmation window that reminds the user that each network has its own vault (the other one is kept, not deleted), then a restart; welcome screen: a line "The vault will be created on the … network" with a link to switch; TESTNET badge in the status bar unchanged. **Demo mode**: `network_set` remembers the choice (`localStorage`, like the environment) and reloads the page on `?network=…`; `?network=` in the URL plays the role of `KYRO_NETWORK`.

### 2.11 Stellar (XLM)

Server: **the SDF's Horizon** (`horizon.stellar.org` / `horizon-testnet.stellar.org`, version 30 on 2026-11-01), Tor family `stellar`, never a fallback, no custom server yet. Stellar RPC is not used: it has no per-account history, and the SDF only publishes a public RPC endpoint for the testnet. Every build, signature and broadcast first checks Horizon's `network_passphrase` (another network → `SERVER_WRONG_NETWORK`); the network passphrase is in any case part of what is signed. **Rust builds the transaction**: sequence number (`/accounts` + 1), fee (90th percentile of the charged fees from `/fee_stats`, at least the base fee, at most **0.01 XLM**), **mandatory time bounds** `[0, last ledger time + 300 s]`, a single operation: **Payment** XLM if the recipient exists, **CreateAccount** otherwise; encoded as XDR by wallet-core. An envelope built by the server is never signed.

| Command | Arguments | Return | Notes |
|---|---|---|---|
| `stellar_backend_info` | — | `{ kind: 'default', network: 'mainnet' \| 'testnet', label, tor }` | |
| `stellar_address` | `{ account? }` | `string` | `m/44'/148'/{account}'` (SEP-0005), vault unlocked; `stellar_build_tx`, `stellar_sign_tx`, `stellar_broadcast` take the same `account?` |
| `stellar_account` | `{ address }` | `{ address, exists, balance /*stroops*/, sequence /*string*/, subentryCount, numSponsoring, numSponsored, sellingLiabilities, reserve, spendable, memoRequired, trustlines: [{ code, issuer, balance, limit }], baseReserve }` | `/accounts/{id}` + `base_reserve_in_stroops` of the latest ledger (**0.5 XLM**, base fee **100 stroops**, read live on 2026-11-01 on testnet and mainnet); `reserve` = (2 + entries + sponsored − sponsoring) × base reserve + XLM committed in offers; `spendable` = balance − reserve; `memoRequired` = SEP-0029 data entry `config.memo_required`; nonexistent account (404): `exists: false` |
| `stellar_txs` | `{ address }` | `[{ id, hash, type, from, to, amount: { kind: 'native', stroops } \| { kind: 'credit', code, issuer, stroops }, fee, time, successful, memo, txSource }]` | last 50 payments (`/accounts/{id}/payments?join=transactions`): Payment, CreateAccount, path payments (amount **received**); account merges ignored; text memo sanitized |
| `stellar_build_tx` | `{ to, amount /*stroops*/, memo?: { kind: 'text' \| 'id' \| 'hash', value }, account? }` | `{ envelope /*unsigned, base64*/, summary: StellarTxSummary, context: { account, destination, baseReserve, baseFee, ledgerTime } }` | refused before any build: recipient with `config.memo_required` **without a memo**; nonexistent recipient account and amount < 2 × base reserve (1 XLM); amount + fee > available; our account not created; M… or S… address; text memo > 28 bytes or containing a control / invisible character, ID > 2⁶⁴ − 1, hash ≠ 64 hex |
| `stellar_sign_tx` | `{ envelope, password, account? }` | `{ envelope /*signed*/, hash, summary, context }` | decodes (strict, source = us), **XLM only** (native Payment or CreateAccount), checks Horizon's network passphrase, refuses a time bound under 30 s or over 5 min, a stale sequence, a Payment to an account that does not exist (or a CreateAccount to an account that exists), **re-reads live** both accounts and the reserve and redoes the checks above; password → native dialog: signing account, recipient, **MEMO framed on its own line** (text between "…", ID, hash; or "NO MEMO" (AUCUN MÉMO) with the warning), amount, creation of the recipient account (reserve locked on their side), maximum fee (and usual fee), balance, locked reserve ((2 + entries) × 0.5 XLM), available, deadline and sequence, **signed network passphrase**; 2nd reinforced dialog if `requiresExtraConfirmation`; signature summary = displayed summary |
| `stellar_broadcast` | `{ envelope, account? }` | `string` (hash) | `stellar_verify_signed` (an ed25519 signature from the source = us, valid **on this network**) then `POST /transactions` (form `tx=`); Horizon answers once the transaction is in a ledger: 200 + identical hash → success; 400 → `INVALID_INPUT` with the codes (`tx_bad_seq`, `tx_too_late`, `op_underfunded`, `op_low_reserve`…) explained in French; 504 or lost response → `SERVER_UNREACHABLE` which says the transaction may have been transmitted (never silently resent; resending it as is is safe: same hash, sequence usable only once) |
| `stellar_tx_status` | `{ hash }` | `{ found, successful }` | `/transactions/{hash}` |
| `stellar_build_asset_tx` | `{ asset /*CODE-ISSUER*/, to, amount /*units, 7 decimals*/, memo?, account? }` | `{ envelope, summary, context }` | assets known to wallet-core only (`stellar_known_assets`: Circle's USDC, issuer `GA5Z…KZVN` on mainnet, `GBBD…LFLA5` on testnet). Payment of that asset. Refused: recipient does not exist, has no trustline for the asset, is not authorized by the issuer or has reached its limit, required memo (SEP-0029) missing, our trustline < amount, available XLM < fee. Balances come from `stellar_account` (`trustlines`, with `authorized`) |
| `stellar_build_trust_tx` | `{ asset /*CODE-ISSUER*/, enable: boolean, account? }` | `{ envelope, summary, context }` | ChangeTrust of the known asset, without a memo: `enable` = maximum limit (one 0.5 XLM base reserve locked; refused if the trustline already exists or if the available XLM do not cover reserve + fee), otherwise limit 0 (refused if the trustline does not exist or its balance is not zero; `removeTrustline` warning → second confirmation). `stellar_sign_tx` accepts a ChangeTrust or a Payment of an issued asset only for a known asset and redoes these checks live; the native dialog names the asset, the verified issuer (Circle) and the reserve |

Refused before any signature: any other operation (SetOptions — account takeover —, AccountMerge, ManageData, offers, path payments, claimable balances, sponsoring, clawback, Soroban…), more than one operation, fee bump and v0 envelopes, muxed accounts, V2 preconditions, "return" type memo or fees > 0.01 XLM without a 2nd window. ChangeTrust (trustlines, for USDC) is decoded and tested in wallet-core, but **not offered yet**: `stellar_sign_tx` refuses it. Hardware wallets: Ledger ("Stellar" app) and Trezor (`StellarSignTx`), `hw_sign_stellar_tx` (§2.3); the signature is verified against Kyro's hash and attached to its envelope.

**For the UI**: the **Memo** field (ID / text / hash) is permanently visible on the Send XLM screen, mandatory if `stellar_account(destination).memoRequired` (Rust refuses anyway); "at least 1 XLM" for a nonexistent recipient; display `spendable` and the explained reserve; M… / S… address: dedicated message. **Done**: `Family` `'xlm'` (chain `stellar`, asset `xlm`, 7 decimals, CoinGecko `stellar`), `Commands` types (`stellar_*`, `Accounts.stellar`, `AccountChain` `'xlm'`), demo backend (`mock-stellar.ts`), Send / Receive (address + QR, reserve) / Assets / History screens (memo, account creation), "Outgoing connections", multiple accounts. Adapter: `StellarAdapter` (`packages/chains/src/stellar/`), `stellarChain(network)`, TS strkeys in `@kyro/shared` (`stellar.ts`).

### 2.11 NEAR Protocol (NEAR transfers)

**Default** servers only (no custom NEAR server yet): JSON RPC `free.rpc.fastnear.com` (mainnet) / `test.rpc.fastnear.com` (testnet), history through FastNEAR's explorer API `tx.main.fastnear.com` / `tx.test.fastnear.com`; Tor family `near`, never a fallback. `near_build_tx` and `near_sign_tx` first check the network via `status` (expected `chain_id` **and** `genesis_hash`, node that is syncing refused: `near_backend::probe`); a NEAR transaction does not name its network, but its reference block exists on only one chain.

**Keys.** SLIP-10 ed25519, path `m/44'/397'/{account}'` (three hardened levels): that of `near-seed-phrase` (near-cli, MyNearWallet, Meteor; account 0 is the legacy `m/44'/397'/0'`). Official vector verified: the `near-seed-phrase` test phrase gives `ed25519:r4yuiZE45mzeZAENDEF2pWeFBJkW8mQYGx3rU46zCqh` (`crates/wallet-core/tests/near.rs`). **Address = implicit account**: the 64 lowercase hexadecimal characters of the public key; it exists on the chain after its first NEAR received. Named accounts (`alice.near`, `bob.testnet`) are only **recipients** (nearcore rules: 2–64 characters, `a-z 0-9 - _ .`, no separator at the start, at the end or doubled, uppercase refused).

**Rust builds the transaction**: `TransactionV0 { signer_id = our implicit account, public_key = our key, nonce = access key nonce + 1, receiver_id, block_hash = final block read with the access key, actions: [Transfer { deposit }] }`, Borsh-encoded by wallet-core, signed with ed25519 over `SHA-256(borsh)` (this SHA-256 is also the transaction hash, known before broadcast). **Strict decoding**: a single `Transfer` action, ed25519 key, no extra bytes, identical re-encoding; `TransactionV1`, any other action (FunctionCall, AddKey, DeleteAccount, Delegate…), several actions, another key or another signer: refused before any signature. No NEP-141 tokens (that would require signing `FunctionCall`s).

**Fees.** They are **not** in a NEAR transaction: they are charged at the gas price of the block that includes it. Rust reads `EXPERIMENTAL_protocol_config` (costs `action_receipt_creation` + `transfer`, and `create_account` + `add_key` when the transfer creates an implicit account; storage price) and `gas_price`: estimate = gas × current price; **bound** = 2 × gas × max(current price, protocol minimum price). Amount + bound must fit within the available balance (balance − storage reserve), otherwise refusal.

| Command | Arguments | Return | Notes |
|---|---|---|---|
| `near_backend_info` | — | `{ kind: 'default', network, label /*RPC host*/, history /*history host*/, tor }` | |
| `near_address` | `{ account? }` | `string` | implicit account of `m/44'/397'/{account}'`, vault unlocked; `near_build_tx`, `near_sign_tx`, `near_broadcast`, `near_tx_status` take the same `account?` |
| `near_account` | `{ accountId }` | `{ accountId, exists, balance, locked, storageUsage, storageReserve, spendable, hasContract }` (yoctoNEAR, decimal strings) | `view_account` (finality `final`); `storageReserve` = `storage_usage` × price per byte (10¹⁹ yocto, read live) − `locked`; `spendable` = balance − reserve; nonexistent account: `exists: false` |
| `near_txs` | `{ accountId }` | `[{ hash, from, to, kind: 'transfer' \| 'other', deposit, fee, height, time, success }]` | last 20 transactions (`/v0/account` then FastNEAR's `/v0/transactions`); `deposit` = sum of the `Transfer` actions **of the transaction itself** (an internal transfer from a contract does not appear there); `fee` = NEAR burned (transaction + receipts) |
| `near_build_tx` | `{ to, amount /*yoctoNEAR*/, account? }` | `{ tx /*Borsh hex, unsigned*/, summary: NearTxSummary, context: NearContext }` | refused before any build: our account nonexistent; key without full access (`FunctionCall`) or removed; **named** or `0x…` recipient nonexistent (a named account must exist, otherwise the fees are lost); amount + fee bound > available; transfer to self |
| `near_sign_tx` | `{ tx, password, account? }` | `{ signed /*Borsh hex*/, hash, summary, context }` | decodes (strict, signer and key = us), **re-reads live** both accounts, the access key (stale nonce → "rebuild" (reconstruis)) and the fees, refuses a reference block older than ≈ 1 h; password → native dialog: **signing account**, recipient and its kind (named / implicit / Ethereum-style), possible account creation, amount (NEAR and yoctoNEAR), **estimated fees and bound**, balance, storage reserve, available, key, nonce, reference block, hash; account not in the list: "unknown" (inconnu) + reinforced dialog; 2nd reinforced dialog if `requiresExtraConfirmation`; signature summary = displayed summary |
| `near_broadcast` | `{ signed, account? }` | `{ hash, status: 'success' \| 'failure' \| 'pending', message }` | `near_verify_signed` (strict decoding, ed25519 signature strictly verified, signer = us) then `send_tx` (`wait_until: EXECUTED_OPTIMISTIC`); node hash ≠ ours → `SERVER_UNREACHABLE`; `INVALID_TRANSACTION` → `INVALID_INPUT` with the cause; node timeout → `pending` |
| `near_tx_status` | `{ hash, account? }` | same shape | `tx` (`wait_until: NONE`): `pending` as long as unknown or not executed |
| `near_token_balances` | `{ accountId }` | `[{ contract, symbol, decimals, balance /*units*/, registered }]` | one row per NEP-141 token known to wallet-core (`near_known_tokens`: Circle's USDC `17208628…33a1` and USDt `usdt.tether-token.near` on mainnet, USDC `3e2210e1…b8af` on testnet); views `ft_balance_of` and `storage_balance_of` (non-null = registered). `near_txs` adds `tokens: [{ contract, direction, amount, counterparty }]`: NEP-297 `ft_transfer` events read **only** in receipts executed by these contracts |
| `near_build_token_tx` | `{ contract, to, amount /*units*/, account? }` | `{ tx, summary: NearTxSummary /*token set*/, context: NearContext /*token set*/ }` | contract known for the app's network only. Transaction to the contract: `ft_transfer({ receiver_id, amount })` (30 Tgas, 1 yoctoNEAR), preceded by `storage_deposit({ account_id: to, registration_only: true })` (30 Tgas, `storage_balance_bounds.min`, ≤ 0.0125 NEAR) when `storage_balance_of(to)` is null. wallet-core accepts only these two shapes, canonical JSON arguments (memo refused), known contract. Refused: named account does not exist, token balance < amount, available NEAR < deposit + prepaid gas (2 × 30 Tgas at most, largely refunded). `near_sign_tx` re-reads everything live (including the recipient's registration); the native dialog shows token, verified contract, decimals, amount, recipient (kind), storage deposit explained, attached NEAR, fees |

```ts
type NearTxSummary = { signerId; publicKey /*ed25519:…*/; nonce; receiverId; receiverKind: 'implicit' | 'ethImplicit' | 'named'; deposit /*yocto*/; blockHash; hash; warnings: Array<{ kind: 'ethImplicitReceiver' }>; requiresExtraConfirmation };
type NearContext = { account: NearAccountInfo; receiver: NearAccountInfo; createsAccount; gasPrice; feeEstimate; feeBound };
```

`0x…` recipient (Ethereum-style NEAR account, NEP-518, controlled by an Ethereum key): `ethImplicitReceiver` warning → reinforced dialog (an exchange's EVM deposit address is not a NEAR account). Hardware wallets: not supported (the UI disables NEAR for these accounts). Multiple accounts: `near` chain of the vault lists (§2.9).

**Done on the UI side**: `Family` `'near'`, `nearChain(network)` (24 decimals, CoinGecko `near`), `NearAdapter` (`packages/chains/src/near/`), shared identifier rules (`nearAccountKind`, `nearAccountIdProblem` in `@kyro/shared`), demo backend (`mock-near.ts`: demo address **not derived**, demo encoding), Send screens (recipient kind and existence, available, decoded summary, execution tracking), Receive (QR of the bare address, no payment link), wallet rows, Accounts, address book, "Outgoing connections".

### 2.11 Sui (SUI)

**Server**: the public **GraphQL** API of the Sui Foundation (`https://graphql.testnet.sui.io/graphql`, `https://graphql.mainnet.sui.io/graphql`), JSON POST over HTTPS, Tor family `sui`, never a fallback, no custom server (yet). Why not JSON-RPC: it was cut off on the Sui Foundation's public full nodes the week of 2026-07-27 (`fullnode.testnet.sui.io` answers "Method not found. JSON-RPC on public fullnodes has been deprecated", verified on 2026-11-01) and removed from the code in October 2026; its successors are gRPC (HTTP/2 + protobuf, which `net.rs` does not speak) and GraphQL (same transport as the other chains). Every response carries `chainIdentifier`, compared with the expected network (mainnet `4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S`, testnet `69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD`): any other value → `SERVER_WRONG_NETWORK`. The Sui Foundation presents these endpoints as rate-limited and "for development": a provider or your own GraphQL node would be safer for heavy use.

**Rust builds the transfer**: SUI coins of your address (`address.objects(filter: { type: "0x2::coin::Coin<0x2::sui::SUI>" })`, type, owner and identifier verified), largest first until covering amount + 0.05 SUI (all of them, at most 256, for "whole balance"); gas price = the epoch's reference price (`epoch.referenceGasPrice`); expiration = current epoch + 1; budget = computation + 1,000 units × price + max(0, storage − rebate) based on the **simulation of a draft** (`simulateTransaction` on the exact BCS bytes, formula from the official SDK); encoded by wallet-core. A transaction built by the server is never signed.

| Command | Arguments | Return | Notes |
|---|---|---|---|
| `sui_backend_info` | — | `{ kind: 'default', network: 'mainnet' \| 'testnet', label, tor }` | |
| `sui_address` | `{ account? }` | `string` | `m/44'/784'/{account}'/0'/0'`, vault unlocked; `sui_build_tx`, `sui_sign_tx`, `sui_broadcast` take the same `account?` |
| `sui_balance` | `{ address }` | `{ address, total, coin, addressBalance }` (MIST) | `address.balance(coinType: "0x2::sui::SUI")`: `coin` = coins (what Kyro spends), `addressBalance` = "address balance" (accumulator added to Sui in 2026), **displayed but not spent** by Kyro |
| `sui_txs` | `{ address }` | `[{ digest, timestamp, checkpoint, success, sender, change, fee, counterparty, otherCoins }]` | last 20 transactions that touch the address (`relation: AFFECTED`), most recent first; `change` = net SUI change of the address (fees included), `fee` = net gas if it sent it |
| `sui_build_tx` | `{ to, amount? /*MIST*/, all?: boolean, account? }` | `{ bcs /*base64*/, summary: SuiTxSummary, context: SuiContext }` | refused: incomplete address, short form, SuiNS name; no SUI coin (dedicated message if everything is in the address balance); amount + budget > coins; simulation failing. `context` = `{ balance, gasCoinsTotal, gasCoinBalances /*MIST of each coin, order of summary.gasCoins*/, referenceGasPrice, epoch, computationCost, storageCost, storageRebate, fee /*signed*/, receives /*whole balance: received according to the simulation*/ }` |
| `sui_sign_tx` | `{ bcs, password, account? }` | `{ bcs, signature, digest, summary, context }` | decodes (strict, sender = us); **re-reads live**: epoch and reference price (expiration ≥ current epoch, price ≥ reference and ≤ 10 × reference), each gas coin still ours **at the same version and digest**, amount + budget ≤ coins; **simulates the exact bytes** (success required; only SUI moves, between you and the recipient; the recipient receives exactly the amount); password → native dialog: signing account, recipient **in full** (reminder: no checksum), amount (SUI and MIST) or "ENTIRE BALANCE" (TOUT LE SOLDE) with the simulated received amount, token `SUI (0x2::sui::SUI)`, estimated fees (computation + storage − rebate), max budget, gas price and reference, number and total of the gas coins then **each coin** (full object identifier and version decoded from the bytes, balance re-read live; beyond 5: "… and N other coins" with their total), spendable balance, deadline epoch, digest; account not in the list → "unknown" (inconnu) + reinforced window; 2nd reinforced window if `requiresExtraConfirmation`; signature summary = displayed summary. Without an expiration epoch: refused (Kyro always sets one) |
| `sui_broadcast` | `{ bcs, signature, account? }` | `string` (digest) | `sui_verify_signed` (ed25519, key = sender = us) then `executeTransaction` (waits for finality); effects digest = local digest otherwise `SERVER_UNREACHABLE`; executed but failed (gas charged) → `INVALID_INPUT` with the error |
| `sui_tx_status` | `{ digest }` | `{ found, success, error, checkpoint }` | `transaction(digest)`: `found: false` until the indexer has it |
| `sui_token_balances` | `{ address }` | `[{ coinType, symbol, decimals, total, coin, addressBalance }]` (token units) | one row per token known to wallet-core (`sui_known_coins`: Circle's native USDC, `0xdba3…::usdc::USDC` on mainnet, `0xa1ec…::usdc::USDC` on testnet; no official USDT on Sui); `coin` = coins (what Kyro sends). `sui_txs` adds `tokens: [{ coinType, change, counterparty }]` for these tokens only (balance changes of the transaction), `otherCoins` now counts only the others |
| `sui_build_token_tx` | `{ coinType, to, amount? /*units*/, all?: boolean, account? }` | `{ bcs, summary: SuiTxSummary /*token set*/, context: SuiContext /*token set*/ }` | known token only. Rust reads the token's coins (type checked on each object, owner = us), picks at most 32 of them (the largest), passes them as `ImmOrOwnedObject` inputs: `MergeCoins(Input(0), [Input(1)…])` then `SplitCoins(Input(0), [amount])` + `TransferObjects`, or, for `all`, `TransferObjects([Input(0)])` of the merged coin; gas paid by separate SUI coins, simulated budget. Refused: insufficient token balance, more than 32 coins for `all`, not enough SUI for gas, failed simulation. `sui_sign_tx` then receives `coinType`: strict decoding (the bytes do not name the type), **every token coin re-read live** (same object, version and digest, of that type, ours), the simulation must move only that token between us and the recipient (exact amount) and our SUI for gas; the native dialog shows token, verified type, decimals, amount (and units), full recipient, merged coins, then gas |

Refused before any signature (see §1): anything that is not this particular transfer — Move call, input object, another token, sponsored transaction, gas paid from the address balance, `ValidDuring` expiration, `Result(0)` form… Stricter than "unknown → reinforced confirmation": Kyro only signs the bytes it built. Hardware wallets: not supported (`accounts.sui` absent → no adapter). **USDC on Sui: not done** (it would need `Object` inputs — USDC coins — and `MergeCoins`, hence a second BCS template and its token table; left aside to keep a single verified template).

**On the UI side**: `Family` `'sui'`, `suiChain(network)`, asset `sui` (9 decimals, CoinGecko `sui`), `SuiAdapter` (`packages/chains/src/sui/`), Send screens (no fee to choose, full address required, spendable balance, decoded summary, `sui_tx_status` tracking), Receive (QR of the bare address: no standard payment link), Asset, History, multiple accounts, "Outgoing connections", demo mode (`mock-sui.ts`: demo addresses in the right format but not derived from the seed, BCS replaced by base64 JSON).

### 2.11 Hedera (HBAR)

No custom server: Rust reaches the official **mirror node** (REST, reads) and the consensus nodes' **gRPC-web proxies** (broadcast), Tor family `hedera`, never a fallback. **Rust builds the CryptoTransfer**: payer = our `0.0.x` account (read from the mirror node), one debit from the payer and one credit to the recipient, `transactionValidStart` = now − 10 s, duration 180 s (network maximum), **maximum** fee = 0.5 ¢ (10 ¢ if the transfer creates the recipient account) at the mirror node's exchange rate, bounded to 0.01 … 5 HBAR (only the actual fees, ≈ $0.0001, are charged); **one copy per node** (`nodeAccountID` is in the signed body), same transaction ID: the network executes at most one of them. Encoded by wallet-core.

**Key and account.** ECDSA secp256k1 key `m/44'/3030'/0'/0/{account}` (standard path of the Hedera SDKs and HashPack for an ECDSA account; official SDK vectors). The vault "address" is the **EVM address** of this key: the first HBAR sent to this address **creates** the account (HIP-583, "hollow" account without a key until we have signed something; our first send sets the key: the `SignaturePair` carries the full 33-byte key). Kyro looks up the account by EVM address (`/api/v1/accounts/{0x…}`), then by public key (`account.publickey`): an account found by key but with a different EVM address must receive **only** through its `0.0.x` (`foundBy: 'publicKey'`). ED25519 (Ledger, old HashPack accounts): not supported.

**Broadcast.** `POST https://{proxy}/proto.CryptoService/cryptoTransfer`, `content-type: application/grpc-web+proto`, body = gRPC-web frame (`0x00`, 4-byte length, `Transaction`); the response contains a data frame (`TransactionResponse.nodeTransactionPrecheckCode`) and a trailer frame (`grpc-status`). Plain HTTP/1.1 is enough: no HTTP/2, no JSON-RPC relay. Proxies (those of the Hedera JS SDK, `MAINNET` / `WEB_TESTNET`, verified on 2026-11-01): mainnet `node00.swirldslabs.com` (0.0.3), `node01-00-grpc.swirlds.com` (0.0.4), `node04.swirldslabs.com` (0.0.7); testnet `testnet-node00-00-grpc.hedera.com` (0.0.3), `testnet-node01-00-grpc.hedera.com` (0.0.4), `testnet-node02-00-grpc.hedera.com` (0.0.5). Copy after copy: `OK` or `DUPLICATE_TRANSACTION` → sent; `BUSY`, `PLATFORM_NOT_ACTIVE`, `PLATFORM_TRANSACTION_NOT_CREATED`, `THROTTLED_AT_CONSENSUS` or unreachable node → next copy; any other code → `INVALID_INPUT` with the code name (nothing is executed, a rejection at precheck is not billed).

| Command | Arguments | Return | Notes |
|---|---|---|---|
| `hbar_backend_info` | — | `{ network: 'mainnet' \| 'testnet', label /*mirror node host*/, tor }` | |
| `hbar_address` | `{ account? }` | `string` | EVM address (EIP-55) of `m/44'/3030'/0'/0/{account}`, vault unlocked; `hbar_account`, `hbar_build_tx`, `hbar_sign_tx`, `hbar_broadcast` take the same `account?` |
| `hbar_account` | `{ account? }` | `{ address /*our EVM address*/, accountIdChecksum, exists, accountId, evmAddress, balance /*tinybars*/, hollow, deleted, receiverSigRequired, foundBy }` | our account at the mirror node (by alias, otherwise by public key); the response must carry our EVM address or our key, otherwise `SERVER_UNREACHABLE`; `exists: false` before the first HBAR received |
| `hbar_recipient` | `{ to }` | `{ to, isEvm, exists, accountId, evmAddress, balance, hollow, deleted, receiverSigRequired }` | `to`: `0.0.x` (optional HIP-15 checksum, verified for this network) or `0x…` (EIP-55; long-zero → `0.0.x`) |
| `hbar_txs` | `{ accountId }` | `[{ id, name, result, time, fee, memo, delta, amount, counterparty, outgoing }]` | last 50 transactions (`/api/v1/transactions?account.id=…`); amounts in tinybars (strings); `amount` = HBAR exchanged with the counterparty (fees excluded for a send); memo sanitized |
| `hbar_build_tx` | `{ to, amount /*tinybars*/, memo?, account? }` | `{ bodies /*unsigned TransactionBody per node, hex*/, summary: HbarTxSummary, context: { account, recipient, createsAccount } }` | refused before any build: our account nonexistent; `0.0.x` recipient unknown, deleted or requiring its signature (`receiverSigRequired`); transfer to self; memo > 100 bytes or with a control / invisible character; amount + max fee > balance |
| `hbar_sign_tx` | `{ bodies, password, account? }` | `{ signed /*signed Transaction per node, hex*/, summary, context }` | decodes (strict, payer = us, nodes from the list), refuses a body less than 45 s from the end of its validity, **re-reads live** our account and the recipient and redoes the checks above, password → native dialog: recipient (EVM address flagged, and its account according to the mirror node), amount, creation of the recipient account, maximum fee, payer and balance, validity, ID, nodes, then the **MEMO framed on its own line** (or "NO MEMO" (AUCUN MÉMO) with the warning); 2nd reinforced dialog if `requiresExtraConfirmation`; signature summary = displayed summary |
| `hbar_broadcast` | `{ signed, account? }` | `string` (`0.0.x@s.n`) | `hbar_verify_signed` of each copy (low-S, key = ours, copies identical except for the node, known and distinct nodes) then gRPC-web submission (see above) |
| `hbar_tx_status` | `{ id /*0.0.x@s.n or 0.0.x-s-n*/ }` | `{ found, result }` | `/api/v1/transactions/{id}`: `found: true` and `result: 'SUCCESS'` once at consensus |
| `hbar_token_holdings` | `{ accountId /*0.0.x*/ }` | `[{ tokenId, associated, balance /*units*/, frozen }]` | known tokens only (USDC `0.0.456858` on mainnet, `0.0.429274` on testnet), mirror node `/accounts/{id}/tokens?token.id=…` |
| `hbar_build_associate_tx` | `{ tokenId, account? }` | like `hbar_build_tx` (`summary.token.associate` = true, `amount` "0", `to` = our account) | `TokenAssociateTransactionBody` (field 40: account = the payer, a single known token); refused if already associated or the account is missing; maximum fee like an account creation (≈ $0.05). Signed by `hbar_sign_tx`: native dialog "Associate USDC" with token, verified ID, decimals |
| `hbar_build_token_tx` | `{ tokenId, to, amount /*token units*/, memo?, account? }` | like `hbar_build_tx` (`summary.token`, `amount` in token units, `context.token`) | CryptoTransfer with a single `TokenTransferList` (known token, debit of the payer, credit of the recipient, `expected_decimals` = Kyro's table), no HBAR transfer. wallet-core refuses any other token, NFTs, several lists, HBAR + tokens, missing or different decimals, and (network-less API `hbar_decode_tx` / `hbar_sign`) every token. Refused beforehand: token not associated or frozen on our side, insufficient balance, recipient frozen, or neither associated nor with automatic association (`max_automatic_token_associations` = 0); HBAR < maximum fee. History: `hbar_txs` adds `tokenTransfers` (net change per token), the adapter keeps the known tokens. Hardware (Ledger ED25519) accounts: HBAR only for now |

Refused before any signature: everything that `HbarTransfer::decode` refuses (§1) — another transaction type (CryptoUpdate, CryptoApproveAllowance, CryptoDelete, ContractCall, EthereumTransaction…), HTS tokens, `is_approval`, hooks, scheduled transactions. The mirror node can lie about **our** account ID (the transaction would then fail with `INVALID_SIGNATURE`, without fees), the balance, the recipient's existence and its "signature required" flag, the exchange rate (displayed max. fees); not about what is signed. An EVM address is signed **as is** (alias): the network, not the mirror node, decides which account is credited. Hardware wallets: `HW_UNSUPPORTED`.

**Done on the UI side**: `Family` `'hbar'` (`hbarChain(network)`, key `hedera`, CoinGecko `hedera-hashgraph`), `AccountChain` `'hbar'`, `Commands` types (`hbar_*`, `Accounts.hbar`), demo backend (`mock-hbar.ts`), Send screens (**Memo** field always visible under the recipient, state of our account, recipient refusal before construction, `hbar_tx_status` tracking), Receive (`0.0.x` identifier with HIP-15 checksum when the account exists, otherwise the EVM address and the explanation of automatic creation), Asset (account identifier), address book, "Outgoing connections". Adapter: `HbarAdapter` (`packages/chains/src/hedera/`).

### 2.11 Kaspa (KAS)

Server: the public Kaspa developers REST API (`kaspa-rest-server`) — `api.kaspa.org` (mainnet), `api-tn10.kaspa.org` (testnet-10), no key, Tor family `kaspa`, never a fallback; **no custom server** for now. Network verified on every read (`GET /info/network`: `networkName` = `kaspa-mainnet` / `kaspa-testnet-10`, otherwise `SERVER_WRONG_NETWORK`). **Rust builds the transaction** (wallet-core `kaspa_build_send`) from the coins read by Rust; a transaction built by the server is never signed.

**Derivation** (identical to Kaspa NG, Kaspium and the rusty-kaspa wallet, official vectors replayed): BIP39 → BIP32 secp256k1, `m/44'/111111'/a'/0/i` (receive) and `m/44'/111111'/a'/1/i` (change), **same path on testnet-10** (only the prefix changes: `kaspatest:`). Displayed address: `…/0/0`; change: `…/1/0`; read (balance, coins, history): `…/0/0..19` and `…/1/0..19` (40 addresses, one request). P2PK **Schnorr** addresses (BIP340, x-only key, script `OP_DATA_32 ‖ key ‖ OP_CHECKSIG`). Hardware wallets: not offered.

| Command | Arguments | Return | Notes |
|---|---|---|---|
| `kas_backend_info` | — | `{ kind: 'default', network: 'mainnet' \| 'testnet', label, tor }` | `label` = `api.kaspa.org` / `api-tn10.kaspa.org` |
| `kas_address` | `{ account? }` | `string` | vault unlocked; `m/44'/111111'/{account}'/0/0` (also in `accounts_get`: `kas: { address, path }`) |
| `kas_account` | `{ account? }` | `{ address, balance, spendable, utxoCount, scanned }` | sompi as decimal strings; `balance`: `POST /addresses/balances` of the 40 addresses; `spendable` / `utxoCount`: `POST /addresses/utxos`, excluding coinbase coins younger than 2,000 DAA (2 × the maturity); **each coin must pay exactly the P2PK script of the address under which it is listed, which must be ours**, otherwise `SERVER_UNREACHABLE` for the whole list; more than 5,000 coins: `INVALID_INPUT` (consolidate first) |
| `kas_txs` | `{ account? }` | `[{ txid, time, delta /*signed*/, fee, counterparty, accepted }]` | `POST /addresses/active` then `GET /addresses/{a}/full-transactions?limit=50&resolve_previous_outpoints=light` for at most 10 active addresses (the most recent); merged by txid, 50 at most, most recent first; `delta` = received − spent by our addresses; a transaction that touches none of our addresses is discarded; `counterparty` only if it is a valid address of the network |
| `kas_tx_status` | `{ txid }` | `{ found, accepted }` | `GET /transactions/{txid}` (404 → `found: false`) |
| `kas_build_tx` | `{ to, amount? /*sompi*/, max?, account? }` | `{ tx /*unsigned JSON*/, summary: KaspaTxSummary, context: { feerateEstimate, priorityFeerate, spendable } }` | refused before any construction: invalid address or one from another network, amount < **0.2 KAS** (KIP-9 storage mass), insufficient funds, more than 84 coins needed. Fees: `GET /info/fee-estimate` (`normalBuckets[0].feerate`, sompi/gram); at the minimum (100, calm network), fee = **100 sompi × relay mass** (mempool rule since Toccata, like the official wallet); above that, estimate (≤ 10,000) × total mass. `max`: all coins (≤ 84), a single output, no change |
| `kas_sign_tx` | `{ tx, password, account? }` | `{ tx /*signed JSON*/, txId, summary }` | strict JSON (unknown fields refused), not already signed; **re-reads the coins live**: each input must be an unspent coin of this account (otherwise `INVALID_INPUT` "rebuild"); amounts and scripts come from this re-read; `kaspa_tx_summary` (refusals listed in §1) → password → native dialog: each recipient (full address, amount), change ("comes back to you"), fee (KAS and sompi), **mass** (compute, KIP-9 storage, transient), minimum relay fee, number and total of the inputs, "No change…" if there is none, identifier; **hardened 2nd dialog** if `requiresExtraConfirmation` (output of unknown script, fee > 1 KAS or > 10 × the minimum); the signature summary = the displayed summary |
| `kas_broadcast` | `{ tx, account? }` | `string` (txid) | coins re-read live, `kaspa_tx_summary`, **each signature verified** (`kaspa_verify_signed`) then `POST /transactions` `{ transaction, allowOrphan: false }`; the returned identifier must be ours, otherwise `SERVER_UNREACHABLE`; node refusal (HTTP 400) → `INVALID_INPUT` with its message |

Signed transaction: **version 0** only (what the official wallet still builds; the Toccata v1 format is neither produced nor signed), native subnetwork, gas 0, empty payload, lock time 0, sequence 0, one sig-op per input, `SIG_HASH_ALL`, signature script `OP_DATA_65 ‖ signature(64) ‖ 0x01`. Mass (grams): compute = bytes + 10 × (2 + script bytes) per output + 1,000 per sig-op; transient = 4 × bytes (÷ 2 once normalized); KIP-9 storage = `C · (Σ p²/output − Σ p²/input)` (relaxed form for 1 output, 1 input or 2:2; otherwise arithmetic mean of the inputs), C = 10¹²; total mass ≤ 100,000. Example: 1 input, 2 outputs = 2,036 g → 0.002036 KAS.

**Done on the UI side**: `Family` `'kas'`, `kaspaChain(network)` (testnet = testnet-10), asset `kas` (CoinGecko `kaspa`), `Commands` types (`kas_*`, `Accounts.kas`, `AccountChain` `'kas'`), TS address (`isKaspaAddress`, `kaspaAddressProblem`, same vectors as Rust), demo backend (`mock-kaspa.ts`), `KaspaAdapter` (`packages/chains/src/kaspa/`), Send screens (no fee to choose, minimum 0.2 KAS, spendable, transaction decoded with mass before the password, acceptance tracking), Receive (address `…/0/0`, no payment link), Asset, History, address book, poisoning alert (after `kaspa:q`), "Outgoing connections".

### 2.11 Polkadot (DOT on Polkadot Asset Hub)

Since the migration to Asset Hub (Polkadot, November 2025), DOT balances and transfers live on **Polkadot Asset Hub** (parachain 1000, `statemint`), not on the relay chain (verified on 01/11/2026: `Balances.TotalIssuance` ≈ 1.71 billion DOT on Asset Hub, ≈ 245,000 on the relay chain). Testnet: **Westend Asset Hub** (`westmint`, WND, 12 decimals, SS58 prefix 42). Node: Parity's (`polkadot-asset-hub-rpc.polkadot.io`, `westend-asset-hub-rpc.polkadot.io`), Substrate JSON-RPC over HTTPS, Tor family `polkadot`, never a fallback; no custom server for now.

**Keys**: sr25519 derived from the BIP39 **entropy** by `substrate-bip39` (mini-secret = PBKDF2-HMAC-SHA512(entropy, "mnemonic" ‖ passphrase, 2048)[..32]), like **Polkadot.js, Nova, Talisman and SubWallet**: Kyro's account 0 is the root account they display for the same phrase. Account `a ≥ 1` = hard derivation `phrase//a` (Polkadot.js notation): another wallet that numbers its accounts differently (for example `//0` for the 2nd) will give other addresses for those accounts. **Not Ledger-compatible**: Ledger's Polkadot app derives in ed25519 (`m/44'/354'/a'/0'/0'`, BIP32-Ed25519); a Ledger phrase imported into Kyro gives a different address. Verified against Polkadot.js (root, `//1`, `//2` of three phrases).

**Rust builds the transfer**: genesis read and compared with the pin; V15 metadata (`state_call Metadata_metadata_at_version(15)`, ≈ 0.7 MB, cached per runtime version) **verified by wallet-core**: the call index of `Balances.transfer_keep_alive` (`0x0a03`) is **pinned** and must be confirmed by the metadata, like its arguments and each transaction extension (unknown → refusal); `spec_version` / `transaction_version` of the metadata = those of `state_getRuntimeVersion`; nonce `system_accountNextIndex`; mortal era of 256 blocks from the last finalized block (`chain_getFinalizedHead`); tip 0; fees paid in DOT (`asset_id = None`); `CheckMetadataHash` disabled (mode 0, `None`); fees estimated by `TransactionPaymentApi_query_info` on a copy with a null signature. A node that lies about the metadata can only make the transaction invalid: the call and its encoding are Kyro's, and genesis, versions and era block are signed.

| Command | Arguments | Return | Notes |
|---|---|---|---|
| `dot_backend_info` | — | `{ network, chain, symbol, decimals, ss58, label, tor }` | |
| `dot_address` | `{ account? }` | `string` | vault unlocked (sr25519 root kept in session, like the Cardano root); `dot_build_tx`, `dot_sign_tx`, `dot_broadcast` take the same `account?` |
| `dot_account` | `{ address }` | `{ address, exists, free, reserved, frozen, spendable, nonce, existentialDeposit }` (planck) | `System.Account` (`state_getStorage`); `spendable` = free − max(frozen − reserved, existential deposit): what `transfer_keep_alive` and the fees can take; existential deposit read from the metadata (0.01 DOT; Westend 0.001 WND) |
| `dot_build_tx` | `{ to, amount /*planck*/, account? }` | `{ payload /*hex*/, summary: DotTxSummary, context: { account, destination, existentialDeposit, fee, eraBirth, validUntil, finalized } }` | refused before any construction: address from another network (SS58 prefix), send to self, nonexistent recipient and amount < existential deposit, amount + fee > available, our account nonexistent, unrecognized runtime |
| `dot_sign_tx` | `{ payload, password, account? }` | `{ extrinsic, hash, blockHash, summary, context }` | decodes (strict, see §1) with the **current** runtime, verifies the era block (known, finalized, consistent phase, at least 16 blocks of validity remaining), the nonce, **re-reads live** both accounts and the fees, redoes the checks; password → sr25519 root re-derived from the vault → native dialog: chain, recipient, amount (DOT and planck), account creation, estimated fee, balance, locked, existential deposit, available, call, tip, deadline block, nonce, runtime; the signature summary = the displayed summary. No 2nd dialog: nothing unusual is accepted, everything is refused |
| `dot_broadcast` | `{ extrinsic, blockHash, account? }` | `string` (hash) | `dot_verify_extrinsic` (sr25519 signature of our key over the payload rebuilt with the current runtime and `blockHash`) then `author_submitExtrinsic`; node refusal (1010…) → `INVALID_INPUT`; node hash ≠ blake2-256(extrinsic) → `SERVER_UNREACHABLE` |
| `dot_tx_status` | `{ address, nonce, validUntil }` | `{ state: 'pending' \| 'finalized' \| 'expired', finalized }` | by the nonce in the **finalized** state: `finalized` = the transaction of this nonce is included (Kyro does not decode events: an included but failed transfer would also consume the nonce); `expired` = era passed and nonce unused |
| `dot_txs` | `{ address }` | `{ available, partial, items: [{ id, hash?, chain: 'assetHub' \| 'relay', blockHeight, extrinsicIndex?, eventIndex?, time (ms), from, to, amount (planck), direction: 'in' \| 'out' \| 'self' }] }` | **never an error**: `available: false` (testnet, Statescan unreachable or unexpected response); `partial` = one of the two chains could not be read; `id` = extrinsic hash if known, otherwise `ahp:{block}-{index}` / `relay:{block}-{index}` |
| `dot_asset_balances` | `{ address }` | `[{ assetId, balance /*units*/, frozen, minBalance }]` | known tokens only (Polkadot Asset Hub: USD₮ asset 1984, USDC asset 1337; none on Westend); `Assets.Metadata` read and compared with Kyro's table (symbol `USDt` / `USDC`, 6 decimals) first, `Assets.Asset` (minimum balance, status), `Assets.Account` |
| `dot_build_asset_tx` | `{ assetId, to, amount /*token units*/, account? }` | like `dot_build_tx` (`summary.call` = `Assets.transfer_keep_alive`, `summary.asset`, the token's `amount` / `symbol` / `decimals`; `context.asset`) | `Assets.transfer_keep_alive(Compact(id), MultiAddress::Id, Compact(amount))`, indices pinned (pallet 50, call 9) and confirmed by the V15 metadata (arguments, layouts of `Assets.Account` / `Asset` / `Metadata`): otherwise tokens are refused, DOT keeps working. Fees in DOT (`asset_id = None`). Refused: unknown asset, asset frozen / not Live, our balance frozen, recipient blocked, amount > balance − the token's minimum balance (it stays on the account), new holder below the minimum balance, insufficient DOT for fees. Signed by `dot_sign_tx`: native dialog with token, verified ID, decimals, amount, our token balance. No token history (Statescan does not provide it in a verified form) |

**History: Statescan (no key, mainnet only).** A Substrate node does not index transfers by account, and Subscan requires an API key ("Unauthenticated access is disabled", verified on 01/11/2026). Rust reads **Statescan**'s public REST API: `GET https://ahp-api.statescan.io/accounts/{ss58}/transfers?page=0&page_size=50` (Asset Hub) and the same route on `polkadot-api.statescan.io` (relay chain, transfers from before the migration), then `GET /extrinsics/{block}-{index}` → `hash` (at most 12 new ones per call, cached for the session). Undocumented API: defensive reading (`balance` decimal or `0x…` hexadecimal, `extrinsicIndex` absent for a transfer without an extrinsic, malformed entries ignored one by one), only native transfers (`isNativeAsset`) where our account (compared by account identifier) is sender or recipient are kept. Westend: no Statescan API, so unavailable. The UI says "history unavailable" instead of showing "no transactions" when nothing could be read. Hardware wallets: `HW_UNSUPPORTED`.

**Done on the UI side**: `Family` `'dot'`, `AccountChain` `'dot'`, `Accounts.polkadot`, `Commands` types (`dot_*`), demo backend (`mock-dot.ts`, demo key: not the real sr25519 derivation), Send (available, existential deposit, fee, Rust preview, nonce tracking), Receive (address, path, existential deposit), Asset, "Outgoing connections". Adapter: `PolkadotAdapter` (`packages/chains/src/polkadot/`), `polkadotChain(network)`.

### 2.11 Algorand (ALGO payments)

Default servers, **no key** (AlgoNode / Nodely free tier): algod `mainnet-api.algonode.cloud` / `testnet-api.algonode.cloud` (accounts, parameters, broadcast, tracking) and indexer `mainnet-idx.algonode.cloud` / `testnet-idx.algonode.cloud` (history), Tor family `algorand`, never a fallback. No custom server yet (your own algod / indexer): only these hosts are contacted. **Rust builds the payment**: `fee` = max(`min-fee`, `fee` per byte × signed size) from `/v2/transactions/params` (0.001 ALGO outside congestion), `fv` = `last-round`, `lv` = `fv` + 200 (≈ 9 min; the protocol allows 1000), `gen` / `gh` = those of wallet-core for the app's network (the server must announce exactly the same genesis, otherwise `SERVER_WRONG_NETWORK`), optional UTF-8 note; encoded by wallet-core in canonical msgpack. A transaction built by the server is never signed.

Keys: BIP39 (the vault's phrase), path **`m/44'/283'/a'/0/0` derived like Ledger's Algorand app** (Ledger OS BIP32-Ed25519, test vector of the Ledger app: account 123). **Not** the 25-word Pera / "Algorand Wallet" format (a raw key, with no BIP39 or derivation): a 25-word phrase cannot be imported into Kyro, and a Kyro phrase cannot be opened in Pera; it opens in Ledger Live (Algorand app) with the same addresses.

| Command | Arguments | Return | Notes |
|---|---|---|---|
| `algo_backend_info` | — | `{ kind: 'default', network: 'mainnet' \| 'testnet', label /*algod*/, indexer, tor }` | |
| `algo_address` | `{ account? }` | `string` | `m/44'/283'/{account}'/0/0`, vault unlocked; `algo_build_tx`, `algo_sign_tx`, `algo_broadcast` take the same `account?` |
| `algo_account` | `{ address }` | `{ address, exists, balance /*µALGO*/, minBalance, spendable, assets, authAddr, round }` | algod `/v2/accounts/{a}?exclude=all`; `minBalance` = the one computed by algod (**0.1 ALGO** + 0.1 per opted-in ASA / application…); `spendable` = balance − `minBalance`; empty account: `exists: false` (it exists on chain only after ≥ 0.1 ALGO); `authAddr` ≠ null: "rekeyed" account, Kyro's key no longer signs for it |
| `algo_txs` | `{ address }` | `[{ id, type, from, to, amount, fee, closeTo, closeAmount, round, time, note }]` | indexer, last 50; `note` = sanitized UTF-8 text (or null); types other than `pay` kept with `amount: '0'` |
| `algo_build_tx` | `{ to, amount /*µALGO*/, note?, account? }` | `{ blob /*unsigned msgpack, hex*/, summary: AlgoTxSummary, context: { account, destination, round } }` | refused before any construction: rekeyed or empty account; amount + fee > `spendable`; recipient who would remain under its `minBalance` (empty account: at least 0.1 ALGO); note > 1024 bytes |
| `algo_sign_tx` | `{ blob, password, account? }` | `{ blob /*signed*/, txid, summary, context }` | decodes (strict, see below), refuses an exceeded validity window, **re-reads live** parameters (genesis) and both accounts and redoes the checks above, password → native dialog with what Rust decoded: recipient, amount, creation of the recipient account, fee, balance / minimum balance / available, **network (genesis id and hash)**, validity rounds, note (sanitized text, or hexadecimal if binary), identifier; hardened 2nd dialog if `requiresExtraConfirmation` (note, fee > 0.01 ALGO); the signature summary = the displayed summary |
| `algo_broadcast` | `{ blob, account? }` | `string` (txid) | `algo_verify_signed` (strict decoding, same refusals, ed25519 `verify_strict` signature by the sender = us, right network) then `POST /v2/transactions` (raw msgpack); node refusal → `INVALID_INPUT` with its message; server `txId` ≠ ours → `SERVER_UNREACHABLE` |
| `algo_tx_status` | `{ txid }` | `{ confirmed, round, error }` | algod `/v2/transactions/pending/{txid}` (`confirmed-round`, `pool-error`), then the indexer if it is no longer there; an Algorand block is final |
| `algo_asset_holdings` | `{ address }` | `[{ assetId, optedIn, amount /*units*/, frozen }]` | known tokens only (mainnet: USDC ASA 31566704, USD₮ ASA 312769; testnet: USDC 10458941), algod `/v2/accounts/{a}/assets/{id}` (404 = not opted in), ID of the response verified |
| `algo_build_optin_tx` | `{ assetId, account? }` | like `algo_build_tx` (`summary.asset.optIn` = true, `context.asset`) | opt-in: `axfer` transfer of 0 units to oneself; refused if already opted in or if `spendable` < 0.1 ALGO (minimum balance increase) + fee. Signed by `algo_sign_tx`: the native dialog shows "Enable USDC", the token, its verified ID, its decimals and the effect on the minimum balance |
| `algo_build_asset_tx` | `{ assetId, to, amount /*token units*/, note?, account? }` | like `algo_build_tx` (`summary.amount` = "0", `summary.asset`, `context.asset`) | `axfer` transfer of a known token; refused: token not opted in or frozen (on our side or the recipient's), token balance < amount, spendable ALGO < fee. wallet-core refuses any other asset, `aclose` (close-out) and `asnd` (clawback); the native dialog shows token, verified ID, decimals, amount, recipient and our token balance. Not on hardware wallets yet |

Refused before any signature (wallet-core `algo_decode_tx`): any type other than `pay` (`axfer`, `appl`, `keyreg`, `acfg`, `afrz`…), **`close` (close-remainder-to: the whole remaining balance would go elsewhere and the account would be closed)**, **`rekey` (control of the account would pass to another key)**, `grp` (grouped transaction), `lx` (lease), any unknown field, any encoding that does not re-encode **byte for byte** identically (key order, explicit empty field, non-minimal integer or length form, extra bytes), sender ≠ us, other network (`gen` or `gh`), null recipient or ourselves, null amount, fee < 0.001 ALGO, invalid `fv`…`lv` window or > 1000 rounds, note > 1024 bytes. Signed transaction: exactly `{ sig, txn }` (no `sgnr`, `msig`, `lsig`). Hardware wallets: not offered (the UI hides Algorand for a hardware wallet account).

**For the UI**: show `spendable` (not only the balance) and the minimum balance; for an empty recipient, "at least 0.1 ALGO"; the note is optional, public forever, ≤ 1024 bytes; after `algo_broadcast`, follow `algo_tx_status`. **Done on the UI side**: `Family` `'algo'`, `AccountChain` `'algo'`, `Commands` types (`algo_*`, `Accounts.algo`), demo backend (`mock-algo.ts`), Send screens (note, spendable balance, recipient minimum, decoded summary, tracking) / Receive (minimum balance explained, Ledger ≠ Pera) / Asset / History, "Outgoing connections". Adapter: `AlgorandAdapter` (`packages/chains/src/algorand/`), `algorandChain(network)`, CoinGecko price `algorand`.

### 2.11 Monero (XMR)

**Design: `monerod` node + local scanning.** Rust downloads the blocks (`get_blocks.bin`, pruned) and scans them **itself** with monero-wallet (`Scanner`, private view key in memory only); spent outputs are recognized by their *key images*, computed locally with the spend key. **No "light wallet" server** (MyMonero, `monero-lws`): they require the view key, so they see the entire incoming history. In return, the first synchronization downloads every block from the restore height (new vault: 1 day before the account was first opened on this device; restored phrase: Kyro's first release, block 3,790,000 ≈ 2026-10-22, since a Monero wallet derived by Kyro cannot be older, unless an older date or the genesis was chosen at restore time for a phrase already used with Monero on a Ledger; older later with `xmr_set_restore_height`). The scan resumes after a restart from the height saved after each batch. Scan state encrypted next to the vault (`monero/<network>-<account>-<key>.bin`). Reorganization: the hash of the last block is re-verified; on a mismatch, the last 30 blocks are rescanned. Hardware wallet: `HW_UNSUPPORTED`.

| Command | Arguments | Return | Notes |
|---|---|---|---|
| `xmr_backend_info` | — | `{ kind: 'default' \| 'node', network: 'mainnet' \| 'stagenet', label, tor }` | |
| `xmr_address` | `{ index?, account? }` | `string` | 0 = primary address; `n ≥ 1` = already-distributed subaddress only; the first call creates the scan state |
| `xmr_new_subaddress` | `{ account? }` | `{ index, address, received }` | next subaddress (100,000 at most), watched with a lookahead of 200 |
| `xmr_subaddresses` | `{ account? }` | `[{ index, address, received /*piconero*/ }]` | |
| `xmr_status` | `{ account? }` | `{ running, restoreHeight, scanned, tip, tipTime, progress /*0…1*/, balance, unlocked, syncedAt, error, subaddresses, ignoredOutputs, node }` | `unlocked` = spendable (10 confirmations, 60 for a coinbase); burned duplicate outputs or outputs with a timelock are ignored and counted |
| `xmr_sync` | `{ account? }` | `XmrStatus` | starts the scan in the background (no effect if it is running); stops on lock; `LOCKED` if locked |
| `xmr_txs` | `{ account? }` | `[{ txid, direction: 'in' \| 'out' \| 'self', amount, fee?, to?, height, time, confirmations }]` | local history (500 at most); `to` only for our sends |
| `xmr_validate_address` | `{ address }` | `XmrDestination` | Rust decoding (see §1) |
| `xmr_set_restore_height` | `{ height, account? }` | `XmrStatus` | forgets the scan state and restarts from `height`; refused during a scan |
| `xmr_prepare_tx` | `{ to, amount? /*piconero, absent = all available*/, account? }` | `{ id, summary: XmrTxSummary }` | Rust chooses the inputs (16 at most), downloads distribution and decoys, bounds the node's fee rate (4,000,000 piconero/max weight), sets the change to the primary address; the transfer **stays in Rust** (single use, 10 min) |
| `xmr_send_tx` | `{ id, password, account? }` | `{ txid, summary }` | password → native dialog (destination and its type, amount, fee, change, inputs, ring, node) → hardened 2nd window if `requiresExtraConfirmation` → signature → verification (exact outputs, fee, key images = planned outputs) → `send_raw_transaction` → outputs marked spent locally (released after 24 h if the transaction does not appear) |
| `xmr_seed_show` | `{ password, account? }` | — | 25-word Monero phrase + restore height, **in the phrase window only** (nothing is returned to the interface) |

Server: `Servers.monero.{mainnet,testnet}` = `{ kind: 'default' } | { kind: 'node', url }` (`https://` or `.onion` via Tor), verified on save (`get_info.nettype` and block 0 hash), never a fallback to the default node. Tor family `monero`, **fail closed** (`TOR_UNAVAILABLE` stays `TOR_UNAVAILABLE` through monero-daemon-rpc).

### 2.11 TON (Gram, formerly Toncoin — ticker GRAM since June 2026; wallet v4R2)

Server: **TON Center** (API v3), `toncenter.com` on mainnet, `testnet.toncenter.com` on testnet, Tor family `ton`, never a fallback; no custom TON server for now. The keyless tier ≈ 1 request/s per IP: all of the app's TON requests are spaced at least 1.1 s apart, one at a time, and a `429` is retried three times (see [NETWORK.md](NETWORK.md)). **Rust builds the transfer**: seqno and states read from TON Center (`walletInformation`), `valid_until` = now + 10 min, the network's wallet id, cells written by wallet-core; a message built by the server is never signed. Fees: **estimated** by emulation (`estimateFee`, signature not verified), displayed as "≈".

| Command | Arguments | Return | Notes |
|---|---|---|---|
| `ton_backend_info` | — | `{ network: 'mainnet' \| 'testnet', label /*host*/, tor }` | |
| `ton_address` | `{ account? }` | `string` | `m/44'/607'/{account}'`, vault unlocked, non-bounceable form `UQ…` (testnet `0Q…`) |
| `ton_account` | `{ address }` | `{ address /*UQ…*/, raw /*0:hex*/, status: 'active' \| 'uninit' \| 'frozen' \| 'nonexist', balance /*nanotons*/, seqno: number \| null, walletType: string \| null }` | user-friendly form only (raw `0:…` refused); address marked testnet (`kQ…` / `0Q…`) refused on mainnet; masterchain refused |
| `ton_txs` | `{ address }` | `[{ hash /*tx, hex*/, time, direction: 'in' \| 'out', counterparty, amount, fee, comment, bounced, success }]` | last 50 transactions of the account; an external message from our wallet gives one row per outgoing message (none: a "failed" row at 0); `success` = compute **and** action phases succeeded, no action skipped |
| `ton_build_tx` | `{ to, amount /*nanotons*/, comment?, sendAll?, account? }` | `{ boc /*unsigned, base64*/, summary: TonTxSummary, context: { account, destination, fee } }` | refused before any construction: frozen recipient, masterchain, our wallet empty (`uninit` at 0, `nonexist`) or frozen, amount + estimated fee ≥ balance, comment > 123 bytes. **Bounce** = flag of the entered address (`EQ…` yes, `UQ…` no), **cleared** if the recipient is not an active contract (otherwise the funds would come back). Wallet not yet deployed (`uninit` with a balance): seqno 0 and our `StateInit` in the message. `sendAll`: mode 130 (entire balance, fees deducted), amount 0 |
| `ton_jetton_balances` | `{ address }` | `[{ master /*EQ…*/, wallet /*EQ…*/, balance /*units*/ }]` | one row per known token (USD₮ on mainnet, none on testnet). `wallet` = token wallet **computed by wallet-core** (the master's token wallet code + our address); a TON Center row for another contract is ignored (balance 0) |
| `ton_jetton_txs` | `{ address }` | `[{ hash, time, direction, master, counterparty, amount /*units*/, comment, success }]` | `jetton/transfers` per known token; row kept only if `source_wallet` is the token wallet computed for the sender (a fake token contract does not pass) |
| `ton_build_jetton_tx` | `{ master /*EQ…*/, to, amount /*token units*/, comment?, account? }` | `{ boc, summary: TonTxSummary /*jetton filled in*/, context: { account, destination /*our token wallet*/, fee } }` | token known to wallet-core only; internal message (mode 3, bounce) to **our** computed token wallet, 0.05 TON attached, TEP-74 body `transfer#0f8a7ea5` (recipient, `response_destination` = our wallet, `forward_ton_amount` 1 nanoton, comment in the forward payload). Refused: token wallet absent, token balance < amount (re-read live, and again at signing), TON < 0.05 + fee. `ton_sign_tx` decodes the body and the native dialog shows token, contract (master), decimals, amount, recipient (both forms), framed comment |
| `ton_sign_tx` | `{ boc, password, account? }` | `{ boc /*signed*/, hash, normalizedHash, summary, context }` | decodes (strict, the network's wallet id, our wallet), refuses a message that is expired (or within 15 s of expiring) or valid for more than 12 min, **re-reads live** our wallet (seqno and deployment must match) and the recipient, re-estimates the fees and redoes the checks above; password → native dialog: recipient in the form of its bounce flag **and** in the other form ("same account"), **COMMENT framed on its own line** (or "NO COMMENT", with the exchange platform warning), amount in TON and nanotons (or "ENTIRE BALANCE"), bounce explained, estimated fee, balance, wallet deployment, validity and seqno; 2nd window if the comment contains invisible or control characters; signature, identical summary required |
| `ton_broadcast` | `{ boc, account? }` | `string` (normalized hash, hex) | `ton_verify_signed` (strict, valid ed25519 signature by our key, our network), refuses an expired message, then `POST /message`; a node refusal (seqno, expiration, signature) → `INVALID_INPUT` with its message; the hashes returned by TON Center must be ours, otherwise `SERVER_UNREACHABLE` |
| `ton_tx_status` | `{ hash /*normalized*/ }` | `{ found, success, txHash }` | `transactionsByMessage`: the transaction of our wallet that processed the message |

**For the UI**: the **Comment** field is always visible under the recipient on the TON Send screen (not hidden in "options"), with a byte counter (123 at most), and control and invisible characters are rejected before the call is even made; an "exchange platform" warning when it is empty; recipient state (not yet active → send without bounce, frozen → blocked); "MAX" = `sendAll`. Comparing a TON address is done **per account** (the `EQ…` and `UQ…` forms of the same account are the same address: `sameTonAccount`). Payment link on receive: `ton://transfer/<address>?amount=<nanotons>`. Hardware wallets: no TON.

### 2.11 Cosmos Hub (ATOM)

Rust chooses the server: the LCD (REST) by default — `cosmos-rest.publicnode.com` (mainnet, `cosmoshub-4`) or `rest.provider-sentry-01.hub-testnet.polypore.xyz` (the Hub's public testnet, chain-id `provider`) —, Tor family `cosmos`, never any fallback (neither to another server, nor in the clear). **No custom server yet** for Cosmos. Every state read checks the chain-id of the latest block (`blocks/latest`): a different network → `SERVER_WRONG_NETWORK`.

**Rust builds the transaction**: chain-id and height (`/cosmos/base/tendermint/v1beta1/blocks/latest`), `account_number` and `sequence` (`/cosmos/auth/v1beta1/accounts/{a}`: `BaseAccount` or vesting account; any other type is refused; so is a registered public key that is not ours), `timeout_height` = height + 100 (≈ 10 min), a single uatom `MsgSend`, memo, SIGN_MODE_DIRECT; the **exact** transaction (fees 0, empty signature) is simulated (`POST /cosmos/tx/v1beta1/simulate`): gas = used × 1.4 (refused above 500,000), fees = gas × the fee market price (`/feemarket/v1/gas_price/uatom`, refused above 1 uatom/gas; 0.005 uatom/gas — the Hub's `min_base_gas_price`, read on 2026-11-01 — if the server does not have this module) × 1.2, rounded up. Encoded by wallet-core; a transaction built by the server is never signed.

| Command | Arguments | Return | Notes |
|---|---|---|---|
| `cosmos_backend_info` | — | `{ kind: 'default', network, label, chainId, tor }` | |
| `cosmos_address` | `{ account? }` | `string` | `m/44'/118'/{account}'/0/0`, vault unlocked; one address per account; `cosmos_build_tx`, `cosmos_sign_tx`, `cosmos_broadcast` take the same `account?` |
| `cosmos_account` | `{ address }` | `{ address, exists, accountNumber, sequence, pubKey /*base64 or null*/, balance /*uatom*/, spendable /*uatom*/ }` | `auth/accounts` + `bank/balances/{a}/by_denom?denom=uatom` + `bank/spendable_balances/…` (vesting); account never seen (gRPC NotFound, HTTP 404): `exists: false` |
| `cosmos_txs` | `{ address }` | `[{ hash, height, time, from, to, amount, fee, memo, success }]` | uatom `MsgSend` only (other messages and IBC tokens are ignored), last 25 sent (`message.sender`) + last 25 received (`transfer.recipient`), sorted, 50 at most; `memo` sanitized; `fee` = `"0"` if we are not the one who paid it. **The public node only indexes recent blocks**: older history does not appear |
| `cosmos_build_tx` | `{ to, amount /*uatom*/, memo?, account? }` | `{ signDoc /*hex*/, summary: CosmosTxSummary, context: { account, height } }` | refused before any construction: sending to oneself, invalid address, memo > 512 characters, our account unknown to the network, amount + fees > `spendable`, simulation refused (node message, `INVALID_INPUT`) |
| `cosmos_sign_tx` | `{ signDoc, password, account? }` | `{ tx /*TxRaw base64*/, hash, summary, context }` | decodes (strict, key = us, the network's chain-id), **re-reads live** the latest block and our account: refuses an exceeded `timeout_height`, a different `account_number`, a stale sequence, insufficient balance; password → native dialog: recipient, amount (ATOM + uatom), fees (ATOM + uatom) and maximum gas, available and remainder after the send, chain-id, account number, sequence, limit block, then **MEMO boxed on its own line** (or "NO MEMO" with the exchange platform warning), after the amounts; 2nd reinforced dialog if `requiresExtraConfirmation` (with the exact memo in hexadecimal if it was sanitized); signature summary = displayed summary |
| `cosmos_broadcast` | `{ tx, account? }` | `string` (hash) | `cosmos_verify_signed` with the `account_number` read live (low-S signature of our key over the reconstructed SignDoc) then `POST /cosmos/tx/v1beta1/txs` (`BROADCAST_MODE_SYNC`); code 0 (or 19 of codespace `sdk`: already in the mempool) accepted, otherwise `INVALID_INPUT` with the code and the log; server hash = `SHA-256(TxRaw)` otherwise `SERVER_UNREACHABLE` |
| `cosmos_tx_status` | `{ hash }` | `{ included, success, code, height, log }` | `GET /cosmos/tx/v1beta1/txs/{hash}`; not yet in a block: `included: false` |

```ts
type CosmosWarning = { kind: 'highFee' } | { kind: 'unusualText' };   // all → reinforced confirmation
type CosmosTxSummary = { chainId; accountNumber; sequence; from; to; amount /*uatom*/; fee /*uatom*/; gasLimit;
                         memo: string | null /*sanitized*/; memoHex: string | null; timeoutHeight; warnings: CosmosWarning[];
                         requiresExtraConfirmation: boolean };
```

Refused before any signature: any other message (**MsgDelegate**, **MsgGrant** / authz, IBC **MsgTransfer**, MsgExec, MsgMultiSend…), a denomination other than `uatom` (IBC tokens), several messages or coins, SIGN_MODE_LEGACY_AMINO_JSON / TEXTUAL, multisig, fees paid by a third party (`payer`, `granter` / feegrant), "unordered" transactions (SDK 0.53), `timeout_timestamp`, extension options, `tip`. Stricter than "unknown → reinforced confirmation": a field that Kyro does not declare is never signed. Hardware wallets: no Cosmos `hw_*` command (Ledger "Cosmos" app, SIGN_MODE_LEGACY_AMINO_JSON: not done); the UI disables Cosmos for these accounts.

**For the UI**: the **Memo** field is always visible under the recipient (not in "options"), empty by default, with the warning "exchange platforms almost always require a memo"; 256 characters at most and no control characters (what the native window displays in full; Rust accepts 512 but then displays a truncated memo, hence reinforced); show `spendable` when it differs from the balance (vesting); after `cosmos_broadcast`, follow `cosmos_tx_status`.

### 2.11 Aptos (APT)

Server: Aptos Labs' REST fullnode, `https://api.mainnet.aptoslabs.com/v1` / `https://api.testnet.aptoslabs.com/v1` (public offering **without a key**), and its `/v1/graphql` indexer (same host) for history; Tor family `aptos`. Fallback fullnodes, tried in order: `api.*` first, then `fullnode.mainnet.aptoslabs.com` and `mainnet.aptoslabs.com` (mainnet) / `fullnode.testnet.aptoslabs.com` (testnet), same keyless Aptos Labs `/v1` API and `/v1/graphql` indexer. A host answering 403/429/5xx (Cloudflare refuses many Tor exits on `api.*`), a non-JSON page or a connection error is skipped for the next one; the last host that answered is tried first afterwards. Each host's `/v1` `chain_id` is checked before it serves anything (`SERVER_WRONG_NETWORK` otherwise); history failing on every host leaves balances working. **No custom server for now.** Before any construction, Rust reads `/v1` and refuses a `chain_id` other than that of the app's network (1 mainnet, 2 testnet: `SERVER_WRONG_NETWORK`). **Rust builds the transfer**: sequence number (`/accounts/{a}`), gas price (`/estimate_gas_price`, capped at 10,000 octas per unit), maximum gas = simulation gas (`/transactions/simulate`, null signature) × 1.5, between 200 and 20,000 units, expiration = ledger time + 10 min; BCS written by wallet-core. A transaction built by the server is never signed. The network requires the balance to cover **amount + maximum gas × price** up front: "send all" therefore sends balance − maximum fees (the unused part stays).

| Command | Arguments | Return | Notes |
|---|---|---|---|
| `aptos_backend_info` | — | `{ network: 'mainnet' \| 'testnet', label, tor }` | |
| `aptos_address` | `{ account? }` | `string` | `m/44'/637'/{account}'/0'/0'`, vault unlocked; `aptos_build_tx`, `aptos_sign_tx`, `aptos_broadcast` take the same `account?` |
| `aptos_account` | `{ address }` | `{ address, balance /*octas*/, sequenceNumber, authenticationKey, keyMatches }` | balance `/accounts/{a}/balance/0x1::aptos_coin::AptosCoin` (coin + primary fungible asset store); account never seen: sequence 0, balance 0; `keyMatches: false` = the account's key was changed (rotation): Kyro then refuses to build and to sign |
| `aptos_txs` | `{ address }` | `[{ version, hash, time, direction, amount, fee, counterparty, success, function, sentByUs }]` | last 50, indexer (`fungible_asset_activities`, APT as coin and as fungible asset `0xa`, grouped by transaction: deposits − withdrawals, gas separate) + `/accounts/{a}/transactions` (our sends: hash and recipient); `counterparty` known only for our sends |
| `aptos_build_tx` | `{ to, amount /*octas*/, account? }` | `{ raw /*RawTransaction BCS hex*/, summary: AptosTxSummary, context: { account, recipientNew, gasUsed, ledgerTime } }` | refused before any construction: address refused (see §1), key changed, amount > balance, simulation that fails (its `vm_status` is given), simulated gas > 13,333 units, amount + maximum fees > balance |
| `aptos_sign_tx` | `{ raw, password, account? }` | `{ signed /*hex*/, hash, summary, context }` | decodes (strict, sender = us, the app's `chain_id`), refuses an expiration less than 30 s or more than 11 min away, **re-reads live** the account (identical sequence, key, balance ≥ amount + maximum fees) and **re-simulates**; password → native dialog: full recipient ("without checksum"), amount (APT and octas), creation of the recipient account, estimated fees (simulated gas × price) and maximum, balance, function, sequence, chain, expiration; 2nd reinforced dialog if `requiresExtraConfirmation`; signature summary = displayed summary |
| `aptos_broadcast` | `{ signed, account? }` | `string` (hash `0x…`) | `aptos_verify_signed` (a single ed25519 key = sender = us, right chain) then `POST /transactions` (BCS, `application/x.aptos.signed_transaction+bcs`); node refusal → `INVALID_INPUT` with its message; node hash ≠ computed hash → `SERVER_UNREACHABLE` |
| `aptos_tx_status` | `{ hash }` | `{ committed, success, vmStatus }` | `/transactions/by_hash`: pending or not found = `committed: false` |
| `aptos_token_balances` | `{ address }` | `[{ metadata, symbol, decimals, balance }]` (token units) | one row per fungible asset known to wallet-core (`aptos_known_assets` for the app's chain: Circle's USDC `0xbae2…46f3b` and Tether's USDt `0x357b…dc2b` on mainnet, USDC `0x6909…2832` on testnet); `/accounts/{a}/balance/{metadata}` (0 without a store) |
| `aptos_token_txs` | `{ address }` | `[{ version, hash, time, metadata, direction, amount, counterparty, success }]` | indexer `fungible_asset_activities` filtered on the known metadata only (excluding gas fees), grouped by transaction; `counterparty` = recipient of our own `primary_fungible_store::transfer` |
| `aptos_build_token_tx` | `{ metadata, to, amount /*units*/, account? }` | `{ raw, summary: AptosTxSummary /*token set*/, context: AptosContext /*tokenBalance*/ }` | known asset only. `0x1::primary_fungible_store::transfer<0x1::fungible_asset::Metadata>(metadata, to, amount)`, gas paid in APT (simulated). wallet-core refuses any other function, another type argument, or metadata unknown for the transaction's chain ID. Refused: token balance < amount (re-read live, and again at signing), APT < maximum fee, key changed. `aptos_sign_tx` signs these transactions like the others; the native dialog shows token, verified metadata, decimals, amount (and units), full recipient, token balance, possible creation of their store, fees in APT |

**Rate limit**: Aptos Labs limits anonymous requests per IP (50,000 compute units per 5 minutes, Geomi documentation read on 2026-11-01). In Tor mode, the exit relay's IP is shared: a 429 response gives `SERVER_UNREACHABLE` with a clear message, never a new attempt in the clear. API key: not supported for now.

Hardware wallets: not offered (no `hw_*` command). What it would take: Ledger "Aptos" app (signing a BCS `RawTransaction` that the app displays); Kyro would verify the signature against its own signing message, as elsewhere.

**Done on the UI side**: `Family` `'apt'`, `AccountChain` `'apt'`, `Commands` types (`aptos_*`, `Accounts.aptos`), demo backend (`mock-aptos.ts`), Wallet / Asset / Receive (address only, no payment link) / Send (full address mandatory, "without checksum" warning, creation of the recipient account, estimated and maximum fees, Rust summary before the password, `aptos_tx_status` tracking) / History (poisoning decoys: zero amount, withdrawal not signed by us) screens, address book, "Outgoing connections". Adapter: `AptosAdapter` (`packages/chains/src/aptos/`), `aptosChain(network)`. Price: CoinGecko `aptos`.

### 2.12 Speed up or cancel (replacement of a pending send)

No new command: the signing commands take an optional `replaces`. Without it they behave as before.

| Command | Added argument |
|---|---|
| `btc_sign_psbt`, `ltc_sign_psbt`, `hw_sign_btc_psbt`, `hw_sign_utxo_psbt` (`ltc` only: any other coin is `INVALID_INPUT`) | `replaces?: { txid, rawTx, mode: 'speedUp' \| 'cancel' }` |
| `evm_sign_tx`, `hw_sign_evm_tx` | `replaces?: { hash, mode, tx: EvmTxRequest, yParity, r, s }`: the original's fields and signature, as read from `eth_getTransactionByHash` |

Before the native window, wallet-core checks the transaction to sign against the original and answers `INVALID_INPUT` (`replacement refused: …`) otherwise.

- `utxo_check_replacement(psbt, request, change)`: txid of `rawTx` recomputed; original marked replaceable (one input below `0xfffffffe`); every new input replaceable; exactly the same inputs; fee ≥ old fee + `RBF_INCREMENTAL_PER_VB` × estimated vsize. Speed-up: same outputs in the same order, only an output proven ours may lower. Cancel: a single output, proven ours. Fees are computed from the PSBT's input amounts, never read from a server.
- `evm_check_replacement(tx, request, own)`: hash recomputed from the fields and the signature; same chain and nonce; `maxFeePerGas` and `maxPriorityFeePerGas` each ≥ `evm_min_replacement_fee` (+10%, rounded up). Speed-up: same `to`, value, data and gas limit. Cancel: `to` = `own`, value 0, no data.

The window then starts with the action, the id replaced and the fees (`describe_utxo_replacement`, `describe_evm_replacement`). The interface builds the transaction with `planReplacement` (`BitcoinAdapter`, `UtxoAdapter` for Litecoin, `EvmAdapter`), which refuses early with `ReplaceRefused` (`confirmed`, `notReplaceable`, `notOurs`, `unknown`, `hasChild`, `noChange`, `tooSmall`, `unsupported`), and calls it again just before signing. Reads use the existing commands (`*_tx_hex`, `*_address_txs`, `net_fetch`): no new host.

## 3. Network allowlist (`net_fetch`)

| Host | Use |
|---|---|
| `api.coingecko.com`, `pro-api.coingecko.com` | prices, top 250, charts |
| `api.kraken.com` | « All » chart: public weekly OHLC (`/0/public/OHLC?pair=…&interval=10080`), no key, Tor family `market` |
| `mempool.space` | Bitcoin: UTXOs, fees, broadcast (Esplora) |
| `litecoinspace.org` | Litecoin (Esplora/mempool, mainnet `/api`, testnet4 `/testnet/api`): used by the Rust `ltc_*` commands, Tor family `litecoin` |
| `s.altnet.rippletest.net` (port 51234), `xrplcluster.com` | XRP Ledger testnet and mainnet (rippled JSON-RPC): used by the Rust `xrp_*` commands, Tor family `xrp` |
| `horizon-testnet.stellar.org`, `horizon.stellar.org` | Stellar testnet and mainnet (SDF's Horizon): used by the Rust `stellar_*` commands, Tor family `stellar` |
| `free.rpc.fastnear.com`, `test.rpc.fastnear.com`, `tx.main.fastnear.com`, `tx.test.fastnear.com` | NEAR mainnet and testnet (FastNEAR: JSON RPC and history API): used by the Rust `near_*` commands, Tor family `near` |
| `graphql.testnet.sui.io`, `graphql.mainnet.sui.io` | Sui testnet and mainnet (Sui Foundation's GraphQL, POST JSON): used by the Rust `sui_*` commands (balance, gas coins, epoch and reference price, simulation, execution, history), Tor family `sui` |
| `westend-asset-hub-rpc.polkadot.io`, `polkadot-asset-hub-rpc.polkadot.io` | Polkadot: Parity's public JSON-RPC nodes for Westend Asset Hub and Polkadot Asset Hub, used by the Rust `dot_*` commands, Tor family `polkadot` |
| `ahp-api.statescan.io`, `polkadot-api.statescan.io` | Polkadot: Statescan's public keyless REST API (Asset Hub, relay chain), read only by the Rust `dot_txs` command (history, mainnet), Tor family `polkadot` |
| `mainnet-api.algonode.cloud`, `testnet-api.algonode.cloud`, `mainnet-idx.algonode.cloud`, `testnet-idx.algonode.cloud` | Algorand mainnet and testnet (AlgoNode / Nodely, keyless: algod and indexer): used by the Rust `algo_*` commands only, Tor family `algorand` (`net::ALGORAND_HOSTS`) |
| `toncenter.com`, `testnet.toncenter.com` | TON mainnet and testnet (TON Center, API v3, public keyless offering, ≈ 1 request/s): used by the Rust `ton_*` commands, Tor family `ton`; optional key `KYRO_TONCENTER_API_KEY` (dev) as `X-API-Key`, never injected into a request from the interface |
| `cosmos-rest.publicnode.com`, `rest.provider-sentry-01.hub-testnet.polypore.xyz` | Cosmos Hub mainnet and testnet (`provider`), Cosmos SDK LCD REST: used by the Rust `cosmos_*` commands, Tor family `cosmos` |
| `preprod.koios.rest`, `api.koios.rest` | Cardano preprod and mainnet (Koios REST, public keyless offering): used by the Rust `ada_*` and `ada_stake_*` commands (`account_info`, `pool_list`, `pool_info`, `drep_info`), Tor family `cardano` |
| `api.kaspa.org`, `api-tn10.kaspa.org` | Kaspa mainnet and testnet-10 (`kaspa-rest-server`, public keyless API): used by the Rust `kas_*` commands, Tor family `kaspa` |
| `xmr-node.cakewallet.com` (port 18081), `monero-stagenet.stackwallet.com` (port 38081) | Monero mainnet and stagenet (`monerod` RPC, JSON and `.bin`): used by the Rust `xmr_*` commands, Tor family `monero`, "bulk" responses (64 MiB / 180 s) |
| `api.mainnet.aptoslabs.com`, `api.testnet.aptoslabs.com`, `fullnode.mainnet.aptoslabs.com`, `mainnet.aptoslabs.com`, `fullnode.testnet.aptoslabs.com` | Aptos mainnet and testnet, the last three as fallbacks tried in order when `api.*` refuses the Tor exit (Aptos Labs REST fullnode + `/v1/graphql` indexer, public keyless offering): used by the Rust `aptos_*` commands, Tor family `aptos` |
| `api.trongrid.io`, `nile.trongrid.io` | TRON mainnet and Nile (TronGrid, java-tron HTTP API + `/v1`): used by the Rust `tron_*` and `tron_stake_*` commands (`getReward`, `listwitnesses`, `getBrokerage`, `getnextmaintenancetime`), Tor family `tron` |
| `testnet.mirrornode.hedera.com`, `mainnet-public.mirrornode.hedera.com` | Hedera testnet and mainnet, official REST mirror node (account, balance, history, exchange rate, status): used by the Rust `hbar_*` commands, Tor family `hedera` |
| `testnet-node00-00-grpc.hedera.com`, `testnet-node01-00-grpc.hedera.com`, `testnet-node02-00-grpc.hedera.com`, `node00.swirldslabs.com`, `node01-00-grpc.swirlds.com`, `node04.swirldslabs.com` | Hedera: gRPC-web proxies of the consensus nodes (broadcast of `CryptoService/cryptoTransfer`, HTTPS port 443): used by `hbar_broadcast` (Rust) only, Tor family `hedera` |
| `ethereum-sepolia-rpc.publicnode.com`, `ethereum-rpc.publicnode.com` | Ethereum RPC |
| `arbitrum-one-rpc.publicnode.com`, `optimism-rpc.publicnode.com`, `base-rpc.publicnode.com`, `polygon-bor-rpc.publicnode.com`, `bsc-rpc.publicnode.com`, `avalanche-c-chain-rpc.publicnode.com` | EVM RPC (phase 2) |
| `arb1.arbitrum.io` | Arbitrum history fallback (`fallbackRpcUrl`), Tor family `evm`: tried when publicnode refuses, never with a custom RPC |
| `cronos-evm-rpc.publicnode.com`, `mantle-rpc.publicnode.com`, `sonic-rpc.publicnode.com`, `gnosis-rpc.publicnode.com`, `hyperliquid-rpc.publicnode.com`, `sei-evm-rpc.publicnode.com` ; `rpc.ankr.com` (Flare, `/flare`), `kaia.api.pocket.network` (Kaia), `evm.confluxrpc.com` (Conflux eSpace) | EVM RPC (phase 2): Cronos 25, Mantle 5000, Sonic 146, Gnosis 100, HyperEVM 999, Sei 1329, Flare 14, Kaia 8217, Conflux 1030; Tor family `evm`. The public Flare and Kaia RPCs answer 403 to Tor exits: Ankr and Pocket Network instead |
| `mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion` | Bitcoin (Esplora) in Tor mode only, `http://` (mempool's official onion service); automatic rewrite of `mempool.space` |
| `api.devnet.solana.com`, `api.mainnet-beta.solana.com` | Solana RPC (also: v0 address tables read by Rust for `sol_decode_tx` / `sol_sign_tx`; `sol_stake_*` staking read and broadcast by Rust: `getProgramAccounts`, `getVoteAccounts`, StakeHistory sysvar, `sendTransaction`; or the `servers.solana[cluster]` RPC from the settings) |
| `github.com`, `release-assets.githubusercontent.com` | automatic updates (`updater.rs`): `latest.json` and signed packages of the `shuntraa/kyro-wallet` releases (GitHub's CDN after redirect). **Rust only**: `net_fetch` refuses them (`HOST_NOT_ALLOWED`, `net::UPDATE_HOSTS`), Tor family `update`, bodies up to 256 MiB |
| `api.0x.org`, `li.quest`, `lite-api.jup.ag` | swap quotes (`li.quest` also: `/v1/status` of a cross-chain swap) |
| `1click.chaindefuser.com` | NEAR Intents 1Click (public, keyless): `/v0/status?depositAddress=` and `/v0/tokens`, confirmation of a cross-chain swap deposit before signing; `POST /v0/quote` (JSON) for direct swaps (BTC / LTC / DOGE / TRON / XRP / Cardano as source, LTC / DOGE / TRON / XRP / Cardano as destination); Tor family `swap` |
| `eth-api.lido.fi` | Lido API (keyless): `GET /v1/protocol/steth/apr/sma`, stETH APR shown as an estimate on the Earn screen; Tor family `market` |
| `exolix.com` | Exolix public API v2 (keyless): `GET /api/v2/rate`, `POST /api/v2/transactions` (JSON), `GET /api/v2/transactions/{id}`; Monero swaps; Tor family `swap` |
| + hosts of custom HTTP servers (`servers.bitcoin.*` of type `esplora`, `servers.evm.*`, `servers.solana.*`) | allowed **only for their family** (the family's Tor circuits); the replaced default server is refused (`DEFAULT_SERVER_DISABLED`) |
| Electrum and Bitcoin Core | **not** reachable through `net_fetch`: only via the `btc_*` commands (Rust) |
| `bch.imaginary.cash:50002`, `bch.loping.net:50002`, `cashnode.bch.ninja:50002`, `chipnet.imaginary.cash:50002`, `chipnet.bch.ninja:50002` (public Fulcrum, Bitcoin Cash mainnet / chipnet default) ; `dash.electrum1.cipig.net:20061`, `dash.electrum2.cipig.net:20061` (Komodo's ElectrumX, Dash mainnet default) ; `net::ELECTRUM_HOSTS` | **not** reachable through `net_fetch` (raw TLS sockets): only via `bch_*` / `dash_*` (Rust), Tor circuits of the `bitcoincash` / `dash` families, host **and** port allowlisted |
| `doge.electrum1.cipig.net:20060`, `doge.electrum2.cipig.net:20060` (Komodo's ElectrumX, Dogecoin mainnet default; `net::ELECTRUM_HOSTS`) | **not** reachable through `net_fetch` (raw TLS sockets, outside `ALLOWED_HOSTS`): only via `doge_*` (Rust), `dogecoin` Tor circuits, host **and** port checked |
| `zec.electrum1.cipig.net:20058`, `zec.electrum2.cipig.net:20058` (Komodo's ElectrumX, Zcash mainnet default, transparent only; `net::ELECTRUM_HOSTS`) | **not** reachable through `net_fetch` (raw TLS sockets, outside `ALLOWED_HOSTS`): only via `zec_*` (Rust), `zcash` Tor circuits, host **and** port checked |
| custom Litecoin / Dogecoin / Bitcoin Cash / Dash Esplora servers (`servers.litecoin.*`, `servers.dogecoin.*`, `servers.bitcoincash.*`, `servers.dash.*`) | **not** reachable through `net_fetch`: only via `ltc_*` / `doge_*` (Rust), their family's Tor circuits; the replaced default (`litecoinspace.org`) is refused (`DEFAULT_SERVER_DISABLED`) |

HTTPS only (except `.onion` via Tor: mempool, or a custom server), no redirect to a host outside the list nor to a custom server (redirects followed by Kyro itself in both modes; an API key is never sent on to another host), response capped at 5 MB, 20 s timeout, bounded CoinGecko cache (128 responses, 16 MiB). A custom server only enters this list after the "New server" native window.
