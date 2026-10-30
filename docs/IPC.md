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
impl KdfParams { pub fn production() -> Self; pub fn insecure_for_tests() -> Self; }
pub fn seal(mnemonic: &Mnemonic, password: &str, kdf: KdfParams) -> Result<VaultFile>; // AAD = version||kdf||salt
pub fn open(file: &VaultFile, password: &str) -> Result<Mnemonic>;                    // Error::WrongPassword si tag invalide

// --- networks & derivation ---
pub enum Network { Mainnet, Testnet }   // Testnet = BTC testnet4 (tb1…), Sepolia (chainId 11155111), Solana devnet
pub enum BtcKind { Segwit /* BIP84 */, Taproot /* BIP86 */ }
pub struct BtcAccount { pub kind: BtcKind, pub xpub: String, pub fingerprint: String /*hex 8*/, pub path: String /*m/84'/1'/0'*/ }
pub fn btc_account(seed: &Seed, net: Network, kind: BtcKind, account: u32) -> Result<BtcAccount>;
pub fn btc_address(seed: &Seed, net: Network, kind: BtcKind, account: u32, change: bool, index: u32) -> Result<String>;
pub fn evm_address(seed: &Seed, index: u32) -> Result<String>;          // m/44'/60'/0'/0/i, EIP-55
pub fn sol_address(seed: &Seed, account: u32) -> Result<String>;        // m/44'/501'/i'/0' (SLIP-10 ed25519), base58

// --- signing (clés dérivées à la demande, zeroizées aussitôt) ---
pub fn btc_sign_psbt(seed: &Seed, net: Network, psbt_b64: &str) -> Result<(String /*signed b64*/, BtcTxSummary)>;
pub struct EvmTxRequest { pub chain_id: u64, pub nonce: u64, pub to: String, pub value_wei: String, pub data: String /*0x…*/,
                          pub gas_limit: u64, pub max_fee_per_gas: String, pub max_priority_fee_per_gas: String }
pub fn evm_sign_tx(seed: &Seed, index: u32, tx: &EvmTxRequest) -> Result<(String /*raw 0x… EIP-1559*/, String /*tx hash*/)>;
pub fn sol_sign_message(seed: &Seed, account: u32, message: &[u8]) -> Result<[u8; 64]>; // ed25519 sur les octets du message ; ne JAMAIS appeler sans sol_decode_message avant

// --- decoding (résumé « en clair », indépendant du frontend) ---
pub struct EvmTxSummary { pub kind: EvmTxKind /*NativeTransfer|Erc20Transfer|Erc20Approve|ContractCall*/,
                          pub to: String, pub token_contract: Option<String>, pub amount: String, pub spender: Option<String>,
                          pub unlimited_approval: bool, pub max_fee_wei: String, pub chain_id: u64 }
pub fn evm_decode(tx: &EvmTxRequest) -> Result<EvmTxSummary>;
pub struct BtcTxSummary { pub outputs: Vec<(String /*address*/, u64 /*sats*/, bool /*is_change*/)>, pub fee_sats: u64 }
pub fn btc_decode_psbt(net: Network, psbt_b64: &str, own: &[String] /*our addresses*/) -> Result<BtcTxSummary>;

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
pub fn utxo_psbt_summary(seed, net, coin, psbt_b64) -> Result<UtxoTxSummary>;     // décodage pour le dialogue, sans signer
pub fn utxo_sign_psbt(seed, net, coin, psbt_b64) -> Result<(String /*PSBT signée, non finalisée*/, UtxoTxSummary)>;
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
    UnknownOutput { index }, OpReturn { index }, ForeignInput { index }, SoftDust { index } /*DOGE < 0,01*/, HighFee /*> 100× le taux usuel ou > total envoyé*/,
    FeeBelowMinimum { minimum } /*informatif*/ }
// requires_extra_confirmation = tout avertissement sauf FeeBelowMinimum.
// Constantes : LTC_MIN_RELAY_FEE_PER_KVB 1 000, LTC_DUST_RELAY_FEE_PER_KVB 30 000 ; DOGE_RECOMMENDED_FEE_PER_KB 1 000 000 (0,01 DOGE/kB),
// DOGE_MIN_RELAY_FEE_PER_KB 100 000, DOGE_SOFT_DUST 1 000 000, DOGE_HARD_DUST 100 000.

// --- TRON : m/44'/195'/0'/0/i, adresse = base58check(0x41 || keccak256(pubkey)[12..]) ; raw_data protobuf
//     (codec écrit à la main, strict : refusé si le ré-encodage diffère d'un seul octet)
pub fn tron_address(seed, index) -> Result<String>;                     // T…
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
pub fn tron_decode_raw(raw_hex, our_address) -> Result<TronTxSummary>;  // + refuse : owner ≠ nous, montant TRX ≤ 0, TRX à soi-même
pub struct TronTxSummary { txid, owner, action: TronAction, fee_limit, expiration, timestamp, ref_block_bytes, ref_block_hash,
                           memo /*hex*/, raw_size, warnings: Vec<TronWarning>, requires_extra_confirmation }   // serde camelCase
pub enum TronAction { TrxTransfer { to, amount }, Trc20Transfer { contract, to, amount, call_value },
                      ContractCall { contract, selector, data, call_value } }   // JSON { "type": "trxTransfer", … }
pub enum TronWarning { UnknownCall { selector }, CallValue, Memo, HighFeeLimit /*> 100 TRX*/ }   // tous → confirmation renforcée
pub fn tron_sign(seed, index, raw_hex) -> Result<([u8; 65] /*r‖s‖v, v = 27 + recid*/, TronTxSummary)>;   // décode d'abord ; libsecp256k1 RFC 6979
pub fn tron_recover_signer(raw_hex, sig65 /*v ∈ 0,1,27,28*/) -> Result<String>;
pub fn tron_signed_transaction(raw_hex, sig) -> Result<String>;          // Transaction { raw_data = 1, signature = 2 }, pour broadcasthex

// --- XRP Ledger : m/44'/144'/0'/0/i (route BIP44 de Ledger, Trezor, Xaman — pas la « family seed » de rippled),
//     adresse r… = base58 (alphabet Ripple) de 0x00 || RIPEMD160(SHA256(pubkey)) + somme SHA-256d ; codec binaire
//     Payment écrit à la main, strict (ré-encodage identique exigé)
pub fn xrp_address(seed, index) -> Result<String>; pub fn xrp_public_key(seed, index) -> Result<[u8; 33]>;
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
// tfPartialPayment, drapeau inconnu, paiement à soi-même, montant ≤ 0, frais 0
pub struct XrpTxSummary { account, destination, destination_tag: Option<u32>, amount: XrpAmountView, fee, sequence,
                          last_ledger_sequence, flags, send_max, source_tag, invoice_id, memos, warnings: Vec<XrpWarning>,
                          requires_extra_confirmation }          // serde camelCase
pub enum XrpAmountView { Xrp { drops }, Issued { value, currency, issuer } }   // JSON { "kind": "xrp", … }
pub enum XrpWarning { SendMax, PathFlags /*tfNoRippleDirect, tfLimitQuality*/, Memo, HighFee /*> 1 XRP*/, InvoiceId }   // → renforcée
pub fn xrp_sign(seed, index, blob_hex) -> Result<(String /*blob signé*/, String /*hash*/, XrpTxSummary)>;   // DER low-S, vérifiée
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
pub fn cardano_min_utxo(address, assets, coins_per_utxo_byte) -> u64;      // (160 + taille de la sortie) × coinsPerUTxOByte
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
pub enum CardanoWarning { Memo, UnknownToken { policy, name }, HighFee /*> 5 ADA*/, NoTtl }   // → confirmation renforcée
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
    Token2022ExtensionsUnverified { instruction } /*informatif*/, PriorityFeeEstimated /*informatif*/ }
// requires_extra_confirmation = instruction inconnue, délégation, payeur ≠ nous, autre signataire inscriptible ou autorité ≠ nous.

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
| `accounts_get` | — | `Accounts` | adresses publiques uniquement ; contient aussi `ltc` et `doge` (§2.4) |
| `btc_address` | `{ kind, change, index }` | `string` | |
| `evm_decode_tx` | `{ tx: EvmTxRequest }` | `EvmTxSummary` | pour l'aperçu avant mot de passe |
| `evm_sign_tx` | `{ tx, password, token?: { symbol, decimals } }` | `{ rawTx, hash }` | dialogue natif obligatoire ; `token` = indication d'affichage seulement (le contrat et le montant brut viennent du décodage Rust) |
| `btc_sign_psbt` | `{ psbt, password }` | `{ psbt, summary }` | dialogue natif obligatoire |
| `sol_decode_tx` | `{ message /*b64, message sérialisé sans signatures*/ }` | `SolTxSummary` | aperçu avant mot de passe ; décodé en Rust, tables d'adresses (v0) récupérées par Rust (`getAccountInfo`) — jamais fournies par l'UI ; session déverrouillée requise |
| `sol_sign_tx` | `{ message /*b64*/, password }` | `{ signature /*b64*/, summary: SolTxSummary }` | même décodage ; refuse si notre adresse n'est pas signataire ; dialogue natif construit depuis le résumé Rust, puis 2ᵉ dialogue « Instruction non reconnue — signer quand même ? » si `requiresExtraConfirmation` ; la signature va à l'index `summary.ourSignerIndex` |
| `net_fetch` | `{ req: { url, method, headers?, body? } }` | `{ status, body }` | allowlist + cache + rate-limit ; seuls `accept`, `content-type`, `0x-version` sont transmis, les clés API sont ajoutées par Rust. **Via Tor si `settings.tor.enabled` (défaut)** : attend le démarrage de Tor (60 s max) puis échoue en `TOR_UNAVAILABLE` — jamais de repli en clair. En mode Tor, `https://mempool.space/…` est servi de façon transparente par le service onion de mempool (même chemin, même réponse) ; l'UI continue d'appeler `https://mempool.space/…`. Toute URL `.onion` est refusée (`HOST_NOT_ALLOWED`) en mode clair |
| `tor_status` | — | `TorStatus` | état courant de Tor intégré |
| `tor_retry` | — | `TorStatus` | relance le démarrage depuis zéro (quel que soit l'état : utile après `error`) ; refusé (`INVALID_INPUT`) si Tor est désactivé |
| `settings_get` / `settings_set` | — / `{ settings: Settings }` | `Settings` (sans secrets : `hasPassword` au lieu du mot de passe Core) | stocké dans le dossier de l'app ; passer `tor.enabled` de `true` à `false` coupe Tor (l'UI doit d'abord demander une confirmation explicite), l'inverse le démarre ; **`settings_set` est asynchrone** et vérifie en direct chaque serveur personnalisé modifié (voir §2.1) avant d'enregistrer — erreurs typées `SERVER_INVALID`, `SERVER_WRONG_NETWORK`, `SERVER_UNREACHABLE`, `TOR_UNAVAILABLE`, rien n'est enregistré en cas d'échec ; si l'objet envoyé n'a pas de clé `servers`, les serveurs enregistrés sont conservés |
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
| `btc_core_setup` | `{ rescanFrom: 'now' \| number /*horodatage UNIX en s*/ }` | `CoreStatus` (`state: 'importing'`) | Bitcoin Core uniquement, session déverrouillée. **Vérification préalable synchrone** (erreurs renvoyées par l'appel lui-même) : nœud joignable (`SERVER_UNREACHABLE`), authentification (`SERVER_INVALID`), bonne chaîne (`SERVER_WRONG_NETWORK`), portefeuille `kyro-watch-<empreinte8>` créé ou chargé et bien sans clé privée (`SERVER_INVALID`), checksums des descripteurs. Seul `importdescriptors` (et son rescan) tourne ensuite en arrière-plan. Aucun nœud Core configuré pour ce réseau : `INVALID_INPUT` |
| `btc_core_status` | — | `CoreStatus` | progression du rescan (`getwalletinfo.scanning`). L'état d'import est propre à **(réseau, URL, portefeuille)** : un autre nœud ou un autre réseau ne voit pas l'import d'un premier. Aucun nœud Core configuré : réponse normale `{ state: 'not-configured', wallet: '', walletLoaded: false }` (pas d'erreur) |
| `btc_cbf_status` | — | `CbfStatus` | mode filtres compacts (fonction `cbf`) ; build sans la fonction : `FEATURE_DISABLED` |
| `btc_cbf_sync` | — | `CbfStatus` | lance (ou rejoint) une synchronisation en arrière-plan ; progression par l'événement `cbf-status` ; exige le coffre déverrouillé (lit les xpubs) — une lecture coffre verrouillé ne lance pas de synchro ; build sans la fonction : `FEATURE_DISABLED` |
| `set_capture_protection` | `{ enabled }` | `void` | `set_content_protected` |
| `config_get` | — | `{ network, hasCoingeckoKey, hasZeroxKey, hasOneinchKey, hasTrongridKey }` | jamais les clés elles-mêmes ; clé TronGrid : `KYRO_TRONGRID_API_KEY` (env) ou `settings.apiKeys.trongrid` |
| `hw_list` | — | `DeviceInfo[]` | détecte les Ledger (HID) et Trezor (WebUSB) branchés ; ids stables pour la session (`ledger-1`, `trezor-1`…) tant que l'appareil reste sur le même port ; 10 s max. Voir §2.3 |
| `hw_open` | `{ id }` | `DeviceStatus` | ouvre l'appareil et lit son état : verrouillé, app Ledger ouverte, firmware Trezor, état par chaîne |
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
type Accounts = {
  network: 'mainnet' | 'testnet';
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
type Settings = { currency: 'EUR' | 'USD'; autoLockSecs: number; hideBalancesOnStart: boolean;
                  captureProtection: boolean; clipboardGuard: boolean;
                  servers: Servers;               // remplace l'ancien `rpc` (encore accepté en entrée, migré, jamais renvoyé)
                  apiKeys: { coingecko?: string; zerox?: string; oneinch?: string;
                             trongrid?: string };   // TronGrid (en-tête TRON-PRO-API-KEY, §2.5) ; comme les autres clés de
                                                    // `apiKeys`, renvoyée par `settings_get` (saisie par l'utilisateur) ;
                                                    // `KYRO_TRONGRID_API_KEY` (env) n'est jamais renvoyée (`config_get.hasTrongridKey`)
                  tor: { enabled: boolean } };   // défaut : { enabled: true }
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
type UtxoServer = { kind: 'default' }       // Litecoin : litecoinspace.org ; Dogecoin : AUCUN (lectures → SERVER_INVALID, voir §2.4)
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
  | { family: 'litecoin' | 'dogecoin'; network: 'mainnet' | 'testnet'; server: UtxoServer }   // { kind: 'default' } Dogecoin : SERVER_INVALID
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
- `hw-prompt` (`{ id, kind: 'confirm-on-device' | 'pin-on-device' | 'passphrase-on-device' | 'pin-matrix' }`) pendant une opération hardware wallet : ce que l'UI doit dire à l'utilisateur (voir §2.3).

Erreurs : rejet de la promesse avec `{ code: 'WRONG_PASSWORD' | 'LOCKED' | 'RATE_LIMITED' | 'USER_REJECTED' | 'HOST_NOT_ALLOWED' | 'INVALID_INPUT' | 'INTERNAL' | 'TOR_UNAVAILABLE' | 'SERVER_INVALID' | 'SERVER_WRONG_NETWORK' | 'SERVER_UNREACHABLE' | 'DEFAULT_SERVER_DISABLED' | 'FEATURE_DISABLED' | 'HW_NOT_FOUND' | 'HW_LOCKED' | 'HW_WRONG_APP' | 'HW_REJECTED' | 'HW_DISCONNECTED' | 'HW_UNSUPPORTED' | 'HW_BUSY' | 'HW_TIMEOUT' | 'HW_BAD_RESPONSE' | 'HW_ADDRESS_MISMATCH' | 'HW_WRONG_DEVICE', message, data? }`. `data` n'existe que pour `HW_WRONG_APP` (`{ expected, open }`), `HW_UNSUPPORTED` (`{ min: string | null }`) et `HW_ADDRESS_MISMATCH` (`{ device, expected }`) ; les codes hardware wallet sont détaillés au §2.3. `TOR_UNAVAILABLE` : Tor activé mais pas prêt (démarrage trop long, échec, arrêté) — la requête n'a **pas** été envoyée.

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
| Cardano (`koios`) | comme Esplora | `GET {url}/genesis` → `networkmagic` = 764824073 (mainnet) ou 1 (preprod) ; preview (2) et autres nommés dans l'erreur. `detected.chainId` = `networkmagic`, `detected.blockHeight` = `GET {url}/tip` |
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

Transport USB en Rust : Ledger en HID (hidapi), Trezor en WebUSB (libusb via rusb, compilée et liée statiquement). Rien ne passe par l'UI ni par le réseau. Chaque appareil a **un verrou** (2ᵉ opération simultanée : `HW_BUSY`) ; chaque appel tourne hors du thread UI avec un **délai** (lecture de clés 90 s, PIN Trezor compris ; affichage d'adresse et signature 180 s ; `hw_list` 10 s). Les transports lisent par tranches de 100 ms : délai dépassé, `hw_cancel` ou débranchement terminent l'appel proprement (Trezor reçoit `Cancel`), la connexion est fermée puis rouverte à l'appel suivant, et rien n'est renvoyé.

Avec un coffre sur cet ordinateur, toutes les commandes `hw_*` qui lisent des clés, enregistrent ou signent exigent la session déverrouillée (`LOCKED`) ; un utilisateur « hardware wallet seul » n'a pas de coffre et pas de mot de passe Kyro (la confirmation se fait sur l'appareil). Les signatures hardware wallet ne demandent **pas** le mot de passe du coffre.

```ts
type DeviceInfo = { id: string; kind: 'ledger' | 'trezor'; model: string; transport: 'hid' | 'webusb' };
type Chain = 'btc' | 'evm' | 'sol' | 'ltc' | 'doge' | 'tron' | 'cardano' | 'xrp';   // phase 4 : HW_UNSUPPORTED
type DeviceStatus = { id: string; kind: 'ledger' | 'trezor'; model: string; locked: boolean;
  app?: { name: string; version: string };        // Ledger : app ouverte ("Tableau de bord" = dashboard)
  firmware?: string; passphrase?: boolean;        // Trezor
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
| Bitcoin (BIP84, BIP86, PSBT) | « Bitcoin Test » (testnet) / « Bitcoin » (mainnet) ≥ 2.1.0 | One ≥ 1.10.4 ; T, Safe 3, Safe 5 ≥ 2.4.3 |
| EVM (EIP-1559) | « Ethereum » ≥ 1.9.0 (toutes les chaînes EVM) | One ≥ 1.10.4 ; T/Safe ≥ 2.4.2 |
| ERC-20 en clair | descripteur signé par Ledger requis : embarqué pour USDC et USDT (mainnet) et tUSDC (Sepolia) ; sinon blind signing (réglage de l'app) + dialogue renforcé | transfert : destinataire, montant brut et contrat affichés (« Unknown token » hors liste) ; `approve` et autres appels : dialogue renforcé |
| Solana | « Solana » ≥ 1.3.1 (blind signing requis pour les instructions qu'il ne décode pas : `HW_UNSUPPORTED`) | T/Safe ≥ 2.6.4 ; pas sur la One |
| Non pris en charge | — | Safe 7 (protocole THP), mode bootloader, One < 1.7 (HID) |

PIN et passphrase : Ledger se déverrouille sur l'appareil (`HW_LOCKED` → l'UI demande de le déverrouiller puis de réessayer). Trezor T/Safe : PIN et passphrase saisis **sur l'appareil** (`hw-prompt`). Trezor One : PIN par la grille aveugle (`pin-matrix` → `hw_pin_matrix`) ; passphrase à saisir sur l'ordinateur → refusée (`HW_UNSUPPORTED`) : aucun secret ne transite par l'UI.

**Erreurs**

| Code | Quand | `data` |
|---|---|---|
| `HW_NOT_FOUND` | id inconnu (relancer `hw_list`) ou appareil introuvable à l'ouverture | |
| `HW_LOCKED` | appareil verrouillé (Ledger `5515`, ou `6982` hors signature) ; PIN Trezor incorrect | |
| `HW_WRONG_APP` | Ledger : mauvaise app ouverte (dashboard compris ; `6E00`, `6E01`, `6D00`, `6D02`, `6511`) | `{ expected, open }` |
| `HW_REJECTED` | refus sur l'appareil (Ledger `6985`, `5501`, `6982` en signature ; Trezor `ActionCancelled` / `PinCancelled`) | |
| `HW_DISCONNECTED` | erreur USB / débranchement, y compris pendant une signature : opération abandonnée, connexion fermée | |
| `HW_UNSUPPORTED` | chaîne de phase 4, firmware/app trop ancien, Safe 7, blind signing désactivé (Ledger `6A80` en signature EVM, `6808` Solana), passphrase Trezor One, entrées mixtes Ledger | `{ min }` |
| `HW_BUSY` | autre opération en cours sur cet appareil ; interface USB prise par une autre application (Trezor Suite, Ledger Live) ; Linux sans règles udev | |
| `HW_TIMEOUT` | pas de réponse dans le délai : opération abandonnée | |
| `HW_BAD_RESPONSE` | réponse mal formée, ou signature/adresse/clé qui ne passe pas la vérification de Kyro | |
| `HW_ADDRESS_MISMATCH` | l'adresse affichée par l'appareil ≠ celle dérivée par Kyro de l'xpub enregistrée : **ne pas utiliser l'adresse** | `{ device, expected }` |
| `HW_WRONG_DEVICE` | les clés de l'appareil ne sont pas celles du compte (autre appareil, autre passphrase, compte enregistré modifié) | |
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
| `…_backend_info` | — | `{ kind: 'default' \| 'esplora', network: 'mainnet' \| 'testnet', label, available, tor }` | `available: false` = Dogecoin sans serveur configuré |
| `…_address` | `{ change, index }` | `string` | coffre déverrouillé |
| `…_address_info` / `…_address_utxos` / `…_address_txs` | `{ address }` | formes Esplora (§2.2) | adresse validée par Rust pour la chaîne et le réseau avant toute requête ; `txs` : 50 au plus, non confirmées d'abord |
| `…_tx_hex` | `{ txid }` | `string` | `GET /tx/{txid}/hex`, vérifié : txid recalculé = `txid` (et pas de témoin pour Dogecoin), sinon `SERVER_UNREACHABLE` |
| `…_fee_rates` | — | `{ fastestFee, halfHourFee, hourFee, economyFee, minimumFee, source? }` | unité minimale **par vbyte** (litoshis/vB ; koinus/octet). `/v1/fees/recommended` puis `/fee-estimates`. Dogecoin : bornes [0,01 ; 1] DOGE/kB (1 000–100 000 koinus/o) ; serveur sans estimation (404) → 0,01 DOGE/kB, `source: 'policy'` |
| `…_tip_height` | — | `number` | |
| `…_broadcast` | `{ hex }` | `string` (txid) | transaction décodée d'abord ; txid du serveur = le nôtre, sinon erreur |
| `…_sign_psbt` | `{ psbt, password }` | `{ psbt /*signée, non finalisée*/, summary: UtxoTxSummary }` | mot de passe → `utxo_psbt_summary` → dialogue natif (destinataires, montants, monnaie, frais, taux, taille ; « Pas de monnaie… » si aucune ; entrées étrangères) → **2ᵉ dialogue renforcé** si `requiresExtraConfirmation` (sortie inconnue « INCONNUE », OP_RETURN, entrée étrangère, poussière douce DOGE, frais très élevés) → signature ; le résumé de la signature doit être identique à celui affiché |

Règles de construction (TS) vérifiées par Rust :
- **Litecoin** : chaque entrée a `witness_utxo` + `bip32_derivation` (`m/84'/2'|1'/0'/…`) ; la monnaie porte sa dérivation (sinon elle s'affiche comme un destinataire) ; poussière = `GetDustThreshold` de Litecoin Core à 30 000 lit/kvB (P2WPKH 2 940 litoshis, P2PKH 5 460) : destinataire en dessous refusé, monnaie en dessous ajoutée aux frais ; minimum 1 litoshi/vB.
- **Dogecoin** : chaque entrée a **`non_witness_utxo`** (transaction précédente complète, `doge_tx_hex`) — c'est ce qui prouve les montants, que le sighash legacy n'engage pas — et **pas** de `witness_utxo` ; frais par taille (0,01 DOGE/kB recommandé = minimum de Kyro ; relais 0,001 DOGE/kB) ; aucune sortie sous 0,01 DOGE (poussière douce : chaque sortie en dessous coûte 0,01 DOGE de frais en plus ; sous 0,001 DOGE, non standard → Rust refuse).
- Taille (identique TS/Rust, signature la plus longue) : P2WPKH 10,5 + 68 par entrée + sorties (31 P2WPKH) vB ; P2PKH 10 + 148 par entrée + 34 par sortie octets.
- **Dogecoin n'a pas de serveur par défaut** : `{ kind: 'default' }` → toute lecture `SERVER_INVALID` (« configure ton serveur Esplora (electrs-dogecoin) »). Voir NETWORK.md.
- Montants JSON : une sortie au-delà de 2⁵³ unités (≈ 90 millions de DOGE) n'est pas lisible sans perte en JS : l'adaptateur la refuse (la signature, elle, prend les montants dans les transactions précédentes, en Rust).

**Fait côté UI** (commit de l'UI Litecoin / Dogecoin) : types `Commands` de `@kyro/shared` (`ltc_*`, `doge_*`, `btc_tx_hex`, `Accounts.ltc/doge`, `Servers.litecoin/dogecoin`, `ServerTestTarget`), backend démo, écrans Envoyer/Recevoir/Actif/Historique pour ces familles, réglages serveurs, liste « Connexions sortantes », sortie de `WATCH_ONLY_CHAINS`.

### 2.5 TRON (TRX, TRC-20)

Rust choisit le serveur (`servers.tron`, sinon TronGrid), famille Tor `tron`, jamais de repli. **Rust construit lui-même `raw_data`** (wallet-core `TronRaw`) depuis `/wallet/getnowblock` : `ref_block_bytes` = octets 6..8 du numéro, `ref_block_hash` = octets 8..16 du `blockID` (vérifié : l'id commence par le numéro), `timestamp` = horodatage du bloc, `expiration` = bloc + 10 min. `createtransaction` du serveur n'est **jamais** utilisé pour ce qui est signé (le test réel compare seulement l'encodage de Kyro au sien : identique octet pour octet).

| Commande | Arguments | Retour | Notes |
|---|---|---|---|
| `tron_backend_info` | — | `{ kind: 'default' \| 'http', network: 'mainnet' \| 'testnet', label, tor }` | |
| `tron_address` | `{ index }` | `string` | `m/44'/195'/0'/0/{index}`, coffre déverrouillé ; **la signature n'utilise que l'index 0** : l'UI ne doit afficher que cette adresse |
| `tron_account` | `{ address }` | `{ address, exists, balance /*sun*/, freeBandwidthLimit, freeBandwidthUsed, bandwidthLimit, bandwidthUsed, energyLimit, energyUsed }` | `getaccount` + `getaccountresource` ; `exists: false` = compte jamais activé |
| `tron_trc20_balance` | `{ contract, address }` | `string` (unités brutes) | `balanceOf` par `triggerconstantcontract` |
| `tron_txs` | `{ address }` | `[{ txid, kind: 'trx' \| 'trc20', from, to, amount, token?: { contract, symbol, decimals }, timestamp, status: 'confirmed' \| 'failed' }]` | API `/v1` de TronGrid (50 TRX + 50 TRC-20 au plus, plus récentes d'abord) ; un nœud java-tron seul n'a pas d'historique → `SERVER_UNREACHABLE` explicite ; pas de frais dans la réponse, et les transferts TRC-20 sont toujours marqués `confirmed` (l'API /v1 ne donne pas leur résultat) |
| `tron_build_tx` | `{ to, amount /*sun ou unités du token*/, token? /*contrat T…*/ }` | `{ raw /*hex*/, txid, summary: TronTxSummary, estimate: TronEstimate }` | TRX : `TransferContract`. TRC-20 : `transfer(to, amount)`, énergie **simulée** (`triggerconstantcontract`, `energy_used + energy_penalty`) ; un transfert qui échouerait (solde de token insuffisant) est refusé ; `fee_limit` = énergie × prix × 1,3, au moins 1 TRX, au plus `getMaxFeeLimit`. Rust re-décode ce qu'il a construit |
| `tron_sign_tx` | `{ raw, password, token?: { symbol, decimals } }` | `{ signature /*65 octets hex*/, txid, summary, estimate }` | décode (`tron_decode_raw`, owner = nous), refuse expirée ou expiration > 24 h, mot de passe, **relit en direct** compte, paramètres de chaîne, existence du destinataire et énergie simulée → dialogue natif : destinataire, montant (USDT nommé par Rust : mainnet `TR7NHq…`, Nile `TXYZop…` ; autre token : unités brutes, `token` de l'UI affiché comme « selon l'interface, non vérifié »), **bande passante nécessaire / disponible (gratuite, gelée) et TRX brûlés**, **énergie estimée / disponible, TRX brûlés estimés et au maximum (`fee_limit`)**, **activation d'un compte inexistant** (création 1 TRX + 0,1 TRX sans bande passante gelée, valeurs lues dans `getchainparameters`), total estimé et maximum, solde, mémo, expiration, bloc de référence, txid ; 2ᵉ dialogue renforcé si `requiresExtraConfirmation` (appel autre que `transfer`, TRX envoyés au contrat, mémo, `fee_limit` > 100 TRX) ; résumé de la signature = résumé affiché |
| `tron_broadcast` | `{ raw, signature }` | `string` (txid) | la signature doit redonner notre adresse ; `/wallet/broadcasthex` ; txid du serveur = `sha256(raw)` sinon `SERVER_UNREACHABLE` ; refus du réseau → `INVALID_INPUT` avec le message décodé |

**Historique et nœud personnel** : `tron_txs` utilise l'API `/v1` propre à TronGrid. Un nœud java-tron seul (serveur `http` personnalisé) ne l'a pas : la commande échoue alors avec `SERVER_UNREACHABLE` et un message explicite (« l'historique exige l'API /v1 de TronGrid »), sans jamais se rabattre sur TronGrid. Soldes, ressources, construction, signature et diffusion fonctionnent avec n'importe quel nœud java-tron.

**Clé TronGrid (optionnelle)** : `KYRO_TRONGRID_API_KEY` (env, développement) ou `settings.apiKeys.trongrid`. Rust l'ajoute en en-tête `TRON-PRO-API-KEY` **uniquement** vers `api.trongrid.io` et `nile.trongrid.io` (jamais vers un nœud personnel ni un autre hôte) ; l'UI ne voit jamais la clé (`config_get.hasTrongridKey`). Sans clé : quotas réduits, et des relais de sortie Tor peuvent recevoir un 403.

Refusé avant toute signature : autre type de contrat que TRX / appel de contrat (gel, vote, délégation, **changement de permissions**…), `Permission_id` (multi-signature), autre propriétaire, `auths`, `scripts`, valeur TRC-10, encodage non canonique. Estimation de bande passante : taille signée + 64 octets (comme java-tron). Hardware wallets : `HW_UNSUPPORTED` (Trezor a `TronSignTx`, Ledger l'app « Tron » : non faits).

**Fait côté UI** (commit de l'UI TRON) : `Family` `'tron'`, types `Commands` (`tron_*`, `Accounts.tron`, `Servers.tron`, `ServerTestTarget`), backend démo, écrans Envoyer (afficher `estimate` avant le mot de passe : bande passante, énergie, activation), Recevoir, Actif (TRX, USDT), Historique, réglage serveur TRON, « Connexions sortantes », sortie de TRON de `WATCH_ONLY_CHAINS`. Adaptateur : `TronAdapter` (`packages/chains/src/tron/`), `tronChain(network)`, `TRON_USDT`.

### 2.6 XRP Ledger (paiements XRP et monnaies émises)

Rust choisit le serveur (`servers.xrp`, sinon le défaut), famille Tor `xrp`, jamais de repli. **Rust construit le Payment** : `Sequence` (`account_info`, registre courant), `Fee` (`fee` : frais du registre ouvert, au moins le frais de référence), `LastLedgerSequence` = registre courant + 20 (≈ 1 min), `Flags` = `tfFullyCanonicalSig`, `SigningPubKey` = notre clé ; encodé par wallet-core. Un blob construit par le serveur n'est jamais signé.

| Commande | Arguments | Retour | Notes |
|---|---|---|---|
| `xrp_backend_info` | — | `{ kind: 'default' \| 'jsonRpc', network: 'mainnet' \| 'testnet', label, tor }` | |
| `xrp_address` | `{ index }` | `string` | `m/44'/144'/0'/0/{index}`, coffre déverrouillé ; **la signature n'utilise que l'index 0** (`xrp_build_tx` / `xrp_sign_tx` / `xrp_broadcast`) : l'UI ne doit afficher que cette adresse |
| `xrp_account` | `{ address }` | `{ address, exists, balance /*drops*/, sequence, ownerCount, flags, requireDestTag, disallowXrp, reserve, spendable }` | `account_info` + réserves de `server_info.validated_ledger` (`reserve_base_xrp`, `reserve_inc_xrp` : **1 XRP et 0,2 XRP**, lus en direct le 30/10/2026 sur testnet et mainnet) ; `reserve` = base + 0,2 × objets possédés ; `spendable` = solde − réserve ; compte inexistant : `exists: false` |
| `xrp_lines` | `{ address }` | `[{ currency, issuer, balance, limit }]` | lignes de confiance (monnaies émises) |
| `xrp_txs` | `{ address }` | `[{ hash, from, to, destinationTag, amount, fee, ledger, time, result }]` | 50 derniers Payment ; `amount` = **montant réellement livré** (`delivered_amount`) |
| `xrp_build_tx` | `{ to, amount /*drops, ou valeur décimale si issued*/, destinationTag?, issued?: { currency, issuer } }` | `{ blob /*non signé, hex*/, summary: XrpTxSummary, context: { account, destination, reserveBase, reserveInc } }` | refusé avant toute construction : destinataire avec `lsfRequireDestTag` **sans tag** ; compte destinataire inexistant et montant XRP < réserve de base (`tecNO_DST_INSUF_XRP`) ; monnaie émise vers un compte inexistant (`tecNO_DST`) ; montant + frais > disponible ; notre compte non activé |
| `xrp_sign_tx` | `{ blob, password }` | `{ blob /*signé*/, hash, summary, context }` | décode (strict, Account et clé = nous), refuse `LastLedgerSequence` dépassé et séquence périmée, **relit en direct** les deux comptes et les réserves et refait les vérifications ci-dessus, mot de passe → dialogue natif : destinataire, **TAG DE DESTINATION encadré sur sa propre ligne** (ou « AUCUN TAG DE DESTINATION » avec l'avertissement), montant, SendMax, création du compte destinataire, frais, solde, réserve bloquée (base + objets), disponible, registre limite, mémos ; 2ᵉ dialogue renforcé si `requiresExtraConfirmation` ; résumé de la signature = résumé affiché |
| `xrp_broadcast` | `{ blob }` | `string` (hash) | `xrp_verify_signed` (DER low-S, clé = Account = nous) puis `submit` ; `tesSUCCESS` ou `terQUEUED` acceptés, sinon `INVALID_INPUT` avec le code ; hash du serveur = `SHA-512Half("TXN\0"‖blob)` sinon `SERVER_UNREACHABLE` |
| `xrp_tx_status` | `{ hash }` | `{ validated, result }` | `tx` : `validated: true` et `result: 'tesSUCCESS'` une fois dans un registre validé |

Refusé avant toute signature : tout autre type de transaction (AccountSet, SetRegularKey, SignerListSet, TrustSet, OfferCreate, EscrowCreate…), **paiement partiel** (`tfPartialPayment` : le montant livré pourrait être presque nul), `Paths`, `DeliverMin`, `TicketSequence`, `NetworkID`, drapeaux inconnus, champs inconnus. Plus strict que « inconnu → confirmation renforcée » : un champ que Kyro ne sait pas décoder n'est jamais signé. Hardware wallets : `HW_UNSUPPORTED` (Trezor `RippleSignTx`, Ledger app « XRP » : non faits).

**Pour l'UI** : le champ **Tag de destination** doit être visible en permanence sur l'écran Envoyer XRP (pas caché dans « options »), avec `parseDestinationTag` (entier 0 … 4 294 967 295) ; s'il est vide, afficher l'avertissement ; si `xrp_account(destination).requireDestTag`, le rendre **obligatoire** (Rust refuse de toute façon) ; afficher `spendable` (pas seulement le solde) et, pour un destinataire inexistant, « au moins 1 XRP » ; après `xrp_broadcast`, suivre `xrp_tx_status`. **Fait côté UI** (commit 158b505) : `Family` `'xrp'`, types `Commands` (`xrp_*`, `Accounts.xrp`, `Servers.xrp`, `ServerTestTarget`), backend démo, écrans Envoyer / Recevoir (adresse + tag éventuel) / Actif (XRP, lignes de confiance) / Historique, réglage serveur XRPL, « Connexions sortantes », sortie de XRP de `WATCH_ONLY_CHAINS`. Adaptateur : `XrpAdapter` (`packages/chains/src/xrp/`), `xrpChain(network)`.

### 2.7 Cardano (ADA et tokens natifs)

Rust choisit le serveur (`servers.cardano`, sinon Koios : `preprod.koios.rest` / `api.koios.rest`, offre publique gratuite sans clé), famille Tor `cardano`, jamais de repli. Blockfrost n'est pas utilisé : Koios fournit tout ce qu'il faut (UTxO, paramètres, tip, historique, `submittx`). **Rust construit la transaction** : UTxO de notre adresse (`address_utxos`), paramètres (`epoch_params` : `min_fee_a`, `min_fee_b`, `coins_per_utxo_size`, `max_tx_size`, bornés contre un serveur hostile), sélection des UTxO (ceux qui portent le token demandé d'abord, puis ADA seuls par valeur décroissante, ceux avec tokens en dernier), une sortie destinataire + une sortie de monnaie qui rend **tous** les tokens restants, frais = `min_fee_a × taille signée + min_fee_b` (itéré), chaque sortie ≥ son min-UTxO, `ttl` = slot courant + 3 600 (≈ 1 h), ensembles taggés 258 (Conway), aucun collatéral, aucun certificat. Encodé par wallet-core ; une transaction construite par le serveur n'est jamais signée.

**Mode une seule adresse** : réception et monnaie sur `m/1852'/1815'/0'/0/0` (staking `…/2/0`), comme les portefeuilles « single address » ; plus simple et plus sûr à vérifier, mais tous les paiements sont liés à une adresse (et à une clé de staking) visible. Le staking (délégation, retraits) n'est pas fait.

| Commande | Arguments | Retour | Notes |
|---|---|---|---|
| `ada_backend_info` | — | `{ kind: 'default' \| 'koios', network: 'mainnet' \| 'testnet', label, tor }` | |
| `ada_address` | `{ index }` | `{ address, path, stakeAddress, accountXpub }` | coffre déverrouillé ; **la signature n'utilise que l'index 0** : l'UI ne doit afficher que cette adresse ; `accountXpub` = clé publique ‖ chain code de `m/1852'/1815'/0'` (hex) |
| `ada_account` | `{ address }` | `{ address, balance /*lovelace*/, tokens: [{ policy, name /*hex*/, nameText, quantity, verified, ticker?, decimals? }], utxoCount, lockedWithTokens }` | `lockedWithTokens` = ADA immobilisés par les tokens (min-UTxO de leurs sorties) : ce qui ne peut pas partir sans eux |
| `ada_txs` | `{ address }` | `[{ hash, time, blockHeight, fee, lovelaceDelta /*signé*/, tokenDeltas: [{ policy, name, nameText, delta }], memo }]` | 20 dernières (`address_txs` + `tx_info`), plus récente d'abord ; `memo` = message CIP-20 |
| `ada_tx_status` | `{ hash }` | `{ confirmations: number \| null }` | `null` : pas encore vue par l'indexeur |
| `ada_build_tx` | `{ to, lovelace?, token?: { policy, name, quantity }, memo? }` | `{ tx /*non signée, CBOR hex*/, summary: CardanoTxSummary, context: { account, params, tip, leaving } }` | `lovelace` absent avec un token = exactement le min-UTxO de la sortie ; refusé avant toute construction : adresse refusée (voir §1), montant sous le min-UTxO (le message donne le minimum), token ou ADA insuffisants, monnaie sous son min-UTxO, transaction > `max_tx_size`. `leaving` = sorties vers d'autres adresses + frais |
| `ada_sign_tx` | `{ tx, password }` | `{ tx /*signée*/, txId, summary, context }` | décode (strict), refuse `ttl` dépassé, **relit en direct** nos UTxO : chaque entrée doit être un de nos UTxO non dépensés, et entrées = sorties + frais (ADA et chaque token) ; frais ≥ minimum ; mot de passe → racine Icarus re-dérivée du coffre → dialogue natif : **chaque sortie** (destinataire ou monnaie, adresse complète, ADA, « dont X ADA minimum obligatoire avec les tokens », chaque token : quantité, nom texte et hex, policy id, vérifié ou NON VÉRIFIÉ), frais, total qui quitte le portefeuille, validité (slot, ≈ minutes), message ; 2ᵉ dialogue renforcé si `requiresExtraConfirmation` (message CIP-20, token hors table vérifiée, frais > 5 ADA, pas de ttl) ; résumé de la signature = résumé affiché |
| `ada_broadcast` | `{ tx }` | `string` (tx id) | `cardano_signed_witnesses` (chaque signature vérifiée sur blake2b-256 du corps, **un seul témoin : notre clé de paiement**) puis Koios `POST /submittx` (CBOR brut, `application/cbor`) ; l'id renvoyé doit être blake2b-256(corps), sinon `SERVER_UNREACHABLE` ; refus du nœud → `INVALID_INPUT` avec son message |

Table de tokens vérifiés (mainnet seulement, vérifiée le 30/10/2026 via Koios `asset_info` / registre de tokens Cardano) : DJED (`8db269c3…cd61` / `446a65644d6963726f555344`), USDM (`c48cbb3d…47ad` / `0014df105553444d`), iUSD (`f66d78b4…9880` / `69555344`). Sur preprod : aucune, tout token demande la confirmation renforcée. N'importe qui peut créer un token au même nom : seule la policy id compte.

Hardware wallets : `HW_UNSUPPORTED`. Ce qu'il faudrait : Ledger app « Cardano ADA » (APDU `DERIVE_ADDRESS` / `GET_EXT_PUBKEY` pour `m/1852'/1815'/a'`, `SIGN_TX` qui reçoit la transaction champ par champ et rend les témoins ; dérivation « Ledger » ≠ Icarus pour une même phrase de 24 mots) ; Trezor `CardanoGetPublicKey` / `CardanoGetAddress` / `CardanoSignTxInit` + flux d'entrées / sorties / tokens (`derivation_type` ICARUS ou ICARUS_TREZOR, qui diffère d'Icarus pour 24 mots). Dans les deux cas Kyro reconstruirait le corps lui-même et vérifierait chaque témoin contre blake2b-256 du corps, comme `btc_hw_finalize`.

**À faire côté UI** (pas dans ce lot) : `Family` `'ada'` (aujourd'hui `CardanoChain` / `cardanoChain(network)` existent dans le registre mais hors `Family` et `allChains()`), types `Commands` de `@kyro/shared` (`ada_*`, `Accounts.cardano`, `Servers.cardano`, `CardanoServer`, `ServerTestTarget` `cardano` ; les types sont aujourd'hui dans `packages/chains/src/cardano/adapter.ts`, à déplacer dans `ipc.ts`), `WalletAccounts.cardano` et `AdapterSet.cardano` (`createAdapters`), backend démo, écrans Envoyer (adresse, montant ADA avec `adaToLovelace`, token facultatif avec quantité, message facultatif public, aperçu du `summary` avant le mot de passe : sorties, min-ADA, frais), Recevoir (adresse de base seule), Actif (ADA, `spendable` = solde − `lockedWithTokens`, liste des tokens avec policy id et mention « non vérifié »), Historique (`lovelaceDelta`, tokens, message), réglage serveur Cardano (Koios), « Connexions sortantes » (`preprod.koios.rest` / `api.koios.rest`), sortie de Cardano de `WATCH_ONLY_CHAINS`. Adaptateur : `CardanoAdapter` (`packages/chains/src/cardano/`), `isCardanoAddress`, `isByronAddress`.

## 3. Allowlist réseau (`net_fetch`)

| Hôte | Usage |
|---|---|
| `api.coingecko.com`, `pro-api.coingecko.com` | prix, top 200, graphiques |
| `mempool.space` | Bitcoin : UTXO, frais, diffusion (Esplora) |
| `litecoinspace.org` | Litecoin (Esplora/mempool, mainnet `/api`, testnet4 `/testnet/api`) : utilisé par les commandes Rust `ltc_*`, famille Tor `litecoin` |
| `s.altnet.rippletest.net` (port 51234), `xrplcluster.com` | XRP Ledger testnet et mainnet (JSON-RPC rippled) : utilisés par les commandes Rust `xrp_*`, famille Tor `xrp` |
| `preprod.koios.rest`, `api.koios.rest` | Cardano preprod et mainnet (Koios REST, offre publique sans clé) : utilisés par les commandes Rust `ada_*`, famille Tor `cardano` |
| `api.trongrid.io`, `nile.trongrid.io` | TRON mainnet et Nile (TronGrid, API HTTP java-tron + `/v1`) : utilisés par les commandes Rust `tron_*`, famille Tor `tron` |
| `ethereum-sepolia-rpc.publicnode.com`, `ethereum-rpc.publicnode.com` | RPC Ethereum |
| `arbitrum-one-rpc.publicnode.com`, `optimism-rpc.publicnode.com`, `base-rpc.publicnode.com`, `polygon-bor-rpc.publicnode.com`, `bsc-rpc.publicnode.com`, `avalanche-c-chain-rpc.publicnode.com` | RPC EVM (phase 2) |
| `mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion` | Bitcoin (Esplora) en mode Tor uniquement, `http://` (service onion officiel de mempool) ; réécriture automatique de `mempool.space` |
| `api.devnet.solana.com`, `api.mainnet-beta.solana.com` | RPC Solana (aussi : tables d'adresses v0 lues par Rust pour `sol_decode_tx` / `sol_sign_tx`, ou le RPC `servers.solana[cluster]` des réglages) |
| `api.0x.org`, `api.1inch.dev`, `li.quest`, `lite-api.jup.ag` | devis de swap |
| + hôtes des serveurs HTTP personnalisés (`servers.bitcoin.*` de type `esplora`, `servers.evm.*`, `servers.solana.*`) | autorisés **uniquement pour leur famille** (circuits Tor de la famille) ; le serveur par défaut remplacé est refusé (`DEFAULT_SERVER_DISABLED`) |
| Electrum et Bitcoin Core | **pas** joignables par `net_fetch` : uniquement via les commandes `btc_*` (Rust) |
| serveurs Esplora Litecoin / Dogecoin personnalisés (`servers.litecoin.*`, `servers.dogecoin.*`) | **pas** joignables par `net_fetch` : uniquement via `ltc_*` / `doge_*` (Rust), circuits Tor de leur famille ; le défaut remplacé (`litecoinspace.org`) est refusé (`DEFAULT_SERVER_DISABLED`) |

HTTPS uniquement (sauf `.onion` via Tor : mempool, ou un serveur personnalisé), pas de redirection vers un hôte hors liste ni vers un serveur personnalisé, réponse plafonnée à 5 Mo, timeout 20 s.
