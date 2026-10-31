# Contrat d'interface Kyro

Ce document fige les frontières entre les trois couches. Toute modification se fait ici d'abord.

```
React (apps/desktop/src)  ──invoke()──►  Tauri shell (apps/desktop/src-tauri)  ──►  wallet-core (crates/wallet-core)
   aucun secret                         session, réseau, dialogues natifs            crypto pure, sans I/O
```

Règles :
- **Aucun secret ne remonte au frontend**, sauf la phrase de récupération affichée *une fois* à la création et via `vault_reveal_mnemonic` (mot de passe requis). Le frontend ne la stocke jamais (pas de state global, pas de localStorage).
- Toute signature exige le **mot de passe** (re-vérifié par Argon2id) **et** une **confirmation native** (dialogue système) affichant le résumé décodé par Rust. Hardware wallet (§2.3) : pas de mot de passe (aucune clé dans Kyro), mais le même dialogue natif, **puis** la confirmation sur l'écran de l'appareil, puis la vérification par Rust de ce que l'appareil renvoie.
- Le frontend n'a **aucun accès réseau direct** : CSP `connect-src ipc: http://ipc.localhost`. Tout passe par `net_fetch`, qui applique une allowlist de domaines.
- Les montants circulent en **chaînes décimales en plus petite unité** (sats, wei, lamports) pour éviter les flottants.

## 1. wallet-core (Rust, `crates/wallet-core`)

Crate pure : pas de réseau, pas de fichiers, pas de Tauri. Erreurs via `wallet_core::Error` (thiserror), jamais de panique sur entrée utilisateur.

```rust
// --- mnemonic ---
pub struct Mnemonic(/* zeroized on drop */);
impl Mnemonic {
    pub fn generate(words: WordCount) -> Result<Mnemonic>;          // WordCount::W12 | W24, OsRng
    pub fn parse(phrase: &str) -> Result<Mnemonic>;                  // BIP39 anglais, checksum vérifié, espaces normalisés
    pub fn words(&self) -> Zeroizing<Vec<String>>;
    pub fn to_seed(&self, passphrase: &str) -> Seed;                 // Seed = Zeroizing<[u8; 64]>
}

// --- vault ---
#[derive(Serialize, Deserialize)]
pub struct VaultFile { pub version: u8, pub kdf: KdfParams, pub salt: String /*b64*/, pub nonce: String /*b64, 24 o*/, pub ciphertext: String /*b64*/ }
pub struct KdfParams { pub m_cost_kib: u32, pub t_cost: u32, pub p_cost: u32 }     // défaut : 262144, 3, 4
impl KdfParams { pub fn production() -> Self; pub fn minimum() -> Self /*65536, 2, 1 : tests*/; }   // insecure_for_tests : tests unitaires de wallet-core seulement
pub fn seal(mnemonic: &Mnemonic, password: &str, kdf: KdfParams) -> Result<VaultFile>; // AAD = version||kdf||salt
pub fn open(file: &VaultFile, password: &str) -> Result<Mnemonic>;                    // Error::WrongPassword si tag invalide
// seal ET open : Error::InvalidVault si m < 64 Mio, t < 2, p = 0, ou m > 1 Gio, t > 10, p > 16 (vérifié avant toute dérivation ;
// un coffre plus faible est refusé, pas re-chiffré)

// --- networks & derivation ---
pub enum Network { Mainnet, Testnet }   // Testnet = BTC testnet4 (tb1…), Sepolia (chainId 11155111), Solana devnet
pub enum BtcKind { Segwit /* BIP84 */, Taproot /* BIP86 */ }
pub struct BtcAccount { pub kind: BtcKind, pub xpub: String, pub fingerprint: String /*hex 8*/, pub path: String /*m/84'/1'/0'*/ }
pub fn btc_account(seed: &Seed, net: Network, kind: BtcKind, account: u32) -> Result<BtcAccount>;
pub fn btc_address(seed: &Seed, net: Network, kind: BtcKind, account: u32, change: bool, index: u32) -> Result<String>;
pub fn evm_address(seed: &Seed, index: u32) -> Result<String>;          // m/44'/60'/0'/0/i, EIP-55 — compte EVM n° i = index d'adresse (voir « Comptes » ci-dessous)
pub fn evm_path(index) -> String;  pub fn sol_path(account) -> String;  pub fn tron_path(account) -> String;
pub fn xrp_path(account) -> String;  pub fn cardano_account_path(account) -> String;   // chemins affichés (dialogue natif, UI)
pub fn sol_address(seed: &Seed, account: u32) -> Result<String>;        // m/44'/501'/i'/0' (SLIP-10 ed25519), base58

// --- signing (clés dérivées à la demande, zeroizées aussitôt) ---
pub fn btc_sign_psbt(seed: &Seed, net: Network, account: u32, psbt_b64: &str) -> Result<(String /*signed b64*/, BtcTxSummary)>;
// ne signe QUE les entrées du compte `account` (origine m/84'|86'/coin'/account'/…) ; celles des autres comptes du même coffre
// sont étrangères (ForeignInput → 2ᵉ dialogue) et la monnaie n'est reconnue que dans ce compte
pub struct EvmTxRequest { pub chain_id: u64, pub nonce: u64, pub to: String, pub value_wei: String, pub data: String /*0x…*/,
                          pub gas_limit: u64, pub max_fee_per_gas: String, pub max_priority_fee_per_gas: String }
pub fn evm_sign_tx(seed: &Seed, index: u32, tx: &EvmTxRequest, net: Network) -> Result<(String /*raw 0x… EIP-1559*/, String /*tx hash*/)>;
// refuse un chain_id de l'autre famille que `net` (EVM_KNOWN_CHAINS), comme evm_decode
pub fn sol_sign_message(seed: &Seed, account: u32, message: &[u8]) -> Result<[u8; 64]>; // ed25519 sur les octets du message ; ne JAMAIS appeler sans sol_decode_message avant

// --- decoding (résumé « en clair », indépendant du frontend) ---
pub struct EvmTxSummary { pub kind: EvmTxKind /*NativeTransfer|Erc20Transfer|Erc20Approve|ContractCall*/,
                          pub to: String, pub token_contract: Option<String>, pub amount: String, pub spender: Option<String>,
                          pub unlimited_approval: bool /*≥ 2^128, même règle que Approval.unlimited*/, pub max_fee_wei: String, pub chain_id: u64, pub value_wei: String,
                          pub warnings: Vec<EvmWarning>, pub requires_extra_confirmation: bool }
pub enum EvmWarning {   // JSON { "kind": "contractCall" | "approval" | … } → 2ᵉ fenêtre renforcée
    ContractCall /*tout appel autre qu'un transfer ERC-20 décodé*/,
    Approval { spender, amount, unlimited /*≥ 2^128 : affiché ILLIMITÉ*/ },
    ValueToContract { value_wei } /*valeur native avec un appel (calldata non vide)*/,
    UnknownChain { chain_id } /*hors EVM_KNOWN_CHAINS*/,
    HighFee { max_fee_wei } /*gas_limit × max_fee_per_gas > evm_high_fee_threshold_wei(chain)*/ }
// Seuil de frais : 0,05 de la monnaie native (ETH, Sepolia, Arbitrum, Optimism, Base, BNB Chain, chaînes inconnues),
// 50 POL (Polygon), 1 AVAX (Avalanche). Limite : un envoi de valeur SANS calldata vers une adresse de contrat
// n'est pas détecté (il faudrait eth_getCode ; Rust ne contacte pas le RPC pour signer).
pub fn evm_decode(tx: &EvmTxRequest, net: Network) -> Result<EvmTxSummary>;
pub const EVM_KNOWN_CHAINS: &[(u64, Network)];   // LA liste : mainnet 1, 42161, 10, 8453, 137, 56, 43114, 61, 25, 5000, 146, 14, 8217, 100, 999, 1329, 1030 ; testnet 11155111
pub fn evm_chain_network(chain_id) -> Option<Network>;
// evm_decode / evm_sign_tx REFUSENT (INVALID_INPUT) un chain id connu de l'autre famille que `net` (mode test ↔ mainnet) ;
// un chain id inconnu reste accepté avec UnknownChain (2ᵉ dialogue).
pub struct BtcTxSummary { pub outputs: Vec<(String /*address*/, u64 /*sats*/, bool /*is_change*/)>, pub fee_sats: u64,
                          pub warnings: Vec<BtcWarning>, pub requires_extra_confirmation: bool }
pub enum BtcWarning {   // JSON { "kind": "unknownScript" | "opReturn" | "foreignInput" | "highFee" | "changeIndexOutOfRange", … } → 2ᵉ fenêtre renforcée
    UnknownScript { output } /*dont witness v2+ et v1 non taproot, rendus "script:<hex>"*/, OpReturn { output },
    ForeignInput { input } /*entrée non signée par nous*/,
    HighFee { sat_per_vb } /*> BTC_HIGH_FEE_SAT_PER_VB = 100 sat/vB (100 × le minimum de relais), ou frais > total des sorties*/,
    ChangeIndexOutOfRange { output } /*sortie vers nos clés à un index > MAX_CHANGE_INDEX = 1000 : is_change = false*/ }
// Un sighash autre que ALL / DEFAULT sur une de nos entrées n'est pas un avertissement : la signature est REFUSÉE.
pub fn btc_decode_psbt(net: Network, psbt_b64: &str, own: &[String] /*our addresses*/) -> Result<BtcTxSummary>;
pub fn btc_psbt_summary(seed, net, account, psbt_b64) -> Result<BtcTxSummary>;   // résumé de btc_sign_psbt sans signer (monnaie et entrées par origine de clé)

// --- Bitcoin, données publiques pour un serveur choisi (B2b) ---
pub fn btc_scripthash(address: &str, net: Network) -> Result<String>;   // Electrum : sha256(scriptPubKey) inversé, hex
pub fn btc_scripthash_of_script(script: &[u8]) -> String;
pub fn btc_script_pubkey(address: &str, net: Network) -> Result<ScriptBuf>;
pub fn btc_address_of_script(script: &[u8], net: Network) -> Option<String>;
pub fn btc_genesis_hash(net: Network) -> String;                         // mainnet / testnet4
pub struct BtcRawTx { pub txid: String, pub inputs: Vec<(String, u32)>, pub outputs: Vec<(Option<String>, u64, String /*spk hex*/)> }
pub fn btc_decode_raw_tx(raw_hex: &str, net: Network) -> Result<BtcRawTx>;
pub fn verify_tx_hex(raw_hex: &str, txid: &str) -> Result<()>;           // une seule transaction complète dont le txid (double SHA-256 de la sérialisation sans témoin) = txid ; sinon erreur (BTC, LTC, DOGE)
pub struct BtcDescriptor { pub kind: BtcKind, pub internal: bool, pub descriptor: String /*sans checksum*/ }
pub fn btc_descriptors(seed: &Seed, net: Network, account: u32) -> Result<Vec<BtcDescriptor>>;
// wpkh([fp/84h/coin'h/0h]xpub/{0,1}/*) et tr([fp/86h/coin'h/0h]xpub/{0,1}/*) — clés publiques uniquement

// --- Litecoin (BIP84 P2WPKH) et Dogecoin (BIP44 P2PKH) : crate `bitcoin` 0.32 réutilisée (clés, PSBT, sighash),
//     encodages d'adresse construits avec ses propres `bech32` / `base58` et les paramètres de chainparams.cpp
pub enum UtxoCoin { Litecoin, Dogecoin }                                  // JSON "litecoin" | "dogecoin"
pub struct UtxoAccount { pub coin: UtxoCoin, pub xpub: String /*xpub/tpub*/, pub fingerprint: String, pub path: String }
pub fn utxo_account(seed, net, coin, account) -> Result<UtxoAccount>;   // m/84'/2'/a' (LTC) · m/44'/3'/a' (DOGE) · testnet : coin type 1
pub fn utxo_address(seed, net, coin, account, change, index) -> Result<String>;   // ltc1…/tltc1… · D…/n…
pub fn utxo_address_from_xpub(xpub, net, coin, change, index) -> Result<String>;
pub fn utxo_script_pubkey(address, net, coin) -> Result<ScriptBuf>;     // LTC : ltc1 (v0/v1+), L…, M… (testnet m/n…, Q…) ; refuse 3…/2… (P2SH ancien = Bitcoin) et MWEB. DOGE : D…, 9…/A… (testnet n…, 2…)
pub fn utxo_address_of_script(script, net, coin) -> Option<String>;
pub fn utxo_genesis_hash(net, coin) -> &'static str;                    // LTC mainnet 12a765e3…, testnet4 4966625a… · DOGE mainnet 1a91e3da…, testnet bb0a7826…
pub fn utxo_decode_raw_tx(raw_hex, net, coin) -> Result<BtcRawTx>;      // DOGE : données témoin refusées
pub fn utxo_dust_threshold(coin, script) -> u64;                        // LTC : GetDustThreshold à 30 000 lit/kvB (P2WPKH 2 940) · DOGE : 0,001 DOGE (poussière dure)
pub fn utxo_psbt_summary(seed, net, coin, account, psbt_b64) -> Result<UtxoTxSummary>;     // décodage pour le dialogue, sans signer
pub fn utxo_sign_psbt(seed, net, coin, account, psbt_b64) -> Result<(String /*PSBT signée, non finalisée*/, UtxoTxSummary)>;   // comme Bitcoin : compte `account` seulement
// Refusé : PSBT mal formée ; entrée LTC sans witness_utxo ; entrée DOGE sans non_witness_utxo dont le txid = l'outpoint, ou avec témoin ;
// origine de clé « à nous » qui ne correspond pas à la clé ou au script ; sighash ≠ ALL ; sortie sous la poussière ; frais négatifs ; aucune entrée à nous.
// Signature : LTC BIP143 (P2WPKH), DOGE legacy (P2PKH), SIGHASH_ALL, chaque signature vérifiée avant d'être gardée.
pub struct UtxoTxSummary {                     // serde camelCase ; montants en chaînes décimales (unité minimale)
    pub coin, pub outputs: Vec<UtxoOutput { address: Option<String>, script /*hex*/, amount, is_change, kind: Address|OpReturn|Unknown }>,
    pub inputs: usize, pub our_inputs: usize, pub fee: String,
    pub size: u64 /*vB (LTC) ou octets (DOGE), signature la plus longue*/, pub fee_per_kb: u64 /*lit/kvB ou koinus/kB*/,
    pub has_change: bool /*false : tout ce qui n'est pas envoyé — poussière comprise — part en frais*/,
    pub warnings: Vec<UtxoWarning>, pub requires_extra_confirmation: bool }
pub enum UtxoWarning {                         // JSON { "kind": "softDust", "index": 2 }
    UnknownOutput { index } /*dont witness v2+ LTC*/, OpReturn { index }, ForeignInput { index }, SoftDust { index } /*DOGE < 0,01*/, HighFee /*> 100× le taux usuel ou > total envoyé*/,
    ChangeIndexOutOfRange { index } /*nos clés au-delà de l'index 1000 : is_change = false*/,
    FeeBelowMinimum { minimum } /*informatif*/ }
// requires_extra_confirmation = tout avertissement sauf FeeBelowMinimum.
// Constantes : LTC_MIN_RELAY_FEE_PER_KVB 1 000, LTC_DUST_RELAY_FEE_PER_KVB 30 000 ; DOGE_RECOMMENDED_FEE_PER_KB 1 000 000 (0,01 DOGE/kB),
// DOGE_MIN_RELAY_FEE_PER_KB 100 000, DOGE_SOFT_DUST 1 000 000, DOGE_HARD_DUST 100 000.

// --- TRON : m/44'/195'/a'/0/0 (un compte = une adresse, comme Ledger Live ; compte 0 = l'historique m/44'/195'/0'/0/0), adresse = base58check(0x41 || keccak256(pubkey)[12..]) ; raw_data protobuf
//     (codec écrit à la main, strict : refusé si le ré-encodage diffère d'un seul octet)
pub fn tron_address(seed, account) -> Result<String>;                   // T…, m/44'/195'/account'/0/0
pub fn tron_address_at(seed, account, index) -> Result<String>;         // m/44'/195'/account'/0/index (vecteurs d'autres portefeuilles)
pub fn tron_address_bytes(address) -> Result<[u8; 21]>; pub fn tron_address_from_bytes(&[u8; 21]) -> String;
pub fn tron_address_of_pubkey(sec1) -> Result<String>;
pub struct TronRaw { ref_block_bytes: [u8; 2], ref_block_hash: [u8; 8], expiration: i64, memo: Vec<u8>,
                     contract: TronContract, timestamp: i64, fee_limit: i64 }
pub enum TronContract { Transfer { owner, to, amount }, Trigger { owner, contract, call_value, data } }   // types 1 et 31 seulement
impl TronRaw { pub fn encode(&self) -> Vec<u8>; pub fn decode(raw) -> Result<TronRaw>; pub fn txid(&self) -> [u8; 32] /*sha256(raw)*/ }
// decode refuse : champ inconnu, ref_block_num, auths, scripts, provider, ContractName, Permission_id, valeur TRC-10,
// autre type de contrat, ≠ 1 contrat, entier négatif, encodage non canonique (ordre, doublon, varint non minimal).
pub fn tron_ref_block(number, block_id_hex) -> Result<([u8; 2], [u8; 8])>;   // octets 6..8 du numéro, 8..16 de l'id ; id doit commencer par le numéro
pub fn tron_trc20_transfer_data(to, amount /*décimal uint256*/) -> Result<Vec<u8>>;   // a9059cbb || to || amount
pub fn tron_decode_raw(raw_hex, our_address) -> Result<TronTxSummary>;  // + refuse : owner ≠ nous, montant TRX ≤ 0, TRX à soi-même,
// expiration > horloge système + 24 h (TRON_MAX_EXPIRATION_MS, aussi dans tron_decode_stake_raw, donc à la signature)
pub struct TronTxSummary { txid, owner, action: TronAction, fee_limit, expiration, timestamp, ref_block_bytes, ref_block_hash,
                           memo /*hex*/, memo_text: Option<String> /*UTF-8 nettoyé (sanitize_text, 256 car.)*/, raw_size,
                           warnings: Vec<TronWarning>, requires_extra_confirmation }   // serde camelCase
pub enum TronAction { TrxTransfer { to, amount }, Trc20Transfer { contract, to, amount, call_value },
                      ContractCall { contract, selector, data, call_value } }   // JSON { "type": "trxTransfer", … }
pub enum TronWarning { UnknownCall { selector }, CallValue, Memo, HighFeeLimit /*> 100 TRX*/, UnusualText /*mémo nettoyé*/ }   // tous → confirmation renforcée
pub fn tron_sign(seed, account, raw_hex) -> Result<([u8; 65] /*r‖s‖v, v = 27 + recid*/, TronTxSummary)>;   // décode d'abord ; libsecp256k1 RFC 6979
pub fn tron_recover_signer(raw_hex, sig65 /*v ∈ 0,1,27,28*/) -> Result<String>;
pub fn tron_signed_transaction(raw_hex, sig) -> Result<String>;          // Transaction { raw_data = 1, signature = 2 }, pour broadcasthex

// --- XRP Ledger : m/44'/144'/a'/0/0, compte 0 = l'historique m/44'/144'/0'/0/0 (route BIP44 de Ledger, Trezor, Xaman — pas la « family seed » de rippled),
//     adresse r… = base58 (alphabet Ripple) de 0x00 || RIPEMD160(SHA256(pubkey)) + somme SHA-256d ; codec binaire
//     Payment écrit à la main, strict (ré-encodage identique exigé)
pub fn xrp_address(seed, account) -> Result<String>; pub fn xrp_public_key(seed, account) -> Result<[u8; 33]>;   // m/44'/144'/account'/0/0
pub fn xrp_address_at(seed, account, index); pub fn xrp_public_key_at(seed, account, index); pub fn xrp_sign_at(seed, account, index, blob);   // …/0/index (vecteurs Trezor)
pub fn xrp_account_id(address) -> Result<[u8; 20]>;        // X-addresses refusées (adresse classique + tag séparé)
pub fn xrp_address_from_id(&[u8; 20]) -> String; pub fn xrp_address_of_pubkey(sec1) -> Result<String>;
pub enum XrpAmount { Xrp(u64 /*drops*/), Issued { mantissa, exponent, negative, currency: [u8; 20], issuer: [u8; 20] } }   // STAmount
pub fn xrp_issued_amount(value /*décimal*/, currency /*3 car. ou 40 hex*/, issuer) -> Result<XrpAmount>;   // ≤ 16 chiffres significatifs
pub struct XrpPayment { flags: Option<u32>, source_tag, sequence, destination_tag, last_ledger_sequence, invoice_id,
                        amount, fee /*drops*/, send_max, signing_pub_key, txn_signature, account, destination, memos }
impl XrpPayment { pub fn encode(&self, with_signature) -> Vec<u8>; pub fn decode(raw) -> Result<Self>;
                  pub fn signing_hash(&self) -> [u8; 32] /*SHA-512Half("STX\0"||…)*/; pub fn hash(&self) -> [u8; 32] /*SHA-512Half("TXN\0"||…)*/ }
// decode refuse : autre TransactionType (AccountSet, SetRegularKey, SignerListSet, TrustSet…), NetworkID, TicketSequence,
// Paths, DeliverMin, montants MPT, champ inconnu, encodage non canonique.
pub fn xrp_decode_tx(blob_hex, our_address, our_pubkey) -> Result<XrpTxSummary>;   // + refuse : déjà signée, Account / SigningPubKey ≠ nous,
// tfPartialPayment, drapeau inconnu, paiement à soi-même, montant ≤ 0, frais 0, LastLedgerSequence absent
pub struct XrpTxSummary { account, destination, destination_tag: Option<u32>, amount: XrpAmountView, fee, sequence,
                          last_ledger_sequence, flags, send_max, source_tag, invoice_id, memos, warnings: Vec<XrpWarning>,
                          requires_extra_confirmation }          // serde camelCase
pub enum XrpAmountView { Xrp { drops }, Issued { value, currency, issuer } }   // JSON { "kind": "xrp", … }
pub enum XrpWarning { SendMax, PathFlags /*tfNoRippleDirect, tfLimitQuality*/, Memo, HighFee /*> 1 XRP*/, InvoiceId,
                      UnusualText /*MemoData nettoyé : memos[].text est la version nettoyée (256 car.), memo_data l'hexadécimal exact*/ }   // → renforcée
pub fn xrp_sign(seed, account, blob_hex) -> Result<(String /*blob signé*/, String /*hash*/, XrpTxSummary)>;   // DER low-S, vérifiée
pub fn xrp_verify_signed(blob_hex) -> Result<String /*hash*/>;   // signature DER low-S de SigningPubKey, clé = Account

// --- Cardano : CIP-1852 m/1852'/1815'/0'/{0,2}/i, racine CIP-0003 « Icarus » (PBKDF2-HMAC-SHA512, 4096 itérations,
//     sel = ENTROPIE BIP39, puis clamping), dérivation BIP32-Ed25519 V2 par le crate ed25519-bip32 (aucune crypto écrite
//     ici), signature ed25519-dalek (hazmat::raw_sign avec le scalaire étendu kL ‖ kR) vérifiée (verify_strict) ;
//     CBOR : sous-ensemble écrit à la main, strict (ré-encodage identique exigé, formes minimales, ordre canonique)
pub struct CardanoRoot;   // XPrv 96 o, effacé au drop ; créé à l'ouverture de session (le coffre ne change pas)
impl CardanoRoot { pub fn from_mnemonic(&Mnemonic, passphrase) -> CardanoRoot }
pub fn cardano_address(root, net, account, index) -> Result<String>;       // adresse de base (type 0) : paiement …/0/index + staking …/2/0
pub fn cardano_payment_public_key(root, account, index) -> Result<[u8; 32]>;
pub fn cardano_account_xpub(root, account) -> Result<String>;              // clé publique ‖ chain code de m/1852'/1815'/account', hex
pub fn cardano_account_stake_address(root, net, account) -> Result<String>; // stake1… / stake_test1… (affichage ; pas de staking)
pub fn cardano_base_address(net, pay_pk, stake_pk); pub fn cardano_enterprise_address(net, pay_pk); pub fn cardano_stake_address(net, stake_pk);
pub fn cardano_address_bytes(address, net) -> Result<Vec<u8>>;   // destinataire : base clé (types 0, 2) ou enterprise clé (6), bon réseau.
// Refusés : Byron (Ae2…, DdzFF…), script en paiement (1, 3, 5, 7 : fonds bloqués sans datum), pointeur (4, 5 : obsolètes en Conway),
// staking (14, 15), autre réseau, somme bech32 fausse.
pub struct CardanoBody { inputs: Vec<CardanoInput { tx_hash, index }>, tagged_sets /*tag 258*/, outputs: Vec<CardanoOutput { address, coin, assets, map_form }>,
                         fee, ttl: Option<u64>, aux_hash: Option<[u8; 32]>, validity_start: Option<u64> }   // clés 0, 1, 2, 3, 7, 8 uniquement
impl CardanoBody { pub fn encode(&self) -> Vec<u8>; pub fn decode(raw) -> Result<Self>; pub fn tx_id(&self) -> [u8; 32] /*blake2b-256(corps)*/ }
pub fn cardano_min_utxo(address, assets, coins_per_utxo_byte) -> u64;      // (160 + taille de la sortie) × coinsPerUTxOByte ; u64::MAX en cas de débordement (donc refus)
pub fn cardano_cip20_aux(message) -> Result<Vec<u8>>;                      // {674: {"msg": [lignes ≤ 64 o]}}, 1 024 o max.
pub fn cardano_unsigned_tx(body, aux) -> Result<Vec<u8>>;                  // [corps, {}, true, aux | null]
pub fn cardano_signed_size(body, aux, keys) -> Result<usize>;               // taille signée (frais = a × taille + b)
pub struct CardanoContext<'a> { net, own: &[String], verified_tokens: &[(policy_hex, name_hex)], coins_per_byte }
pub fn cardano_decode_tx(tx_hex, ctx) -> Result<CardanoTxSummary>;  pub fn cardano_tx_body(tx_hex, ctx) -> Result<CardanoBody>;
// decode refuse : certificats (4), retraits (5), mises à jour (6), mint (9), script_data_hash (11), collatéral (13, 16, 17),
// signataires requis (14), network id (15), entrées de référence (18), votes (19), propositions (20), trésor (21, 22), champ inconnu ;
// sorties avec datum / hash de datum / script de référence ; sortie sous son min-UTxO ; quantité de token nulle ; métadonnées autres
// qu'un message CIP-20 ou au hash faux ; entrée en double ; témoins déjà présents ; tout CBOR non canonique (longueur indéfinie, entier
// non minimal, ordre des clés ou des tokens, doublon, octets en trop) ; plus de 16 384 octets.
pub struct CardanoTxSummary { tx_id, inputs /*"hash#i"*/, outputs: Vec<CardanoOutputView { address, kind /*base|enterprise*/, is_change,
                              lovelace, tokens: Vec<CardanoTokenView { policy, name /*hex*/, name_text?, quantity, verified }>, min_lovelace }>,
                              fee, ttl, valid_from, memo: Option<Vec<String>>, warnings: Vec<CardanoWarning>, requires_extra_confirmation }   // serde camelCase
pub enum CardanoWarning { Memo, UnknownToken { policy, name }, HighFee /*> 5 ADA*/, NoTtl,
                          UnusualText /*ligne CIP-20 nettoyée, ou nom de token à nettoyer (name_text = None : hex seul)*/ }   // → confirmation renforcée
// memo : lignes passées par sanitize_text. Staking (cardano_decode_stake_tx / cardano_sign_stake) : une seule sortie, vers ctx.own, sinon refus.
pub fn cardano_sign(root, account, index, tx_hex, ctx) -> Result<(String /*tx signée*/, String /*tx id*/, CardanoTxSummary)>;
// témoin vkey = (clé publique, Ed25519 sur blake2b-256(corps CBOR)), vérifié ; clé publique dalek = clé ed25519-bip32 sinon erreur
pub fn cardano_signed_witnesses(tx_hex) -> Result<(String /*tx id*/, Vec<[u8; 32]>)>;   // chaque témoin vérifié contre le tx id
pub fn cardano_verify(pk, msg, sig) -> Result<()>; pub fn cardano_blake2b256(data) -> [u8; 32];

// --- Solana : décodage des messages legacy et v0 (parseur écrit à la main, format filaire documenté) ---
pub struct SolLookupTable { pub key: String, pub addresses: Vec<String> }            // base58
pub fn sol_message_lookup_tables(message: &[u8]) -> Result<Vec<String>>;             // tables à récupérer (v0)
pub fn sol_parse_lookup_table(account_data: &[u8]) -> Result<Vec<String>>;           // compte AddressLookupTable : en-tête 56 o + n×32 ; refuse non initialisée / désactivée
pub const SOL_LOOKUP_TABLE_PROGRAM: &str;                                            // owner attendu du compte table
pub fn sol_decode_message(message: &[u8], tables: &[SolLookupTable], our_address: &str) -> Result<SolTxSummary>;
// Échec (Error) si : message tronqué / short-vec non canonique / index hors bornes / octets en trop /
// clés dupliquées / version ≠ 0 / table manquante ou index de table absent / données mal formées pour un programme reconnu.
pub struct SolTxSummary {                       // serde camelCase ; montants u64 en chaînes décimales
    pub version: String /*"legacy"|"v0"*/, pub fee_payer: String, pub signers: Vec<String>, pub our_signer_index: Option<usize>,
    pub recent_blockhash: String, pub instructions: Vec<SolInstruction>, pub lookup_tables: Vec<String>,
    pub base_fee_lamports: String /*5000 × signatures*/, pub compute_unit_limit: Option<u32>,
    pub compute_unit_price_micro_lamports: Option<String>, pub priority_fee_lamports: Option<String> /*ceil(prix × limite / 1e6)*/,
    pub warnings: Vec<SolWarning>, pub requires_extra_confirmation: bool }
pub enum SolInstruction {                       // JSON : { "type": "systemTransfer", ...champs camelCase }
    SystemTransfer { from, to, lamports }, SystemTransferWithSeed { from, base, to, lamports, seed },
    SystemCreateAccount { from, new_account, lamports, space, owner },
    SystemCreateAccountWithSeed { from, new_account, base, seed, lamports, space, owner },
    TokenTransfer { token_program /*token|token2022*/, checked, source, destination, authority, mint?, amount, decimals?, multisig_signers },
    TokenApprove { token_program, checked, source, delegate, owner, mint?, amount, decimals?, multisig_signers },   // DÉLÉGATION
    AtaCreate { idempotent, payer, account, owner, mint, token_program? },
    ComputeUnitLimit { units }, ComputeUnitPrice { micro_lamports }, Memo { text },
    Unknown { program_id, accounts, account_keys, data_len } }
pub enum SolWarning {                           // JSON : { "kind": "feePayerNotUs", ... }
    FeePayerNotUs { fee_payer }, ExtraWritableSigner { address }, AuthorityNotUs { instruction, authority },
    Delegation { instruction }, UnknownInstruction { instruction, program_id },
    Token2022ExtensionsUnverified { instruction } /*informatif*/, PriorityFeeEstimated /*informatif*/,
    UnknownOwnerProgram { instruction, owner, space } /*CreateAccount(WithSeed) pour un programme hors liste fermée*/,
    UncheckedTokenTransfer { instruction } /*Transfer SPL tag 3, sans mint ni décimales*/,
    UnusualText { instruction } /*mémo ou seed nettoyé, ou mémo > 80 caractères*/ }
// requires_extra_confirmation = instruction inconnue, délégation, payeur ≠ nous, autre signataire inscriptible, autorité ≠ nous,
// UnknownOwnerProgram, UncheckedTokenTransfer, UnusualText. Memo.text et les seeds sont nettoyés (sanitize_text ; mémo 566 car. max).
// Liste fermée des propriétaires : System ; Token (165 ou 82 octets) ; Token-2022 (82, ou 165 à 1024 octets) ; Stake (règles du staking).

// --- Texte venu de la chaîne : UN seul nettoyeur, exporté pour le shell ---
pub fn sanitize_text(s: &str, max_chars: usize) -> SanitizedText { text, altered, truncated };   // contrôles (\n \r \t → espace, autres → U+FFFD),
// bidi / invisibles retirés (U+200B–200F, U+202A–202E, U+2060–206F, U+FEFF, U+00AD, U+061C, U+180E, U+FFF9–FFFB, tags U+E0000–E007F),
// longueur bornée avec « … » ; altered = quelque chose a changé → avertissement + 2ᵉ dialogue chez l'appelant.

// --- Staking (§2.8). Solana : programme Stake11111111111111111111111111111111111111, décodé dans sol_decode_message ---
// SolInstruction gagne 4 variantes (JSON "type") : StakeInitialize { stake_account, staker, withdrawer },
//   StakeDelegate { stake_account, vote_account, authority }, StakeDeactivate { stake_account, authority },
//   StakeWithdraw { stake_account, to, lamports, authority }.
// sol_decode_message REFUSE (Error, pas « inconnu ») : toute autre instruction du programme Stake (Authorize*, SetLockup*,
// Split, Merge, InitializeChecked, Redelegate, MoveStake, MoveLamports, DeactivateDelinquent, GetMinimumDelegation) ;
// Initialize avec staker ou withdrawer ≠ nous, ou un lockup / dépositaire non nul ; Delegate / Deactivate / Withdraw dont
// l'autorité ≠ nous, un Withdraw vers une autre adresse (ou un dépositaire ≠ nous) ; un sysvar / StakeConfig / nombre de
// comptes inattendu ; un compte créé pour le programme Stake d'une taille ≠ 200 octets ou non initialisé dans la même
// transaction ; un CreateAccountWithSeed dont l'adresse n'est pas sha256(base ‖ seed ‖ owner).
pub enum SolStakeOp { CreateAndDelegate { seed, lamports /*stake + réserve de rent*/, vote_account },
                      Delegate { stake_account, vote_account }, Deactivate { stake_account }, Withdraw { stake_account, lamports } }
pub fn sol_stake_message(me, op: &SolStakeOp, blockhash) -> Result<Vec<u8>>;  // message legacy, un seul signataire (nous) ; création
// par CreateAccountWithSeed (base = nous, owner = Stake, 200 o) + Initialize (staker = withdrawer = nous, lockup nul) + DelegateStake
pub fn sol_create_with_seed(base, seed /*≤ 32 o*/, owner) -> Result<String>;
pub fn sol_parse_stake_account(data /*200 o*/) -> Result<SolStakeAccount { state, rent_exempt_reserve, staker, withdrawer,
    lockup_unix_timestamp, lockup_epoch, lockup_custodian, delegation: Option<SolDelegation { vote_account, stake, activation_epoch,
    deactivation_epoch }> }>;
pub fn sol_parse_stake_history(data) -> Result<Vec<SolStakeHistoryEntry { epoch, effective, activating, deactivating }>>;
pub fn sol_stake_activation(delegation, target_epoch, history) -> SolStakeActivation { effective, activating, deactivating };
// = Delegation::stake_activating_and_deactivating du programme Stake (taux 9 %/époque) ; getStakeActivation n'existe plus (Agave 2.0)
pub fn sol_stake_withdrawable(account, balance, epoch, history) -> (u64 /*retrait partiel max*/, bool /*tout retirer (fermer) possible*/);

// --- Staking Cardano (Conway) : CardanoBody gagne `certs: Vec<CardanoCert>` (clé 4, set 258 si tagged_sets) et
//     `withdrawals: Vec<(Vec<u8> /*adresse de récompenses*/, u64)>` (clé 5). cardano_decode_tx (paiements) les refuse toujours.
pub enum CardanoCert { StakeRegistration { stake, deposit } /*cert 7*/, StakeDeregistration { stake, refund } /*8*/,
                       StakeDelegation { stake, pool } /*2*/, VoteDelegation { stake, drep: CardanoDrep } /*9*/ }   // identifiant de CLÉ seulement
pub enum CardanoDrep { Key([u8; 28]), Script([u8; 28]), AlwaysAbstain, AlwaysNoConfidence }
pub fn cardano_decode_stake_tx(tx_hex, ctx, stake_pk, key_deposit) -> Result<CardanoStakeSummary>;
pub fn cardano_stake_tx_body(tx_hex, ctx, stake_pk, key_deposit) -> Result<CardanoBody>;
pub fn cardano_sign_stake(root, account, index, stake_account, tx_hex, ctx, key_deposit) -> Result<(String, String, CardanoStakeSummary)>;
// témoins : clé de paiement …/account'/0/index puis clé de staking …/stake_account'/2/0, chacun vérifié (verify_strict)
// cardano_decode_stake_tx REFUSE : certificats 0, 1 (anciens formats), 3, 4 (pools), 5, 6 (genesis, MIR), 10–13 (combinés),
// 14–18 (comité, DRep) ; identifiant de script ; un certificat ou un retrait pour une autre clé que stake_pk ; dépôt ≠ key_deposit ;
// certificat en double ; enregistrement + désinscription, ou délégation + désinscription, ensemble ; enregistrement pas en premier ;
// plusieurs retraits ; retrait de 0 ; métadonnées ; aucune opération de staking. Les votes (19) et propositions (20) restent refusés.
pub struct CardanoStakeSummary { tx: CardanoTxSummary, stake_address, certificates: Vec<CardanoCertView>, withdrawals:
    Vec<CardanoWithdrawalView { reward_address, lovelace }>, deposit, refund, withdrawn }   // serde camelCase, montants en chaînes
pub enum CardanoCertView { StakeRegistration { deposit }, StakeDeregistration { refund }, StakeDelegation { pool_id /*pool1…*/,
    pool_hash }, VoteDelegation { drep: CardanoDrepView } }          // JSON { "type": "stakeDelegation", … }
pub enum CardanoDrepView { Key { id /*CIP-129 drep1…*/, hash }, Script { id, hash }, AlwaysAbstain, AlwaysNoConfidence }   // JSON { "kind": … }
pub fn cardano_stake_public_key(root, account) -> Result<[u8; 32]>; pub fn cardano_blake2b224(data) -> [u8; 28];
pub fn cardano_reward_address_bytes(net, stake_hash) -> Vec<u8>;    // 0xE0 | réseau ‖ hash
pub fn cardano_pool_id(s /*pool1… ou 56 hex*/) -> Result<[u8; 28]>; pub fn cardano_pool_bech32(hash) -> Result<String>;
pub fn cardano_drep_parse(s /*alwaysAbstain | alwaysNoConfidence | drep1… (CIP-129 ou CIP-105) | drep_script1…*/) -> Result<CardanoDrep>;
pub fn cardano_drep_id(drep) -> Option<String>;                     // CIP-129

// --- Staking TRON (Stake 2.0) : TronContract gagne FreezeV2 { owner, amount, resource }, UnfreezeV2 { … }, WithdrawExpireUnfreeze,
//     CancelAllUnfreezeV2, VoteWitness { owner, votes: Vec<([u8; 21], i64)> }, WithdrawBalance (types 54, 55, 56, 59, 4, 13).
//     TronRaw::decode refuse toujours DelegateResource / UnDelegateResource (57, 58), TRON_POWER, le champ `support`.
//     tron_decode_raw (paiements) refuse ces contrats de staking.
pub enum TronResource { Bandwidth, Energy }                          // JSON "BANDWIDTH" | "ENERGY"
pub fn tron_decode_stake_raw(raw_hex, our_address) -> Result<TronStakeSummary>;   // + refuse : owner ≠ nous, montant ≤ 0, mémo,
// fee_limit ≠ 0, 0 ou plus de 30 votes (TRON_MAX_VOTES), un SR deux fois, un vote nul, un transfert / appel de contrat
pub fn tron_stake_sign(seed, account, raw_hex) -> Result<([u8; 65], TronStakeSummary)>;
pub struct TronStakeSummary { txid, owner, action: TronStakeAction, expiration, timestamp, ref_block_bytes, ref_block_hash, raw_size }
pub enum TronStakeAction { Freeze { resource, amount }, Unfreeze { resource, amount }, WithdrawUnfrozen, CancelAllUnfreeze,
                           Vote { votes: Vec<TronVote { address, count }>, total }, ClaimRewards }   // JSON { "type": "freeze", … }

// --- hardware wallets (B3) : aucune clé privée ; on ne fait jamais confiance à l'appareil ---
pub enum HwDeviceKind { Ledger, Trezor }                                  // JSON "ledger" | "trezor"
pub struct WatchOnlyAccount { pub id: String /*"hw-"+16 hex*/, pub label: String, pub device: HwDeviceKind,
    pub model: String, pub network: Network, pub account: u32 /*≤ 100*/,
    pub btc: Vec<BtcAccount> /*≤ 1 par type, même empreinte*/, pub evm: Option<WatchEvm { xpub /*nœud m/44'/60'/0'/0*/, path }>,
    pub sol: Option<WatchSol { address, path /*m/44'/501'/account'/0'*/ }> }   // serde camelCase, deny_unknown_fields
pub struct WatchOnlyStore { pub version: u8 /*1*/, pub accounts: Vec<WatchOnlyAccount> }
impl WatchOnlyStore { pub fn from_json(json, network) -> Result<Self>; pub fn validate(&self, network); pub fn to_json(&self) }
// Fichier séparé du coffre (le format VaultFile v1 est inchangé) ; validation complète à la lecture.
pub fn btc_hw_plan(net, psbt_b64, accounts: &[BtcAccount]) -> Result<HwBtcPlan>;   // nos entrées/monnaie, vérifiées contre l'xpub
pub struct HwBtcPlan { pub inputs: Vec<HwBtcInput { index, kind, path: Vec<u32>, pubkey, amount, has_prev_tx }>,
    pub external_inputs: Vec<usize>, pub change: Vec<HwBtcChange { index, kind, path }>, pub summary: BtcTxSummary }
pub struct HwBtcSignature { pub input: usize, pub pubkey: Option<Vec<u8>>, pub signature: Vec<u8> }
pub fn btc_hw_finalize(net, psbt_b64, accounts, sigs: &[HwBtcSignature]) -> Result<(String /*PSBT signée*/, BtcTxSummary)>;
// Recalcule chaque sighash (BIP143 / BIP341) et vérifie chaque signature contre la clé dérivée de l'xpub ;
// signature manquante, en double, pour une entrée étrangère, autre clé, sighash ≠ ALL/DEFAULT, high-S → Error::Device.
pub fn btc_hw_own_addresses(net, accounts, gap) -> Result<Vec<String>>;
pub fn evm_signing_payload(tx) -> Result<Vec<u8>>;          // 0x02 || rlp(champs non signés) — ce que reçoit le Ledger
pub fn evm_tx_fields(tx) -> Result<EvmTxFields>;              // entiers big-endian minimaux (Trezor)
pub fn evm_hw_finalize(tx, r, s, expected_address) -> Result<(String /*raw*/, String /*hash*/)>; // v ignoré, low-S exigé, récupération = adresse attendue
pub fn evm_xpub_from_node(sec1, chain_code) -> Result<String>; pub fn evm_address_from_xpub(xpub, index) -> Result<String>;
pub fn evm_address_of_pubkey(sec1) -> Result<String>;       pub fn evm_checksum_address(addr) -> Result<String>;
pub fn sol_address_of_pubkey(bytes) -> Result<String>;      pub fn sol_verify_signature(address, message, sig) -> Result<[u8; 64]>; // verify_strict
pub struct LedgerErc20Descriptor { chain_id, contract: [u8; 20], ticker, decimals, signature /*DER*/ }
pub fn ledger_erc20_lookup(chain_id, contract) -> Option<LedgerErc20Descriptor>;   // table embarquée (voir §2.3)
pub fn ledger_erc20_verify(d) -> Result<()>;                // contre LEDGER_ERC20_SIGNER (clé publiée par Ledger)
pub fn ledger_erc20_payload(d) -> Result<Vec<u8>>;          // données de l'APDU PROVIDE ERC 20 TOKEN INFORMATION
// Error::Device(String) : réponse d'un appareil rejetée par une vérification indépendante (code HW_BAD_RESPONSE).
```

## 2. Commandes Tauri (exposées au frontend)

Types TypeScript de référence : `packages/shared/src/ipc.ts`. Noms en `snake_case`, arguments en `camelCase` (convention Tauri).

| Commande | Arguments | Retour | Notes |
|---|---|---|---|
| `vault_status` | — | `{ exists, unlocked, autoLockSecs, lockInSecs \| null }` | |
| `vault_create` | `{ password, words: 12 \| 24 }` | `{ words: string[] }` | phrase affichée une seule fois |
| `vault_import` | `{ password, phrase }` | `void` | |
| `vault_unlock` | `{ password }` | `void` | 5 essais puis délai croissant |
| `vault_lock` | — | `void` | zeroize de la session |
| `vault_reveal_mnemonic` | `{ password }` | `{ words: string[] }` | rate-limité, capture d'écran bloquée |
| `session_touch` | — | `void` | activité utilisateur → repousse l'auto-lock |
| `accounts_get` | `{ account? }` | `Accounts` | adresses publiques uniquement, du compte `account` (absent = 0) de chaque chaîne ; contient aussi `ltc` et `doge` (§2.4). Comptes multiples : §2.9 |
| `vault_accounts_get` / `vault_account_add` / `vault_account_rename` / `vault_account_remove` | voir §2.9 | `VaultAccountLists` | listes de comptes du coffre, par chaîne |
| `btc_address` | `{ kind, change, index, account? }` | `string` | `m/84'\|86'/coin'/account'/change/index` |
| `evm_decode_tx` | `{ tx: EvmTxRequest }` | `EvmTxSummary` | pour l'aperçu avant mot de passe ; `INVALID_INPUT` si le chainId est d'un réseau principal en mode test (ou Sepolia en mainnet) |
| `evm_sign_tx` | `{ tx, password, token?: { symbol, decimals }, account? }` | `{ rawTx, hash }` | clé `m/44'/60'/0'/0/{account}` ; dialogue natif obligatoire (compte signataire et adresse « De » en tête, §2.9) ; `token` = indication d'affichage seulement (le contrat et le montant brut viennent du décodage Rust) ; **2ᵉ dialogue renforcé** si `requiresExtraConfirmation` : appel de contrat autre qu'un transfer ERC-20, **toute** autorisation (`approve` : bénéficiaire et montant, « ILLIMITÉ » si ≥ 2^128), valeur native envoyée avec un appel, chainId inconnu, frais maximum au-dessus du seuil (voir §1) ; chainId de l'autre famille de réseaux : refusé (`INVALID_INPUT`) |
| `btc_sign_psbt` | `{ psbt, password, account? }` | `{ psbt, summary }` | ne signe que les entrées du compte `account` (celles des autres comptes : `foreignInput`) ; dialogue natif obligatoire (résumé `btc_psbt_summary`, compte signataire en tête) ; **2ᵉ dialogue renforcé** si `summary.requiresExtraConfirmation` (script inconnu, OP_RETURN, entrée qui n'est pas à nous, frais > 100 sat/vB ou > total des sorties) ; le résumé de la signature doit être identique à celui affiché |
| `sol_decode_tx` | `{ message /*b64, message sérialisé sans signatures*/, account? }` | `SolTxSummary` | aperçu avant mot de passe ; décodé en Rust, tables d'adresses (v0) récupérées par Rust (`getAccountInfo`) — jamais fournies par l'UI ; session déverrouillée requise |
| `sol_sign_tx` | `{ message /*b64*/, password, account? }` | `{ signature /*b64*/, summary: SolTxSummary }` | même décodage ; refuse si notre adresse n'est pas signataire ; dialogue natif construit depuis le résumé Rust, puis 2ᵉ dialogue « Instruction non reconnue — signer quand même ? » si `requiresExtraConfirmation` ; la signature va à l'index `summary.ourSignerIndex` |
| `net_fetch` | `{ req: { url, method, headers?, body? } }` | `{ status, body }` | allowlist + cache + rate-limit ; seuls `accept`, `content-type`, `0x-version` sont transmis, les clés API sont ajoutées par Rust. **Via Tor si `settings.tor.enabled` (défaut)** : attend le démarrage de Tor (60 s max) puis échoue en `TOR_UNAVAILABLE` — jamais de repli en clair. En mode Tor, `https://mempool.space/…` est servi de façon transparente par le service onion de mempool (même chemin, même réponse) ; l'UI continue d'appeler `https://mempool.space/…`. Toute URL `.onion` est refusée (`HOST_NOT_ALLOWED`) en mode clair |
| `tor_status` | — | `TorStatus` | état courant de Tor intégré |
| `tor_retry` | — | `TorStatus` | relance le démarrage depuis zéro (quel que soit l'état : utile après `error`) ; refusé (`INVALID_INPUT`) si Tor est désactivé |
| `settings_get` / `settings_set` | — / `{ settings: SettingsInput }` | `Settings` (sans secrets : `hasPassword` au lieu du mot de passe Core, `apiKeysSet` au lieu des clés API) | stocké dans le dossier de l'app ; passer `tor.enabled` de `true` à `false` coupe Tor (l'UI doit d'abord demander une confirmation explicite), l'inverse le démarre ; **`settings_set` est asynchrone** et vérifie en direct chaque serveur personnalisé modifié (voir §2.1) avant d'enregistrer — erreurs typées `SERVER_INVALID`, `SERVER_WRONG_NETWORK`, `SERVER_UNREACHABLE`, `TOR_UNAVAILABLE`, rien n'est enregistré en cas d'échec ; si l'objet envoyé n'a pas de clé `servers`, les serveurs enregistrés sont conservés |
| `server_test` | `{ target: ServerTestTarget }` | `ServerTestResult` | teste un serveur **sans l'enregistrer** (mêmes vérifications que `settings_set`). Bitcoin Core `userpass` envoyé **sans** `password` : le mot de passe enregistré est réutilisé s'il s'agit du même emplacement (même réseau), de la même URL et du même utilisateur ; sinon `SERVER_INVALID` (mot de passe manquant) |
| `electrum_fetch_cert` | `{ host, port }` | `{ sha256, webpkiValid }` | empreinte SHA-256 du certificat TLS d'un serveur Electrum, pour la confirmation TOFU ; la poignée de main est interrompue dès la réception du certificat (aucune donnée envoyée) |
| `btc_backend_info` | — | `{ kind, network, label, tor }` | serveur Bitcoin actif : `kind` = `default` \| `esplora` \| `electrum` \| `core` \| `cbf`, `network` = `mainnet` \| `testnet4`, `label` = hôte (jamais d'identifiants) |
| `btc_address_info` | `{ address }` | forme Esplora `GET /address/{a}` | voir §2.2 |
| `btc_address_utxos` | `{ address }` | forme Esplora `GET /address/{a}/utxo` | voir §2.2 |
| `btc_address_txs` | `{ address }` | forme Esplora `GET /address/{a}/txs` | voir §2.2 (50 plus récentes au plus) |
| `btc_fee_rates` | — | forme mempool `GET /v1/fees/recommended` | sat/vB |
| `btc_tip_height` | — | `number` | |
| `btc_tx_hex` | `{ txid }` | `string` (transaction brute, hex) | transaction complète, par exemple le `non_witness_utxo` d'une entrée SegWit v0 pour un hardware wallet. Esplora/défaut `GET /tx/{txid}/hex` ; Electrum `blockchain.transaction.get` ; Core `gettransaction` (portefeuille de surveillance) puis `getrawtransaction` — hors portefeuille et sans `-txindex=1` : `INVALID_INPUT` explicite ; filtres compacts : transactions gardées des blocs synchronisés, sinon `INVALID_INPUT` explicite. **Toujours** : Rust vérifie que la réponse est une transaction dont le txid (double SHA-256 de la sérialisation sans témoin) = `txid`, sinon `SERVER_UNREACHABLE` ; `txid` mal formé : `INVALID_INPUT` |
| `btc_broadcast` | `{ hex }` | `string` (txid) | le txid renvoyé par le serveur doit correspondre à la transaction, sinon erreur |
| `ltc_*`, `doge_*` | voir §2.4 | | Litecoin, Dogecoin : mêmes formes Esplora que `btc_*`, signature avec dialogue natif |
| `ada_*` | voir §2.7 | | Cardano : transaction construite **par Rust** depuis les UTxO et les paramètres de protocole, chaque sortie détaillée (ADA, tokens, min-ADA) |
| `xrp_*` | voir §2.6 | | XRP Ledger : paiement construit **par Rust** (Sequence, Fee, LastLedgerSequence), tag de destination mis en évidence, réserve |
| `tron_*` | voir §2.5 | | TRON : transaction construite **par Rust** depuis le dernier bloc, signature avec dialogue natif (ressources, TRX brûlés) |
| `sol_stake_*`, `ada_stake_*`, `tron_stake_*` | voir §2.8 | | Staking : Solana natif, délégation Cardano, TRON Stake 2.0 ; opérations construites **par Rust**, décodées et vérifiées en direct avant le dialogue natif |
| `btc_core_setup` | `{ rescanFrom: 'now' \| number /*horodatage UNIX en s*/ }` | `CoreStatus` (`state: 'importing'`) | Bitcoin Core uniquement, session déverrouillée. **Vérification préalable synchrone** (erreurs renvoyées par l'appel lui-même) : nœud joignable (`SERVER_UNREACHABLE`), authentification (`SERVER_INVALID`), bonne chaîne (`SERVER_WRONG_NETWORK`), portefeuille `kyro-watch-<empreinte8>` créé ou chargé et bien sans clé privée (`SERVER_INVALID`), checksums des descripteurs. Seul `importdescriptors` (et son rescan) tourne ensuite en arrière-plan. Aucun nœud Core configuré pour ce réseau : `INVALID_INPUT` |
| `btc_core_status` | — | `CoreStatus` | progression du rescan (`getwalletinfo.scanning`). L'état d'import est propre à **(réseau, URL, portefeuille)** : un autre nœud ou un autre réseau ne voit pas l'import d'un premier. Aucun nœud Core configuré : réponse normale `{ state: 'not-configured', wallet: '', walletLoaded: false }` (pas d'erreur) |
| `btc_cbf_status` | — | `CbfStatus` | mode filtres compacts (fonction `cbf`) ; build sans la fonction : `FEATURE_DISABLED` |
| `btc_cbf_sync` | — | `CbfStatus` | lance (ou rejoint) une synchronisation en arrière-plan ; progression par l'événement `cbf-status` ; exige le coffre déverrouillé (lit les xpubs) — une lecture coffre verrouillé ne lance pas de synchro ; build sans la fonction : `FEATURE_DISABLED` |
| `set_capture_protection` | `{ enabled }` | `void` | `set_content_protected` |
| `config_get` | — | `{ network, hasCoingeckoKey, hasZeroxKey, hasTrongridKey }` | jamais les clés elles-mêmes ; chaque `hasXKey` = variable d'environnement **ou** clé enregistrée dans les réglages (ex. TronGrid : `KYRO_TRONGRID_API_KEY` ou `apiKeys.trongrid`) |
| `network_get` / `network_set` | — / `{ network: 'mainnet' \| 'testnet' }` | `NetworkInfo` / `boolean` | choix du réseau depuis l'application, appliqué en **redémarrant** l'app : voir §2.10 |
| `hw_list` | — | `DeviceInfo[]` | détecte les Ledger (HID) et Trezor (WebUSB) branchés ; ids stables pour la session (`ledger-1`, `trezor-1`…) tant que l'appareil reste sur le même port ; 10 s max. Voir §2.3 |
| `hw_open` | `{ id }` | `DeviceStatus` | ouvre l'appareil et lit son état : verrouillé, app Ledger ouverte, firmware Trezor, état par chaîne. **Seule commande qui peut appairer un Trezor Safe 7** (THP, §2.3) : `hw-prompt` `thp-confirm-pairing` puis `thp-pairing-code` → `hw_thp_pairing_code` ; délai 180 s |
| `hw_thp_pairing_code` | `{ id, code /*6 chiffres*/ }` | `void` | Trezor Safe 7, après `hw-prompt` `thp-pairing-code` : le code affiché **sur l'écran de l'appareil**, recopié par l'utilisateur. Autre chose que 6 chiffres ASCII : `INVALID_INPUT` (l'appel `hw_open` continue d'attendre) ; aucun appairage en attente : `HW_BAD_RESPONSE`. Code faux : `hw_open` échoue en `HW_PAIRING_FAILED` |
| `hw_thp_pairings` | — | `{ key /*hex, clé statique publique de l'appareil*/; model /*"T3W1"*/; added /*s UNIX*/ }[]` | appareils THP appairés avec cette installation (données publiques) |
| `hw_thp_forget` | `{ key? }` | `number` | session déverrouillée si un coffre existe. Oublie l'appairage d'un appareil (`key` de `hw_thp_pairings`), ou **tous** sans `key` (supprime aussi la clé THP de Kyro : nouvelle clé au prochain appairage). Ferme les connexions Trezor inactives. Côté appareil, Kyro reste connu jusqu'à sa réinitialisation |
| `hw_cancel` | `{ id }` | `boolean` | abandonne l'opération en cours sur `id` (`true` s'il y en avait une) ; elle se termine en `USER_REJECTED` |
| `hw_pin_matrix` | `{ id, positions /*"1"…"9"*/ }` | `void` | Trezor One uniquement, après l'événement `hw-prompt` `pin-matrix` : **positions** dans la grille 3×3 vierge, jamais le PIN ; disposition du pavé numérique Trezor : ligne du haut 7 8 9, milieu 4 5 6, bas 1 2 3 (case en haut à gauche = « 7 »), transmise telle quelle |
| `hw_get_xpub` | `{ id, chain: 'btc' \| 'evm' \| 'sol', account }` | `HwXpub` | lit les clés publiques sur l'appareil, sans rien afficher ni enregistrer |
| `hw_accounts_get` | — | `WatchOnlyAccount[]` | comptes hardware wallet enregistrés (lecture seule, clés publiques) |
| `hw_account_add` | `{ id, chain, account, accountId?, label? }` | `WatchOnlyAccount` | lit les clés de `chain` sur l'appareil et les enregistre (nouveau compte, ou ajout à `accountId` : même marque, même numéro, même empreinte sinon `HW_WRONG_DEVICE`) |
| `hw_account_remove` | `{ accountId }` | `void` | |
| `hw_verify_address` | `{ id, accountId, chain, path }` | `{ address, path }` | **affiche l'adresse sur l'écran de l'appareil** ; avant, relit les clés de l'appareil (`HW_WRONG_DEVICE` si ce n'est pas le bon) ; l'adresse affichée doit être identique à celle que Kyro dérive de l'xpub enregistrée, sinon `HW_ADDRESS_MISMATCH` (erreur bloquante : ne pas utiliser l'adresse) |
| `hw_sign_btc_psbt` | `{ id, accountId, psbt }` | `{ psbt, summary }` | décodage Rust → dialogue natif Kyro (+ 2ᵉ dialogue si sortie inconnue) → confirmation sur l'appareil → vérification de chaque signature. PSBT signée, **non finalisée** |
| `hw_sign_evm_tx` | `{ id, accountId, tx: EvmTxRequest, token?: { symbol, decimals } }` | `{ rawTx, hash }` | idem ; 2ᵉ dialogue si appel de contrat ou si l'appareil ne peut pas afficher le détail (blind signing) ; signe pour l'adresse `m/44'/60'/0'/0/{account}` |
| `hw_sign_sol_tx` | `{ id, accountId, message /*b64*/ }` | `{ signature /*b64*/, summary: SolTxSummary }` | même décodage que `sol_sign_tx` ; signature vérifiée (ed25519 strict) contre l'adresse enregistrée |

```ts
type Accounts = {                 // accounts_get({ account? }) : tout est celui du compte `account` (0 = l'historique)
  network: 'mainnet' | 'testnet';
  account: number;
  // evm, sol, tron, xrp, cardano : { address, path } (path = chemin de la clé, ex. m/44'/60'/0'/0/1)
  btc: { segwit: { address: string; xpub: string; fingerprint: string; path: string };
         taproot: { address: string; xpub: string; fingerprint: string; path: string } };
  evm: { address: string };
  sol: { address: string };
  ltc: { address: string; xpub: string; fingerprint: string; path: string };   // m/84'/2'/0' (testnet m/84'/1'/0'), address = …/0/0
  doge: { address: string; xpub: string; fingerprint: string; path: string };  // m/44'/3'/0' (testnet m/44'/1'/0')
  tron: { address: string };                                                    // m/44'/195'/0'/0/0 (même chemin sur Nile)
  xrp: { address: string };                                                     // m/44'/144'/0'/0/0
  cardano: { address: string };   // adresse de base m/1852'/1815'/0'/0/0 + staking …/2/0 (CIP-1852, Icarus) ; addr_test1… sur preprod
};
type ApiKeyName = 'coingecko' | 'zerox' | 'trongrid';   // toutes les clés que Settings connaît (1inch retiré : une ancienne clé est ignorée puis effacée)
// coingecko : en-tête x-cg-demo-api-key / x-cg-pro-api-key (api / pro-api.coingecko.com) ; zerox : 0x-api-key (api.0x.org) ;
// trongrid : TRON-PRO-API-KEY (api.trongrid.io, nile.trongrid.io, §2.5).
// (LI.FI et Jupiter : variables d'environnement seulement, pas de clé dans Settings.)
type Settings = { currency: 'EUR' | 'USD'; autoLockSecs: number; hideBalancesOnStart: boolean;   // ce que RENVOIENT settings_get / settings_set
                  captureProtection: boolean; clipboardGuard: boolean;
                  servers: Servers;               // remplace l'ancien `rpc` (encore accepté en entrée, migré, jamais renvoyé)
                  apiKeysSet: { [K in ApiKeyName]: boolean };   // clé enregistrée ou non ; JAMAIS la valeur (pas de champ `apiKeys`)
                  tor: { enabled: boolean } };   // défaut : { enabled: true }
type SettingsInput = Omit<Settings, 'apiKeysSet'> & {   // ce qu'ACCEPTE settings_set (`apiKeysSet` envoyé en retour est ignoré)
                  apiKeys?: { [K in ApiKeyName]?: string | null } };
// Règle de fusion de `apiKeys.<nom>` dans settings_set : absent (ou null) = inchangé ; "" = supprimé ;
// chaîne non vide = enregistrée après trim (vide après trim ou caractère de contrôle → INVALID_INPUT ; nom inconnu → INVALID_INPUT).
// `config_get.hasXKey` = clé d'environnement (KYRO_…) OU clé enregistrée ; les clés d'environnement ne sont jamais renvoyées non plus.
// ---- serveurs personnalisés (B2b) ----
// Clé absente = serveur par défaut. Un serveur personnalisé n'est autorisé que pour sa famille
// et emprunte les circuits Tor isolés de cette famille ; le serveur par défaut de la même chaîne
// est alors REFUSÉ (`DEFAULT_SERVER_DISABLED`) : jamais de repli silencieux.
type Servers = {
  bitcoin: { mainnet?: BtcServer; testnet4?: BtcServer };
  evm: { [chainId: string]: { url: string } };          // clé = chainId décimal, ex. "11155111"
  solana: { 'devnet'?: { url: string }; 'mainnet-beta'?: { url: string } };
  litecoin: { mainnet?: UtxoServer; testnet?: UtxoServer };   // testnet = Litecoin testnet4
  dogecoin: { mainnet?: UtxoServer; testnet?: UtxoServer };
  tron: { mainnet?: TronServer; testnet?: TronServer };       // testnet = Nile
  xrp: { mainnet?: XrpServer; testnet?: XrpServer };          // testnet = XRPL Testnet
  cardano: { mainnet?: CardanoServer; testnet?: CardanoServer };  // testnet = preprod
};
type UtxoServer = { kind: 'default' }       // Litecoin : litecoinspace.org ; Dogecoin mainnet : ElectrumX de Komodo ; Dogecoin testnet : AUCUN (lectures → SERVER_INVALID, voir §2.4)
                | { kind: 'esplora'; url: string };   // même type que le serveur par défaut (Esplora : electrs, mempool)
type BtcServer =
  | { kind: 'default' }                                   // mempool.space (son .onion en mode Tor)
  | { kind: 'esplora'; url: string }                      // ex. "https://mon-noeud.example/api"
  | { kind: 'electrum'; host: string; port: number;
      tls: 'webpki' | 'pinned' | 'none'; certSha256?: string /*64 hex, requis si 'pinned'*/ }
  | { kind: 'core'; url: string;                          // ex. "http://127.0.0.1:48332"
      auth: { kind: 'cookie'; cookiePath: string /*chemin absolu*/ }
          | { kind: 'userpass'; user: string; password?: string; hasPassword?: boolean } }
  | { kind: 'cbf';                                        // filtres compacts BIP157/158 (fonction `cbf`)
      peers?: string[] /*"onion:port" ou "ip:port", jamais de nom d'hôte*/; birthHeight?: number };
// `kind: 'cbf'` dans un build sans la fonction `cbf` : refusé par `settings_set` / `server_test` avec
// `FEATURE_DISABLED` (afficher « disponible après revue (≥ 2026-11-11) »).
type CbfStatus = { state: 'idle' | 'connecting' | 'headers' | 'filters' | 'synced' | 'error';
                   tipHeight: number | null; scannedHeight: number | null; birthHeight: number; progress: number /*0..1*/;
                   peers: string[]; tor: boolean; lastSyncUnix: number | null; watchedScripts: number;
                   matchedBlocks: number; message?: string };
// Pas de phase « blocs » distincte : les blocs correspondants sont téléchargés pendant `filters` (compteur `matchedBlocks`).
// Mot de passe Core : `settings_get` ne le renvoie JAMAIS (`hasPassword: true` à la place).
// Dans `settings_set` : `password` absent = garder celui enregistré (même URL et même user),
// `password: ""` = l'effacer, une valeur = le remplacer.
type ServerTestTarget =
  | { family: 'bitcoin'; network: 'mainnet' | 'testnet4'; server: BtcServer }
  | { family: 'evm'; chainId: number; server: { url: string } }
  | { family: 'solana'; cluster: 'devnet' | 'mainnet-beta'; server: { url: string } }
  | { family: 'litecoin' | 'dogecoin'; network: 'mainnet' | 'testnet'; server: UtxoServer }   // { kind: 'default' } Dogecoin testnet : SERVER_INVALID
  | { family: 'tron'; network: 'mainnet' | 'testnet'; server: TronServer }
  | { family: 'xrp'; network: 'mainnet' | 'testnet'; server: XrpServer }       // detected.chainId = network_id XRPL (0 mainnet, 1 testnet)
  | { family: 'cardano'; network: 'mainnet' | 'testnet'; server: CardanoServer };   // detected.chainId = networkmagic (764824073 / 1)
type CardanoServer = { kind: 'default' }    // Koios : preprod.koios.rest / api.koios.rest (offre publique gratuite, sans clé)
                   | { kind: 'koios'; url: string };   // instance Koios, URL de base de l'API, ex. "https://koios.example/api/v1"
type XrpServer = { kind: 'default' }        // s.altnet.rippletest.net:51234 (testnet) / xrplcluster.com (mainnet)
               | { kind: 'jsonRpc'; url: string };   // JSON-RPC rippled, même type que les serveurs par défaut
type TronServer = { kind: 'default' }       // TronGrid : api.trongrid.io / nile.trongrid.io
                | { kind: 'http'; url: string };   // API HTTP java-tron (FullNode), même type que TronGrid ; l'historique exige en plus l'API /v1 de TronGrid
type ServerTestResult = { latencyMs: number; detected: { network?: string; genesisHash?: string;
                          chainId?: number; serverVersion?: string; blockHeight?: number } };
type CoreStatus = { wallet: string; state: 'not-configured' | 'idle' | 'importing' | 'ready' | 'error'; walletLoaded: boolean;
                    scanProgress?: number /*0..1*/; scanDurationSecs?: number; error?: string };
type TorStatus = { state: 'off' | 'bootstrapping' | 'ready' | 'error'; progress: number /*0..100*/; message?: string };
```

Événements :
- `vault-locked` (sans contenu) émis par Rust à l'auto-lock ;
- `cbf-status` (`CbfStatus`) pendant une synchronisation par filtres compacts (au plus 2 par seconde) ;
- `tor-status` (`TorStatus`) émis à chaque changement d'état ou de progression du démarrage de Tor. Un démarrage bloqué passe en `error` après 120 s (jamais de `bootstrapping` infini).
- `hw-prompt` (`{ id, kind: 'confirm-on-device' | 'pin-on-device' | 'passphrase-on-device' | 'pin-matrix' | 'thp-confirm-pairing' | 'thp-pairing-code' | 'thp-confirm-connection' }`) pendant une opération hardware wallet : ce que l'UI doit dire à l'utilisateur (voir §2.3 ; les trois `thp-*` : Trezor Safe 7).

Erreurs : rejet de la promesse avec `{ code: 'WRONG_PASSWORD' | 'LOCKED' | 'RATE_LIMITED' | 'USER_REJECTED' | 'HOST_NOT_ALLOWED' | 'INVALID_INPUT' | 'INTERNAL' | 'TOR_UNAVAILABLE' | 'SERVER_INVALID' | 'SERVER_WRONG_NETWORK' | 'SERVER_UNREACHABLE' | 'DEFAULT_SERVER_DISABLED' | 'FEATURE_DISABLED' | 'HW_NOT_FOUND' | 'HW_LOCKED' | 'HW_WRONG_APP' | 'HW_REJECTED' | 'HW_DISCONNECTED' | 'HW_UNSUPPORTED' | 'HW_PAIRING_REQUIRED' | 'HW_PAIRING_FAILED' | 'HW_BUSY' | 'HW_TIMEOUT' | 'HW_BAD_RESPONSE' | 'HW_ADDRESS_MISMATCH' | 'HW_WRONG_DEVICE', message, data? }`. `data` n'existe que pour `HW_WRONG_APP` (`{ expected, open }`), `HW_UNSUPPORTED` (`{ min: string | null }`) et `HW_ADDRESS_MISMATCH` (`{ device, expected }`) ; les codes hardware wallet sont détaillés au §2.3. `TOR_UNAVAILABLE` : Tor activé mais pas prêt (démarrage trop long, échec, arrêté) — la requête n'a **pas** été envoyée.

- `SERVER_INVALID` : configuration refusée avant tout réseau (URL, schéma, identifiants dans l'URL, `.onion` sans Tor, empreinte mal formée, mot de passe manquant, fichier `.cookie` illisible, authentification RPC refusée, portefeuille `kyro-watch-…` absent).
- `SERVER_WRONG_NETWORK` : le serveur répond mais n'est pas sur la bonne chaîne (genesis Bitcoin, `getblockchaininfo.chain`, `eth_chainId`, `getGenesisHash`, `network_id` XRPL, bloc 0 TRON, `networkmagic` Cardano).
- `SERVER_UNREACHABLE` : le serveur personnalisé ne répond pas (connexion, TLS, épinglage non concordant, délai, réponse invalide). **Kyro ne se rabat jamais sur le serveur par défaut.**
- `FEATURE_DISABLED` : fonction absente de ce build (aujourd'hui : filtres compacts `cbf`, désactivés par défaut jusqu'à revue).
- `DEFAULT_SERVER_DISABLED` : requête vers le serveur par défaut d'une chaîne pour laquelle un serveur personnalisé est configuré (signe que l'UI n'utilise pas encore le bon serveur).

### 2.1 Vérifications des serveurs (à l'enregistrement et dans `server_test`)

| Type | Règles d'URL | Vérification en direct |
|---|---|---|
| Esplora | `https://` ; `http://` uniquement pour un `.onion`, via Tor ; jamais d'identifiants dans l'URL | `GET {url}/block-height/0` = genesis du réseau (mainnet `000000000019d6…e26f`, testnet4 `00000000da84f2…f043`) |
| Electrum | `host` + `port` ; `tls: 'none'` uniquement pour un `.onion` via Tor ; `pinned` exige `certSha256` | `server.version` (protocole 1.4) puis `server.features.genesis_hash` = genesis du réseau |
| Bitcoin Core | `http://` uniquement pour une adresse locale/LAN (127.0.0.0/8, ::1, RFC 1918, fc00::/7, fe80::/10, `localhost`) ; sinon `https://` ou `.onion` via Tor | `getblockchaininfo.chain` = `main` ou `testnet4` |
| XRP (`jsonRpc`) | comme Esplora | `server_info` → `info.network_id` = 0 (mainnet) ou 1 (testnet) ; devnet (2) et autres réseaux nommés dans l'erreur. `server_test` renvoie ce `network_id` dans `detected.chainId` (et `detected.blockHeight` = dernier registre validé) |
| Cardano (`koios`) | comme Esplora | `GET {url}/genesis` → `networkmagic` = 764824073 (mainnet) ou 1 (preprod) ; preview (2) et autres nommés dans l'erreur. `server_test` renvoie ce `networkmagic` dans `detected.chainId`. `detected.chainId` = `networkmagic`, `detected.blockHeight` = `GET {url}/tip` |
| TRON (`http`) | comme Esplora | `POST {url}/wallet/getblockbynum {num:0}` → `blockID` = mainnet `00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc` ou Nile `0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc` ; Shasta (`…de1aa882…a9059e`) est reconnu et nommé dans l'erreur |
| Esplora Litecoin / Dogecoin | comme Esplora | `GET {url}/block-height/0` = genesis de la chaîne (Litecoin mainnet `12a765e3…04bfe2`, testnet4 `4966625a…3e29a0` ; Dogecoin mainnet `1a91e3da…355691`, testnet `bb0a7826…50559e`) ; le message nomme la chaîne trouvée si c'en est une connue |
| EVM | comme Esplora | `eth_chainId` = la clé (`chainId`) |
| Solana | comme Esplora ; clé `devnet` ou `mainnet-beta` | `getGenesisHash` = devnet `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`, mainnet-beta `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` |

Si Tor est activé, les vérifications passent par Tor (un nœud Core local, lui, est joint directement). Changer `tor.enabled` et un serveur dans le même `settings_set` : la vérification utilise le nouveau mode, mais Tor ne démarre qu'après l'enregistrement — faire les deux changements séparément.

### 2.2 Bitcoin : ce que le côté TypeScript doit changer

Toutes les lectures et la diffusion Bitcoin passent désormais par des commandes Rust qui renvoient **exactement les formes Esplora** déjà consommées par `packages/chains/src/bitcoin/adapter.ts`, quel que soit le serveur (défaut, Esplora, Electrum, Core). Le choix du serveur et l'absence de repli sont donc garantis par Rust. Dans `BitcoinAdapter`, remplacer :

| Aujourd'hui (`net_fetch`) | Désormais (`call`) | Forme renvoyée |
|---|---|---|
| `fetchJson(`${base}/address/${a}`)` | `call('btc_address_info', { address: a })` | `{ address, chain_stats: { funded_txo_sum, spent_txo_sum, tx_count }, mempool_stats: { … } }` |
| `fetchJson(`${base}/address/${a}/utxo`)` | `call('btc_address_utxos', { address: a })` | `[{ txid, vout, value, status: { confirmed, block_height? } }]` |
| `fetchJson(`${base}/address/${a}/txs`)` | `call('btc_address_txs', { address: a })` | `[{ txid, fee?, status: { confirmed, block_height?, block_time? }, vin: [{ txid, vout, prevout: { scriptpubkey, scriptpubkey_address?, value } \| null }], vout: [{ scriptpubkey, scriptpubkey_address?, value }] }]` |
| `fetchJson(`${base}/v1/fees/recommended`)` | `call('btc_fee_rates')` | `{ fastestFee, halfHourFee, hourFee, economyFee, minimumFee }` (sat/vB) |
| `fetchText(`${base}/blocks/tip/height`)` | `call('btc_tip_height')` | `number` |
| `fetchText(`${base}/tx`, POST hex)` | `call('btc_broadcast', { hex })` | `string` (txid) |

Différences à connaître :
- Avec Electrum et Core, `funded_txo_sum` / `spent_txo_sum` portent le **solde net** (financé = solde, dépensé = 0, ou la part négative d'un solde non confirmé) ; `tx_count` est exact. Le calcul existant (`funded − spent`, `tx_count > 0` = adresse utilisée) reste juste.
- `btc_address_txs` renvoie, **pour tous les serveurs**, au plus les 50 transactions les plus récentes, non confirmées d'abord puis confirmées de la plus récente à la plus ancienne (pas de champ `truncated` : 50 entrées = il peut y en avoir d'autres). Avec Esplora (défaut ou perso), Rust suit la pagination `/txs` puis `/txs/chain/{dernier_txid}` jusqu'à 50. `prevout` vaut `null` quand l'entrée vient d'une transaction que le serveur ne fournit pas (Core : transaction hors portefeuille) ; `fee` est alors absent.
- Avec Core, le portefeuille `kyro-watch-…` doit exister : sinon `SERVER_INVALID` (« lance la configuration ») → l'UI propose `btc_core_setup`, puis suit `btc_core_status`.
- `esploraUrl` (registre) et `settings.rpc.esplora` ne servent plus : supprimer l'option `esploraUrl` de l'adaptateur. Le scan d'adresses et la construction des PSBT ne changent pas.
- Filtres compacts (`cbf`) : les mêmes commandes répondent depuis l'état local (jamais de requête réseau pendant l'appel) et relancent une synchronisation en arrière-plan si la dernière date de plus de 2 min. Avant la première synchronisation : `SERVER_UNREACHABLE` (« pas encore synchronisé »). Les paiements entrants **non confirmés** ne sont pas visibles (pas de mempool) ; seules nos propres diffusions apparaissent en attente. `btc_fee_rates` ajoute `source: 'block-average'` (moyenne des frais payés dans les derniers blocs, voir NETWORK.md).
- EVM et Solana restent sur `net_fetch` : l'UI utilise `servers.evm[chainId].url` ou `servers.solana[cluster].url` s'ils existent, sinon l'URL par défaut du registre.

### 2.3 Hardware wallets (Ledger, Trezor)

Transport USB en Rust : Ledger en HID (hidapi), Trezor en WebUSB (libusb via rusb, compilée et liée statiquement) ; Trezor Safe 7 par-dessus le même WebUSB avec le protocole chiffré **THP** (voir « Trezor Safe 7 » plus bas). Rien ne passe par l'UI ni par le réseau. Chaque appareil a **un verrou** (2ᵉ opération simultanée : `HW_BUSY`) ; chaque appel tourne hors du thread UI avec un **délai** (lecture de clés 90 s, PIN Trezor compris ; affichage d'adresse et signature 180 s ; `hw_list` 10 s). Les transports lisent par tranches de 100 ms : délai dépassé, `hw_cancel` ou débranchement terminent l'appel proprement (Trezor reçoit `Cancel`), la connexion est fermée puis rouverte à l'appel suivant, et rien n'est renvoyé.

Avec un coffre sur cet ordinateur, toutes les commandes `hw_*` qui lisent des clés, enregistrent ou signent exigent la session déverrouillée (`LOCKED`) ; un utilisateur « hardware wallet seul » n'a pas de coffre et pas de mot de passe Kyro (la confirmation se fait sur l'appareil). Les signatures hardware wallet ne demandent **pas** le mot de passe du coffre.

```ts
type DeviceInfo = { id: string; kind: 'ledger' | 'trezor'; model: string; transport: 'hid' | 'webusb' };
type Chain = 'btc' | 'evm' | 'sol' | 'ltc' | 'doge' | 'tron' | 'cardano' | 'xrp';   // phase 4 : HW_UNSUPPORTED
type DeviceStatus = { id: string; kind: 'ledger' | 'trezor'; model: string; locked: boolean;
  app?: { name: string; version: string };        // Ledger : app ouverte ("Tableau de bord" = dashboard)
  firmware?: string; passphrase?: boolean;        // Trezor
  protocol?: 'thp';                               // Trezor Safe 7 : canal THP chiffré et appairé
  chains: { chain: Chain; state: 'ready' | 'open-app' | 'unlock' | 'unsupported';
            app?: string /*app Ledger à ouvrir*/; min?: string /*version minimale*/; reason?: string }[] };
type HwXpub = { chain: Chain; account: number;
  btc?: { kind: 'segwit' | 'taproot'; xpub: string; fingerprint: string; path: string }[];   // BIP84 + BIP86
  evm?: { xpub: string /*nœud m/44'/60'/0'/0*/; path: string; address: string /*…/0/{account}*/ };
  sol?: { address: string; path: string /*m/44'/501'/{account}'/0'*/ } };
type WatchOnlyAccount = { id: string; label: string; device: 'ledger' | 'trezor'; model: string;
  network: 'mainnet' | 'testnet'; account: number; btc?: HwXpub['btc']; evm?: { xpub: string; path: string };
  sol?: { address: string; path: string } };
```

**Déroulé d'une signature** : (1) Rust décode (`btc_hw_plan` / `evm_decode` / `sol_decode_message`) ; (2) Rust relit les clés de l'appareil et les compare au compte enregistré (`HW_WRONG_DEVICE`) ; (3) dialogue natif Kyro avec le résumé décodé + « vérifie les mêmes informations sur l'appareil », puis 2ᵉ dialogue renforcé si quelque chose est « inconnu » (sortie BTC non décodée, appel de contrat EVM, instruction Solana inconnue) ou si l'appareil ne pourra pas afficher le détail (blind signing) ; (4) confirmation finale sur l'écran de l'appareil (`hw-prompt: confirm-on-device`) ; (5) Rust vérifie chaque signature (sighash recalculé, clé dérivée de l'xpub enregistrée ; EVM : adresse récupérée = adresse attendue, low-S ; Solana : ed25519 strict) avant de répondre. Une réponse de l'appareil qui ne passe pas : `HW_BAD_RESPONSE`, rien n'est renvoyé.

**PSBT pour hardware wallet** : chaque entrée doit avoir `witness_utxo` et la dérivation (`bip32_derivation` ou `tap_key_origins`, empreinte et chemin du compte) ; chaque entrée SegWit v0 doit aussi avoir **`non_witness_utxo`** (transaction précédente complète : exigée par Trezor, avertissement « entrées non vérifiées » sur Ledger sinon) — sinon `INVALID_INPUT` avant tout échange avec l'appareil. Les sorties de monnaie doivent porter leur dérivation pour être reconnues (sinon l'appareil les affiche comme des destinataires). Entrées étrangères : `HW_UNSUPPORTED`. Ledger : une seule sorte d'entrée (SegWit **ou** Taproot) par transaction.

**Applications et versions minimales**

| | Ledger (app à ouvrir, version min.) | Trezor (firmware min.) |
|---|---|---|
| Bitcoin (BIP84, BIP86, PSBT) | « Bitcoin Test » (testnet) / « Bitcoin » (mainnet) ≥ 2.1.0 | One ≥ 1.10.4 ; T, Safe 3, Safe 5, Safe 7 ≥ 2.4.3 (Safe 7 : tout firmware publié, ≥ 2.9.3) |
| EVM (EIP-1559) | « Ethereum » ≥ 1.9.0 (toutes les chaînes EVM) | One ≥ 1.10.4 ; T/Safe ≥ 2.4.2 |
| ERC-20 en clair | descripteur signé par Ledger requis : embarqué pour USDC et USDT (mainnet) et tUSDC (Sepolia) ; sinon blind signing (réglage de l'app) + dialogue renforcé | transfert : destinataire, montant brut et contrat affichés (« Unknown token » hors liste) ; `approve` et autres appels : dialogue renforcé |
| Solana | « Solana » ≥ 1.3.1 (blind signing requis pour les instructions qu'il ne décode pas : `HW_UNSUPPORTED`) | T/Safe ≥ 2.6.4 ; pas sur la One |
| Non pris en charge | — | mode bootloader, One < 1.7 (HID) ; Safe 7 : appairage autre que par code (QR, NFC : pas proposés par le firmware de production) |

PIN et passphrase : Ledger se déverrouille sur l'appareil (`HW_LOCKED` → l'UI demande de le déverrouiller puis de réessayer). Trezor T/Safe : PIN et passphrase saisis **sur l'appareil** (`hw-prompt`). Trezor One : PIN par la grille aveugle (`pin-matrix` → `hw_pin_matrix`) ; passphrase à saisir sur l'ordinateur → refusée (`HW_UNSUPPORTED`) : aucun secret ne transite par l'UI.

**Trezor Safe 7 (THP, Trezor Host Protocol)** — `hw/thp.rs`, `hw/thp_store.rs`. Même identifiant USB que les T/Safe (`1209:53c1`, interface WebUSB 0, paquets de 64 octets) : `hw_list` le liste comme `model: "Trezor"`, et `hw_open` le reconnaît à sa réponse `Failure(InvalidProtocol)` au premier message v1 (méthode de trezorlib), puis bascule en THP. Le modèle réel (« Trezor Safe 7 ») est dans `DeviceStatus.model`, avec `protocol: 'thp'`. Une fois connecté, **toutes les commandes existantes** marchent comme pour un Safe 5 (mêmes messages protobuf, mêmes vérifications Rust) : `hw_get_xpub`, `hw_account_add`, `hw_verify_address`, `hw_sign_btc_psbt` / `evm_tx` / `sol_tx`. Ce que fait Rust :
1. **Canal** : allocation sur le canal de diffusion, poignée de main `Noise_XX_25519_AESGCM_SHA256` (crate `snow`), puis tout est chiffré (AES-256-GCM). Appareil verrouillé : `hw-prompt` `pin-on-device`, le PIN se tape sur l'appareil pendant la poignée de main.
2. **Appareil déjà appairé** (identifiant THP enregistré) : pas de code ; l'appareil demande en général de **confirmer la connexion** de « Kyro Wallet » sur son écran (`hw-prompt` `thp-confirm-connection`). Kyro ne demande jamais l'option « autoconnect » (connexion sans confirmation).
3. **Appareil inconnu** : seulement dans `hw_open` (toute autre commande répond `HW_PAIRING_REQUIRED`). (a) l'appareil demande d'autoriser « Kyro Wallet » à s'appairer → `hw-prompt` `thp-confirm-pairing`. Kyro s'annonce avec le libellé fixe « Kyro Wallet » (champs `host_name` et `app_name` de `ThpPairingRequest`), **jamais le nom de l'ordinateur** ; aucun identifiant d'installation n'est nécessaire (l'identifiant THP est lié à la clé de Kyro, pas au libellé) ; (b) il affiche un **code à 6 chiffres** → `hw-prompt` `thp-pairing-code` : l'UI affiche un champ de saisie et appelle `hw_thp_pairing_code { id, code }` ; (c) Rust vérifie par CPace que l'appareil connaît le même code, puis que son secret correspond à l'engagement envoyé **avant** le défi de Kyro ; (d) l'appareil délivre un identifiant, enregistré dans `trezor-thp.json` (voir SECURITY.md) ; (e) confirmation de connexion éventuelle (`thp-confirm-connection`). Code faux, ou appareil qui ne prouve pas le code : `HW_PAIRING_FAILED` (rien n'est enregistré ; relancer `hw_open` : l'appareil affiche un nouveau code). Refus sur l'appareil : `HW_REJECTED`. Personne ne tape le code : `HW_TIMEOUT` après 180 s, et l'appareil reçoit `Cancel` pour quitter l'écran du code. `hw_cancel` : `USER_REJECTED`, idem.
4. Identifiant refusé par l'appareil (réinitialisé, hôtes oubliés) : Kyro l'efface et il faut réappairer (`HW_PAIRING_REQUIRED` hors `hw_open`).
5. **Sessions** : `GetFeatures` sur la session 0 (sans graine), puis `ThpCreateNewSession` (session 1) : passphrase **sur l'appareil** si elle est activée, sinon passphrase vide. Session oubliée par l'appareil (`ThpUnallocatedSession`) ou canal perdu (`UNALLOCATED_CHANNEL`, `DECRYPTION_FAILED`) : `HW_DISCONNECTED`, reconnexion à l'appel suivant (avec l'identifiant : pas de nouveau code).
6. **Authenticité** : THP authentifie l'appareil **auprès de Kyro** par l'appairage (le code vu sur l'écran physique), pas par un certificat du fabricant. Le contrôle « appareil authentique » de Trezor (`AuthenticateDevice` : chaînes X.509 Optiga P-256, Tropic Ed25519, MCU ML-DSA-44 jusqu'aux clés racines Trezor) est un message séparé, aussi disponible sur Safe 3/5, **non implémenté** par Kyro (voir SECURITY.md) ; à faire dans Trezor Suite.

*Ce que l'UI doit ajouter (rien n'est fait côté UI)* :
- Gérer les trois nouveaux `hw-prompt` dans l'écran d'opération hardware wallet : `thp-confirm-pairing` (« Sur ton Trezor, autorise Kyro Wallet à s'appairer »), `thp-pairing-code` (écran de saisie : 6 cases numériques, clavier numérique, bouton « Valider » → `hw_thp_pairing_code` ; bouton « Annuler » → `hw_cancel`), `thp-confirm-connection` (« Confirme la connexion sur ton Trezor »).
- Sur `INVALID_INPUT` de `hw_thp_pairing_code` : laisser la saisie ouverte. Sur `HW_PAIRING_FAILED` : expliquer « code incorrect », proposer de recommencer (`hw_open`, nouveau code).
- Sur `HW_PAIRING_REQUIRED` (n'importe quelle commande) : envoyer l'utilisateur vers « Connecter » (`hw_open`).
- Une petite liste « Appareils Trezor appairés » (`hw_thp_pairings`) avec « Oublier » (`hw_thp_forget { key }`) et « Tout oublier » (`hw_thp_forget {}`), en précisant que l'appareil, lui, garde Kyro dans sa liste jusqu'à sa réinitialisation.
- Afficher `DeviceStatus.protocol === 'thp'` (« canal chiffré, appairé ») si utile ; aucun autre changement des écrans BTC / EVM / Solana.

**Erreurs**

| Code | Quand | `data` |
|---|---|---|
| `HW_NOT_FOUND` | id inconnu (relancer `hw_list`) ou appareil introuvable à l'ouverture | |
| `HW_LOCKED` | appareil verrouillé (Ledger `5515`, ou `6982` hors signature) ; PIN Trezor incorrect | |
| `HW_WRONG_APP` | Ledger : mauvaise app ouverte (dashboard compris ; `6E00`, `6E01`, `6D00`, `6D02`, `6511`) | `{ expected, open }` |
| `HW_REJECTED` | refus sur l'appareil (Ledger `6985`, `5501`, `6982` en signature ; Trezor `ActionCancelled` / `PinCancelled`) | |
| `HW_DISCONNECTED` | erreur USB / débranchement, y compris pendant une signature : opération abandonnée, connexion fermée | |
| `HW_UNSUPPORTED` | chaîne de phase 4, firmware/app trop ancien, blind signing désactivé (Ledger `6A80` en signature EVM, `6808` Solana), passphrase Trezor One, entrées mixtes Ledger ; Safe 7 : version THP ≠ 2.x, appairage par code non proposé | `{ min }` |
| `HW_BUSY` | autre opération en cours sur cet appareil ; interface USB prise par une autre application (Trezor Suite, Ledger Live) ; Linux sans règles udev | |
| `HW_TIMEOUT` | pas de réponse dans le délai : opération abandonnée | |
| `HW_BAD_RESPONSE` | réponse mal formée, ou signature/adresse/clé qui ne passe pas la vérification de Kyro | |
| `HW_ADDRESS_MISMATCH` | l'adresse affichée par l'appareil ≠ celle dérivée par Kyro de l'xpub enregistrée : **ne pas utiliser l'adresse** | `{ device, expected }` |
| `HW_WRONG_DEVICE` | les clés de l'appareil ne sont pas celles du compte (autre appareil, autre passphrase, compte enregistré modifié) | |
| `HW_PAIRING_REQUIRED` | Trezor Safe 7 pas (ou plus) appairé avec Kyro, et la commande n'est pas `hw_open` : appairer d'abord par `hw_open` | |
| `HW_PAIRING_FAILED` | appairage THP échoué : code incorrect (refusé par l'appareil), ou l'appareil n'a pas prouvé le code (engagement/secret incohérents) ; rien n'est enregistré | |
| `INTERNAL` | (hardware wallet) fichier `trezor-thp.json` illisible ou non inscriptible, aléa du système indisponible ; `hw_thp_forget {}` remet le fichier à zéro | |
| `USER_REJECTED` | refus dans le dialogue natif de Kyro, ou `hw_cancel` | |

**Phase 4 (pas encore implémentée ; l'abstraction `HardwareWallet` a déjà les chaînes)** : Ledger — apps « Litecoin », « Dogecoin » (protocole Bitcoin historique, pas l'app v2), « Tron », « Cardano ADA », « XRP » ; Trezor — Litecoin et Dogecoin (même flux `SignTx` que Bitcoin, firmware universel), XRP (`RippleSignTx`), Cardano (T/Safe), Tron (firmware récent, `Capability_Tron`).

*Litecoin / Dogecoin sur hardware wallet — conception seulement (les commandes `hw_*` répondent toujours `HW_UNSUPPORTED` pour `ltc` / `doge`)* :
- **Trezor** : `GetPublicKey` / `GetAddress` / `SignTx` avec `coin_name = "Litecoin"` / `"Dogecoin"` (le firmware définit aussi `"Litecoin Testnet"` — `common/defs/bitcoin/litecoin_testnet.json` — mais **pas** de Dogecoin testnet : Dogecoin sur hardware wallet ne serait testable que sur mainnet). Script LTC `SPENDWITNESS`, DOGE `SPENDADDRESS`. Le flux `SignTx` du code BTC (`hw/trezor_btc.rs`) est réutilisable tel quel, paramétré par `coin_name` ; Trezor exige les transactions précédentes (`TxAck` prev) : `ltc_tx_hex` / `doge_tx_hex` les fournissent déjà, vérifiées par leur txid.
- **Ledger** : apps « Litecoin » et « Dogecoin » = **ancien protocole Bitcoin** (APDU `GET WALLET PUBLIC KEY`, `UNTRUSTED HASH TRANSACTION INPUT START/FINALIZE`, `UNTRUSTED HASH SIGN`), pas l'app Bitcoin v2 (PSBT + politiques) utilisée par Kyro pour BTC : il faudrait écrire ce transport (non fait ; `ledger_bitcoin_client` ne le couvre pas). L'app Dogecoin exige aussi les transactions précédentes complètes (trusted inputs).
- **Vérification Kyro** identique à BTC : recalcul du sighash (BIP143 LTC, legacy DOGE) avec `wallet-core`, signature vérifiée contre la clé dérivée de l'xpub enregistrée, low-S ; il faudrait ajouter `utxo_hw_plan` / `utxo_hw_finalize` (miroirs de `btc_hw_plan` / `btc_hw_finalize`) et des champs `ltc` / `doge` dans `WatchOnlyAccount` (format de fichier à versionner).

### 2.4 Litecoin et Dogecoin

Mêmes principes que Bitcoin (§2.2) : Rust choisit le serveur (`servers.litecoin` / `servers.dogecoin`, sinon le défaut), passe par les circuits Tor de la famille `litecoin` / `dogecoin`, ne se rabat jamais ; les lectures renvoient **exactement les formes Esplora** de §2.2. Adaptateurs TS : `LitecoinAdapter`, `DogecoinAdapter` (`packages/chains/src/litecoin/`, `dogecoin/`), créés par `createUtxoAdapters(accounts)`.

| Commande (`ltc_…` / `doge_…`) | Arguments | Retour | Notes |
|---|---|---|---|
| `…_backend_info` | — | `{ kind: 'default' \| 'esplora', network: 'mainnet' \| 'testnet', label, available, tor }` | `kind` = le réglage (`default` même quand le défaut Dogecoin mainnet parle Electrum) ; `label` = hôte (Dogecoin mainnet par défaut : `doge.electrum1.cipig.net`) ; `available: false` = Dogecoin **testnet** sans serveur configuré |
| `…_address` | `{ change, index, account? }` | `string` | coffre déverrouillé ; `m/84'/2'/account'/…` (LTC), `m/44'/3'/account'/…` (DOGE) |
| `…_address_info` / `…_address_utxos` / `…_address_txs` | `{ address }` | formes Esplora (§2.2) | adresse validée par Rust pour la chaîne et le réseau avant toute requête ; `txs` : 50 au plus, non confirmées d'abord. **Défaut Dogecoin mainnet (ElectrumX)** : `get_balance` + `get_history` (`funded_txo_sum`/`spent_txo_sum` portent le solde net, comme Electrum Bitcoin) ; `listunspent` puis **chaque UTXO confronté à sa transaction précédente** (`transaction.get`, hash recalculé ; la sortie doit exister, payer notre script et valoir exactement le montant annoncé, sinon `SERVER_UNREACHABLE` pour toute la liste ; 1 000 pièces au plus) ; historique : `get_history` + `transaction.get` des transactions et de leurs entrées + `block.header`, toute transaction qui ne touche pas l'adresse est écartée. Types stricts : txid 64 hex, montants entiers en koinus, `tx_pos` u32 |
| `…_tx_hex` | `{ txid }` | `string` | `GET /tx/{txid}/hex` (Electrum : `blockchain.transaction.get`), vérifié : txid recalculé = `txid` (et pas de témoin pour Dogecoin), sinon `SERVER_UNREACHABLE` |
| `…_fee_rates` | — | `{ fastestFee, halfHourFee, hourFee, economyFee, minimumFee, source? }` | unité minimale **par vbyte** (litoshis/vB ; koinus/octet). `/v1/fees/recommended` puis `/fee-estimates`. Dogecoin : bornes [0,01 ; 1] DOGE/kB (1 000–100 000 koinus/o) ; serveur sans estimation (404) → 0,01 DOGE/kB, `source: 'policy'`. Electrum (Dogecoin mainnet) : `estimatefee` à 2 / 30 / 60 / 144 blocs (≈ 2 min / ½ h / 1 h / 1 j) + `relayfee`, mêmes bornes ; aucune estimation → `source: 'policy'` |
| `…_tip_height` | — | `number` | |
| `…_broadcast` | `{ hex }` | `string` (txid) | transaction décodée d'abord ; txid du serveur = le nôtre, sinon erreur (Electrum : `blockchain.transaction.broadcast`) |
| `…_sign_psbt` | `{ psbt, password, account? }` | `{ psbt /*signée, non finalisée*/, summary: UtxoTxSummary }` | mot de passe → `utxo_psbt_summary` → dialogue natif (destinataires, montants, monnaie, frais, taux, taille ; « Pas de monnaie… » si aucune ; entrées étrangères) → **2ᵉ dialogue renforcé** si `requiresExtraConfirmation` (sortie inconnue « INCONNUE », OP_RETURN, entrée étrangère, poussière douce DOGE, frais très élevés) → signature ; le résumé de la signature doit être identique à celui affiché |

Règles de construction (TS) vérifiées par Rust :
- **Litecoin** : chaque entrée a `witness_utxo` + `bip32_derivation` (`m/84'/2'|1'/0'/…`) ; la monnaie porte sa dérivation (sinon elle s'affiche comme un destinataire) ; poussière = `GetDustThreshold` de Litecoin Core à 30 000 lit/kvB (P2WPKH 2 940 litoshis, P2PKH 5 460) : destinataire en dessous refusé, monnaie en dessous ajoutée aux frais ; minimum 1 litoshi/vB.
- **Dogecoin** : chaque entrée a **`non_witness_utxo`** (transaction précédente complète, `doge_tx_hex`) — c'est ce qui prouve les montants, que le sighash legacy n'engage pas — et **pas** de `witness_utxo` ; frais par taille (0,01 DOGE/kB recommandé = minimum de Kyro ; relais 0,001 DOGE/kB) ; aucune sortie sous 0,01 DOGE (poussière douce : chaque sortie en dessous coûte 0,01 DOGE de frais en plus ; sous 0,001 DOGE, non standard → Rust refuse).
- Taille (identique TS/Rust, signature la plus longue) : P2WPKH 10,5 + 68 par entrée + sorties (31 P2WPKH) vB ; P2PKH 10 + 148 par entrée + 34 par sortie octets.
- **Serveur par défaut Dogecoin** : mainnet → ElectrumX publics de Komodo (`doge.electrum1.cipig.net:20060`, secours `doge.electrum2.cipig.net:20060`, allowlist `net::ELECTRUM_HOSTS`, TLS validé, genesis vérifié à chaque session, circuits Tor `dogecoin`) ; **testnet → aucun** : `{ kind: 'default' }` → toute lecture `SERVER_INVALID` (« configure ton serveur Esplora (electrs-dogecoin) »). Voir NETWORK.md.
- **Avant toute signature Dogecoin** (et toute entrée Litecoin qui porte `non_witness_utxo`), Rust (`wallet-core`) recalcule le hash de la transaction précédente : il doit égaler le txid de l'outpoint ; le `vout` doit exister ; son script doit être le nôtre ; **le montant (et donc les frais du dialogue natif) vient uniquement de cette transaction**, jamais de la liste d'UTXO du serveur. Sinon : refus (`INVALID_INPUT`), avant le dialogue.
- Montants JSON : une sortie au-delà de 2⁵³ unités (≈ 90 millions de DOGE) n'est pas lisible sans perte en JS : l'adaptateur la refuse (la signature, elle, prend les montants dans les transactions précédentes, en Rust).

**Fait côté UI** (commit de l'UI Litecoin / Dogecoin) : types `Commands` de `@kyro/shared` (`ltc_*`, `doge_*`, `btc_tx_hex`, `Accounts.ltc/doge`, `Servers.litecoin/dogecoin`, `ServerTestTarget`), backend démo, écrans Envoyer/Recevoir/Actif/Historique pour ces familles, réglages serveurs, liste « Connexions sortantes », sortie de `WATCH_ONLY_CHAINS`.

### 2.5 TRON (TRX, TRC-20)

Rust choisit le serveur (`servers.tron`, sinon TronGrid), famille Tor `tron`, jamais de repli. **Rust construit lui-même `raw_data`** (wallet-core `TronRaw`) depuis `/wallet/getnowblock` : `ref_block_bytes` = octets 6..8 du numéro, `ref_block_hash` = octets 8..16 du `blockID` (vérifié : l'id commence par le numéro), `timestamp` = horodatage du bloc, `expiration` = bloc + 10 min. `createtransaction` du serveur n'est **jamais** utilisé pour ce qui est signé (le test réel compare seulement l'encodage de Kyro au sien : identique octet pour octet).

| Commande | Arguments | Retour | Notes |
|---|---|---|---|
| `tron_backend_info` | — | `{ kind: 'default' \| 'http', network: 'mainnet' \| 'testnet', label, tor }` | |
| `tron_address` | `{ account?, index? }` | `string` | `m/44'/195'/{account}'/0/0`, coffre déverrouillé ; une adresse par compte (`index` ≠ 0 refusé) ; `tron_build_tx`, `tron_sign_tx`, `tron_broadcast` et `tron_stake_*` prennent le même `account?` |
| `tron_account` | `{ address }` | `{ address, exists, balance /*sun*/, freeBandwidthLimit, freeBandwidthUsed, bandwidthLimit, bandwidthUsed, energyLimit, energyUsed }` | `getaccount` + `getaccountresource` ; `exists: false` = compte jamais activé |
| `tron_trc20_balance` | `{ contract, address }` | `string` (unités brutes) | `balanceOf` par `triggerconstantcontract` |
| `tron_txs` | `{ address }` | `[{ txid, kind: 'trx' \| 'trc20', from, to, amount, token?: { contract, symbol, decimals }, timestamp, status: 'confirmed' \| 'failed' }]` | API `/v1` de TronGrid (50 TRX + 50 TRC-20 au plus, plus récentes d'abord) ; un nœud java-tron seul n'a pas d'historique → `SERVER_UNREACHABLE` explicite ; pas de frais dans la réponse, et les transferts TRC-20 sont toujours marqués `confirmed` (l'API /v1 ne donne pas leur résultat) |
| `tron_build_tx` | `{ to, amount /*sun ou unités du token*/, token? /*contrat T…*/, account? }` | `{ raw /*hex*/, txid, summary: TronTxSummary, estimate: TronEstimate }` | TRX : `TransferContract`. TRC-20 : `transfer(to, amount)`, énergie **simulée** (`triggerconstantcontract`, `energy_used + energy_penalty`) ; un transfert qui échouerait (solde de token insuffisant) est refusé ; `fee_limit` = énergie × prix × 1,3, au moins 1 TRX, au plus `getMaxFeeLimit`. Rust re-décode ce qu'il a construit |
| `tron_sign_tx` | `{ raw, password, token?: { symbol, decimals }, account? }` | `{ signature /*65 octets hex*/, txid, summary, estimate }` | décode (`tron_decode_raw`, owner = nous), refuse expirée ou expiration > 24 h, mot de passe, **relit en direct** compte, paramètres de chaîne, existence du destinataire et énergie simulée → dialogue natif : destinataire, montant (USDT nommé par Rust : mainnet `TR7NHq…`, Nile `TXYZop…` ; autre token : unités brutes, `token` de l'UI affiché comme « selon l'interface, non vérifié »), **bande passante nécessaire / disponible (gratuite, gelée) et TRX brûlés**, **énergie estimée / disponible, TRX brûlés estimés et au maximum (`fee_limit`)**, **activation d'un compte inexistant** (création 1 TRX + 0,1 TRX sans bande passante gelée, valeurs lues dans `getchainparameters`), total estimé et maximum, solde, mémo, expiration, bloc de référence, txid ; 2ᵉ dialogue renforcé si `requiresExtraConfirmation` (appel autre que `transfer`, TRX envoyés au contrat, mémo, `fee_limit` > 100 TRX) ; résumé de la signature = résumé affiché |
| `tron_broadcast` | `{ raw, signature, account? }` | `string` (txid) | la signature doit redonner notre adresse ; `/wallet/broadcasthex` ; txid du serveur = `sha256(raw)` sinon `SERVER_UNREACHABLE` ; refus du réseau → `INVALID_INPUT` avec le message décodé |

**Historique et nœud personnel** : `tron_txs` utilise l'API `/v1` propre à TronGrid. Un nœud java-tron seul (serveur `http` personnalisé) ne l'a pas : la commande échoue alors avec `SERVER_UNREACHABLE` et un message explicite (« l'historique exige l'API /v1 de TronGrid »), sans jamais se rabattre sur TronGrid. Soldes, ressources, construction, signature et diffusion fonctionnent avec n'importe quel nœud java-tron.

**Clé TronGrid (optionnelle)** : `KYRO_TRONGRID_API_KEY` (env, développement) ou `settings.apiKeys.trongrid`. Rust l'ajoute en en-tête `TRON-PRO-API-KEY` **uniquement** vers `api.trongrid.io` et `nile.trongrid.io` (jamais vers un nœud personnel ni un autre hôte) ; l'UI ne voit jamais la clé (`config_get.hasTrongridKey`). Sans clé : quotas réduits, et des relais de sortie Tor peuvent recevoir un 403.

Refusé avant toute signature : autre type de contrat que TRX / appel de contrat (**délégation de ressources**, **changement de permissions**… ; gel, dégel, vote et récompenses passent uniquement par `tron_stake_*`, §2.8), `Permission_id` (multi-signature), autre propriétaire, `auths`, `scripts`, valeur TRC-10, encodage non canonique. Estimation de bande passante : taille signée + 64 octets (comme java-tron). Hardware wallets : `HW_UNSUPPORTED` (Trezor a `TronSignTx`, Ledger l'app « Tron » : non faits).

**Fait côté UI** (commit de l'UI TRON) : `Family` `'tron'`, types `Commands` (`tron_*`, `Accounts.tron`, `Servers.tron`, `ServerTestTarget`), backend démo, écrans Envoyer (afficher `estimate` avant le mot de passe : bande passante, énergie, activation), Recevoir, Actif (TRX, USDT), Historique, réglage serveur TRON, « Connexions sortantes », sortie de TRON de `WATCH_ONLY_CHAINS`. Adaptateur : `TronAdapter` (`packages/chains/src/tron/`), `tronChain(network)`, `TRON_USDT`.

### 2.6 XRP Ledger (paiements XRP et monnaies émises)

Rust choisit le serveur (`servers.xrp`, sinon le défaut), famille Tor `xrp`, jamais de repli. **Rust construit le Payment** : `Sequence` (`account_info`, registre courant), `Fee` (`fee` : frais du registre ouvert, au moins le frais de référence), `LastLedgerSequence` = registre courant + 20 (≈ 1 min), `Flags` = `tfFullyCanonicalSig`, `SigningPubKey` = notre clé ; encodé par wallet-core. Un blob construit par le serveur n'est jamais signé.

| Commande | Arguments | Retour | Notes |
|---|---|---|---|
| `xrp_backend_info` | — | `{ kind: 'default' \| 'jsonRpc', network: 'mainnet' \| 'testnet', label, tor }` | |
| `xrp_address` | `{ account?, index? }` | `string` | `m/44'/144'/{account}'/0/0`, coffre déverrouillé ; une adresse par compte (`index` ≠ 0 refusé) ; `xrp_build_tx`, `xrp_sign_tx`, `xrp_broadcast` prennent le même `account?` |
| `xrp_account` | `{ address }` | `{ address, exists, balance /*drops*/, sequence, ownerCount, flags, requireDestTag, disallowXrp, reserve, spendable }` | `account_info` + réserves de `server_info.validated_ledger` (`reserve_base_xrp`, `reserve_inc_xrp` : **1 XRP et 0,2 XRP**, lus en direct le 30/10/2026 sur testnet et mainnet) ; `reserve` = base + 0,2 × objets possédés ; `spendable` = solde − réserve ; compte inexistant : `exists: false` |
| `xrp_lines` | `{ address }` | `[{ currency, issuer, balance, limit }]` | lignes de confiance (monnaies émises) |
| `xrp_txs` | `{ address }` | `[{ hash, from, to, destinationTag, amount, fee, ledger, time, result }]` | 50 derniers Payment ; `amount` = **montant réellement livré** (`delivered_amount`) |
| `xrp_build_tx` | `{ to, amount /*drops, ou valeur décimale si issued*/, destinationTag?, issued?: { currency, issuer }, account? }` | `{ blob /*non signé, hex*/, summary: XrpTxSummary, context: { account, destination, reserveBase, reserveInc } }` | refusé avant toute construction : destinataire avec `lsfRequireDestTag` **sans tag** ; compte destinataire inexistant et montant XRP < réserve de base (`tecNO_DST_INSUF_XRP`) ; monnaie émise vers un compte inexistant (`tecNO_DST`) ; montant + frais > disponible ; notre compte non activé |
| `xrp_sign_tx` | `{ blob, password, account? }` | `{ blob /*signé*/, hash, summary, context }` | décode (strict, Account et clé = nous), refuse `LastLedgerSequence` dépassé et séquence périmée, **relit en direct** les deux comptes et les réserves et refait les vérifications ci-dessus, mot de passe → dialogue natif : destinataire, **TAG DE DESTINATION encadré sur sa propre ligne** (ou « AUCUN TAG DE DESTINATION » avec l'avertissement), montant, SendMax, création du compte destinataire, frais, solde, réserve bloquée (base + objets), disponible, registre limite, mémos ; 2ᵉ dialogue renforcé si `requiresExtraConfirmation` ; résumé de la signature = résumé affiché |
| `xrp_broadcast` | `{ blob, account? }` | `string` (hash) | `xrp_verify_signed` (DER low-S, clé = Account = nous) puis `submit` ; `tesSUCCESS` ou `terQUEUED` acceptés, sinon `INVALID_INPUT` avec le code ; hash du serveur = `SHA-512Half("TXN\0"‖blob)` sinon `SERVER_UNREACHABLE` |
| `xrp_tx_status` | `{ hash }` | `{ validated, result }` | `tx` : `validated: true` et `result: 'tesSUCCESS'` une fois dans un registre validé |

Refusé avant toute signature : tout autre type de transaction (AccountSet, SetRegularKey, SignerListSet, TrustSet, OfferCreate, EscrowCreate…), **paiement partiel** (`tfPartialPayment` : le montant livré pourrait être presque nul), `Paths`, `DeliverMin`, `TicketSequence`, `NetworkID`, drapeaux inconnus, champs inconnus. Plus strict que « inconnu → confirmation renforcée » : un champ que Kyro ne sait pas décoder n'est jamais signé. Hardware wallets : `HW_UNSUPPORTED` (Trezor `RippleSignTx`, Ledger app « XRP » : non faits).

**Pour l'UI** : le champ **Tag de destination** doit être visible en permanence sur l'écran Envoyer XRP (pas caché dans « options »), avec `parseDestinationTag` (entier 0 … 4 294 967 295) ; s'il est vide, afficher l'avertissement ; si `xrp_account(destination).requireDestTag`, le rendre **obligatoire** (Rust refuse de toute façon) ; afficher `spendable` (pas seulement le solde) et, pour un destinataire inexistant, « au moins 1 XRP » ; après `xrp_broadcast`, suivre `xrp_tx_status`. **Fait côté UI** (commit 158b505) : `Family` `'xrp'`, types `Commands` (`xrp_*`, `Accounts.xrp`, `Servers.xrp`, `ServerTestTarget`), backend démo, écrans Envoyer / Recevoir (adresse + tag éventuel) / Actif (XRP, lignes de confiance) / Historique, réglage serveur XRPL, « Connexions sortantes », sortie de XRP de `WATCH_ONLY_CHAINS`. Adaptateur : `XrpAdapter` (`packages/chains/src/xrp/`), `xrpChain(network)`.

### 2.7 Cardano (ADA et tokens natifs)

Rust choisit le serveur (`servers.cardano`, sinon Koios : `preprod.koios.rest` / `api.koios.rest`, offre publique gratuite sans clé), famille Tor `cardano`, jamais de repli. Blockfrost n'est pas utilisé : Koios fournit tout ce qu'il faut (UTxO, paramètres, tip, historique, `submittx`). **Rust construit la transaction** : UTxO de notre adresse (`address_utxos`), paramètres (`epoch_params` : `min_fee_a`, `min_fee_b`, `coins_per_utxo_size`, `max_tx_size`, bornés contre un serveur hostile), sélection des UTxO (ceux qui portent le token demandé d'abord, puis ADA seuls par valeur décroissante, ceux avec tokens en dernier), une sortie destinataire + une sortie de monnaie qui rend **tous** les tokens restants, frais = `min_fee_a × taille signée + min_fee_b` (itéré), chaque sortie ≥ son min-UTxO, `ttl` = slot courant + 3 600 (≈ 1 h), ensembles taggés 258 (Conway), aucun collatéral, aucun certificat. Encodé par wallet-core ; une transaction construite par le serveur n'est jamais signée.

**Mode une seule adresse** (par compte) : réception et monnaie sur `m/1852'/1815'/a'/0/0` (staking `…/a'/2/0`) du compte `a` (0 = l'historique `m/1852'/1815'/0'/0/0`), comme les portefeuilles « single address » ; plus simple et plus sûr à vérifier, mais tous les paiements sont liés à une adresse (et à une clé de staking) visible. Staking (enregistrement, délégation, vote, retraits) : §2.8, toujours avec cette clé `…/0'/2/0` ; `ada_sign_tx` refuse toujours certificats et retraits.

| Commande | Arguments | Retour | Notes |
|---|---|---|---|
| `ada_backend_info` | — | `{ kind: 'default' \| 'koios', network: 'mainnet' \| 'testnet', label, tor }` | |
| `ada_address` | `{ index, account? }` | `{ address, path, stakeAddress, accountXpub }` | coffre déverrouillé ; **la signature n'utilise que l'index 0** du compte : l'UI ne doit afficher que cette adresse ; `accountXpub` = clé publique ‖ chain code de `m/1852'/1815'/{account}'` (hex) ; `ada_build_tx`, `ada_sign_tx`, `ada_broadcast` et `ada_stake_*` prennent le même `account?` |
| `ada_account` | `{ address }` | `{ address, balance /*lovelace*/, tokens: [{ policy, name /*hex*/, nameText, quantity, verified, ticker?, decimals? }], utxoCount, lockedWithTokens }` | `lockedWithTokens` = ADA immobilisés par les tokens (min-UTxO de leurs sorties) : ce qui ne peut pas partir sans eux |
| `ada_txs` | `{ address }` | `[{ hash, time, blockHeight, fee, lovelaceDelta /*signé*/, tokenDeltas: [{ policy, name, nameText, delta }], memo }]` | 20 dernières (`address_txs` + `tx_info`), plus récente d'abord ; `memo` = message CIP-20 |
| `ada_tx_status` | `{ hash }` | `{ confirmations: number \| null }` | `null` : pas encore vue par l'indexeur |
| `ada_build_tx` | `{ to, lovelace?, token?: { policy, name, quantity }, memo?, account? }` | `{ tx /*non signée, CBOR hex*/, summary: CardanoTxSummary, context: { account, params, tip, leaving } }` | **garde toujours une sortie de monnaie** (au moins son min-UTxO, ≈ 1 ADA) : « tout envoyer » laisse donc environ 1 ADA sur l'adresse ; `lovelace` absent avec un token = exactement le min-UTxO de la sortie ; refusé avant toute construction : adresse refusée (voir §1), montant sous le min-UTxO (le message donne le minimum), token ou ADA insuffisants, monnaie sous son min-UTxO, transaction > `max_tx_size`. `leaving` = sorties vers d'autres adresses + frais |
| `ada_sign_tx` | `{ tx, password, account? }` | `{ tx /*signée*/, txId, summary, context }` | décode (strict), refuse `ttl` dépassé, **relit en direct** nos UTxO : chaque entrée doit être un de nos UTxO non dépensés, et entrées = sorties + frais (ADA et chaque token) ; frais ≥ minimum ; mot de passe → racine Icarus re-dérivée du coffre → dialogue natif : **chaque sortie** (destinataire ou monnaie, adresse complète, ADA, « dont X ADA minimum obligatoire avec les tokens », chaque token : quantité, nom texte et hex, policy id, vérifié ou NON VÉRIFIÉ), frais, total qui quitte le portefeuille, validité (slot, ≈ minutes), message ; 2ᵉ dialogue renforcé si `requiresExtraConfirmation` (message CIP-20, token hors table vérifiée, frais > 5 ADA, pas de ttl) ; résumé de la signature = résumé affiché |
| `ada_broadcast` | `{ tx, account? }` | `string` (tx id) | `cardano_signed_witnesses` (chaque signature vérifiée sur blake2b-256 du corps, **un seul témoin : notre clé de paiement**) puis Koios `POST /submittx` (CBOR brut, `application/cbor`) ; l'id renvoyé doit être blake2b-256(corps), sinon `SERVER_UNREACHABLE` ; refus du nœud → `INVALID_INPUT` avec son message |

Table de tokens vérifiés (mainnet seulement, vérifiée le 30/10/2026 via Koios `asset_info` / registre de tokens Cardano) : DJED (`8db269c3…cd61` / `446a65644d6963726f555344`), USDM (`c48cbb3d…47ad` / `0014df105553444d`), iUSD (`f66d78b4…9880` / `69555344`). Sur preprod : aucune, tout token demande la confirmation renforcée. N'importe qui peut créer un token au même nom : seule la policy id compte.

Hardware wallets : `HW_UNSUPPORTED`. Ce qu'il faudrait : Ledger app « Cardano ADA » (APDU `DERIVE_ADDRESS` / `GET_EXT_PUBKEY` pour `m/1852'/1815'/a'`, `SIGN_TX` qui reçoit la transaction champ par champ et rend les témoins ; dérivation « Ledger » ≠ Icarus pour une même phrase de 24 mots) ; Trezor `CardanoGetPublicKey` / `CardanoGetAddress` / `CardanoSignTxInit` + flux d'entrées / sorties / tokens (`derivation_type` ICARUS ou ICARUS_TREZOR, qui diffère d'Icarus pour 24 mots). Dans les deux cas Kyro reconstruirait le corps lui-même et vérifierait chaque témoin contre blake2b-256 du corps, comme `btc_hw_finalize`.

**Fait côté UI** (commit 45208d5) : `Family` `'ada'` (aujourd'hui `CardanoChain` / `cardanoChain(network)` existent dans le registre mais hors `Family` et `allChains()`), types `Commands` de `@kyro/shared` (`ada_*`, `Accounts.cardano`, `Servers.cardano`, `CardanoServer`, `ServerTestTarget` `cardano` ; les types sont aujourd'hui dans `packages/chains/src/cardano/adapter.ts`, à déplacer dans `ipc.ts`), `WalletAccounts.cardano` et `AdapterSet.cardano` (`createAdapters`), backend démo, écrans Envoyer (adresse, montant ADA avec `adaToLovelace`, token facultatif avec quantité, message facultatif public, aperçu du `summary` avant le mot de passe : sorties, min-ADA, frais), Recevoir (adresse de base seule), Actif (ADA, `spendable` = solde − `lockedWithTokens`, liste des tokens avec policy id et mention « non vérifié »), Historique (`lovelaceDelta`, tokens, message), réglage serveur Cardano (Koios), « Connexions sortantes » (`preprod.koios.rest` / `api.koios.rest`), sortie de Cardano de `WATCH_ONLY_CHAINS`. Adaptateur : `CardanoAdapter` (`packages/chains/src/cardano/`), `isCardanoAddress`, `isByronAddress`.

### 2.8 Staking (Solana, Cardano, TRON)

**Chaînes concernées.** Solana (staking natif, programme Stake), Cardano (délégation à un pool + délégation de vote, Conway) et TRON (Stake 2.0 + votes pour les SR). **Pas de staking** pour Bitcoin, Litecoin, Dogecoin et XRP Ledger : ces protocoles n'en ont pas. **Ethereum (et chaînes EVM) : hors périmètre** — le staking natif exige 32 ETH et un validateur qui tourne en permanence ; le « staking liquide » (Lido, Rocket Pool…) n'est qu'un appel au contrat d'un tiers (risque de contrat et de garde), que Kyro ne décode pas : il n'est pas proposé.

**Principe commun.** L'UI ne construit rien : elle choisit une opération, `*_stake_build({ action })` la fait **construire par Rust** (données lues en direct via Tor, familles `solana` / `cardano` / `tron`, aucun nouvel hôte) et renvoie le résultat **décodé par wallet-core** avec le contexte vivant (validateur / pool / SR, montants, calendrier) à afficher **avant** le mot de passe. `*_stake_sign({ …, password })` redécode, **relit tout en direct** et refait chaque vérification, demande le mot de passe, ouvre la **fenêtre native** (texte construit par Rust), puis la **2ᵉ fenêtre renforcée** si `requiresExtraConfirmation`, signe et vérifie la signature ; le résumé signé doit être identique à celui affiché. Toute opération qui n'est pas exactement une de celles listées ici est refusée (`INVALID_INPUT`, message en français). Montants : chaînes décimales en plus petite unité (lamports, lovelace, sun). Coffre verrouillé : `LOCKED`. Serveur en panne ou réponse invalide : `SERVER_UNREACHABLE` (jamais de repli). Pas de hardware wallet pour le staking (`HW_UNSUPPORTED` n'est pas renvoyé : les commandes `hw_*` ne le proposent simplement pas).

#### Solana (`sol_stake_*`) — compte de staking dérivé de ton adresse (`createWithSeed(toi, "kyro-stake-N", Stake)`), toi comme staker **et** withdrawer, aucun blocage

| Commande | Arguments | Retour | Notes |
|---|---|---|---|
| `sol_stake_overview` | — | `SolStakeOverview` | comptes de staking dont tu es le **withdrawer** (`getProgramAccounts`, filtre `memcmp` offset 44, revérifié par Rust après lecture), état calculé par Rust depuis le sysvar StakeHistory, époque, minimum de délégation (`getStakeMinimumDelegation` : **1 SOL sur devnet** le 30/10/2026), réserve de rent d'un nouveau compte (`getMinimumBalanceForRentExemption(200)`) |
| `sol_stake_validators` | `{ withNames?: boolean /*défaut true*/ }` | `{ validators: SolValidator[], namesAvailable: boolean }` | `getVoteAccounts` (en cours puis en retard), triés par stake actif ; noms des comptes validator-info (programme Config, **déclarés, non vérifiés**) ; mainnet : ≈ 2 Mo à lire via Tor, `withNames: false` pour s'en passer (`namesAvailable: false` si la lecture échoue) |
| `sol_stake_build` | `{ action: SolStakeRequest }` | `{ message /*b64, legacy, non signé*/, summary: SolTxSummary, stake: SolStakePreview }` | refusé avant construction : montant < minimum de délégation, solde < montant + rent + frais, compte de vote inconnu de `getVoteAccounts`, compte de staking pas entièrement à toi (staker, withdrawer, blocage), délégation d'un compte qui n'est pas inactif, désactivation d'un compte non délégué, retrait au-delà de `withdrawable` (ou tout le solde alors que du stake reste actif) |
| `sol_stake_sign` | `{ message, password }` | `{ signature /*b64*/, summary, stake }` | décodage wallet-core (`sol_decode_message`) ; le message doit être **exactement** une des 4 opérations Kyro (payeur et seul signataire = toi, pas de table d'adresses) ; relit en direct l'époque, la rent, le solde, le compte de staking et le validateur ; dialogue natif : opération, compte, montants (délégué, réserve de rent, total), validateur (compte de vote, identité, nom déclaré, commission, stake actif, en retard ou non), autorités, époque en cours et temps restant, activation à l'époque N+1 ou refroidissement, frais, « pas de slashing » ; **renforcé** si le validateur est en retard (`delinquent`) ou garde plus de 10 % de commission |
| `sol_stake_broadcast` | `{ message, signature }` | `string` (signature base58 = id) | le message doit être une opération de staking Kyro, la signature doit se vérifier pour ton adresse ; `sendTransaction` (preflight) ; l'id renvoyé doit être la signature ; refus du réseau → `INVALID_INPUT` avec son message. Suivi : `getSignatureStatuses` par `net_fetch`, comme les envois |

```ts
type SolStakeRequest =
  | { kind: 'createAndDelegate'; lamports: string /*montant délégué ; Kyro ajoute la réserve de rent*/; voteAccount: string }
  | { kind: 'delegate'; stakeAccount: string; voteAccount: string }        // compte « initialized » ou « inactive » uniquement
  | { kind: 'deactivate'; stakeAccount: string }                           // compte « activating » ou « active »
  | { kind: 'withdraw'; stakeAccount: string; lamports?: string };         // absent = le maximum (tout le solde si canClose)
type SolEpoch = { epoch: number; slotIndex: number; slotsInEpoch: number; absoluteSlot: number; secondsLeft: number /*≈, 400 ms par slot*/ };
type SolStakePosition = {
  address: string; lamports: string; state: 'initialized' | 'activating' | 'active' | 'deactivating' | 'inactive';
  rentExemptReserve: string; staker: string; withdrawer: string;
  ours: boolean /*staker = withdrawer = toi et pas de blocage en cours : gérable par Kyro*/; lockupInForce: boolean;
  voteAccount: string | null; delegated: string | null; activationEpoch: number | null; deactivationEpoch: number | null;
  effective: string; activating: string; deactivating: string;   // lamports
  withdrawable: string /*retrait partiel max sans fermer le compte*/; canClose: boolean /*tout le solde retirable (ferme le compte)*/ };
type SolStakeOverview = { address: string; balance: string; epoch: SolEpoch; minimumDelegation: string; rentExemptReserve: string;
                          accounts: SolStakePosition[] };
type SolValidator = { voteAccount: string; identity: string; name: string | null /*déclaré, non vérifié*/; commission: number /*%*/;
                      activatedStake: string; delinquent: boolean; lastVote: number; epochVoteAccount: boolean };
type SolStakeWarning = { kind: 'delinquent' } | { kind: 'highCommission'; commission: number };
type SolStakePreview = {
  kind: 'createAndDelegate' | 'delegate' | 'deactivate' | 'withdraw'; stakeAccount: string; seed: string | null;
  lamports: string | null /*versés au nouveau compte, ou retirés*/; delegated: string | null; rentExemptReserve: string;
  validator: SolValidator | null; account: SolStakePosition | null /*état actuel d'un compte existant*/;
  balance: string; fee: string; epoch: SolEpoch; closesAccount: boolean;
  warnings: SolStakeWarning[]; requiresExtraConfirmation: boolean };
```
`summary.instructions` contient les variantes `stakeInitialize`, `stakeDelegate`, `stakeDeactivate`, `stakeWithdraw` (§1), plus `systemCreateAccountWithSeed` pour une création.

Calendrier : une délégation s'active au début de l'époque suivante (≈ 2 jours par époque sur devnet et mainnet : 432 000 slots), plus si le réseau limite la montée (9 % du stake total par époque) ; même chose pour le refroidissement après `deactivate`, pendant lequel il n'y a pas de récompense. **Exception utile** : désactivé dans l'époque même de sa délégation, le stake n'a jamais été actif et se retire aussitôt (`canClose: true`). Les récompenses s'ajoutent au compte de staking (elles se retirent avec `withdraw`).

#### Cardano (`ada_stake_*`) — clé de staking `m/1852'/1815'/0'/2/0` (celle de ton adresse unique), certificats Conway

| Commande | Arguments | Retour | Notes |
|---|---|---|---|
| `ada_stake_overview` | — | `AdaStakeOverview` | Koios `account_info` (enregistrée, pool, DRep, récompenses, dépôt), `pool_info` du pool actuel, `epoch_params` (`key_deposit` : **2 ADA**), `tip` + `genesis` (époque, fin) |
| `ada_stake_pools` | `{ limit?: number /*défaut 50, max 200*/ }` | `AdaPool[]` | `pool_list` (pools enregistrés, par stake actif décroissant) puis `pool_info` |
| `ada_stake_pool` | `{ poolId /*pool1… ou 56 hex*/ }` | `AdaPool` | pour un id saisi ; inconnu → `INVALID_INPUT` |
| `ada_stake_build` | `{ action: AdaStakeRequest }` | `{ tx /*CBOR hex non signé*/, summary: CardanoStakeSummary, context: AdaStakeContext }` | Rust choisit les UTxO (ADA seuls d'abord), **une seule sortie : la monnaie vers ton adresse**, frais calculés pour 2 témoins, `ttl` = slot + 1 h ; puis exactement les vérifications de `ada_stake_sign` |
| `ada_stake_sign` | `{ tx, password }` | `{ tx /*signée*/, txId, summary, context }` | décodage wallet-core (`cardano_decode_stake_tx` avec **ta** clé de staking et le `key_deposit` lu en direct) ; refusé aussi : une sortie qui n'est pas ton adresse, entrée inconnue ou dépensée, déséquilibre (entrées + retrait + remboursement ≠ sortie + frais + dépôt), frais sous le minimum, ttl dépassé, enregistrement d'une clé déjà enregistrée (ou opération sur une clé non enregistrée), remboursement ≠ dépôt payé, retrait ≠ toutes les récompenses disponibles, **retrait sans délégation de vote** (règle du réseau depuis Plomin), désinscription sans retrait des récompenses, pool inconnu ou retiré, DRep non enregistré ; dialogue natif : chaque certificat (dépôt 2 ADA, pool : ticker, nom déclaré, marge, coût fixe, pledge, saturation, délégants ; DRep), retrait, monnaie, frais, coût ou gain net, époque, calendrier (compte à l'époque N+2, premières récompenses au début de N+4), « pas de blocage, pas de slashing » ; **renforcé** si le pool part à la retraite, a une marge > 10 % ou est saturé (> 100 %), ou si le DRep est inactif |
| `ada_stake_broadcast` | `{ tx }` | `string` (tx id) | témoins = **exactement** ta clé de paiement et ta clé de staking, chacun vérifié ; `submittx` ; id renvoyé = blake2b-256(corps) ; suivi : `ada_tx_status` (§2.7) |

```ts
type AdaStakeRequest =
  | { kind: 'delegate'; poolId: string; drep?: string }    // enregistre la clé d'abord si besoin (dépôt 2 ADA) ; drep facultatif
  | { kind: 'voteDelegate'; drep: string }                  // idem ; drep = 'alwaysAbstain' | 'alwaysNoConfidence' | 'drep1…' | 'drep_script1…'
  | { kind: 'withdraw' }                                    // toutes les récompenses (le réseau n'accepte pas un retrait partiel)
  | { kind: 'deregister' };                                 // retire les récompenses et rembourse le dépôt
type AdaStakeAccount = { stakeAddress: string; registered: boolean; delegatedPool: string | null;
                         delegatedDrep: string | null /*'alwaysAbstain' | 'alwaysNoConfidence' | 'drep1…'*/;
                         rewardsAvailable: string; deposit: string; totalBalance: string };
type AdaEpoch = { epoch: number; slotInEpoch: number; epochLength: number; secondsLeft: number; slot: number };
type AdaPool = { poolId: string; poolHash: string; ticker: string | null; name: string | null; homepage: string | null /*déclarés*/;
                 margin: number /*0..1*/; fixedCost: string; pledge: string; activeStake: string | null; liveStake: string | null;
                 liveSaturation: number | null /*%*/; liveDelegators: number | null; status: 'registered' | 'retiring' | 'retired' | string;
                 retiringEpoch: number | null };
type AdaStakeOverview = { address: string; stake: AdaStakeAccount; pool: AdaPool | null; keyDeposit: string; epoch: AdaEpoch;
                          canWithdraw: boolean /*récompenses > 0 et vote délégué*/ };
type CardanoDrepView = { kind: 'key' | 'script'; id: string /*CIP-129*/; hash: string } | { kind: 'alwaysAbstain' } | { kind: 'alwaysNoConfidence' };
type CardanoCertView = { type: 'stakeRegistration'; deposit: string } | { type: 'stakeDeregistration'; refund: string }
                     | { type: 'stakeDelegation'; poolId: string; poolHash: string } | { type: 'voteDelegation'; drep: CardanoDrepView };
type CardanoStakeSummary = { tx: CardanoTxSummary /*§2.7*/; stakeAddress: string; certificates: CardanoCertView[];
                             withdrawals: { rewardAddress: string; lovelace: string }[]; deposit: string; refund: string; withdrawn: string };
type AdaStakeWarning = { kind: 'poolRetiring'; epoch: number } | { kind: 'highMargin'; margin: number /*%*/ }
                     | { kind: 'poolSaturated'; saturation: number } | { kind: 'drepInactive' };
type AdaStakeContext = { account: CardanoAccount /*§2.7*/; stake: AdaStakeAccount /*avant la transaction*/; pool: AdaPool | null;
                         drep: { drep: CardanoDrepView; registered: boolean; active: boolean } | null; params: { minFeeA: number; minFeeB: number; coinsPerByte: number; maxTxSize: number };
                         keyDeposit: string; epoch: AdaEpoch; netCost: string /*signé : frais + dépôt − remboursement − retrait*/;
                         warnings: AdaStakeWarning[]; requiresExtraConfirmation: boolean };
```
Les ADA délégués **restent sur ton adresse et restent dépensables** ; la délégation porte sur tout ce que contrôle la clé de staking (`totalBalance`). Les récompenses s'accumulent sur le compte de récompenses (`stake…`) et ne sont dépensables qu'après `withdraw`.

#### TRON (`tron_stake_*`) — Stake 2.0, adresse `m/44'/195'/0'/0/0`

| Commande | Arguments | Retour | Notes |
|---|---|---|---|
| `tron_stake_overview` | — | `TronStakeAccount` | `getaccount` (`frozenV2`, `unfrozenV2`, `votes`, `latest_withdraw_time`), `getaccountresource` (TRON Power, énergie, bande passante), `getReward`, `getchainparameters` (`getUnfreezeDelayDays` : **14 j sur mainnet, 1 j sur Nile**, lus le 30/10/2026), `getnextmaintenancetime` |
| `tron_stake_witnesses` | — | `TronWitness[]` | `listwitnesses`, classés par votes ; `url` = seul « nom » d'un SR, **déclaré, non vérifié** ; `brokerage` n'est lu que pour les SR d'un vote (dans `context`) |
| `tron_stake_build` | `{ action: TronStakeRequest }` | `{ raw /*hex*/, txid, summary: TronStakeSummary, context: TronStakeContext }` | `raw_data` construit par Rust (dernier bloc, expiration + 10 min, **pas de `fee_limit`, pas de mémo**) ; refusé : stake < 1 TRX ou > solde, dégel > staké pour cette ressource, 32 dégels déjà en attente, rien à retirer, aucun dégel à annuler, récompense nulle ou réclamée il y a moins de 24 h, 0 ou > 30 SR, votes > TRON Power, adresse qui n'est pas un candidat SR |
| `tron_stake_sign` | `{ raw, password }` | `{ signature /*65 o hex*/, txid, summary, context }` | décodage wallet-core (`tron_decode_stake_raw`, owner = toi), expiration vérifiée, **relit en direct** compte, ressources, SR et `getBrokerage` ; dialogue natif : opération, montant et ressource, délai de dégel du réseau, TRON Power, votes (remplacent **tous** les votes actuels) avec url, rang, part gardée par le SR, bande passante et TRX brûlés, « pas de slashing », expiration, txid ; **renforcé** si un SR est hors des 127 premiers (aucune récompense), garde 100 %, ou si un dégel va réduire tes votes |
| `tron_broadcast` | `{ raw, signature, account? }` | `string` (txid) | la commande existante (§2.5) : signature → ton adresse, txid = sha256(raw) |

```ts
type TronResource = 'BANDWIDTH' | 'ENERGY';
type TronStakeRequest =
  | { kind: 'freeze'; resource: TronResource; amount: string /*sun, ≥ 1 TRX*/ }
  | { kind: 'unfreeze'; resource: TronResource; amount: string }
  | { kind: 'withdrawUnfrozen' }                      // retire les dégels dont le délai est fini
  | { kind: 'cancelAllUnfreeze' }                     // annule tous les dégels en cours (re-stake ; les dégels finis sont retirés)
  | { kind: 'vote'; votes: { address: string; count: string /*TRON Power*/ }[] }   // 1 à 30 SR ; remplace tous les votes
  | { kind: 'claimRewards' };                         // WithdrawBalance : récompenses de vote, une fois par 24 h
type TronStakeAccount = { address: string; balance: string; stakedBandwidth: string; stakedEnergy: string;
  unfreezing: { resource: TronResource; amount: string; expireTime: number /*ms*/ }[]; withdrawableNow: string;
  tronPowerLimit: number; tronPowerUsed: number /*1 = 1 TRX staké*/; votes: { address: string; count: string }[];
  reward: string; nextClaimTime: number /*ms, 0 = maintenant*/; unfreezeDelayDays: number; nextMaintenanceTime: number /*ms*/;
  energyLimit: number; energyUsed: number; bandwidthLimit: number; bandwidthUsed: number };
type TronWitness = { address: string; url: string; voteCount: number; rank: number; isSr: boolean /*≤ 27*/; isPaid: boolean /*≤ 127*/;
                     producing: boolean; brokerage: number | null /*% gardé par le SR*/ };
type TronStakeAction = { type: 'freeze' | 'unfreeze'; resource: TronResource; amount: string } | { type: 'withdrawUnfrozen' }
  | { type: 'cancelAllUnfreeze' } | { type: 'vote'; votes: { address: string; count: string }[]; total: string } | { type: 'claimRewards' };
type TronStakeSummary = { txid: string; owner: string; action: TronStakeAction; expiration: number; timestamp: number;
                          refBlockBytes: string; refBlockHash: string; rawSize: number };
type TronStakeWarning = { kind: 'srNotPaid'; address: string; rank: number } | { kind: 'brokerageAll'; address: string } | { kind: 'votesReduced' };
type TronStakeContext = { account: TronStakeAccount /*avant*/; estimate: TronEstimate /*§2.5 : bande passante*/; witnesses: TronWitness[];
                          warnings: TronStakeWarning[]; requiresExtraConfirmation: boolean };
```
Refusé par wallet-core avant toute signature : `DelegateResource` / `UnDelegateResource` (prêter son énergie ou sa bande passante à **un autre compte**), ressource `TRON_POWER`, champ obsolète `support` d'un vote, tout autre contrat. Il n'y a pas de commande de suivi TRON dédiée : rafraîchir `tron_stake_overview` après la diffusion.

#### Ce que l'UI doit faire (écrans Staking)

- **Accueil Staking** : une carte par chaîne (Solana, Cardano, TRON) ; BTC / LTC / DOGE / XRP : « pas de staking natif » ; EVM : « non proposé (32 ETH ou contrat tiers) ».
- **Solana** : `sol_stake_overview` → liste des comptes (état, délégué, effectif / en activation / en refroidissement, validateur, retirable) et compte à rebours d'époque (`secondsLeft`) ; « Staker » : montant (≥ `minimumDelegation`, afficher en plus la réserve `rentExemptReserve`) + choix du validateur dans `sol_stake_validators` (commission, stake actif, en retard, nom marqué « déclaré ») ; boutons par compte selon `state` : `active`/`activating` → Désactiver ; `initialized`/`inactive` → Déléguer ; `withdrawable > 0` ou `canClose` → Retirer ; un compte `ours: false` est en lecture seule.
- **Cardano** : `ada_stake_overview` (enregistrée ? pool actuel, DRep, récompenses, dépôt) ; « Déléguer » : liste `ada_stake_pools` (ticker, nom déclaré, marge, coût fixe, saturation) ou saisie d'un `pool1…` (`ada_stake_pool`), et choix du vote (« toujours s'abstenir » par défaut proposé, « toujours défiance », ou un `drep1…`) ; afficher le **dépôt de 2 ADA** quand `registered: false` ; « Retirer » seulement si `canWithdraw` (sinon expliquer qu'il faut d'abord déléguer son vote) ; « Arrêter le staking » = `deregister` (rembourse le dépôt).
- **TRON** : `tron_stake_overview` (staké par ressource, dégels avec date `expireTime`, retirable maintenant, TRON Power utilisé / total, votes, récompense et `nextClaimTime`) ; « Staker » / « Dégeler » (ressource + montant ; rappeler le délai `unfreezeDelayDays`) ; « Voter » : liste `tron_stake_witnesses` (rang, url déclarée, votes) et répartition du TRON Power (le total ≤ `tronPowerLimit`) en rappelant que **le vote remplace les votes actuels** ; « Retirer » (`withdrawableNow > 0`), « Annuler les dégels », « Réclamer » (`reward > 0` et `nextClaimTime` passé).
- Dans tous les cas : afficher `summary` + `stake`/`context` **avant** le mot de passe, puis `*_stake_sign` (les fenêtres natives, y compris la renforcée, sont ouvertes par Rust), puis la diffusion ; ne jamais construire ni modifier un message, un CBOR ou un `raw_data` côté UI.

### 2.9 Comptes multiples du coffre (modèle Ledger Live)

Les clés viennent toutes de la phrase : un « compte » n'est qu'un **marque-page public** (numéro + nom) par chaîne, enregistré dans `settings.json` (`accounts.<mainnet|testnet>.<chaîne>`), jamais renvoyé par `settings_get` ni accepté par `settings_set` (qui garde toujours les listes enregistrées). Retirer un compte ne retire que le marque-page : l'ajouter de nouveau redonne les mêmes adresses. Le **compte 0** de chaque chaîne existe toujours (c'est l'historique : ses chemins et adresses n'ont pas changé, tests `crates/wallet-core/tests/accounts.rs`) ; il peut être renommé, pas retiré.

| Chaîne (`chain`) | Compte `a` | Compte 0 (inchangé) |
|---|---|---|
| `btc` | BIP84 `m/84'/c'/a'` + BIP86 `m/86'/c'/a'` (adresses `…/0\|1/i`) | `m/84'/c'/0'`, `m/86'/c'/0'` |
| `ltc` / `doge` | `m/84'/2'/a'` / `m/44'/3'/a'` (testnet : `c` = 1) | `…/0'` |
| `evm` | **`m/44'/60'/0'/0/a`** (index d'adresse : MetaMask, Trezor Suite et les comptes hardware wallet de Kyro ; pas `m/44'/60'/a'/0/0` de Ledger Live — identique pour le compte 0, et une phrase importée de MetaMask retrouve ses comptes dans le même ordre) ; une seule liste pour toutes les chaînes EVM | `m/44'/60'/0'/0/0` |
| `sol` | `m/44'/501'/a'/0'` (Phantom, Solflare) | `m/44'/501'/0'/0'` |
| `tron` | `m/44'/195'/a'/0/0` (Ledger Live) | `m/44'/195'/0'/0/0` |
| `xrp` | `m/44'/144'/a'/0/0` (Ledger Live, Trezor Suite) | `m/44'/144'/0'/0/0` |
| `ada` | CIP-1852 `m/1852'/1815'/a'/0/0` + staking `…/a'/2/0` | `m/1852'/1815'/0'/…` |

| Commande | Arguments | Retour | Notes |
|---|---|---|---|
| `vault_accounts_get` | — | `VaultAccountLists` | listes du réseau courant ; chaque chaîne a au moins `{ index: 0, name }` |
| `vault_account_add` | `{ chain, account, name }` | `VaultAccountLists` | coffre déverrouillé ; `account` ≤ 100, au plus 20 comptes par chaîne, nom 1–32 caractères sans caractère de contrôle (espaces de bord retirés) ; déjà présent → `INVALID_INPUT`. L'UI prévisualise d'abord le compte avec `accounts_get({ account })` (adresse, chemin) et son solde |
| `vault_account_rename` | `{ chain, account, name }` | `VaultAccountLists` | coffre déverrouillé ; absent de la liste → `INVALID_INPUT` |
| `vault_account_remove` | `{ chain, account }` | `VaultAccountLists` | coffre déverrouillé ; compte 0 → `INVALID_INPUT` |

```ts
type AccountChain = 'btc' | 'evm' | 'sol' | 'ltc' | 'doge' | 'tron' | 'xrp' | 'ada';
type VaultAccountLists = { [C in AccountChain]: { index: number; name: string }[] };   // triées par index ; nom par défaut « Bitcoin 2 » pour l'index 1
```

**`account?` sur les commandes du coffre.** Toutes les commandes qui dérivent une de nos adresses ou signent prennent `account?` (absent = 0, donc une ancienne UI marche sans changement ; > 100 → `INVALID_INPUT`) : `accounts_get`, `btc_address`, `btc_sign_psbt`, `evm_sign_tx`, `sol_decode_tx`, `sol_sign_tx`, `ltc_*`/`doge_*` `_address` et `_sign_psbt`, `tron_address` / `_build_tx` / `_sign_tx` / `_broadcast`, `xrp_address` / `_build_tx` / `_sign_tx` / `_broadcast`, `ada_address` / `_build_tx` / `_sign_tx` / `_broadcast`, `sol_stake_overview` / `_build` / `_sign` / `_broadcast`, `ada_stake_overview` / `_build` / `_sign` / `_broadcast`, `tron_stake_overview` / `_build` / `_sign`. Les commandes de lecture par adresse (`*_address_info`, `*_txs`, `tron_account`…) n'en ont pas besoin. `btc_core_setup` importe les descripteurs de **tous** les comptes Bitcoin de la liste (un compte ajouté ensuite demande de relancer la configuration) ; les filtres compacts (`cbf`, désactivés par défaut) ne surveillent encore que le compte 0.

**Dialogue natif.** La première ligne de chaque fenêtre de signature du coffre dit **quel compte signe** : « Compte signataire : Bitcoin 2 — m/84'/1'/1' (SegWit), m/86'/1'/1' (Taproot) » (EVM : plus l'adresse « De »). Un compte qui n'est **pas** dans la liste de l'utilisateur est affiché « inconnu » (« n° N, absent de ta liste ») avec son chemin, et la signature exige une **2ᵉ fenêtre renforcée** (« Attention : compte inconnu »). Bitcoin, Litecoin, Dogecoin : seules les entrées du compte choisi sont signées ; une entrée d'un autre compte du coffre est étrangère (2ᵉ fenêtre déjà existante) et la monnaie n'est reconnue que dans le compte choisi.

**Fait côté UI** (commit de l'UI des comptes) : Réglages › Comptes (liste par chaîne, « Ajouter un compte » qui prévisualise `accounts_get({ account })` et son solde, renommer, retirer), un jeu d'adaptateurs par compte (`createAdapters(…, account)`, chaque adaptateur passe `account` à ses commandes de signature), le compte choisi par chaîne (mémorisé par réseau dans `localStorage`, donnée publique) utilisé par Envoyer / Recevoir / Swap / Staking / Actif, sélecteur « Compte » toujours affiché pour le coffre (même avec un seul compte ; pas pour un hardware wallet), une ligne par compte dans Actifs (totaux additionnés), historique de tous les comptes. **Mode démo** : listes, adresses, soldes et signatures BTC / EVM / Solana / LTC / DOGE par compte ; TRON, XRP, Cardano et staking simulés pour le premier compte seulement (erreur explicite sinon).

**Beaucoup d'adresses, facilement** (aucune nouvelle commande : `vault_account_add` appelé une fois par compte, Rust vérifie chaque règle). Le sélecteur « Compte » (Envoyer, Recevoir, Swap, Staking, Actif) a une entrée **« Nouveau compte »** : elle crée le prochain numéro libre avec son nom par défaut (« Bitcoin 2 »), le sélectionne et affiche son adresse (lue avec `accounts_get({ account })` avant la sélection). Recevoir a aussi un bouton « Nouveau compte » visible (la « Nouvelle adresse » BTC/LTC reste) et affiche le chemin de dérivation du compte choisi (champ `path` d'`accounts_get`, par ex. `m/44'/60'/0'/0/1` pour « Ethereum 2 »). Réglages › Comptes : **« Créer plusieurs… »** (1 à 10 d'un coup, dans la limite de 20 par chaîne ; un échec en route garde les comptes déjà créés). Envoyer : **« Mes comptes »** à côté de « Carnet » liste les **autres** comptes de la même chaîne (nom, adresse courte, solde) et peut en créer un nouveau comme destinataire ; choisir un compte remplit l'adresse, puis c'est un envoi ordinaire (décodage Rust, dialogue natif, mêmes contrôles). Le récapitulatif nomme le destinataire « Ton compte « X » » quand l'adresse est à l'un de tes comptes. Fonctions pures testées : `planNewAccounts`, `otherOwnAccounts`, `ownAccountOf` (`apps/desktop/src/lib/accounts.ts`). Les adresses du compte 0 ne changent pas.

**Hardware wallets.** Déjà multi-comptes à leur façon : `hw_account_add({ account })` enregistre un compte par numéro (BTC `m/84'|86'/c'/a'`, EVM `m/44'/60'/0'/0/a`, Solana `m/44'/501'/a'/0'`), affiché comme un portefeuille à part dans le sélecteur de la barre de titre ; ils ne sont pas (encore) regroupés par chaîne comme les comptes du coffre.

### 2.10 Choix du réseau (réseau principal / réseau de test)

Le réseau est fixé **au lancement** et ne change jamais pendant que l'app tourne. Ordre de priorité (`src-tauri/src/network.rs`) :

1. variable d'environnement `KYRO_NETWORK` (`mainnet` ou `testnet`, insensible à la casse ; toute autre valeur est ignorée) — réservée au développement ;
2. le choix enregistré par `network_set` dans `network.json` (dossier de l'app, donnée publique : `{ "network": "mainnet" }`) ;
3. sans choix enregistré, si un coffre existe sur **un seul** des deux réseaux (installation antérieure au choix) : ce réseau-là, pour qu'une mise à jour n'affiche jamais « Bienvenue » à quelqu'un qui a déjà un coffre ;
4. sinon le défaut du build : **mainnet en release**, **testnet en debug** (`cfg!(debug_assertions)`).

Chaque réseau a ses propres fichiers : `coffre-{mainnet|testnet}.kyrovault`, `hw-accounts-{mainnet|testnet}.json`, et ses propres listes de comptes (`settings.json › accounts.<réseau>`). Changer de réseau **ne supprime rien** : le coffre de l'autre réseau est gardé et retrouvé en y revenant. Les réglages (`settings.json`) sont communs, les serveurs personnalisés sont rangés par réseau.

| Commande | Arguments | Retour | Notes |
|---|---|---|---|
| `network_get` | — | `NetworkInfo` | lecture seule, coffre verrouillé ou non |
| `network_set` | `{ network }` | `boolean` (`true` = redémarrage demandé) | enregistre le choix ; s'il diffère du réseau courant : verrouille la session (zeroize) puis redémarre l'app (`AppHandle::request_restart`). Même réseau : enregistre seulement (`false`). Refusé (`INVALID_INPUT`, rien n'est enregistré) : valeur autre que `mainnet`/`testnet` ; réseau imposé par `KYRO_NETWORK` ; **une fenêtre de signature native est ouverte** (compteur tenu par `confirm_native`) ; une opération hardware wallet est en cours. Aucun nouvel hôte réseau |

```ts
type NetworkInfo = {
  network: 'mainnet' | 'testnet';                       // réseau de cette exécution
  source: 'env' | 'saved' | 'vault' | 'default';        // d'où il vient (ordre ci-dessus)
  saved: 'mainnet' | 'testnet' | null;                  // contenu de network.json
  default: 'mainnet' | 'testnet';                       // défaut du build
  canSwitch: boolean;                                   // false si KYRO_NETWORK impose le réseau
  otherVaultExists: boolean;                            // un coffre existe déjà sur l'autre réseau (gardé)
};
```

**Fait côté UI** : Réglages › Réseaux et serveurs › « Réseau » (Réseau principal — fonds réels / Réseau de test — jetons sans valeur), fenêtre de confirmation qui rappelle que chaque réseau a son propre coffre (l'autre est gardé, pas supprimé), puis redémarrage ; écran d'accueil : une ligne « Le coffre sera créé sur le réseau … » avec un lien pour changer ; badge TESTNET de la barre d'état inchangé. **Mode démo** : `network_set` mémorise le choix (`localStorage`, comme l'environnement) et recharge la page sur `?network=…` ; `?network=` dans l'URL joue le rôle de `KYRO_NETWORK`.

## 3. Allowlist réseau (`net_fetch`)

| Hôte | Usage |
|---|---|
| `api.coingecko.com`, `pro-api.coingecko.com` | prix, top 200, graphiques |
| `mempool.space` | Bitcoin : UTXO, frais, diffusion (Esplora) |
| `litecoinspace.org` | Litecoin (Esplora/mempool, mainnet `/api`, testnet4 `/testnet/api`) : utilisé par les commandes Rust `ltc_*`, famille Tor `litecoin` |
| `s.altnet.rippletest.net` (port 51234), `xrplcluster.com` | XRP Ledger testnet et mainnet (JSON-RPC rippled) : utilisés par les commandes Rust `xrp_*`, famille Tor `xrp` |
| `preprod.koios.rest`, `api.koios.rest` | Cardano preprod et mainnet (Koios REST, offre publique sans clé) : utilisés par les commandes Rust `ada_*` et `ada_stake_*` (`account_info`, `pool_list`, `pool_info`, `drep_info`), famille Tor `cardano` |
| `api.trongrid.io`, `nile.trongrid.io` | TRON mainnet et Nile (TronGrid, API HTTP java-tron + `/v1`) : utilisés par les commandes Rust `tron_*` et `tron_stake_*` (`getReward`, `listwitnesses`, `getBrokerage`, `getnextmaintenancetime`), famille Tor `tron` |
| `ethereum-sepolia-rpc.publicnode.com`, `ethereum-rpc.publicnode.com` | RPC Ethereum |
| `arbitrum-one-rpc.publicnode.com`, `optimism-rpc.publicnode.com`, `base-rpc.publicnode.com`, `polygon-bor-rpc.publicnode.com`, `bsc-rpc.publicnode.com`, `avalanche-c-chain-rpc.publicnode.com` | RPC EVM (phase 2) |
| `mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion` | Bitcoin (Esplora) en mode Tor uniquement, `http://` (service onion officiel de mempool) ; réécriture automatique de `mempool.space` |
| `api.devnet.solana.com`, `api.mainnet-beta.solana.com` | RPC Solana (aussi : tables d'adresses v0 lues par Rust pour `sol_decode_tx` / `sol_sign_tx` ; staking `sol_stake_*` lu et diffusé par Rust : `getProgramAccounts`, `getVoteAccounts`, sysvar StakeHistory, `sendTransaction` ; ou le RPC `servers.solana[cluster]` des réglages) |
| `api.0x.org`, `li.quest`, `lite-api.jup.ag` | devis de swap |
| + hôtes des serveurs HTTP personnalisés (`servers.bitcoin.*` de type `esplora`, `servers.evm.*`, `servers.solana.*`) | autorisés **uniquement pour leur famille** (circuits Tor de la famille) ; le serveur par défaut remplacé est refusé (`DEFAULT_SERVER_DISABLED`) |
| Electrum et Bitcoin Core | **pas** joignables par `net_fetch` : uniquement via les commandes `btc_*` (Rust) |
| `doge.electrum1.cipig.net:20060`, `doge.electrum2.cipig.net:20060` (ElectrumX de Komodo, défaut Dogecoin mainnet ; `net::ELECTRUM_HOSTS`) | **pas** joignables par `net_fetch` (sockets TLS brutes, hors `ALLOWED_HOSTS`) : uniquement via `doge_*` (Rust), circuits Tor `dogecoin`, hôte **et** port vérifiés |
| serveurs Esplora Litecoin / Dogecoin personnalisés (`servers.litecoin.*`, `servers.dogecoin.*`) | **pas** joignables par `net_fetch` : uniquement via `ltc_*` / `doge_*` (Rust), circuits Tor de leur famille ; le défaut remplacé (`litecoinspace.org`) est refusé (`DEFAULT_SERVER_DISABLED`) |

HTTPS uniquement (sauf `.onion` via Tor : mempool, ou un serveur personnalisé), pas de redirection vers un hôte hors liste ni vers un serveur personnalisé, réponse plafonnée à 5 Mo, timeout 20 s.
