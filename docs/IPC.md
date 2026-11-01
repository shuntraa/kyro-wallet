# Contrat d'interface Kyro

Ce document fige les frontières entre les trois couches. Toute modification se fait ici d'abord.

```
React (apps/desktop/src)  ──invoke()──►  Tauri shell (apps/desktop/src-tauri)  ──►  wallet-core (crates/wallet-core)
   aucun secret                         session, réseau, dialogues natifs            crypto pure, sans I/O
```

Règles :
- **Aucun secret ne remonte au frontend, la phrase de récupération comprise** : à la création (`vault_backup_show`) comme à la demande (`vault_reveal_mnemonic`), Rust l'affiche dans une **fenêtre système native** ; l'interface ne reçoit jamais les mots. Seule exception inévitable : une phrase **importée** est tapée dans l'interface (`vault_import`).
- **Tout texte venu de l'extérieur** (mémos, noms de compte, de token, de validateur, de pool, d'appareil, hôtes) passe par un seul assainisseur avant une fenêtre native (`dialog_text.rs`) : caractères de contrôle remplacés (retours à la ligne compris), caractères bidi et invisibles retirés, longueur plafonnée, valeur entre « … », mémos affichés **après** les montants et les frais.
- **Navigation** : la webview ne peut charger que l'origine de l'app (`tauri://localhost`, `http(s)://tauri.localhost`, `devUrl` en debug) ; `window.open` est refusé (`nav_guard.rs`).
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
pub fn xrp_path(account) -> String;  pub fn cardano_account_path(account) -> String;  pub fn stellar_path(account) -> String;  pub fn algo_path(account) -> String;   // chemins affichés (dialogue natif, UI)
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
    UnknownChain { chain_id } /*hors EVM_KNOWN_CHAINS (avec sa famille) : mainnet 1, 42161, 10, 8453, 137, 56, 43114, 25, 5000, 146, 14, 8217, 100, 999, 1329, 1030 ; test 11155111*/,
    HighFee { max_fee_wei } /*gas_limit × max_fee_per_gas > evm_high_fee_threshold_wei(chain)*/ }
// Seuil de frais : 0,05 de la monnaie native (ETH, Sepolia, Arbitrum, Optimism, Base, BNB Chain, HyperEVM, chaînes inconnues),
// 50 POL (Polygon), 1 AVAX (Avalanche), ≈ 10 USD sur les chaînes à monnaie bon marché (31/10/2026) : 200 CRO (Cronos),
// 20 MNT (Mantle), 250 S (Sonic), 2 000 FLR (Flare), 300 KAIA, 10 XDAI (Gnosis), 200 SEI, 200 CFX (Conflux eSpace).
// Le dialogue nomme la chaîne et sa monnaie native d'après la table générée depuis registry.ts (`known_tokens.rs` de la coque). Limite : un envoi de valeur SANS calldata vers une adresse de contrat
// n'est pas détecté (il faudrait eth_getCode ; Rust ne contacte pas le RPC pour signer).
pub fn evm_decode(tx: &EvmTxRequest, net: Network) -> Result<EvmTxSummary>;
pub const EVM_KNOWN_CHAINS: &[(u64, Network)];   // LA liste : mainnet 1, 42161, 10, 8453, 137, 56, 43114, 25, 5000, 146, 14, 8217, 100, 999, 1329, 1030 ; testnet 11155111
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

// --- Litecoin (BIP84 P2WPKH), Dogecoin, Bitcoin Cash et Dash (BIP44 P2PKH) : crate `bitcoin` 0.32 réutilisée (clés,
//     PSBT, sighash), encodages d'adresse construits avec ses propres `bech32` / `base58` et les paramètres de
//     chainparams.cpp ; CashAddr (`cashaddr.rs`) = moteur de somme de contrôle générique de la crate `bech32` configuré
//     avec le générateur de la spécification (tous les vecteurs de la spec vérifiés)
pub enum UtxoCoin { Litecoin, Dogecoin, BitcoinCash, Dash }               // JSON "litecoin" | "dogecoin" | "bitcoincash" | "dash"
pub struct UtxoAccount { pub coin: UtxoCoin, pub xpub: String /*xpub/tpub*/, pub fingerprint: String, pub path: String }
pub fn utxo_account(seed, net, coin, account) -> Result<UtxoAccount>;   // m/84'/2'/a' (LTC) · m/44'/3'/a' (DOGE) · m/44'/145'/a' (BCH) · m/44'/5'/a' (DASH) · testnet : coin type 1
pub fn utxo_address(seed, net, coin, account, change, index) -> Result<String>;   // ltc1…/tltc1… · D…/n… · bitcoincash:q…/bchtest:q… · X…/y…
pub fn utxo_address_from_xpub(xpub, net, coin, change, index) -> Result<String>;
pub fn utxo_script_pubkey(address, net, coin) -> Result<ScriptBuf>;     // LTC : ltc1 (v0/v1+), L…, M… (testnet m/n…, Q…) ; refuse 3…/2… (P2SH ancien = Bitcoin) et MWEB. DOGE : D…, 9…/A… (testnet n…, 2…). DASH : X…, 7… (testnet y…, 8…/9…). BCH : CashAddr seulement (préfixe facultatif, casse mixte refusée, types jeton z…/r… = mêmes scripts, P2SH32 refusé) ; la forme legacy 1…/3… est refusée (indiscernable d'une adresse Bitcoin)
pub fn utxo_address_of_script(script, net, coin) -> Option<String>;
pub fn utxo_genesis_hash(net, coin) -> &'static str;                    // LTC mainnet 12a765e3…, testnet4 4966625a… · DOGE mainnet 1a91e3da…, testnet bb0a7826… · BCH = genesis de Bitcoin (chipnet : celui de testnet4) · DASH mainnet 00000ffd…, testnet 00000bad…
pub fn utxo_checkpoint(net, coin) -> Option<(u64, &'static str)>;       // BCH seulement : bloc 478 559 (000…651ef99c…5eec, 1er bloc après la scission) · chipnet 200 000 (000…5d7d9946…7c05)
pub fn utxo_header_hash(header_hex) -> Result<String>;                  // hash (double SHA-256) d'un en-tête de 80 octets, pour le point de contrôle
pub fn utxo_decode_raw_tx(raw_hex, net, coin) -> Result<BtcRawTx>;      // DOGE/BCH/DASH : données témoin refusées · DASH : transaction spéciale DIP2 décodée (charge utile sautée, couverte par le txid)
pub fn utxo_is_special_tx(raw_hex, coin) -> bool;                       // DASH : transaction spéciale (type ≠ 0, version ≥ 3) : affichée, jamais dépensée
pub fn bch_forkid_sighash(tx, input, script_code, value, sighash_type) -> Result<[u8; 32]>;   // digest BIP143 + type 32 bits (FORKID obligatoire, SIGHASH_UTXOS refusé) ; Kyro ne signe qu'en 0x41
pub fn utxo_dust_threshold(coin, script) -> u64;                        // LTC : GetDustThreshold à 30 000 lit/kvB (P2WPKH 2 940) · DOGE : 0,001 DOGE (poussière dure) · BCH/DASH : 3 000/kB (P2PKH 546, P2SH 540)
pub fn utxo_psbt_summary(seed, net, coin, account, psbt_b64) -> Result<UtxoTxSummary>;     // décodage pour le dialogue, sans signer
pub fn utxo_sign_psbt(seed, net, coin, account, psbt_b64) -> Result<(String /*PSBT signée, non finalisée*/, UtxoTxSummary)>;   // comme Bitcoin : compte `account` seulement
// Refusé : PSBT mal formée ; entrée LTC sans witness_utxo ; entrée DOGE/BCH/DASH sans non_witness_utxo dont le txid = l'outpoint, ou avec témoin ;
// origine de clé « à nous » qui ne correspond pas à la clé ou au script ; sighash ≠ ALL ; sortie sous la poussière ; frais négatifs ; aucune entrée à nous ;
// BCH : version ≠ 1/2 ; DASH : transaction spéciale (type ≠ 0) — et une pièce issue d'une transaction spéciale ne peut pas être dépensée (la PSBT
// ne porte pas sa charge utile, son txid ne correspond donc jamais).
// Signature : LTC BIP143 (P2WPKH), DOGE/DASH legacy (P2PKH), SIGHASH_ALL ; BCH digest BIP143 avec SIGHASH_ALL|FORKID (0x41, montants engagés) ;
// chaque signature vérifiée avant d'être gardée. BCH : une signature 0x41 ne tient pas dans une signature partielle PSBT, l'entrée est donc
// FINALISÉE par wallet-core (final_script_sig = <DER‖41> <clé>, origines de clé retirées) ; LTC/DOGE/DASH : signatures partielles, non finalisées.
pub struct UtxoTxSummary {                     // serde camelCase ; montants en chaînes décimales (unité minimale)
    pub coin, pub outputs: Vec<UtxoOutput { address: Option<String>, script /*hex*/, amount, is_change, kind: Address|OpReturn|Unknown }>,
    pub inputs: usize, pub our_inputs: usize, pub fee: String,
    pub size: u64 /*vB (LTC) ou octets (DOGE/BCH/DASH), signature la plus longue*/, pub fee_per_kb: u64 /*lit/kvB, koinus/kB, sat/kB, duffs/kB*/,
    pub has_change: bool /*false : tout ce qui n'est pas envoyé — poussière comprise — part en frais*/,
    pub warnings: Vec<UtxoWarning>, pub requires_extra_confirmation: bool }
pub enum UtxoWarning {                         // JSON { "kind": "softDust", "index": 2 }
    UnknownOutput { index } /*dont witness v2+ LTC*/, OpReturn { index }, ForeignInput { index }, SoftDust { index } /*DOGE < 0,01*/, HighFee /*> 100× le taux usuel ou > total envoyé*/,
    ChangeIndexOutOfRange { index } /*nos clés au-delà de l'index 1000 : is_change = false*/,
    FeeBelowMinimum { minimum } /*informatif*/ }
// requires_extra_confirmation = tout avertissement sauf FeeBelowMinimum.
// Constantes : LTC_MIN_RELAY_FEE_PER_KVB 1 000, LTC_DUST_RELAY_FEE_PER_KVB 30 000 ; DOGE_RECOMMENDED_FEE_PER_KB 1 000 000 (0,01 DOGE/kB),
// DOGE_MIN_RELAY_FEE_PER_KB 100 000, DOGE_SOFT_DUST 1 000 000, DOGE_HARD_DUST 100 000 ; BCH_DASH_MIN_RELAY_FEE_PER_KB 1 000,
// BCH_DASH_DUST_RELAY_FEE_PER_KB 3 000, BCH_SIGHASH_ALL_FORKID 0x41. Frais très élevés (HighFee) : > 100 sat/o (BCH), > 100 duffs/o (DASH).

// --- Zcash, TRANSPARENT SEULEMENT : BIP44 m/44'/133'/a'/c/i (testnet m/44'/1'/…), P2PKH t1… (0x1cb8) / tm… (0x1d25) ; P2SH t3… / t2… ;
//     format v5 (ZIP 225), txid et condensé de signature ZIP 244, branches et hauteurs d'activation, frais ZIP 317 : crates librustzcash
//     (zcash_primitives 0.31.0-pre.2, zcash_transparent 0.11.0-pre.2, zcash_protocol 0.11.0-pre.1) ; ECDSA libsecp256k1 (crate bitcoin)
pub fn zec_account(seed, net, account) -> Result<ZecAccount { xpub, fingerprint, path }>;
pub fn zec_address(seed, net, account, change, index) -> Result<String>;          // t1… / tm…
pub fn zec_address_from_xpub(xpub, net, change, index) -> Result<String>;
pub fn zec_parse_address(address, net) -> Result<(Vec<u8> /*scriptPubKey*/, ZecAddressKind /*P2pkh|P2sh|Tex*/)>;  // refuse zs…, zc…, u1… (« protégée … ou unifiée : pas encore prise en charge »), autre réseau
pub fn zec_address_of_script(script, net) -> Option<String>;
pub fn zec_genesis_hash(net) -> &'static str;                                      // mainnet 00040fe8…, testnet 05a60a92…
pub fn zec_decode_raw_tx(raw_hex, net) -> Result<ZecRawTx { txid, version, branch_id, inputs, outputs, shielded, coinbase }>;  // toute version, txid recalculé
pub fn zec_header_branch_id(raw: &[u8]) -> Option<u32>;                            // nConsensusBranchId d'une transaction v5+ (octets 8..12), même inconnu
pub fn zec_consensus(net, tip_height, observed_height, observed_branch_id) -> Result<ZecConsensus>;  // refus : branche inconnue, ou ≠ table de zcash_protocol à cette hauteur ; expiration +40, raccourcie avant une mise à niveau connue
pub fn zec_tx_summary(seed, net, account, &ZecSendRequest) -> Result<ZecTxSummary>; // construit (sélection, ZIP 317, monnaie à nous) sans signer
pub fn zec_sign(seed, net, account, &ZecSendRequest) -> Result<(String /*hex v5 signée*/, ZecTxSummary)>;  // SIGHASH_ALL, chaque signature vérifiée, encodage relu
pub fn zec_input_sighash(raw_hex, prevouts, index) -> Result<[u8; 32]>;            // condensé ZIP 244 d'une entrée (vérification de vraies transactions)
pub struct ZecSendRequest { coins: Vec<ZecCoin { prev_tx /*hex*/, vout, change, index }>, to, amount /*zatoshis*/, max, change_index, tip_height, network_branch_height, network_branch_id }
// Refusé : destinataire protégé/unifié/autre réseau ; branche inconnue ou incohérente ; transaction précédente illisible ; sortie absente ou qui ne paie
// pas la clé du compte à l'index annoncé ; coinbase ; pièce en double ; montant < 54 zatoshis ; solde insuffisant ; index de monnaie > 1000.
// ZecWarning : HighFee (frais > 10 × ZIP 317 ou > montant : 2ᵉ fenêtre) · ExpiryCapped { next_upgrade_height } (informatif).
// Constantes : ZEC_EXPIRY_DELTA 40, ZEC_DUST 54, ZEC_MIN_CHANGE 5 000, ZEC_MAX_INPUTS 50.

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

// --- Stellar : SEP-0005 m/44'/148'/a' (SLIP-10 ed25519, comme Solana : ed25519-dalek-bip32 ; Lobstr, Freighter, Ledger,
//     Trezor), compte 0 = m/44'/148'/0' ; adresse G… = strkey SEP-0023 (octet de version 6 << 3 ‖ clé ‖ CRC16-XModem,
//     base32 sans remplissage, aller-retour canonique exigé) ; codec XDR écrit à la main, strict (ré-encodage identique exigé)
pub fn stellar_address(seed, account) -> Result<String>; pub fn stellar_public_key(seed, account) -> Result<[u8; 32]>;
pub fn stellar_path(account) -> String;                     // m/44'/148'/account'
pub fn stellar_account_id(address) -> Result<[u8; 32]>;     // G… seulement ; M… (multiplexé) et S… (CLÉ SECRÈTE collée par erreur) refusés avec leur message
pub fn stellar_address_from_key(&[u8; 32]) -> String; pub fn stellar_muxed_parts(m) -> Result<(String, u64)>;
pub fn stellar_asset(code /*1–12 alphanumériques, « XLM » refusé*/, issuer) -> Result<StellarAsset>;
pub fn stellar_network_passphrase(Network) -> &'static str;  // « Public Global Stellar Network ; September 2015 » / « Test SDF Network ; September 2015 »
pub struct StellarTransaction { source: [u8; 32], fee: u32 /*stroops*/, sequence: i64, time_bounds: Option<(u64, u64)>, memo: StellarMemo,
                                operations: Vec<StellarOp> }   // Transaction v1 ; hash(net) = SHA-256(SHA-256(phrase réseau) ‖ ENVELOPE_TYPE_TX ‖ XDR)
pub struct StellarEnvelope { tx, signatures }   // TransactionEnvelope ENVELOPE_TYPE_TX ; encode / decode / to_base64 / from_base64
pub enum StellarOperation { CreateAccount { destination, starting_balance }, Payment { destination, asset, amount }, ChangeTrust { asset, limit } }
// decode refuse : enveloppes v0 et fee bump, comptes multiplexés (M…), PRECOND_V2, Soroban (ext ≠ 0), toute autre opération
// (SetOptions, AccountMerge, ManageData, offres, path payments, claimable balances, InvokeHostFunction…), parts de pool,
// codes d'actif non canoniques, remplissage non nul, octets en trop, encodage non canonique.
pub fn stellar_decode_tx(envelope_b64, our_address, net) -> Result<StellarTxSummary>;   // + refuse : déjà signée, source ≠ nous,
// pas de limites de temps (ou maxTime 0), frais 0, séquence ≤ 0, autre chose qu'UNE opération, opération avec sa propre source,
// paiement / création vers soi-même, montant ≤ 0, limite de confiance < 0, ligne de confiance vers son propre actif
pub struct StellarTxSummary { network, source, fee, sequence, min_time, max_time, memo: StellarMemoView, operation: StellarOpView,
                              warnings: Vec<StellarWarning>, requires_extra_confirmation }   // serde camelCase, montants en stroops (chaînes)
pub enum StellarWarning { HighFee /*> 0,01 XLM*/, UnusualText /*mémo nettoyé ou non UTF-8*/, MemoReturn, RemoveTrustline }   // → renforcée
pub fn stellar_sign(seed, account, envelope_b64, net) -> Result<(String /*enveloppe signée*/, String /*hash*/, StellarTxSummary)>;   // ed25519, vérifiée (verify_strict)
pub fn stellar_verify_signed(envelope_b64, net) -> Result<String /*hash*/>;   // une signature, de la source, indice = 4 derniers octets de la clé, valide SUR CE RÉSEAU

// --- Sui : m/44'/784'/a'/0'/0' (SLIP-10 ed25519, tous niveaux durcis ; compte 0 = celui de Sui Wallet / Slush, `sui keytool`
//     et des SDK officiels), adresse = 0x + hex(BLAKE2b-256(0x00 || clé publique 32 o)), sans somme de contrôle ;
//     BCS écrit à la main pour le SEUL transfert de SUI construit par Kyro, strict (ré-encodage identique exigé)
pub fn sui_address(seed, account) -> Result<String>; pub fn sui_public_key(seed, account) -> Result<[u8; 32]>; pub fn sui_path(account) -> String;
pub fn sui_parse_address(s) -> Result<[u8; 32]>;   // 0x + exactement 64 hex ; forme courte (0x2) et noms SuiNS refusés
pub struct SuiObjectRef { object_id: [u8; 32], version: u64, digest: [u8; 32] }   // pièce de gaz (ObjectRef)
pub enum SuiTransferAmount { Mist(u64), All }
pub struct SuiTransfer { sender, recipient, amount, gas_payment: Vec<SuiObjectRef>, gas_price, gas_budget, expiration_epoch: Option<u64> }
impl SuiTransfer { pub fn encode(&self) -> Result<Vec<u8>>; pub fn decode(bcs) -> Result<Self> }
// TransactionData::V1 { ProgrammableTransaction { inputs: [Pure(u64), Pure(address)],
//   commands: [SplitCoins(GasCoin, [Input(0)]), TransferObjects([NestedResult(0,0)], Input(1))] }   <- montant
// | { inputs: [Pure(address)], commands: [TransferObjects([GasCoin], Input(0))] }                    <- tout le solde
// sender, GasData { payment, owner = sender, price, budget }, expiration None | Epoch(e) }
// decode refuse tout le reste : entrée Object, MoveCall, MergeCoins, Publish, Result(0) au lieu de NestedResult(0,0),
// parrain (owner ≠ sender), gaz payé par le solde d'adresse (payment vide), expiration ValidDuring, octet en trop, ULEB non canonique.
pub fn sui_decode_tx(bcs_b64, our_address) -> Result<SuiTxSummary>;   // + sender = nous
pub struct SuiTxSummary { sender, recipient, coin_type /*"0x2::sui::SUI"*/, amount: Option<String> /*MIST ; None = tout*/, gas_budget,
                          gas_price, gas_coins: Vec<{ object_id, version, digest }>, expiration_epoch, digest /*base58*/, warnings, requires_extra_confirmation }
pub enum SuiWarning { SendAll, SelfTransfer, HighGasBudget /*> 0,1 SUI*/, NoExpiration }   // -> renforcée
pub fn sui_sign(seed, account, bcs_b64) -> Result<(String /*flag 0x00 || sig 64 || pk 32, base64*/, SuiTxSummary)>;
//   signe ed25519(BLAKE2b-256([0,0,0] || bcs)) (IntentMessage TransactionData/V0/Sui), vérifiée (verify_strict)
pub fn sui_verify_signed(bcs_b64, signature_b64) -> Result<String /*digest*/>;   // flag ed25519, clé = sender, verify_strict
pub fn sui_tx_digest(bcs) -> String;   // base58(BLAKE2b-256("TransactionData::" || bcs))

// --- Hedera : ECDSA secp256k1 m/44'/3030'/0'/0/a (chemin « standard » ECDSA des SDK Hedera, toStandardECDSAsecp256k1PrivateKey(pass, a),
//     celui de HashPack pour un compte ECDSA ; compte 0 = m/44'/3030'/0'/0/0) ; « adresse » = adresse EVM de la clé (alias : le premier
//     HBAR reçu crée le compte 0.0.x, HIP-583) ; ED25519 (m/44'/3030'/0'/0'/a', Ledger, anciens comptes HashPack) non pris en charge ;
//     protobuf du seul CryptoTransfer HBAR écrit à la main, strict (ré-encodage identique exigé), recoupé avec le runtime protobuf de Google
pub fn hbar_path(account) -> String; pub fn hbar_public_key(seed, account) -> Result<[u8; 33]>; pub fn hbar_evm_address(seed, account) -> Result<String>;
pub fn hbar_checksum(net, num) -> String;                 // HIP-15 (0.0.123-vfmkw mainnet, -esxsf testnet)
pub fn hbar_parse_account_id(s, net) -> Result<u64>;      // 0.0.n, somme HIP-15 facultative mais vérifiée ; autre shard / realm refusé
pub fn hbar_parse_recipient(s, net) -> Result<HbarRecipient>;   // 0.0.n ou 0x… (EIP-55 si casse mixte ; « long-zero » → 0.0.n ; nulle refusée)
pub enum HbarRecipient { Id(u64), Evm([u8; 20]) }
pub struct HbarTransfer { payer, valid_start_secs, valid_start_nanos, node, max_fee /*tinybars*/, valid_duration, memo, to: HbarRecipient, amount }
impl HbarTransfer { pub fn encode(&self) -> Vec<u8> /*TransactionBody*/; pub fn decode(raw) -> Result<Self>; pub fn transaction_id(&self) /*0.0.p@s.n*/; pub fn mirror_transaction_id(&self) /*0.0.p-s-n*/ }
// decode refuse : tout champ de TransactionBody autre que transactionID (1), nodeAccountID (2), transactionFee (3), transactionValidDuration (4),
// memo (6), cryptoTransfer (14) — donc tout autre type de transaction, batch_key, max_custom_fees… ; scheduled, nonce, generateRecord ;
// transferts de tokens HTS ; is_approval (dépense par allowance) ; hooks ; autre chose qu'un débit du payeur suivi d'un crédit égal ;
// alias long-zero ; shard / realm ≠ 0 ; encodage non canonique.
pub fn hbar_check_memo(memo) -> Result<()>;               // ≤ 100 octets, sans caractère de contrôle / invisible / bidi
pub fn hbar_decode_tx(bodies_hex: &[String], our_account: u64, our_pubkey, allowed_nodes: &[u64]) -> Result<HbarTxSummary>;
// + refuse : copies différentes (hors nœud), nœud hors liste ou en double, payeur ≠ nous, transfert à soi-même (0.0.x ou notre adresse EVM),
// montant 0, frais max 0, validité hors 1–180 s
pub struct HbarTxSummary { from, to, to_is_evm, amount, max_fee, memo /*nettoyé*/, memo_hex, transaction_id, mirror_transaction_id,
                           valid_start, valid_duration, nodes, warnings: Vec<HbarWarning>, requires_extra_confirmation }   // serde camelCase
pub enum HbarWarning { HighFee /*frais max > 2 HBAR*/, UnusualText /*mémo nettoyé*/ }   // → renforcée
pub fn hbar_sign(seed, account, our_account, bodies_hex, allowed_nodes) -> Result<(Vec<String> /*Transaction signée par nœud*/, HbarTxSummary)>;
// ECDSA libsecp256k1 sur keccak256(bodyBytes), compacte r‖s low-S, vérifiée ; SignaturePair { pubKeyPrefix = clé complète 33 o, ECDSA_secp256k1 }
pub fn hbar_verify_signed(tx_hex) -> Result<HbarSignedTransfer { transfer, public_key }>;   // Transaction { signedTransactionBytes } seul, une signature
pub fn hbar_decode_precheck(raw) -> Result<(u32 /*code*/, u64 /*cost*/)>; pub fn hbar_response_name(code) -> String;

// --- Polkadot (Asset Hub) : sr25519 depuis l'ENTROPIE BIP39 (substrate-bip39, comme Polkadot.js / Nova / Talisman /
//     SubWallet), schnorrkel (ExpansionMode::Ed25519, contexte « substrate ») ; compte 0 = clé racine de la phrase,
//     compte a ≥ 1 = dérivation dure `//a` ; SS58 (préfixe 0 Polkadot, 42 Westend), blake2b-512 « SS58PRE » ;
//     SCALE (parity-scale-codec) ; métadonnées V15 décodées par frame-metadata + scale-info (crates de Parity)
pub struct PolkadotRoot(/* mini-secret sr25519, effacé */);  impl PolkadotRoot { pub fn from_mnemonic(&Mnemonic, passphrase) -> Result<PolkadotRoot>; }
pub fn dot_chain(Network) -> &'static DotChain;   // ÉPINGLÉ : genesis, spec_name, SS58, décimales, Balances = 10, transfer_keep_alive = 3
pub fn dot_public_key(root, account) -> Result<[u8; 32]>;  pub fn dot_address(root, account, Network) -> Result<String>;  pub fn dot_path(account) -> String;
pub fn dot_ss58_encode(&[u8; 32], prefix) -> String;  pub fn dot_ss58_decode(address) -> Result<(u8, [u8; 32])>;
pub fn dot_account_id(address, Network) -> Result<[u8; 32]>;   // préfixe SS58 du réseau exigé (Kusama, « 5… » sur mainnet : refusés)
pub fn dot_runtime(Network, state_call_result) -> Result<DotRuntime>;   // Option<métadonnées V15> du nœud, vérifiées contre DotChain :
//   spec_name, SS58Prefix, index de Balances et de transfer_keep_alive (+ arguments dest: MultiAddress, value: Compact<u128>),
//   extrinsèque v4, MultiAddress / MultiSignature::Sr25519, disposition de System.Account, extensions de transaction
//   TOUTES connues avec les types attendus (sinon refus : « Kyro doit être mis à jour »), ExistentialDeposit
pub struct DotTransfer { dest, value /*planck*/, era: DotEra /*mortelle*/, block_hash, nonce, tip /*toujours 0*/ }
pub fn dot_transfer_payload(&DotRuntime, &DotTransfer, from) -> Result<String /*hex : call ‖ extra ‖ additional*/>;
pub fn dot_decode_payload(&DotRuntime, payload_hex, from) -> Result<DotTxSummary>;   // refuse : autre appel, MultiAddress autre
//   que Id, montant nul, envoi à soi-même, pourboire, frais dans un autre actif, CheckMetadataHash activé, ère immortelle
//   ou > 4096 blocs, autre genesis / spec / transaction_version, octets en trop, ré-encodage différent
pub fn dot_sign(root, account, &DotRuntime, payload_hex) -> Result<(String /*extrinsèque signé*/, String /*blake2-256*/, DotTxSummary)>;
pub fn dot_verify_extrinsic(&DotRuntime, extrinsic_hex, block_hash) -> Result<([u8; 32] /*signataire*/, String /*hash*/, DotTxSummary)>;
pub fn dot_fee_probe_extrinsic(&DotRuntime, payload_hex, from) -> Result<Vec<u8>>;   // signature nulle, pour query_info seulement
pub fn dot_account_storage_key(&[u8; 32]) -> Vec<u8>;  pub fn dot_decode_account_info(&[u8]) -> Result<DotAccountInfo>;   // System.Account, 80 octets
pub fn dot_decode_fee_info(&[u8]) -> Result<u128>;   // TransactionPaymentApi_query_info → partial_fee

// --- Algorand : m/44'/283'/a'/0/0 dérivé comme l'app Algorand de Ledger (racine HMAC-SHA512 « ed25519 seed » re-hachée tant
//     que le 3ᵉ bit de poids fort de kL est à 1, chaîne HMAC-SHA256 ; enfants BIP32-Ed25519 V2 (44'/283'/a' durcis, 0/0 non durcis) par le crate ed25519-bip32 ;
//     les 32 octets kL du dernier nœud = clé secrète ed25519 RFC 8032, signée par ed25519-dalek). Pas le format Pera à 25 mots.
//     Adresse = base32 sans remplissage (data-encoding) de pk ‖ 4 derniers octets de SHA-512/256(pk), 58 caractères.
//     msgpack canonique du seul type `pay` écrit à la main, strict (ré-encodage identique exigé) ; signé : ed25519("TX" ‖ msgpack)
pub fn algo_address(seed, account) -> Result<String>; pub fn algo_public_key(seed, account) -> Result<[u8; 32]>;
pub fn algo_address_bytes(address) -> Result<[u8; 32]>;   // 58 car. base32 majuscules, somme de contrôle (clé, ou hash d'application / de programme)
pub fn algo_address_of_pubkey(&[u8; 32]) -> String; pub fn algo_genesis(net) -> Result<(&str /*gen*/, [u8; 32] /*gh*/)>;
pub struct AlgoPayment { amount, close_remainder_to: Option<[u8; 32]>, fee, first_valid, genesis_id, genesis_hash, group, last_valid,
                         lease, note: Vec<u8>, receiver, rekey_to, sender }   // close / rekey / grp / lx décodés pour être refusés
impl AlgoPayment { pub fn encode(&self) -> Vec<u8> /*msgpack canonique*/; pub fn decode(raw) -> Result<Self>;
                   pub fn signing_bytes(&self) -> Vec<u8> /*"TX" ‖ msgpack*/; pub fn txid(&self) -> String /*base32(SHA-512/256(…))*/ }
pub fn algo_encode_signed(&AlgoPayment, &[u8; 64]) -> Vec<u8>; pub fn algo_decode_signed(raw) -> Result<(AlgoPayment, [u8; 64])>;
pub fn algo_decode_tx(blob_hex, net, our_address) -> Result<AlgoTxSummary>;   // refuse : autre type, close, rekey, grp, lx, champ inconnu,
// encodage non canonique, expéditeur ≠ nous, autre réseau (gen/gh), destinataire nul ou nous, montant 0, frais < 1000, fenêtre > 1000, note > 1024 o
pub struct AlgoTxSummary { sender, receiver, amount, fee /*µALGO*/, first_valid, last_valid, genesis_id, genesis_hash /*b64*/,
                           note_len, note_hex, note_text /*nettoyé*/, txid, warnings: Vec<AlgoWarning>, requires_extra_confirmation }
pub enum AlgoWarning { Note, BinaryNote, UnusualText, HighFee /*> 0,01 ALGO*/ }   // → renforcée
pub fn algo_sign(seed, account, net, blob_hex) -> Result<(String /*signé, hex*/, String /*txid*/, AlgoTxSummary)>;   // verify_strict
pub fn algo_verify_signed(signed_hex, net, our_address) -> Result<(String /*txid*/, Vec<u8> /*à diffuser*/)>;

// --- TON : SLIP-10 ed25519 m/44'/607'/a' (route BIP39 de Trust Wallet : compte 0 = son adresse ; Tonkeeper / Tonhub ont
//     leur propre format de phrase et Ledger un chemin à 6 niveaux, donc d'autres adresses), portefeuille standard v4R2
//     (code officiel, hash feb5ff68…dabd5c0 vérifié à chaque usage), wallet id 698983191 sur mainnet et 0x4B59524F
//     (« KYRO ») sur testnet : une signature v4R2 ne nomme pas le réseau, un id distinct rend impossible de rejouer un
//     transfert de testnet sur mainnet. Cellules et BOC : crate tycho-types ; mises en page TL-B écrites ici (message
//     externe, corps v4R2, message interne, commentaire texte), décodage strict à ré-encodage **octet pour octet**.
pub fn ton_path(account) -> String;  pub fn ton_public_key(seed, account) -> Result<[u8; 32]>;  pub fn ton_wallet_id(testnet) -> u32;
pub fn ton_wallet_address(pubkey, wallet_id) -> Result<TonAddress>;        // 0: ‖ hash du StateInit v4R2
pub fn ton_address(seed, account, testnet) -> Result<String>;              // forme lisible non rebondissante UQ… (testnet 0Q…)
pub fn ton_parse_address(s) -> Result<TonFriendly>;   // 48 car. base64url ou base64, CRC16-XModem, tag 0x11/0x51 (+0x80 testnet), wc 0 ou -1 ;
                                                      // forme brute « 0:… » refusée (pas de somme de contrôle)
pub fn ton_parse_raw_address(s) -> Result<TonAddress>;   // « wc:hex » des réponses serveur uniquement
pub struct TonTransfer { public_key, wallet_id, valid_until, seqno, mode /*3 ou 130*/, destination: TonAddress, bounce, amount /*nanotons*/,
                         comment: Option<String> /*≤ 123 octets*/, with_state_init /*seqno 0 seulement*/ }
impl TonTransfer { pub fn encode_unsigned(&self) -> Result<String /*BOC base64, signature nulle*/>; pub fn signing_hash(&self);
                   pub fn estimate_parts(&self) -> Result<TonEstimateParts>;
                   pub fn decode(boc, our_pubkey, wallet_id) -> Result<(TonTransfer, [u8; 64] /*signature*/)>; }   // strict (ci-dessous)
pub fn ton_decode_tx(boc, our_pubkey, testnet) -> Result<TonTxSummary>;   // non signé (signature nulle) ; refuse : autre destinataire du message
//     externe que notre portefeuille, autre wallet id (autre réseau), StateInit qui n'est pas le nôtre ou avec seqno ≠ 0, op ≠ 0 (plugins),
//     ≠ 1 message, mode ≠ 3 (montant > 0) / 130 (montant 0), message interne rebondi / avec IHR / avec autres monnaies / qui déploie un
//     contrat, corps autre que vide ou commentaire texte (op 0 + UTF-8 valide, une cellule), masterchain, cellule spéciale, données en trop,
//     BOC non canonique (le ré-encodage doit redonner les mêmes octets, CRC compris)
pub struct TonTxSummary { wallet, destination /*forme selon le drapeau bounce*/, destination_other /*l'autre forme*/, destination_raw, amount,
                          send_all, bounce, comment /*nettoyé*/, seqno, valid_until, deploys_wallet, wallet_id, warnings: Vec<TonWarning>,
                          requires_extra_confirmation }
pub enum TonWarning { UnusualText }   // JSON { "kind": "unusualText" }
pub fn ton_sign(seed, account, boc, testnet) -> Result<TonSigned { boc, hash, normalized_hash, summary }>;   // ed25519 du hash de la partie
//     signée, vérifiée (verify_strict) ; hash = hash du message externe, normalized_hash = TEP-467 (sans StateInit), ce qu'indexent les explorateurs
pub fn ton_verify_signed(boc, our_pubkey, testnet) -> Result<(TonTransfer, String /*hash*/, String /*normalisé*/)>;

// --- Cosmos Hub : m/44'/118'/a'/0/0 (Keplr, Leap, Ledger Live, gaiad), adresse cosmos1… = bech32 (BIP-173, pas bech32m) de
//     RIPEMD160(SHA256(clé compressée)) ; MsgSend d'uatom en SIGN_MODE_DIRECT uniquement. Protobuf : les messages du SDK
//     (Coin, MsgSend, Any, TxBody, PubKey, ModeInfo, SignerInfo, Fee, AuthInfo, SignDoc, TxRaw) déclarés à la main avec le derive
//     de `prost` (pas de protoc), seulement les champs utilisés : tout octet décodé doit se ré-encoder à l'identique, à chaque
//     niveau (le champ inconnu, le doublon ou le varint non minimal que prost accepterait sont ainsi refusés)
pub const COSMOS_CHAIN_ID_MAINNET = "cosmoshub-4"; pub const COSMOS_CHAIN_ID_TESTNET = "provider";   pub fn cosmos_chain_id(net) -> &str;
pub fn cosmos_path(account) -> String; pub fn cosmos_public_key(seed, account) -> Result<[u8; 33]>; pub fn cosmos_address(seed, account) -> Result<String>;
pub fn cosmos_address_bytes(address) -> Result<Vec<u8>>;     // bech32 vérifié, préfixe cosmos, 20 ou 32 octets, casse mixte refusée
pub fn cosmos_normalize_address(address) -> Result<String>;  // forme canonique minuscule ; cosmos_address_of_pubkey(sec1), cosmos_address_from_bytes(&[u8])
pub struct CosmosSendRequest { chain_id, account_number, sequence, public_key: [u8; 33], to, amount /*uatom*/, fee /*uatom*/, gas_limit, memo, timeout_height }
pub fn cosmos_send_sign_doc(&CosmosSendRequest) -> Result<Vec<u8>>;   // SignDoc sérialisé, revérifié par le décodeur
pub fn cosmos_simulation_tx(sign_doc) -> Result<Vec<u8>>;               // TxRaw avec une signature vide (pour /simulate)
pub fn cosmos_decode_sign_doc(sign_doc_hex, our_pubkey, net) -> Result<CosmosTxSummary>;
// refuse : chain-id ≠ celui du réseau, autre message qu'un seul MsgSend, autre dénomination qu'uatom, plusieurs pièces, montant
// ou frais non canoniques / nuls, expéditeur ≠ nous, envoi à soi-même, destinataire non canonique, plusieurs signataires, clé ≠ la
// nôtre, mode ≠ SIGN_MODE_DIRECT, payer / granter, gas_limit 0, timeout_height absent, mémo > 512 caractères, TxBody.unordered,
// timeout_timestamp, extension_options, AuthInfo.tip (champs non déclarés → ré-encodage différent)
pub struct CosmosTxSummary { chain_id, account_number, sequence, from, to, amount, fee, gas_limit, memo /*nettoyé, 256 car.*/,
                             memo_hex /*exact*/, timeout_height, warnings: Vec<CosmosWarning>, requires_extra_confirmation }   // serde camelCase
pub enum CosmosWarning { HighFee /*> 0,1 ATOM*/, UnusualText /*mémo nettoyé*/ }   // → renforcée (le mémo seul ne l'est pas : il est encadré)
pub fn cosmos_sign(seed, account, sign_doc_hex, net) -> Result<(String /*TxRaw base64*/, String /*hash SHA-256 hex*/, CosmosTxSummary)>;
// décode d'abord ; SHA-256(SignDoc), libsecp256k1 RFC 6979, low-S, 64 octets r‖s, vérifiée
pub fn cosmos_verify_signed(tx_b64, net, account_number) -> Result<(String /*hash*/, CosmosTxSummary)>;
// mêmes règles + une seule signature de 64 octets, low-S, de la clé du signataire sur le SignDoc reconstruit (chain-id du réseau,
// account_number lu en direct)

// --- Aptos : m/44'/637'/a'/0'/0' (SLIP-10 ed25519, tous niveaux durcis : Petra, CLI et SDK Aptos, Ledger ; compte 0 = m/44'/637'/0'/0'/0'),
//     adresse = clé d'authentification = SHA3-256(clé publique 32 o || 0x00), écrite 0x + 64 hex (forme longue AIP-40, sans somme de contrôle) ;
//     BCS écrit à la main, strict (ULEB128 canonique, variantes connues seulement, aucun octet en trop, ré-encodage identique exigé)
pub fn aptos_path(account) -> String; pub fn aptos_address(seed, account) -> Result<String>; pub fn aptos_public_key(seed, account) -> Result<[u8; 32]>;
pub fn aptos_address_of_pubkey(&[u8]) -> Result<String>; pub fn aptos_parse_address(&str) -> Result<[u8; 32]>;   // 0x + 64 hex exactement : forme courte (0x1, zéros de tête omis) et noms ANS (.apt) refusés
pub struct AptosTransfer { sender, sequence_number, recipient, amount /*octas*/, max_gas_amount, gas_unit_price, expiration_timestamp_secs, chain_id }
impl AptosTransfer { pub fn encode(&self) -> Result<Vec<u8>> /*RawTransaction BCS*/; pub fn decode(bcs) -> Result<Self>; pub fn max_fee(&self) -> u64;
                     pub fn signed_bytes(&self, pubkey, sig) -> Result<Vec<u8>> /*raw || 0x00 Ed25519 || uleb 32 || pk || uleb 64 || sig*/ }
// decode n'accepte QUE RawTransaction { payload: EntryFunction(0x1::aptos_account::transfer, aucun argument de type, [bcs(address), bcs(u64)]) } ;
// refusés : script, multisig, charge « Payload » (transactions sans séquence), autre module / fonction, arguments de type, montant / gaz / prix / chain_id nuls.
pub fn aptos_signing_message(raw) -> Vec<u8>;     // SHA3-256("APTOS::RawTransaction") || raw
pub fn aptos_tx_hash(signed) -> String;           // 0x + hex(SHA3-256(SHA3-256("APTOS::Transaction") || 0x00 || signed))
pub fn aptos_decode_tx(raw_hex, our_address) -> Result<AptosTxSummary>;   // + refuse : expéditeur ≠ nous
pub struct AptosTxSummary { sender, recipient, function, amount, sequence_number, max_gas_amount, gas_unit_price, max_fee,
                            expiration_timestamp_secs, chain_id, warnings: Vec<AptosWarning>, requires_extra_confirmation }   // serde camelCase
pub enum AptosWarning { SelfTransfer, HighFee /*frais maximum > 0,02 APT*/ }   // → renforcée
pub fn aptos_sign(seed, account, raw_hex) -> Result<(String /*signée, hex*/, String /*hash*/, AptosTxSummary)>;   // décode d'abord ; verify_strict
pub fn aptos_verify_signed(signed_hex) -> Result<(String /*hash*/, AptosTransfer)>;   // une seule clé ed25519, adresse(clé) = expéditeur, verify_strict
pub fn aptos_simulation_bytes(raw_hex, pubkey) -> Result<Vec<u8>>;   // signature nulle, pour /transactions/simulate (qui refuse une vraie signature)
// Vecteurs : wallet « shoot island … » du SDK TypeScript officiel (clé publique, adresse), deux vrais transferts mainnet
// (versions 7851560271 et 7851558238) reconstruits octet pour octet : la signature de la chaîne se vérifie et le hash est identique.

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

// --- Kaspa (crates/wallet-core/src/kaspa.rs ; règles de rusty-kaspa v2.1.0, vecteurs officiels dans tests/kaspa.rs) ---
// Dérivation « gen1 » (Kaspa NG, Kaspium) : m/44'/111111'/account'/0/i (réception), …/1/i (monnaie), MÊME chemin sur testnet-10.
pub fn kaspa_path(account, change, index) -> String; pub fn kaspa_account_path(account) -> Result<String>;
pub fn kaspa_public_key(seed, account, change, index) -> Result<[u8; 32] /*x-only*/>;
pub fn kaspa_address(seed, net, account, change, index) -> Result<String>;       // P2PK Schnorr, kaspa: / kaspatest:
pub fn kaspa_own_keys(seed, net, account, window) -> Result<Vec<KaspaOwnKey { change, index, xonly, address }>>;   // réception puis monnaie
pub fn kaspa_address_encode(net, kind, payload); pub fn kaspa_address_decode(net, address) -> Result<(KaspaAddressKind, Vec<u8>)>;
// decode : minuscules seulement, préfixe du réseau exigé (message clair si c'est l'autre réseau), somme de contrôle (polymod CashAddr),
// version 0 (P2PK Schnorr, 32 o) / 1 (P2PK ECDSA, 33 o) / 8 (P2SH, 32 o), forme canonique (ré-encodage identique).
pub fn kaspa_script_pubkey(net, address) -> Result<Vec<u8>>;  pub fn kaspa_address_of_script(net, version, script) -> Option<String>;
pub struct KaspaTx { version, inputs: Vec<KaspaInput { outpoint, signature_script, sequence, sig_op_count }>,
                     outputs: Vec<KaspaOutput { value, script_version, script }>, lock_time, subnetwork_id: [u8; 20], gas, payload }
pub fn kaspa_tx_id(tx) -> Result<[u8; 32]>;        // BLAKE2b à clé « TransactionID », sans scripts de signature (version 0 seulement)
pub fn kaspa_tx_hash(tx) -> Result<[u8; 32]>;      // « TransactionHash », encodage complet (vecteurs)
pub fn kaspa_sighash(tx, entries, index, hash_type) -> Result<[u8; 32]>;   // calc_schnorr_signature_hash (« TransactionSigningHash ») ; les 6 types (vecteurs), Kyro ne signe que 0x01
pub fn kaspa_mass(tx, entries) -> Result<KaspaMass { compute, transient, storage, relay, total }>;   // KIP-9 généralisé (pluralités)
pub fn kaspa_storage_mass(inputs: &[(montant, longueur de script)], outputs) -> Option<u64>;
pub fn kaspa_priority_feerate(estimate) -> u64;    // 0 si l'estimation du serveur est au minimum (100), sinon min(estimation, 10 000)
pub fn kaspa_build_send(coins, to_script, KaspaAmount::Exact(sompi) | Max, change_script, priority) -> Result<KaspaBuilt { tx, entries }>;
// pièces par montant décroissant, ≤ 84 entrées, destinataire ≥ 0,2 KAS (KIP-9), frais = max(100 × masse de relais, priorité × masse totale),
// monnaie jamais créée au-delà de 100 000 g : ajoutée aux frais si ≤ 0,2 KAS, sinon pièces supplémentaires.
pub fn kaspa_tx_summary(net, tx, entries, ours) -> Result<KaspaTxSummary>;
// refuse : version ≠ 0, sous-réseau non natif, gas, payload, lock time ≠ 0, séquence ≠ 0, sig-op ≠ 1, entrée hors `ours` (P2PK de ce compte),
// entrée en double, 0 ou > 2 sorties, sortie nulle, version de script ≠ 0, sorties > entrées, masse > 100 000, frais < minimum de relais.
pub struct KaspaTxSummary { tx_id, outputs: Vec<KaspaOutputView { address?, script, amount, is_change, kind /*address|unknown*/ }>, inputs,
                            input_total, sent, fee, mass, minimum_fee, fee_rate, has_change, warnings: Vec<KaspaWarning>, requires_extra_confirmation }   // serde camelCase
pub enum KaspaWarning { UnknownOutput { index }, HighFee /*> 1 KAS ou > 10 × minimum*/ }   // serde tag "kind" → confirmation renforcée
pub fn kaspa_sign(seed, net, account, tx, entries) -> Result<(KaspaTx /*signée*/, KaspaTxSummary)>;   // BIP340 libsecp256k1, aléa auxiliaire, chaque signature revérifiée ; résumé identique avant/après
pub fn kaspa_verify_signed(tx, entries) -> Result<()>;   // script de signature = OP_DATA_65 ‖ sig64 ‖ 0x01, Schnorr contre la clé de la pièce
pub fn kaspa_tx_to_json(tx) -> Result<String>; pub fn kaspa_tx_from_json(json) -> Result<KaspaTx>;   // forme SubmitTxModel de l'API, champs inconnus refusés, hex minuscule

// --- Monero (monero-oxide / monero-wallet 0.2, MIT, audit Cypher Stack mai 2025 ; aucune crypto maison) :
//     k = BIP32-secp256k1(seed, m/44'/128'/a'/0/0) ; spend = sc_reduce32(keccak256(k)) ; view = sc_reduce32(keccak256(spend))
//     (schéma de l'app Monero de Ledger ; la phrase de 25 mots de `spend` restaure le même portefeuille dans Monero GUI, Feather, Cake).
//     Testnet de Kyro = **stagenet** Monero.
pub fn xmr_path(account) -> String; pub fn xmr_view_pair(seed, account) -> Result<ViewPair>;
pub fn xmr_address(seed, net, account, index) -> Result<String>;   // 0 = adresse principale, n ≥ 1 = sous-adresse (0, n)
pub fn xmr_addresses(seed, net, account, range) -> Result<Vec<String>>; pub fn xmr_public_keys(seed, account) -> Result<(String, String)>;
pub fn xmr_seed_words(seed, account) -> Result<Zeroizing<Vec<String>>>; pub fn xmr_words_to_key(phrase) -> Result<Zeroizing<[u8; 32]>>;   // 25 mots anglais + somme CRC32
pub fn xmr_parse_address(address, net) -> Result<XmrDestination { address, kind: standard | subaddress | integrated { paymentId } }>;
                                                                   // autre réseau, adresse « featured », encodage non canonique : refusés
pub fn xmr_scanner(seed, account, subaddresses) -> Result<Scanner>;   // clé de vue privée en mémoire, jamais envoyée
pub fn xmr_key_images(seed, account, outputs) -> Result<Vec<[u8; 32]>>;   // vérifie que chaque sortie est bien à nous
pub fn xmr_cache_seal(seed, net, account, plain) / xmr_cache_open(...);   // état de scan chiffré (XChaCha20-Poly1305, clé dérivée de la clé de vue)
pub fn xmr_build(seed, net, account, inputs: Vec<OutputWithDecoys>, to, amount, fee_rate, own) -> Result<XmrUnsigned>;   // anneau 16, CLSAG + Bulletproofs+
pub struct XmrTxSummary { network, account, destination, amount, fee, change, inputsTotal, inputCount, ringSize, feePerWeight,
                          warnings: Vec<XmrWarning /*integratedAddress | highFee (> 0,01 XMR) | feeAboveAmount | ownAddress*/>, requiresExtraConfirmation }
pub fn xmr_sign(seed, account, unsigned) -> Result<XmrSigned { tx, txid, key_images, summary }>;
                                                                   // puis Eventuality : exactement les sorties prévues (paiement + monnaie), frais = ceux affichés

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
| `vault_create` | `{ password, words: 12 \| 24 }` | `{ wordCount }` | crée le coffre (verrou tenu de la vérification d'existence jusqu'au début de la session, fichier créé sans jamais écraser : `INVALID_INPUT` si un coffre existe) ; **les mots ne sont pas renvoyés** : Rust les garde jusqu'à la vérification (ou au verrouillage) |
| `vault_backup_show` | — | `{ checks: [i, j, k] }` | affiche la phrase du coffre qui vient d'être créé dans une **fenêtre native** (rend la main à sa fermeture), puis tire au hasard (OS) les 3 positions (base 0) à vérifier ; `INVALID_INPUT` s'il n'y a plus de phrase en attente |
| `vault_backup_verify` | `{ answers: string[3] }` | `{ ok, attemptsLeft }` | compare aux positions tirées par Rust ; ne répond que oui/non ; au 5ᵉ échec la phrase en attente est oubliée (`attemptsLeft: 0` : la réafficher depuis Réglages › Sécurité) |
| `vault_import` | `{ password, phrase, xmrRestore? }` | `void` | `xmrRestore` : début du premier scan Monero — `{ kind: 'kyro' }` (défaut, première version de Kyro), `{ kind: 'date', date }` ou `{ kind: 'genesis' }` (phrase déjà utilisée avec Monero sur un Ledger) ; gardé dans `monero/<réseau>-restore-<clé>.json` |
| `vault_unlock` | `{ password }` | `void` | 5 essais puis délai croissant ; chaque essai est **réservé** (compté) sous le même verrou que la vérification du délai, avant Argon2id (des appels parallèles ne contournent pas la limite), et le compteur + `retry_after` sont enregistrés à côté du coffre (`coffre-<réseau>.attempts`) : redémarrer l'app ne remet pas le délai à zéro. Même règle pour toute commande qui demande le mot de passe |
| `vault_lock` | — | `void` | zeroize de la session |
| `vault_reveal_mnemonic` | `{ password }` | `void` | mot de passe (limité comme ci-dessus, 10 s entre deux demandes), puis **confirmation native** (« Afficher » / « Annuler » → `USER_REJECTED`), puis les mots dans une **fenêtre native** ; rien n'est renvoyé à l'interface (qui connaît le mot de passe qu'elle a fait taper). Le blocage des captures d'écran ne s'applique pas à ces fenêtres système |
| `session_touch` | — | `void` | activité utilisateur → repousse l'auto-lock |
| `accounts_get` | `{ account? }` | `Accounts` | adresses publiques uniquement, du compte `account` (absent = 0) de chaque chaîne ; contient aussi `ltc`, `doge`, `bch` et `dash` (§2.4). Comptes multiples : §2.9 |
| `vault_accounts_get` / `vault_account_add` / `vault_account_rename` / `vault_account_remove` | voir §2.9 | `VaultAccountLists` | listes de comptes du coffre, par chaîne |
| `btc_address` | `{ kind, change, index, account? }` | `string` | `m/84'\|86'/coin'/account'/change/index` |
| `evm_decode_tx` | `{ tx: EvmTxRequest }` | `EvmTxSummary` | pour l'aperçu avant mot de passe ; `INVALID_INPUT` si le chainId est d'un réseau principal en mode test (ou Sepolia en mainnet) |
| `evm_sign_tx` | `{ tx, password, account? }` | `{ rawTx, hash }` | clé `m/44'/60'/0'/0/{account}` ; dialogue natif obligatoire (compte signataire et adresse « De » en tête, §2.9) ; symbole et décimales d'un token **uniquement** depuis la table Rust `known_tokens.rs` (réseau + chainId + contrat) — un `token` envoyé par une ancienne interface est ignoré ; token hors table : contrat + **unités brutes**, « JETON INCONNU », et 2ᵉ dialogue ; monnaie native nommée par chaîne (ETH, POL, BNB, AVAX) ; **2ᵉ dialogue renforcé** si `requiresExtraConfirmation` ou jeton inconnu : appel de contrat autre qu'un transfer ERC-20, **toute** autorisation (`approve` : bénéficiaire et montant, « ILLIMITÉ » si ≥ 2^128), valeur native envoyée avec un appel, chainId inconnu, frais maximum au-dessus du seuil (voir §1) ; chainId de l'autre famille de réseaux : refusé (`INVALID_INPUT`) |
| `btc_sign_psbt` | `{ psbt, password, account? }` | `{ psbt, summary }` | ne signe que les entrées du compte `account` (celles des autres comptes : `foreignInput`) ; dialogue natif obligatoire (résumé `btc_psbt_summary`, compte signataire en tête) ; **2ᵉ dialogue renforcé** si `summary.requiresExtraConfirmation` (script inconnu, OP_RETURN, entrée qui n'est pas à nous, frais > 100 sat/vB ou > total des sorties) ; le résumé de la signature doit être identique à celui affiché |
| `sol_decode_tx` | `{ message /*b64, message sérialisé sans signatures*/, account? }` | `SolTxSummary` | aperçu avant mot de passe ; décodé en Rust, tables d'adresses (v0) récupérées par Rust (`getAccountInfo`) — jamais fournies par l'UI ; session déverrouillée requise ; `requiresExtraConfirmation` est aussi mis quand une instruction reconnue utilise un compte **lu dans une table** (voir `sol_sign_tx`) |
| `sol_sign_tx` | `{ message /*b64*/, password, account? }` | `{ signature /*b64*/, summary: SolTxSummary }` | même décodage ; refuse si notre adresse n'est pas signataire ; dialogue natif construit depuis le résumé Rust, chaque adresse absente des clés statiques du message (donc fournie par la table du RPC) marquée « [lu dans une table d'adresses] », mint nommé par `known_tokens.rs` ou « jeton inconnu », mémo en dernier ; puis 2ᵉ dialogue « Instruction non reconnue — signer quand même ? » si `requiresExtraConfirmation` (qui inclut : un destinataire, une autorité, un compte token… venu d'une table, listés) ; la signature va à l'index `summary.ourSignerIndex`. Le staking (`sol_stake_*`) refuse tout compte venu d'une table |
| `net_fetch` | `{ req: { url, method, headers?, body? } }` | `{ status, body }` | allowlist + cache + rate-limit ; seuls `accept`, `content-type`, `0x-version` sont transmis, les clés API sont ajoutées par Rust. **Via Tor si `settings.tor.enabled` (défaut)** : attend le démarrage de Tor (60 s max) puis échoue en `TOR_UNAVAILABLE` — jamais de repli en clair. En mode Tor, `https://mempool.space/…` est servi de façon transparente par le service onion de mempool (même chemin, même réponse) ; l'UI continue d'appeler `https://mempool.space/…`. Toute URL `.onion` est refusée (`HOST_NOT_ALLOWED`) en mode clair |
| `tor_status` | — | `TorStatus` | état courant de Tor intégré |
| `tor_retry` | — | `TorStatus` | relance le démarrage depuis zéro (quel que soit l'état : utile après `error`) ; refusé (`INVALID_INPUT`) si Tor est désactivé |
| `settings_get` / `settings_set` | — / `{ settings: SettingsInput }` | `Settings` (sans secrets : `hasPassword` au lieu du mot de passe Core, `apiKeysSet` au lieu des clés API) | stocké dans le dossier de l'app (`settings.json`, 0600 sous Unix) ; passer `tor.enabled` de `true` à `false` coupe Tor après une **confirmation native** (« Désactiver Tor » / « Garder Tor » → `USER_REJECTED`), l'inverse le démarre ; chaque hôte de serveur personnalisé **nouveau** (ni enregistré, ni déjà autorisé dans cette session) est montré dans une **fenêtre native** (« Nouveau serveur » : usage, `schéma://hôte:port`) **avant toute requête** — refus = `USER_REJECTED`, rien n'est envoyé ni enregistré ; un nouveau chemin `.cookie` n'est accepté que s'il vient de `btc_core_pick_cookie` ; **`settings_set` est asynchrone** et vérifie ensuite en direct chaque serveur personnalisé modifié (voir §2.1) avant d'enregistrer — erreurs typées `SERVER_INVALID`, `SERVER_WRONG_NETWORK`, `SERVER_UNREACHABLE`, `TOR_UNAVAILABLE`, `USER_REJECTED`, rien n'est enregistré en cas d'échec ; si l'objet envoyé n'a pas de clé `servers`, les serveurs enregistrés sont conservés |
| `server_test` | `{ target: ServerTestTarget }` | `ServerTestResult` | teste un serveur **sans l'enregistrer** (mêmes vérifications que `settings_set`, y compris la fenêtre native « Nouveau serveur » avant toute requête et la règle du `.cookie`). Bitcoin Core `userpass` envoyé **sans** `password` : le mot de passe enregistré est réutilisé s'il s'agit du même emplacement (même réseau), de la même URL et du même utilisateur ; sinon `SERVER_INVALID` (mot de passe manquant) |
| `electrum_fetch_cert` | `{ host, port }` | `{ sha256, webpkiValid }` | empreinte SHA-256 du certificat TLS d'un serveur Electrum, pour la confirmation TOFU ; un hôte ni enregistré ni autorisé est d'abord confirmé en **fenêtre native** (son nom seul partirait au DNS / à un relais de sortie) ; la poignée de main est interrompue dès la réception du certificat (aucune donnée envoyée) |
| `btc_core_pick_cookie` | — | `{ path: string \| null }` | ouvre le **sélecteur de fichiers du système** (géré par Rust) pour choisir le `.cookie` de Bitcoin Core ; le fichier doit s'appeler exactement `.cookie`, ne pas être un lien symbolique, faire au plus 256 octets et contenir `__cookie__:<64 hex>` ; il devient le seul nouveau chemin accepté par `settings_set` / `server_test` ; `null` = annulé |
| `btc_backend_info` | — | `{ kind, network, label, tor }` | serveur Bitcoin actif : `kind` = `default` \| `esplora` \| `electrum` \| `core` \| `cbf`, `network` = `mainnet` \| `testnet4`, `label` = hôte (jamais d'identifiants) |
| `btc_address_info` | `{ address }` | forme Esplora `GET /address/{a}` | voir §2.2 |
| `btc_address_utxos` | `{ address }` | forme Esplora `GET /address/{a}/utxo` | voir §2.2 |
| `btc_address_txs` | `{ address }` | forme Esplora `GET /address/{a}/txs` | voir §2.2 (50 plus récentes au plus) |
| `btc_fee_rates` | — | forme mempool `GET /v1/fees/recommended` | sat/vB |
| `btc_tip_height` | — | `number` | |
| `btc_tx_hex` | `{ txid }` | `string` (transaction brute, hex) | transaction complète, par exemple le `non_witness_utxo` d'une entrée SegWit v0 pour un hardware wallet. Esplora/défaut `GET /tx/{txid}/hex` ; Electrum `blockchain.transaction.get` ; Core `gettransaction` (portefeuille de surveillance) puis `getrawtransaction` — hors portefeuille et sans `-txindex=1` : `INVALID_INPUT` explicite ; filtres compacts : transactions gardées des blocs synchronisés, sinon `INVALID_INPUT` explicite. **Toujours** : Rust vérifie que la réponse est une transaction dont le txid (double SHA-256 de la sérialisation sans témoin) = `txid`, sinon `SERVER_UNREACHABLE` ; `txid` mal formé : `INVALID_INPUT` |
| `btc_broadcast` | `{ hex }` | `string` (txid) | le txid renvoyé par le serveur doit correspondre à la transaction, sinon erreur |
| `ltc_*`, `doge_*`, `bch_*`, `dash_*` | voir §2.4 | | Litecoin, Dogecoin, Bitcoin Cash, Dash : mêmes formes Esplora que `btc_*`, signature avec dialogue natif |
| `ada_*` | voir §2.7 | | Cardano : transaction construite **par Rust** depuis les UTxO et les paramètres de protocole, chaque sortie détaillée (ADA, tokens, min-ADA) |
| `stellar_*` | voir §2.11 | | Stellar : transaction construite **par Rust** (séquence, frais bornés, limites de temps ; Payment ou CreateAccount), mémo mis en évidence, réserve, phrase réseau vérifiée |
| `xrp_*` | voir §2.6 | | XRP Ledger : paiement construit **par Rust** (Sequence, Fee, LastLedgerSequence), tag de destination mis en évidence, réserve |
| `sui_*` | voir §2.11 | | Sui : transfert de SUI construit **par Rust** (pièces de gaz, prix de référence, budget simulé, BCS), adresse complète dans le dialogue natif |
| `hbar_*` | voir §2.11 | | Hedera : CryptoTransfer construit **par Rust** (une copie par nœud, même identifiant), mémo mis en évidence, diffusion gRPC-web |
| `kas_*` | voir §2.11 | | Kaspa : transaction construite **par Rust** depuis les pièces du compte (20 adresses de réception + 20 de monnaie), masse KIP-9 et frais calculés, pièces relues avant signature |
| `dot_*` | voir §2.11 | | Polkadot Asset Hub : transfert `transfer_keep_alive` construit **par Rust** (métadonnées vérifiées, nonce, ère), dépôt existentiel, signature sr25519 |
| `algo_*` | voir §2.11 | | Algorand : paiement `pay` construit **par Rust** (frais, fenêtre de validité, genesis), msgpack canonique, solde minimum, close-remainder-to et rekey refusés |
| `xmr_*` | voir §2.11 | | Monero : blocs analysés **localement** par Rust (clé de vue en mémoire seulement), transfert construit **par Rust** (anneau de 16, CLSAG, Bulletproofs+, monero-wallet), dialogue natif |
| `ton_*` | voir §2.11 | | TON : transfert v4R2 construit **par Rust** (seqno, état des comptes, frais émulés), commentaire mis en évidence, les deux formes d'adresse |
| `cosmos_*` | voir §2.11 | | Cosmos Hub : MsgSend construit **par Rust** (account number, sequence, timeout height, gas simulé, prix du marché des frais), SignDoc décodé strictement, mémo encadré |
| `aptos_*` | voir §2.11 | | Aptos : transfert d'APT (`0x1::aptos_account::transfer`) construit **par Rust** (séquence, prix du gaz, gaz simulé, expiration), décodé strictement, re-simulé avant le dialogue natif |
| `tron_*` | voir §2.5 | | TRON : transaction construite **par Rust** depuis le dernier bloc, signature avec dialogue natif (ressources, TRX brûlés) |
| `sol_stake_*`, `ada_stake_*`, `tron_stake_*` | voir §2.8 | | Staking : Solana natif, délégation Cardano, TRON Stake 2.0 ; opérations construites **par Rust**, décodées et vérifiées en direct avant le dialogue natif |
| `btc_core_setup` | `{ rescanFrom: 'now' \| number /*horodatage UNIX en s*/ }` | `CoreStatus` (`state: 'importing'`) | Bitcoin Core uniquement, session déverrouillée. **Vérification préalable synchrone** (erreurs renvoyées par l'appel lui-même) : nœud joignable (`SERVER_UNREACHABLE`), authentification (`SERVER_INVALID`), bonne chaîne (`SERVER_WRONG_NETWORK`), portefeuille `kyro-watch-<empreinte8>` créé ou chargé et bien sans clé privée (`SERVER_INVALID`), checksums des descripteurs. Seul `importdescriptors` (et son rescan) tourne ensuite en arrière-plan. Aucun nœud Core configuré pour ce réseau : `INVALID_INPUT` |
| `btc_core_status` | — | `CoreStatus` | progression du rescan (`getwalletinfo.scanning`). L'état d'import est propre à **(réseau, URL, portefeuille)** : un autre nœud ou un autre réseau ne voit pas l'import d'un premier. Aucun nœud Core configuré : réponse normale `{ state: 'not-configured', wallet: '', walletLoaded: false }` (pas d'erreur) |
| `btc_cbf_status` | — | `CbfStatus` | mode filtres compacts (fonction `cbf`) ; build sans la fonction : `FEATURE_DISABLED` |
| `btc_cbf_sync` | — | `CbfStatus` | lance (ou rejoint) une synchronisation en arrière-plan ; progression par l'événement `cbf-status` ; exige le coffre déverrouillé (lit les xpubs) — une lecture coffre verrouillé ne lance pas de synchro ; build sans la fonction : `FEATURE_DISABLED` |
| `set_capture_protection` | `{ enabled }` | `void` | `set_content_protected` |
| `open_fees_page` | — | `void` | ouvre `https://kyrowallet.com/frais` (URL fixe en Rust) dans le navigateur du système ; aucun argument, aucune autre URL possible |
| `update_status` | — | `{ version: string, updatedTo: string \| null }` | version en cours ; `updatedTo` = la version installée par une **mise à jour automatique**, renvoyée **une seule fois** après le démarrage qui l'a appliquée (l'interface affiche « Kyro a été mis à jour en version X »). Le reste (vérification, téléchargement, signature, installation) est fait par Rust seul, sans commande : voir SECURITY.md « Mises à jour automatiques » |
| `config_get` | — | `{ network, hasCoingeckoKey, hasZeroxKey, hasTrongridKey, systemLanguage }` | `systemLanguage` : `'fr' \| 'en'`, la langue de l'ordinateur (ce que `settings.language = 'auto'` utilise) ; jamais les clés elles-mêmes ; chaque `hasXKey` = variable d'environnement **ou** clé enregistrée dans les réglages (ex. TronGrid : `KYRO_TRONGRID_API_KEY` ou `apiKeys.trongrid`) |
| `network_get` / `network_set` | — / `{ network: 'mainnet' \| 'testnet' }` | `NetworkInfo` / `boolean` | choix du réseau depuis l'application, appliqué en **redémarrant** l'app : voir §2.10 |
| `hw_list` | — | `DeviceInfo[]` | détecte les Ledger (HID) et Trezor (WebUSB) branchés ; ids stables pour la session (`ledger-1`, `trezor-1`…) tant que l'appareil reste sur le même port ; 10 s max. Voir §2.3 |
| `hw_open` | `{ id }` | `DeviceStatus` | ouvre l'appareil et lit son état : verrouillé, app Ledger ouverte, firmware Trezor, état par chaîne. **Seule commande qui peut appairer un Trezor Safe 7** (THP, §2.3) : `hw-prompt` `thp-confirm-pairing` puis `thp-pairing-code` → `hw_thp_pairing_code` ; délai 180 s |
| `hw_thp_pairing_code` | `{ id, code /*6 chiffres*/ }` | `void` | Trezor Safe 7, après `hw-prompt` `thp-pairing-code` : le code affiché **sur l'écran de l'appareil**, recopié par l'utilisateur. Autre chose que 6 chiffres ASCII : `INVALID_INPUT` (l'appel `hw_open` continue d'attendre) ; aucun appairage en attente : `HW_BAD_RESPONSE`. Code faux : `hw_open` échoue en `HW_PAIRING_FAILED` |
| `hw_thp_pairings` | — | `{ key /*hex, clé statique publique de l'appareil*/; model /*"T3W1"*/; added /*s UNIX*/ }[]` | appareils THP appairés avec cette installation (données publiques) |
| `hw_thp_forget` | `{ key? }` | `number` | session déverrouillée si un coffre existe. Oublie l'appairage d'un appareil (`key` de `hw_thp_pairings`), ou **tous** sans `key` (supprime aussi la clé THP de Kyro : nouvelle clé au prochain appairage). Ferme les connexions Trezor inactives. Côté appareil, Kyro reste connu jusqu'à sa réinitialisation |
| `hw_cancel` | `{ id }` | `boolean` | abandonne l'opération en cours sur `id` (`true` s'il y en avait une) ; elle se termine en `USER_REJECTED` |
| `hw_pin_matrix` | `{ id, positions /*"1"…"9"*/ }` | `void` | Trezor One uniquement, après l'événement `hw-prompt` `pin-matrix` : **positions** dans la grille 3×3 vierge, jamais le PIN ; disposition du pavé numérique Trezor : ligne du haut 7 8 9, milieu 4 5 6, bas 1 2 3 (case en haut à gauche = « 7 »), transmise telle quelle |
| `hw_get_xpub` | `{ id, chain: 'btc' \| 'evm' \| 'sol', account }` | `HwXpub` | lit les clés publiques sur l'appareil, sans rien afficher ni enregistrer |
| `hw_accounts_get` | — | `WatchOnlyAccount[]` | comptes hardware wallet enregistrés (lecture seule, clés publiques) ; `LOCKED` si un coffre existe et est verrouillé (les xpubs donnent toutes tes adresses) ; sans coffre (mode hardware wallet seul) : toujours lisible |
| `hw_account_add` | `{ id, chain, account, accountId?, label? }` | `WatchOnlyAccount` | lit les clés de `chain` sur l'appareil et les enregistre (nouveau compte, ou ajout à `accountId` : même marque, même numéro, même empreinte sinon `HW_WRONG_DEVICE`) |
| `hw_account_remove` | `{ accountId }` | `void` | |
| `hw_verify_address` | `{ id, accountId, chain, path }` | `{ address, path }` | **affiche l'adresse sur l'écran de l'appareil** ; avant, relit les clés de l'appareil (`HW_WRONG_DEVICE` si ce n'est pas le bon) ; l'adresse affichée doit être identique à celle que Kyro dérive de l'xpub enregistrée, sinon `HW_ADDRESS_MISMATCH` (erreur bloquante : ne pas utiliser l'adresse) |
| `hw_sign_btc_psbt` | `{ id, accountId, psbt }` | `{ psbt, summary }` | décodage Rust → dialogue natif Kyro (+ 2ᵉ dialogue si sortie inconnue) → confirmation sur l'appareil → vérification de chaque signature. PSBT signée, **non finalisée** |
| `hw_sign_evm_tx` | `{ id, accountId, tx: EvmTxRequest }` | `{ rawTx, hash }` | idem ; token nommé par un descripteur Ledger vérifié hors ligne, sinon par `known_tokens.rs`, jamais par l'interface ; 2ᵉ dialogue si appel de contrat, jeton inconnu ou si l'appareil ne peut pas afficher le détail (blind signing) ; signe pour l'adresse `m/44'/60'/0'/0/{account}` |
| `hw_sign_sol_tx` | `{ id, accountId, message /*b64*/ }` | `{ signature /*b64*/, summary: SolTxSummary }` | même décodage que `sol_sign_tx` ; signature vérifiée (ed25519 strict) contre l'adresse enregistrée |
| `hw_sign_utxo_psbt` | `{ id, accountId, chain: 'ltc' \| 'doge' \| 'bch' \| 'dash', psbt }` | `{ psbt, summary: UtxoTxSummary }` | `utxo_hw_plan` (même décodage que `…_sign_psbt`, avec la seule xpub enregistrée) → clés relues (`HW_WRONG_DEVICE`) → dialogue natif (+ renforcé) → appareil → `utxo_hw_finalize` (chaque signature vérifiée contre le sighash recalculé et la clé dérivée de l'xpub). Toutes les entrées doivent être du compte et porter `non_witness_utxo` (Litecoin aussi). Signatures partielles ; Bitcoin Cash : entrées finalisées (FORKID) |
| `hw_xrp_build_tx` | `{ accountId, to, amount, destinationTag?, issued? }` | comme `xrp_build_tx` | construit avec l'adresse et la clé du compte hardware wallet (pas de coffre nécessaire) |
| `hw_sign_xrp_tx` | `{ id, accountId, blob }` | comme `xrp_sign_tx` | mêmes vérifications que `xrp_sign_tx` → dialogue natif → **Ledger** (app « XRP ») → signature DER vérifiée (low-S) sur le hash de signature calculé par Kyro, attachée au blob de Kyro (`xrp_hw_assemble`) |
| `hw_xrp_broadcast` | `{ accountId, blob }` | `string` (hash) | comme `xrp_broadcast` |
| `hw_tron_build_tx` | `{ accountId, to, amount, token? }` | `TronBuilt` | comme `tron_build_tx`, adresse du compte hardware wallet |
| `hw_sign_tron_tx` | `{ id, accountId, raw }` | comme `tron_sign_tx` | **Ledger seulement** (app « Tron ») ; la signature doit redonner l'adresse du compte (`tron_recover_signer`) |
| `hw_tron_broadcast` | `{ accountId, raw, signature }` | `string` (txid) | comme `tron_broadcast` |
| `hw_stellar_build_tx` | `{ accountId, to, amount, memo? }` | comme `stellar_build_tx` | adresse du compte hardware wallet |
| `hw_sign_stellar_tx` | `{ id, accountId, envelope }` | comme `stellar_sign_tx` | Ledger (app « Stellar », sur la *signature base*) ou Trezor (`StellarSignTx` + opération, le firmware reconstruit l'XDR) ; signature ed25519 vérifiée strictement sur **le hash de Kyro** pour ce réseau, attachée à l'enveloppe de Kyro (`stellar_hw_assemble`) |
| `hw_stellar_broadcast` | `{ accountId, envelope }` | `string` (hash) | comme `stellar_broadcast` |
| `hw_key_add` | `{ id, chain: 'sui' \| 'apt' \| 'algo' \| 'near' \| 'cosmos', account, accountId?, label? }` | `WatchOnlyAccount` | **Ledger seulement** (§2.3, « Chaînes à clé unique ») : lit la clé publique de `chain` dans l'app Ledger correspondante et l'enregistre (`keys[]` du compte ; nouveau compte ou ajout à `accountId` : même marque, même numéro ; une autre clé déjà enregistrée pour cette chaîne : `HW_WRONG_DEVICE`) |
| `hw_key_verify` | `{ id, accountId, chain }` | `{ address, path }` | relit la clé (`HW_WRONG_DEVICE` si ce n'est pas la même), puis **l'affiche sur l'appareil** (adresse ; NEAR : clé `ed25519:…`) ; clé affichée ≠ clé enregistrée : `HW_ADDRESS_MISMATCH` |
| `hw_sui_build_tx` / `hw_sign_sui_tx` / `hw_sui_broadcast` | comme `sui_*` avec `accountId` au lieu de `account` ; signature : `{ id, accountId, bcs }` | comme `sui_*` | construction et diffusion pour l'adresse du compte hardware wallet ; signature : mêmes contrôles que `sui_sign_tx`, dialogue natif, app « Sui » (message d'intention `00 00 00 ‖ BCS`), signature sérialisée vérifiée (`sui_verify_signed`) |
| `hw_aptos_build_tx` / `hw_sign_aptos_tx` / `hw_aptos_broadcast` | idem (`{ id, accountId, raw }`) | comme `aptos_*` | app « Aptos » : message de signature `SHA3-256("APTOS::RawTransaction") ‖ BCS` ; transaction signée vérifiée (`aptos_verify_signed`) |
| `hw_algo_build_tx` / `hw_sign_algo_tx` / `hw_algo_broadcast` | idem (`{ id, accountId, blob }`) | comme `algo_*` | app « Algorand » : msgpack canonique (l'app préfixe `TX`) ; vérifiée (`algo_verify_signed`) |
| `hw_near_build_tx` / `hw_sign_near_tx` / `hw_near_broadcast` / `hw_near_tx_status` | idem (`{ id, accountId, tx }`) | comme `near_*` | app « NEAR » : Borsh de la transaction (l'app signe son SHA-256) ; vérifiée (`near_verify_signed`). Compte implicite de la clé `m/44'/397'/0'/0'/(account+1)'` |
| `hw_cosmos_build_tx` / `hw_sign_cosmos_tx` / `hw_cosmos_broadcast` | idem (`{ id, accountId, signDoc }`) | comme `cosmos_*` | app « Cosmos » : SignDoc en mode **LEGACY_AMINO_JSON** (l'app ne signe pas DIRECT) ; l'appareil signe le JSON amino canonique (clés triées, entiers en chaînes) ; signature DER normalisée low-S et vérifiée, TxRaw revérifié avant diffusion |

```ts
type Accounts = {                 // accounts_get({ account? }) : tout est celui du compte `account` (0 = l'historique)
  network: 'mainnet' | 'testnet';
  account: number;
  // evm, sol, tron, xrp, cardano, stellar, sui, hbar, cosmos : { address, path } (hbar : adresse EVM de m/44'/3030'/0'/0/a) (path = chemin de la clé, ex. m/44'/60'/0'/0/1)
  btc: { segwit: { address: string; xpub: string; fingerprint: string; path: string };
         taproot: { address: string; xpub: string; fingerprint: string; path: string } };
  evm: { address: string };
  sol: { address: string };
  ltc: { address: string; xpub: string; fingerprint: string; path: string };   // m/84'/2'/0' (testnet m/84'/1'/0'), address = …/0/0
  doge: { address: string; xpub: string; fingerprint: string; path: string };  // m/44'/3'/0' (testnet m/44'/1'/0')
  bch: { address: string; xpub: string; fingerprint: string; path: string };   // m/44'/145'/0' (chipnet m/44'/1'/0'), CashAddr bitcoincash:q… / bchtest:q…
  dash: { address: string; xpub: string; fingerprint: string; path: string };  // m/44'/5'/0' (testnet m/44'/1'/0'), X… / y…
  tron: { address: string };                                                    // m/44'/195'/0'/0/0 (même chemin sur Nile)
  xrp: { address: string };                                                     // m/44'/144'/0'/0/0
  stellar: { address: string };                                                 // m/44'/148'/0' (SEP-0005, même clé sur testnet), G…
  cardano: { address: string };   // adresse de base m/1852'/1815'/0'/0/0 + staking …/2/0 (CIP-1852, Icarus) ; addr_test1… sur preprod
  sui: { address: string };       // m/44'/784'/0'/0'/0' (SLIP-10 ed25519, même chemin sur testnet), 0x + 64 hex (§2.11)
  algo: { address: string };      // m/44'/283'/0'/0/0 (dérivation de l'app Algorand de Ledger, même chemin sur testnet), 58 caractères
  ton: { address: string };       // v4R2 de m/44'/607'/0', UQ… (testnet 0Q…, autre wallet id donc autre adresse)
  cosmos: { address: string };    // m/44'/118'/0'/0/0, cosmos1… (même chemin sur le testnet)
};
type ApiKeyName = 'coingecko' | 'zerox' | 'trongrid';   // toutes les clés que Settings connaît (1inch retiré : une ancienne clé est ignorée puis effacée)
// coingecko : en-tête x-cg-demo-api-key / x-cg-pro-api-key (api / pro-api.coingecko.com) ; zerox : 0x-api-key (api.0x.org) ;
// trongrid : TRON-PRO-API-KEY (api.trongrid.io, nile.trongrid.io, §2.5).
// (LI.FI et Jupiter : variables d'environnement seulement, pas de clé dans Settings.)
type Settings = { currency: Currency /* FIAT_CURRENCIES (26 devises CoinGecko), défaut au 1er lancement = région de la locale du système (fiat.rs), jamais l'IP */; autoLockSecs: number; hideBalancesOnStart: boolean;   // ce que RENVOIENT settings_get / settings_set
                  captureProtection: boolean; clipboardGuard: boolean;
                  servers: Servers;               // remplace l'ancien `rpc` (encore accepté en entrée, migré, jamais renvoyé)
                  apiKeysSet: { [K in ApiKeyName]: boolean };   // clé enregistrée ou non ; JAMAIS la valeur (pas de champ `apiKeys`)
                  tor: { enabled: boolean };     // défaut : { enabled: true }
                  language: 'auto' | 'fr' | 'en';   // défaut : 'auto' (voir ci-dessous)
                  autoUpdate: boolean };   // défaut : true ; false = aucune vérification, une mise à jour en attente est supprimée
// `language` : langue de l'interface ET des fenêtres natives (signature, avertissements, phrase,
// serveurs, sélecteur de .cookie). `auto` = langue de l'ordinateur (français si elle est française,
// anglais sinon), lue par Rust (crate `sys-locale`) et renvoyée par `config_get.systemLanguage`.
// Toute autre valeur dans settings_set → INVALID_INPUT ; dans un settings.json existant, une valeur
// inconnue est lue comme `auto` (les autres réglages sont gardés). Appliquée dès l'enregistrement :
// l'interface se ré-affiche, la prochaine fenêtre native utilise la nouvelle langue.
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
  bitcoincash: { mainnet?: UtxoServer; testnet?: UtxoServer };   // testnet = chipnet
  dash: { mainnet?: UtxoServer; testnet?: UtxoServer };
  tron: { mainnet?: TronServer; testnet?: TronServer };       // testnet = Nile
  xrp: { mainnet?: XrpServer; testnet?: XrpServer };          // testnet = XRPL Testnet
  cardano: { mainnet?: CardanoServer; testnet?: CardanoServer };  // testnet = preprod
};
type UtxoServer = { kind: 'default' }       // Litecoin : litecoinspace.org ; Dogecoin / Dash mainnet : ElectrumX de Komodo ; Bitcoin Cash mainnet et chipnet : Fulcrum publics ; Dogecoin / Dash testnet : AUCUN (lectures → SERVER_INVALID, voir §2.4)
                | { kind: 'esplora'; url: string };   // même type que le serveur par défaut (Esplora : electrs, mempool)
type BtcServer =
  | { kind: 'default' }                                   // mempool.space (son .onion en mode Tor)
  | { kind: 'esplora'; url: string }                      // ex. "https://mon-noeud.example/api"
  | { kind: 'electrum'; host: string; port: number;
      tls: 'webpki' | 'pinned' | 'none'; certSha256?: string /*64 hex, requis si 'pinned'*/ }
  | { kind: 'core'; url: string;                          // ex. "http://127.0.0.1:48332"
      auth: { kind: 'cookie'; cookiePath: string /*chemin absolu de « .cookie », choisi par btc_core_pick_cookie ; nœud local/LAN seulement*/ }
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
  | { family: 'litecoin' | 'dogecoin' | 'bitcoincash' | 'dash'; network: 'mainnet' | 'testnet'; server: UtxoServer }   // { kind: 'default' } Dogecoin / Dash testnet : SERVER_INVALID
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

Erreurs : rejet de la promesse avec `{ code: 'WRONG_PASSWORD' | 'LOCKED' | 'RATE_LIMITED' | 'USER_REJECTED' | 'HOST_NOT_ALLOWED' | 'INVALID_INPUT' | 'INTERNAL' | 'TOR_UNAVAILABLE' | 'SERVER_INVALID' | 'SERVER_WRONG_NETWORK' | 'SERVER_UNREACHABLE' | 'DEFAULT_SERVER_DISABLED' | 'FEATURE_DISABLED' | 'HW_NOT_FOUND' | 'HW_LOCKED' | 'HW_WRONG_APP' | 'HW_REJECTED' | 'HW_DISCONNECTED' | 'HW_UNSUPPORTED' | 'HW_PAIRING_REQUIRED' | 'HW_PAIRING_FAILED' | 'HW_BUSY' | 'HW_TIMEOUT' | 'HW_BAD_RESPONSE' | 'HW_ADDRESS_MISMATCH' | 'HW_WRONG_DEVICE', message, data? }`. `data` n'existe que pour `HW_WRONG_APP` (`{ expected, open }`), `HW_UNSUPPORTED` (`{ min: string | null }`) et `HW_ADDRESS_MISMATCH` (`{ device, expected }`) ; les codes hardware wallet sont détaillés au §2.3. `TOR_UNAVAILABLE` : Tor activé mais pas prêt (démarrage trop long, échec, arrêté) — la requête n'a **pas** été envoyée. `message` : texte pour l'utilisateur dans la langue de `settings.language` (la même que les fenêtres natives) ; le début du message (« Entrée invalide : » / « Invalid input: »…) est toujours traduit, un détail libre sans version anglaise reste en français. L'UI décide sur `code` ; quand une erreur n'a plus que son message, elle reconnaît les préfixes dans les deux langues (`isTorUnavailable`, `isCustomServerDown`).

- `SERVER_INVALID` : configuration refusée avant tout réseau (URL, schéma, identifiants dans l'URL, `.onion` sans Tor, empreinte mal formée, mot de passe manquant, fichier `.cookie` refusé — nom autre que `.cookie`, nœud non local, lien symbolique, contenu invalide, chemin non choisi par le sélecteur ; le message ne contient jamais le chemin ni l'erreur système —, authentification RPC refusée, portefeuille `kyro-watch-…` absent).
- `USER_REJECTED` (réglages) : fenêtre native « Nouveau serveur » ou « Désactiver Tor ? » refusée ; rien n'a été envoyé.
- `SERVER_WRONG_NETWORK` : le serveur répond mais n'est pas sur la bonne chaîne (genesis Bitcoin, `getblockchaininfo.chain`, `eth_chainId`, `getGenesisHash`, `network_id` XRPL, bloc 0 TRON, `networkmagic` Cardano).
- `SERVER_UNREACHABLE` : le serveur personnalisé ne répond pas (connexion, TLS, épinglage non concordant, délai, réponse invalide). **Kyro ne se rabat jamais sur le serveur par défaut.**
- `FEATURE_DISABLED` : fonction absente de ce build (aujourd'hui : filtres compacts `cbf`, désactivés par défaut jusqu'à revue).
- `DEFAULT_SERVER_DISABLED` : requête vers le serveur par défaut d'une chaîne pour laquelle un serveur personnalisé est configuré (signe que l'UI n'utilise pas encore le bon serveur).

### 2.1 Vérifications des serveurs (à l'enregistrement et dans `server_test`)

| Type | Règles d'URL | Vérification en direct |
|---|---|---|
| Esplora | `https://` ; `http://` uniquement pour un `.onion`, via Tor ; jamais d'identifiants dans l'URL | `GET {url}/block-height/0` = genesis du réseau (mainnet `000000000019d6…e26f`, testnet4 `00000000da84f2…f043`) |
| Electrum | `host` + `port` ; `tls: 'none'` uniquement pour un `.onion` via Tor ; `pinned` exige `certSha256` | `server.version` (protocole 1.4) puis `server.features.genesis_hash` = genesis du réseau |
| Bitcoin Core | `http://` uniquement pour une adresse locale/LAN (127.0.0.0/8, ::1, RFC 1918, fc00::/7, fe80::/10, `localhost`) ; sinon `https://` ou `.onion` via Tor ; **authentification `.cookie` seulement vers une adresse locale/LAN** (jamais un nœud distant ni un `.onion` : utiliser `userpass`) | `getblockchaininfo.chain` = `main` ou `testnet4` |
| XRP (`jsonRpc`) | comme Esplora | `server_info` → `info.network_id` = 0 (mainnet) ou 1 (testnet) ; devnet (2) et autres réseaux nommés dans l'erreur. `server_test` renvoie ce `network_id` dans `detected.chainId` (et `detected.blockHeight` = dernier registre validé) |
| Cardano (`koios`) | comme Esplora | `GET {url}/genesis` → `networkmagic` = 764824073 (mainnet) ou 1 (preprod) ; preview (2) et autres nommés dans l'erreur. `server_test` renvoie ce `networkmagic` dans `detected.chainId`. `detected.chainId` = `networkmagic`, `detected.blockHeight` = `GET {url}/tip` |
| TRON (`http`) | comme Esplora | `POST {url}/wallet/getblockbynum {num:0}` → `blockID` = mainnet `00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc` ou Nile `0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc` ; Shasta (`…de1aa882…a9059e`) est reconnu et nommé dans l'erreur |
| Esplora Litecoin / Dogecoin | comme Esplora | `GET {url}/block-height/0` = genesis de la chaîne (Litecoin mainnet `12a765e3…04bfe2`, testnet4 `4966625a…3e29a0` ; Dogecoin mainnet `1a91e3da…355691`, testnet `bb0a7826…50559e`) ; le message nomme la chaîne trouvée si c'en est une connue |
| EVM | comme Esplora | `eth_chainId` = la clé (`chainId`) |
| Solana | comme Esplora ; clé `devnet` ou `mainnet-beta` | `getGenesisHash` = devnet `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`, mainnet-beta `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` |

Avant toute vérification, chaque hôte nouveau est confirmé dans une fenêtre native (voir `settings_set`). Si Tor est activé, les vérifications passent par Tor (un nœud Core local, lui, est joint directement). Changer `tor.enabled` et un serveur dans le même `settings_set` : la vérification utilise le nouveau mode, mais Tor ne démarre qu'après l'enregistrement — faire les deux changements séparément.

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
type Chain = 'btc' | 'evm' | 'sol' | 'ltc' | 'doge' | 'bch' | 'dash' | 'xrp' | 'tron' | 'stellar'
  | 'sui' | 'apt' | 'algo' | 'near' | 'cosmos'      // Ledger seulement, commandes hw_key_* (voir plus bas)
  | 'cardano' | 'zec'                                // HW_UNSUPPORTED
  | 'dot' | 'hbar' | 'kas' | 'ton';                 // pas de hardware wallet (raison dans `reason`)
type DeviceStatus = { id: string; kind: 'ledger' | 'trezor'; model: string; locked: boolean;
  app?: { name: string; version: string };        // Ledger : app ouverte ("Tableau de bord" = dashboard)
  firmware?: string; passphrase?: boolean;        // Trezor
  protocol?: 'thp';                               // Trezor Safe 7 : canal THP chiffré et appairé
  chains: { chain: Chain; state: 'ready' | 'open-app' | 'unlock' | 'unsupported';
            app?: string /*app Ledger à ouvrir*/; min?: string /*version minimale*/; reason?: string }[] };
type HwXpub = { chain: Chain; account: number;
  btc?: { kind: 'segwit' | 'taproot'; xpub: string; fingerprint: string; path: string }[];   // BIP84 + BIP86
  evm?: { xpub: string /*nœud m/44'/60'/0'/0*/; path: string; address: string /*…/0/{account}*/ };
  sol?: { address: string; path: string /*m/44'/501'/{account}'/0'*/ };
  utxo?: UtxoKey;   // ltc, doge, bch, dash
  key?: ChainKey };  // xrp, tron, stellar
type UtxoKey = { coin: 'litecoin' | 'dogecoin' | 'bitcoincash' | 'dash'; xpub: string /*xpub/tpub standard*/;
  fingerprint: string; path: string /*m/84'/2'/a', m/44'/3'/a', m/44'/145'/a', m/44'/5'/a' ; testnet …/1'/a'*/ };
type ChainKey = { address: string; pubkey: string /*hex : XRP 33 o, TRON 65 o, Stellar 32 o*/;
  path: string /*m/44'/144'/a'/0/0, m/44'/195'/a'/0/0, m/44'/148'/a'*/ };
type WatchOnlyAccount = { id: string; label: string; device: 'ledger' | 'trezor'; model: string;
  network: 'mainnet' | 'testnet'; account: number; btc?: HwXpub['btc']; evm?: { xpub: string; path: string };
  sol?: { address: string; path: string };
  utxo?: UtxoKey[];   // une par chaîne, même empreinte maître que btc
  xrp?: ChainKey; tron?: ChainKey; stellar?: ChainKey;   // adresse = celle de la clé, chemin standard (vérifiés au chargement)
  keys?: { chain: 'sui' | 'apt' | 'algo' | 'near' | 'cosmos'; pubkey: string /*hex*/; address: string; path: string }[] };
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
| Litecoin, Dogecoin, Bitcoin Cash, Dash | « Litecoin », « Dogecoin », « Bitcoin Cash », « Dash » ≥ 1.4.0 (ancien protocole Bitcoin, trusted inputs) ; **mainnet seulement** (pas d'app Ledger de test) | One ≥ 1.10.4 ; T/Safe ≥ 2.4.3 (`Capability_Bitcoin_like`) ; pas de Dogecoin testnet |
| XRP | « XRP » ≥ 2.0.0 (secp256k1) | **non** : le firmware ne donne pas la clé publique avant la signature |
| TRON | « Tron » ≥ 0.5.0 (TRC-20 : réglages de l'app selon le jeton) | **non** (absent du firmware Trezor) |
| Stellar | « Stellar » ≥ 5.0.0 (`6C66` : « Hash signing » désactivé → `HW_UNSUPPORTED`) | One ≥ 1.10.4 ; T/Safe ≥ 2.4.3 |
| Cardano, Zcash | non proposés (`HW_UNSUPPORTED`) | non proposés |
| Sui | « Sui » ≥ 1.0.0, `m/44'/784'/a'/0'/0'` (= coffre) | pas d'app Trezor |
| Aptos | « Aptos » ≥ 0.6.0, `m/44'/637'/a'/0'/0'` (= coffre) | pas d'app Trezor |
| Algorand | « Algorand » ≥ 2.0.0 (Zondax), `m/44'/283'/a'/0/0` (= coffre) | pas d'app Trezor |
| NEAR | « NEAR » ≥ 2.0.0, **`m/44'/397'/0'/0'/(a+1)'`** (chemin de Ledger Live : l'app n'accepte que 5 niveaux ; le coffre utilise `m/44'/397'/a'` → autre compte implicite) | pas d'app Trezor |
| Cosmos Hub | « Cosmos » ≥ 2.34.0, `m/44'/118'/a'/0/0` (= coffre), amino JSON | pas d'app Trezor |
| Polkadot, Hedera, Kaspa, TON | non proposés (raisons ci-dessous) | pas d'app Trezor |
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
| `HW_UNSUPPORTED` | chaîne non proposée sur cet appareil (Cardano, Zcash ; XRP / TRON sur Trezor ; LTC / DOGE / BCH / DASH sur Ledger en testnet), firmware/app trop ancien, « Hash signing » désactivé (app Stellar `6C66`), blind signing désactivé (Ledger `6A80` en signature EVM, `6808` Solana), passphrase Trezor One, entrées mixtes Ledger ; Safe 7 : version THP ≠ 2.x, appairage par code non proposé | `{ min }` |
| `HW_BUSY` | autre opération en cours sur cet appareil ; interface USB prise par une autre application (Trezor Suite, Ledger Live) ; Linux sans règles udev | |
| `HW_TIMEOUT` | pas de réponse dans le délai : opération abandonnée | |
| `HW_BAD_RESPONSE` | réponse mal formée, ou signature/adresse/clé qui ne passe pas la vérification de Kyro | |
| `HW_ADDRESS_MISMATCH` | l'adresse affichée par l'appareil ≠ celle dérivée par Kyro de l'xpub enregistrée : **ne pas utiliser l'adresse** | `{ device, expected }` |
| `HW_WRONG_DEVICE` | les clés de l'appareil ne sont pas celles du compte (autre appareil, autre passphrase, compte enregistré modifié) | |
| `HW_PAIRING_REQUIRED` | Trezor Safe 7 pas (ou plus) appairé avec Kyro, et la commande n'est pas `hw_open` : appairer d'abord par `hw_open` | |
| `HW_PAIRING_FAILED` | appairage THP échoué : code incorrect (refusé par l'appareil), ou l'appareil n'a pas prouvé le code (engagement/secret incohérents) ; rien n'est enregistré | |
| `INTERNAL` | (hardware wallet) fichier `trezor-thp.json` illisible ou non inscriptible, aléa du système indisponible ; `hw_thp_forget {}` remet le fichier à zéro | |
| `USER_REJECTED` | refus dans le dialogue natif de Kyro, ou `hw_cancel` | |

**Litecoin, Dogecoin, Bitcoin Cash, Dash, XRP, TRON, Stellar** (`hw/chains.rs`, `hw/ledger_utxo.rs`, `hw/ledger_coins.rs`, `hw/trezor_coins.rs`, `commands_hw_coins.rs`). `hw_get_xpub` / `hw_account_add` / `hw_verify_address` acceptent ces chaînes ; la signature passe par les commandes `hw_sign_utxo_psbt`, `hw_sign_xrp_tx`, `hw_sign_tron_tx`, `hw_sign_stellar_tx` ci-dessus, et la construction / diffusion par `hw_*_build_tx` / `hw_*_broadcast` (un utilisateur « hardware wallet seul » n'a pas de coffre). Mêmes étapes que pour Bitcoin : décodage Rust, clés de l'appareil relues et comparées au compte, dialogue natif (+ renforcé), écran de l'appareil, vérification de la signature dans wallet-core.
- **Ledger, LTC / DOGE / BCH / DASH** : apps bâties sur `lib-app-bitcoin` = **ancien protocole Bitcoin** (`doc/btc.asc` de ledger-app-btc, `@ledgerhq/hw-app-btc`) : `GET WALLET PUBLIC KEY` (`E0 40`, format d'adresse P2 `00` legacy, `02` bech32, `03` CashAddr ; l'xpub est reconstruite à partir de la clé maître — empreinte —, du parent et du nœud de compte), `GET TRUSTED INPUT` (`E0 42`, chaque transaction précédente transmise élément par élément, scripts par blocs de 50 octets ; l'app rend une *trusted input* de 56 octets qui prouve le montant), `UNTRUSTED HASH TRANSACTION INPUT START` (`E0 44`, P2 `02` Litecoin, `03` Bitcoin Cash, `00` Dogecoin / Dash, `80` pour continuer), `FINALIZE FULL` (`E0 4A`, chemin de la monnaie d'abord avec P1 `FF`, puis les sorties que l'utilisateur vérifie à l'écran), `UNTRUSTED HASH SIGN` (`E0 48`, `SIGHASH_ALL`, Bitcoin Cash `ALL|FORKID`). Flux BIP143 (Litecoin, Bitcoin Cash) : toutes les entrées une fois, les sorties une fois, puis une pseudo-transaction par entrée ; flux legacy (Dogecoin, Dash) : la transaction entière pour chaque entrée, script sur l'entrée signée seulement. Réseau principal uniquement.
- **Trezor, LTC / DOGE / BCH / DASH** : `GetPublicKey` (xpub reconstruite depuis `node`, version standard), `GetAddress`, `SignTx` / `TxRequest` comme Bitcoin avec `coin_name` « Litecoin » / « Dogecoin » / « Bcash » / « Dash » (testnet : « Litecoin Testnet », « Bcash Testnet », « Dash Testnet »), `SPENDWITNESS` (Litecoin) ou `SPENDADDRESS` ; transactions précédentes depuis la PSBT, txid recalculé.
- **Ledger XRP / Stellar / Tron** (`hw-app-xrp`, `hw-app-str`, `hw-app-trx`) : clé lue avec `E0 02` (XRP et Tron renvoient aussi l'adresse, qui doit être celle de la clé), signature `E0 04` : XRP = transaction binaire non signée en blocs de 150 octets ; Stellar = *signature base* (`networkId ‖ ENVELOPE_TYPE_TX ‖ XDR`) en blocs de 255 ; Tron = `raw_data` découpé entre champs protobuf (≤ 250 octets par APDU, P1 `10` / `00` / `80` / `90`).
- **Trezor Stellar** : `StellarGetAddress`, puis `StellarSignTx` + l'opération (paiement XLM ou création de compte) ; le firmware reconstruit l'XDR lui-même : si sa reconstruction différait de celle de Kyro, la signature ne se vérifierait pas sur le hash de Kyro (`HW_BAD_RESPONSE`).
- **Non proposés** : XRP sur Trezor (le firmware ne livre que l'adresse, pas la clé publique dont Kyro a besoin pour construire et vérifier le Payment) ; TRON sur Trezor (absent du firmware) ; **Cardano** (protocole de signature en plusieurs étapes, Ledger « Cardano ADA » comme Trezor `CardanoSignTx*` : pas écrit, faute de pouvoir le valider sans appareil) ; **Zcash** (transactions v5 / ZIP 244 : l'app Ledger Zcash et Trezor exigent les parties blindées des transactions précédentes, non fait).

**Chaînes à clé unique (Ledger seulement)** — `hw/ledger_apps.rs` (commun), un module par app officielle : `hw/ledger_sui.rs` (protocole par blocs de l'app Sui : paramètres découpés en blocs de 180 octets chaînés par SHA-256, `GET_CHUNK` / `PUT_CHUNK` / `RESULT_*`), `hw/ledger_aptos.rs` (CLA 5B), `hw/ledger_algo.rs` (CLA 80, numéro de compte), `hw/ledger_near.rs` (CLA 80, chemin à 5 niveaux sans longueur), `hw/ledger_cosmos.rs` (CLA 55, chemin little-endian). Le compte enregistre une clé publique par chaîne (`WatchOnlyAccount.keys`, `wallet_core::WatchKey` : l'adresse est recalculée depuis la clé, le chemin depuis le numéro de compte). Déroulé d'un envoi : `hw_<chaîne>_build_tx` (construction pour l'adresse enregistrée, comme le coffre) → `hw_sign_<chaîne>_tx` : (1) relecture de la clé sur l'appareil = clé enregistrée (`HW_WRONG_DEVICE`) ; (2) mêmes contrôles en direct que la commande du coffre ; (3) dialogue natif (résumé décodé par Rust + « vérifie sur l'appareil »), 2ᵉ dialogue renforcé selon les mêmes déclencheurs ; (4) l'appareil affiche et signe les octets construits par `wallet-core` ; (5) Rust vérifie la signature (ed25519 strict / ECDSA low-S) et assemble la transaction → `hw_<chaîne>_broadcast` (revérifiée). Aucune clé privée côté hôte, aucune crypto écrite à la main.

**Non proposés sur hardware wallet** : **Polkadot** — l'app générique « Polkadot » exige l'extension `CheckMetadataHash` avec une preuve des métadonnées (RFC-0078) jointe à chaque transaction, et des clés ed25519 `m/44'/354'/…` (Kyro : sr25519 Polkadot.js, sans preuve) ; **Hedera** — l'app Ledger signe en ed25519 `m/44'/3030'/0'/0'/i'`, Kyro ne gère que les comptes ECDSA secp256k1 (création automatique par l'alias EVM) ; **Kaspa** — protocole de signature de l'app non vérifié contre les règles en vigueur depuis Toccata (rusty-kaspa 2.1) ; **TON** — l'app reconstruit elle-même le message (requête structurée, chemin à 6 niveaux, identifiant de portefeuille standard : incompatible avec l'identifiant testnet de Kyro), pas encore écrit. `hw_open` les rapporte `unsupported` avec cette raison ; Trezor n'a d'app pour aucune de ces neuf chaînes.

### 2.4 Litecoin, Dogecoin, Bitcoin Cash et Dash

Mêmes principes que Bitcoin (§2.2) : Rust choisit le serveur (`servers.litecoin` / `servers.dogecoin` / `servers.bitcoincash` / `servers.dash`, sinon le défaut), passe par les circuits Tor de la famille de la chaîne, ne se rabat jamais ; les lectures renvoient **exactement les formes Esplora** de §2.2. Adaptateurs TS : `LitecoinAdapter`, `DogecoinAdapter`, `BitcoinCashAdapter`, `DashAdapter` (`packages/chains/src/litecoin/`, `dogecoin/`, `bitcoincash/`, `dash/`), créés par `createUtxoAdapters(accounts)`. Bitcoin Cash : adresses CashAddr (codec TS `@kyro/shared` `cashaddr.ts`, miroir de Rust, mêmes vecteurs de la spec), sorties ajoutées par script.

| Commande (`ltc_…` / `doge_…` / `bch_…` / `dash_…`) | Arguments | Retour | Notes |
|---|---|---|---|
| `…_backend_info` | — | `{ kind: 'default' \| 'esplora', network: 'mainnet' \| 'testnet', label, available, tor }` | `kind` = le réglage (`default` même quand le défaut Dogecoin mainnet parle Electrum) ; `label` = hôte (Dogecoin mainnet par défaut : `doge.electrum1.cipig.net`) ; `available: false` = Dogecoin **testnet** sans serveur configuré |
| `…_address` | `{ change, index, account? }` | `string` | coffre déverrouillé ; `m/84'/2'/account'/…` (LTC), `m/44'/3'/account'/…` (DOGE) |
| `…_address_info` / `…_address_utxos` / `…_address_txs` | `{ address }` | formes Esplora (§2.2) | adresse validée par Rust pour la chaîne et le réseau avant toute requête ; `txs` : 50 au plus, non confirmées d'abord. **Défaut Dogecoin mainnet (ElectrumX)** : `get_balance` + `get_history` (`funded_txo_sum`/`spent_txo_sum` portent le solde net, comme Electrum Bitcoin) ; `listunspent` puis **chaque UTXO confronté à sa transaction précédente** (`transaction.get`, hash recalculé ; la sortie doit exister, payer notre script et valoir exactement le montant annoncé, sinon `SERVER_UNREACHABLE` pour toute la liste ; 1 000 pièces au plus) ; historique : `get_history` + `transaction.get` des transactions et de leurs entrées + `block.header`, toute transaction qui ne touche pas l'adresse est écartée. Types stricts : txid 64 hex, montants entiers en koinus, `tx_pos` u32 |
| `…_tx_hex` | `{ txid }` | `string` | `GET /tx/{txid}/hex` (Electrum : `blockchain.transaction.get`), vérifié : txid recalculé = `txid` (et pas de témoin pour Dogecoin), sinon `SERVER_UNREACHABLE` |
| `…_fee_rates` | — | `{ fastestFee, halfHourFee, hourFee, economyFee, minimumFee, source? }` | unité minimale **par vbyte** (litoshis/vB ; koinus/octet). `/v1/fees/recommended` puis `/fee-estimates`. Dogecoin : bornes [0,01 ; 1] DOGE/kB (1 000–100 000 koinus/o) ; serveur sans estimation (404) → 0,01 DOGE/kB, `source: 'policy'`. Electrum (Dogecoin mainnet) : `estimatefee` à 2 / 30 / 60 / 144 blocs (≈ 2 min / ½ h / 1 h / 1 j) + `relayfee`, mêmes bornes ; aucune estimation → `source: 'policy'` |
| `…_tip_height` | — | `number` | |
| `…_broadcast` | `{ hex }` | `string` (txid) | transaction décodée d'abord ; txid du serveur = le nôtre, sinon erreur (Electrum : `blockchain.transaction.broadcast`) |
| `…_sign_psbt` | `{ psbt, password, account? }` | `{ psbt /*signée, non finalisée — finalisée pour Bitcoin Cash*/, summary: UtxoTxSummary }` | mot de passe → `utxo_psbt_summary` → dialogue natif (destinataires, montants, monnaie, frais, taux, taille ; « Pas de monnaie… » si aucune ; entrées étrangères) → **2ᵉ dialogue renforcé** si `requiresExtraConfirmation` (sortie inconnue « INCONNUE », OP_RETURN, entrée étrangère, poussière douce DOGE, frais très élevés) → signature ; le résumé de la signature doit être identique à celui affiché |

Règles de construction (TS) vérifiées par Rust :
- **Litecoin** : chaque entrée a `witness_utxo` + `bip32_derivation` (`m/84'/2'|1'/0'/…`) ; la monnaie porte sa dérivation (sinon elle s'affiche comme un destinataire) ; poussière = `GetDustThreshold` de Litecoin Core à 30 000 lit/kvB (P2WPKH 2 940 litoshis, P2PKH 5 460) : destinataire en dessous refusé, monnaie en dessous ajoutée aux frais ; minimum 1 litoshi/vB.
- **Dogecoin** : chaque entrée a **`non_witness_utxo`** (transaction précédente complète, `doge_tx_hex`) — c'est ce qui prouve les montants, que le sighash legacy n'engage pas — et **pas** de `witness_utxo` ; frais par taille (0,01 DOGE/kB recommandé = minimum de Kyro ; relais 0,001 DOGE/kB) ; aucune sortie sous 0,01 DOGE (poussière douce : chaque sortie en dessous coûte 0,01 DOGE de frais en plus ; sous 0,001 DOGE, non standard → Rust refuse).
- Taille (identique TS/Rust, signature la plus longue) : P2WPKH 10,5 + 68 par entrée + sorties (31 P2WPKH) vB ; P2PKH 10 + 148 par entrée + 34 par sortie octets.
- **Serveur par défaut Dogecoin** : mainnet → ElectrumX publics de Komodo (`doge.electrum1.cipig.net:20060`, secours `doge.electrum2.cipig.net:20060`, allowlist `net::ELECTRUM_HOSTS`, TLS validé, genesis vérifié à chaque session, circuits Tor `dogecoin`) ; **testnet → aucun** : `{ kind: 'default' }` → toute lecture `SERVER_INVALID` (« configure ton serveur Esplora (electrs-dogecoin) »). Voir NETWORK.md.
- **Avant toute signature Dogecoin** (et toute entrée Litecoin qui porte `non_witness_utxo`), Rust (`wallet-core`) recalcule le hash de la transaction précédente : il doit égaler le txid de l'outpoint ; le `vout` doit exister ; son script doit être le nôtre ; **le montant (et donc les frais du dialogue natif) vient uniquement de cette transaction**, jamais de la liste d'UTXO du serveur. Sinon : refus (`INVALID_INPUT`), avant le dialogue.
- Montants JSON : une sortie au-delà de 2⁵³ unités (≈ 90 millions de DOGE) n'est pas lisible sans perte en JS : l'adaptateur la refuse (la signature, elle, prend les montants dans les transactions précédentes, en Rust).
- **Bitcoin Cash** (`bch_*`, famille Tor `bitcoincash`) : comme Dogecoin, chaque entrée porte `non_witness_utxo` (`bch_tx_hex`) et Rust n'en prend que montant et script, même si le digest FORKID engage déjà les montants ; adresses CashAddr seulement (`bitcoincash:q…`, chipnet `bchtest:q…`) ; poussière 546 sat (P2PKH), minimum 1 sat/o, estimations bornées à [1 ; 100] sat/o (`estimatefee` à 1 / 3 / 6 / 144 blocs) ; signature `SIGHASH_ALL|FORKID` et PSBT **renvoyée finalisée**. Serveurs par défaut : Fulcrum publics `bch.imaginary.cash:50002` (secours `bch.loping.net:50002`, `cashnode.bch.ninja:50002`), chipnet `chipnet.imaginary.cash:50002` (secours `chipnet.bch.ninja:50002`). Bitcoin Cash partageant le genesis de Bitcoin (chipnet : celui de testnet4), chaque session vérifie **aussi** `blockchain.block.header` au point de contrôle (`utxo_checkpoint`, hash recalculé par Rust) : un serveur Bitcoin est refusé (`SERVER_WRONG_NETWORK`) ; même contrôle pour un Esplora perso (`GET /block-height/478559`). `get_balance` et `listunspent` sont appelés avec `token_filter = "exclude_tokens"` (Fulcrum) : une pièce portant des CashTokens n'est ni comptée ni dépensée (la dépenser brûlerait les jetons) ; si un serveur en glisse une quand même, son script (préfixe de jeton) ne correspond pas au nôtre → liste refusée, et wallet-core refuse de la signer.
- **Dash** (`dash_*`, famille Tor `dash`) : chemin Dogecoin (sighash legacy, `non_witness_utxo` obligatoire et vérifié, montants pris uniquement dans la transaction précédente) ; poussière 546 duffs, minimum 1 duff/o, bornes [1 ; 100] duffs/o (`estimatefee` à 1 / 12 / 24 / 144 blocs). Les transactions spéciales DIP2 (version 3, type ≠ 0 : coinbase CbTx, ProTx, retraits Platform…) sont décodées (txid sur la sérialisation complète) mais leurs sorties sont **exclues** de `dash_address_utxos` et `dash_tx_hex` les refuse (`INVALID_INPUT`) : une PSBT ne peut pas porter leur charge utile. Serveur par défaut : ElectrumX de Komodo `dash.electrum1.cipig.net:20061` (secours `dash.electrum2.cipig.net:20061`) sur mainnet ; **testnet : aucun** (`SERVER_INVALID`).
- Serveur perso Bitcoin Cash / Dash : seul le type « Esplora » est accepté (comme Litecoin / Dogecoin) ; il n'existe guère d'API Esplora publique pour ces chaînes, un **serveur Electrum perso** pour les chaînes UTXO n'est pas encore pris en charge.

**Fait côté UI** (commit de l'UI Litecoin / Dogecoin) : types `Commands` de `@kyro/shared` (`ltc_*`, `doge_*`, `btc_tx_hex`, `Accounts.ltc/doge`, `Servers.litecoin/dogecoin`, `ServerTestTarget`), backend démo, écrans Envoyer/Recevoir/Actif/Historique pour ces familles, réglages serveurs, liste « Connexions sortantes », sortie de `WATCH_ONLY_CHAINS`.

### 2.4b Zcash (adresses transparentes seulement)

**Transparent uniquement** : adresses `t1…` (P2PKH) et `t3…` (P2SH) sur mainnet, `tm…` / `t2…` sur testnet ; comme destinataire, aussi `tex1…` (ZIP 320 : une P2PKH qui n'accepte que des fonds venus d'entrées transparentes — c'est le cas de toutes les transactions de Kyro). Les adresses **protégées** (Sapling `zs…`, Sprout `zc…`) et **unifiées** (`u1…`) sont **refusées** par Rust (`INVALID_INPUT`, « adresse Zcash protégée … ou unifiée … : pas encore prise en charge »), et l'UI le dit avant (Envoyer, Recevoir). Kyro ne construit et ne lit aucune partie protégée.

Clés BIP44 `m/44'/133'/a'/c/i` (testnet `m/44'/1'/a'/…`, convention de zcashd), P2PKH, `xpub`/`tpub` standards. **Rust construit lui-même la transaction** (comme TRON, XRP, Cardano) : l'interface ne propose que les pièces candidates (outpoint + laquelle de nos adresses), le destinataire, le montant et l'index de la prochaine monnaie. Rust (`wallet-core` `zcash.rs`, crates officielles librustzcash `zcash_primitives` / `zcash_transparent` / `zcash_protocol`) :
- lit lui-même au serveur la **transaction précédente de chaque pièce**, la ré-analyse et recalcule son txid (ZIP 244 pour v5+, double SHA-256 avant) : il doit être celui de l'outpoint ; la sortie doit exister et payer **la clé de ce compte** à l'index annoncé ; montant et script viennent de cette transaction, jamais de l'interface ni de la liste du serveur ; pièce de minage (coinbase) refusée (Zcash impose de la protéger) ;
- choisit les pièces (les plus grosses d'abord, 50 au plus), calcule les **frais ZIP 317** (`zip317::FeeRule::standard()` : 5 000 zatoshis par action logique, 2 au minimum = 10 000), envoie la monnaie à **notre** adresse `…/1/changeIndex` (index ≤ 1000) ; une monnaie sous 5 000 zatoshis est ajoutée aux frais ; destinataire sous 54 zatoshis (poussière) refusé ;
- **lit la branche de consensus sur la chaîne** : `headers.subscribe` puis `transaction.id_from_pos` + `transaction.get` d'une transaction v5+ des 3 derniers blocs (la coinbase d'abord), dont l'en-tête porte le `nConsensusBranchId` ; il doit être connu de `zcash_protocol` **et** égal à ce que sa table d'activation donne pour cette hauteur, sinon refus (« le réseau Zcash utilise la branche … inconnue de cette version de Kyro … : mets Kyro à jour ») — jamais de branche codée en dur ; la transaction est signée pour la branche du bloc suivant ;
- construit une transaction **v5** (ZIP 225), `lock_time` 0, expiration = bloc suivant + 40 (ZIP 203), raccourcie avant une mise à niveau connue ; signature `SIGHASH_ALL` sur le **condensé ZIP 244** calculé par `zcash_primitives` (il engage le montant et le script de **chaque** entrée), ECDSA libsecp256k1 (crate `bitcoin`), low-S, chaque signature vérifiée ; l'encodage final est relu par `zcash_primitives` et doit dire exactement ce que montre le dialogue.

| Commande (`zec_…`) | Arguments | Retour | Notes |
|---|---|---|---|
| `zec_backend_info` | — | `{ kind: 'default', network, label, available, tor }` | `label` = `zec.electrum1.cipig.net` sur mainnet ; testnet : `''`, `available: false` (aucun serveur public) |
| `zec_address` | `{ change, index, account? }` | `string` | coffre déverrouillé ; `t1…` / `tm…` |
| `zec_address_info` / `zec_address_utxos` / `zec_address_txs` | `{ address }` | formes Esplora (§2.2) | adresse transparente de ce réseau (forme `t…` canonique) vérifiée avant toute requête. Electrum : `get_balance` + `get_history` ; `listunspent` puis **chaque UTXO confronté à sa transaction précédente** (re-hachée par `zcash_primitives`, sortie existante, notre script, montant exact ; sinon `SERVER_UNREACHABLE` pour toute la liste ; 1 000 au plus ; `coinbase: true` = pièce de minage, non dépensable par Kyro) ; historique : 50 au plus, transaction qui ne touche pas l'adresse écartée, `shielded: true` (sans `fee`) quand la transaction déplace aussi une valeur protégée ; heure du bloc lue dans l'en-tête Zcash (`nTime`, octets 100..104) |
| `zec_tip_height` | — | `number` | |
| `zec_send_preview` | `{ request: ZecSendArgs, account? }` | `ZecTxSummary` | coffre déverrouillé, sans mot de passe : la même construction que `zec_sign` (lectures réseau comprises) |
| `zec_sign` | `{ request: ZecSendArgs, password, account? }` | `{ hex, txid, summary: ZecTxSummary }` | mot de passe → construction et décodage par Rust → **dialogue natif** (compte signataire, destinataire — pour une TEX, l'adresse `t1…` qu'elle encode —, montant, monnaie et son adresse, frais et frais ZIP 317, reste ajouté aux frais, entrées, mise à niveau et branche, expiration, « Transparent : … publics ») → **2ᵉ dialogue renforcé** si `requiresExtraConfirmation` (frais > 10 × ZIP 317 ou > montant) → signature ; le résumé de la signature doit être identique à celui affiché |
| `zec_broadcast` | `{ hex }` | `string` (txid) | transaction décodée d'abord (refusée si elle a une partie protégée) ; `blockchain.transaction.broadcast` ; txid du serveur = le nôtre (ZIP 244), sinon erreur |

```ts
type ZecSendArgs = {
  to: string;                       // t1… / t3… / tex1… (refus : zs…, zc…, u1…)
  amount: string;                   // zatoshis (entier décimal) ; ignoré avec max
  max: boolean;                     // tout envoyer moins les frais, sans monnaie
  coins: { txid: string; vout: number; change: boolean; index: number }[];   // candidates, 200 au plus, AUCUN montant (deny_unknown_fields)
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

- **Serveurs** : mainnet → ElectrumX publics de Komodo (`zec.electrum1.cipig.net:20058`, secours `zec.electrum2.cipig.net:20058`, allowlist `net::ELECTRUM_HOSTS` famille `zcash`, TLS validé normalement, genesis Zcash vérifié à chaque session, circuits Tor `zcash`, jamais en clair si Tor est activé) ; **testnet → aucun** : toute lecture `SERVER_INVALID`. Pas de serveur personnalisé Zcash pour l'instant. Voir NETWORK.md.
- **Mise à niveau réseau** : la table d'activation vient de `zcash_protocol` 0.11.0-pre.1 (NU6.3 depuis le bloc 3 428 143 sur mainnet, en vigueur le 01/11/2026 ; NU7 : branche connue, **hauteur mainnet absente** de cette version). Quand le réseau passera à une branche que cette table ne donne pas pour la hauteur, Kyro refusera de signer (rien n'est perdu : pas de transaction invalide) jusqu'à la mise à jour des crates.
- Hardware wallets : `HW_UNSUPPORTED` (pas de clés Zcash dans `WatchOnlyAccount`).
- **Comptes** (§2.9) : chaîne `zec`, `m/44'/133'/a'`.

**Fait côté UI** : types `ZecCommands` de `@kyro/shared` (`Accounts.zec`, `AccountChain` `zec`), `ZcashAdapter` (`packages/chains/src/zcash/`, balayage des adresses avec limite d'écart, historique, pièces candidates, aperçu Rust), chaîne `zcash` du registre (prix CoinGecko `zcash`), écrans Envoyer (refus clair des adresses protégées et unifiées, frais ZIP 317 « rien à choisir », récapitulatif décodé), Recevoir (adresse `t1…`, URI ZIP 321 `zcash:`, avertissement « adresses protégées pas encore prises en charge »), Actif, carnet d'adresses, Connexions sortantes ; backend démo (`mock-zec.ts`).

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
| `tron_sign_tx` | `{ raw, password, account? }` | `{ signature /*65 octets hex*/, txid, summary, estimate }` | décode (`tron_decode_raw`, owner = nous), refuse expirée ou expiration > 24 h, mot de passe, **relit en direct** compte, paramètres de chaîne, existence du destinataire et énergie simulée → dialogue natif : destinataire, montant (token nommé par `known_tokens.rs` seulement : USDT mainnet `TR7NHq…`, Nile `TXYZop…` ; autre token : unités brutes et « JETON INCONNU », 2ᵉ dialogue ; un `token` envoyé par une ancienne interface est ignoré), **bande passante nécessaire / disponible (gratuite, gelée) et TRX brûlés**, **énergie estimée / disponible, TRX brûlés estimés et au maximum (`fee_limit`)**, **activation d'un compte inexistant** (création 1 TRX + 0,1 TRX sans bande passante gelée, valeurs lues dans `getchainparameters`), total estimé et maximum, solde, mémo (une ligne entre « … », après les montants), expiration, bloc de référence, txid ; 2ᵉ dialogue renforcé si `requiresExtraConfirmation` (appel autre que `transfer`, TRX envoyés au contrat, mémo, `fee_limit` > 100 TRX) ; résumé de la signature = résumé affiché |
| `tron_broadcast` | `{ raw, signature, account? }` | `string` (txid) | la signature doit redonner notre adresse ; `/wallet/broadcasthex` ; txid du serveur = `sha256(raw)` sinon `SERVER_UNREACHABLE` ; refus du réseau → `INVALID_INPUT` avec le message décodé |

**Historique et nœud personnel** : `tron_txs` utilise l'API `/v1` propre à TronGrid. Un nœud java-tron seul (serveur `http` personnalisé) ne l'a pas : la commande échoue alors avec `SERVER_UNREACHABLE` et un message explicite (« l'historique exige l'API /v1 de TronGrid »), sans jamais se rabattre sur TronGrid. Soldes, ressources, construction, signature et diffusion fonctionnent avec n'importe quel nœud java-tron.

**Clé TronGrid (optionnelle)** : `KYRO_TRONGRID_API_KEY` (env, développement) ou `settings.apiKeys.trongrid`. Rust l'ajoute en en-tête `TRON-PRO-API-KEY` **uniquement** vers `api.trongrid.io` et `nile.trongrid.io` (jamais vers un nœud personnel ni un autre hôte) ; l'UI ne voit jamais la clé (`config_get.hasTrongridKey`). Sans clé : quotas réduits, et des relais de sortie Tor peuvent recevoir un 403.

Refusé avant toute signature : autre type de contrat que TRX / appel de contrat (**délégation de ressources**, **changement de permissions**… ; gel, dégel, vote et récompenses passent uniquement par `tron_stake_*`, §2.8), `Permission_id` (multi-signature), autre propriétaire, `auths`, `scripts`, valeur TRC-10, encodage non canonique. Estimation de bande passante : taille signée + 64 octets (comme java-tron). Hardware wallets : Ledger (app « Tron », `hw_sign_tron_tx`, §2.3) ; Trezor non.

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

Refusé avant toute signature : tout autre type de transaction (AccountSet, SetRegularKey, SignerListSet, TrustSet, OfferCreate, EscrowCreate…), **paiement partiel** (`tfPartialPayment` : le montant livré pourrait être presque nul), `Paths`, `DeliverMin`, `TicketSequence`, `NetworkID`, drapeaux inconnus, champs inconnus. Plus strict que « inconnu → confirmation renforcée » : un champ que Kyro ne sait pas décoder n'est jamais signé. Hardware wallets : Ledger (app « XRP », `hw_sign_xrp_tx`, §2.3) ; Trezor non (pas de clé publique avant la signature).

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

**Principe commun.** L'UI ne construit rien : elle choisit une opération, `*_stake_build({ action })` la fait **construire par Rust** (données lues en direct via Tor, familles `solana` / `cardano` / `tron`, aucun nouvel hôte) et renvoie le résultat **décodé par wallet-core** avec le contexte vivant (validateur / pool / SR, montants, calendrier) à afficher **avant** le mot de passe. `*_stake_sign({ …, password })` redécode, **relit tout en direct** et refait chaque vérification, demande le mot de passe, ouvre la **fenêtre native** (texte construit par Rust), puis la **2ᵉ fenêtre renforcée** si `requiresExtraConfirmation`, signe et vérifie la signature ; le résumé signé doit être identique à celui affiché. Toute opération qui n'est pas exactement une de celles listées ici est refusée (`INVALID_INPUT`). Montants : chaînes décimales en plus petite unité (lamports, lovelace, sun). Coffre verrouillé : `LOCKED`. Serveur en panne ou réponse invalide : `SERVER_UNREACHABLE` (jamais de repli). Pas de hardware wallet pour le staking (`HW_UNSUPPORTED` n'est pas renvoyé : les commandes `hw_*` ne le proposent simplement pas).

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
| `ltc` / `doge` / `bch` / `dash` | `m/84'/2'/a'` / `m/44'/3'/a'` / `m/44'/145'/a'` / `m/44'/5'/a'` (testnet : `c` = 1) | `…/0'` |
| `zec` | `m/44'/133'/a'` (testnet `m/44'/1'/a'`), transparent seulement | `m/44'/133'/0'` |
| `evm` | **`m/44'/60'/0'/0/a`** (index d'adresse : MetaMask, Trezor Suite et les comptes hardware wallet de Kyro ; pas `m/44'/60'/a'/0/0` de Ledger Live — identique pour le compte 0, et une phrase importée de MetaMask retrouve ses comptes dans le même ordre) ; une seule liste pour toutes les chaînes EVM | `m/44'/60'/0'/0/0` |
| `sol` | `m/44'/501'/a'/0'` (Phantom, Solflare) | `m/44'/501'/0'/0'` |
| `tron` | `m/44'/195'/a'/0/0` (Ledger Live) | `m/44'/195'/0'/0/0` |
| `xrp` | `m/44'/144'/a'/0/0` (Ledger Live, Trezor Suite) | `m/44'/144'/0'/0/0` |
| `ada` | CIP-1852 `m/1852'/1815'/a'/0/0` + staking `…/a'/2/0` | `m/1852'/1815'/0'/…` |
| `xlm` | SEP-0005 `m/44'/148'/a'` (Lobstr, Freighter, Ledger, Trezor ; vecteurs SEP-0005) | `m/44'/148'/0'` |
| `sui` | `m/44'/784'/a'/0'/0'` (Sui Wallet / Slush, `sui keytool`) | `m/44'/784'/0'/0'/0'` |
| `algo` | `m/44'/283'/a'/0/0` (app Algorand de Ledger) | `m/44'/283'/0'/0/0` |
| `ton` | `m/44'/607'/a'` (Trust Wallet), portefeuille v4R2 | `m/44'/607'/0'` |
| `cosmos` | `m/44'/118'/a'/0/0` (Keplr, Leap, Ledger Live) | `m/44'/118'/0'/0/0` |

| Commande | Arguments | Retour | Notes |
|---|---|---|---|
| `vault_accounts_get` | — | `VaultAccountLists` | listes du réseau courant ; chaque chaîne a au moins `{ index: 0, name }` |
| `vault_account_add` | `{ chain, account, name }` | `VaultAccountLists` | coffre déverrouillé ; `account` ≤ 100, au plus 20 comptes par chaîne, nom 1–32 caractères sans caractère de contrôle (espaces de bord retirés) ; déjà présent → `INVALID_INPUT`. L'UI prévisualise d'abord le compte avec `accounts_get({ account })` (adresse, chemin) et son solde |
| `vault_account_rename` | `{ chain, account, name }` | `VaultAccountLists` | coffre déverrouillé ; absent de la liste → `INVALID_INPUT` |
| `vault_account_remove` | `{ chain, account }` | `VaultAccountLists` | coffre déverrouillé ; compte 0 → `INVALID_INPUT` |

```ts
type AccountChain = 'btc' | 'evm' | 'sol' | 'ltc' | 'doge' | 'tron' | 'xrp' | 'ada' | 'xlm' | 'bch' | 'dash' | 'sui' | 'algo' | 'ton' | 'cosmos' | 'zec';
type VaultAccountLists = { [C in AccountChain]: { index: number; name: string }[] };   // triées par index ; nom par défaut « Bitcoin 2 » pour l'index 1
```

**`account?` sur les commandes du coffre.** Toutes les commandes qui dérivent une de nos adresses ou signent prennent `account?` (absent = 0, donc une ancienne UI marche sans changement ; > 100 → `INVALID_INPUT`) : `accounts_get`, `btc_address`, `btc_sign_psbt`, `evm_sign_tx`, `sol_decode_tx`, `sol_sign_tx`, `ltc_*`/`doge_*` `_address` et `_sign_psbt`, `zec_address` / `_send_preview` / `_sign`, `tron_address` / `_build_tx` / `_sign_tx` / `_broadcast`, `xrp_address` / `_build_tx` / `_sign_tx` / `_broadcast`, `ada_address` / `_build_tx` / `_sign_tx` / `_broadcast`, `cosmos_address` / `_build_tx` / `_sign_tx` / `_broadcast`, `algo_address` / `_build_tx` / `_sign_tx` / `_broadcast`, `stellar_address` / `_build_tx` / `_sign_tx` / `_broadcast`, `sui_address` / `_build_tx` / `_sign_tx` / `_broadcast`, `sol_stake_overview` / `_build` / `_sign` / `_broadcast`, `ada_stake_overview` / `_build` / `_sign` / `_broadcast`, `tron_stake_overview` / `_build` / `_sign`, `kas_address` / `_account` / `_txs` / `_build_tx` / `_sign_tx` / `_broadcast` (Kaspa lit les adresses du compte, donc ses lectures aussi). Les commandes de lecture par adresse (`*_address_info`, `*_txs`, `tron_account`…) n'en ont pas besoin. `btc_core_setup` importe les descripteurs de **tous** les comptes Bitcoin de la liste (un compte ajouté ensuite demande de relancer la configuration) ; les filtres compacts (`cbf`, désactivés par défaut) ne surveillent encore que le compte 0.

**Dialogue natif.** La première ligne de chaque fenêtre de signature du coffre dit **quel compte signe** : « Compte signataire : Bitcoin 2 — m/84'/1'/1' (SegWit), m/86'/1'/1' (Taproot) » (EVM : plus l'adresse « De »). Un compte qui n'est **pas** dans la liste de l'utilisateur est affiché « inconnu » (« n° N, absent de ta liste ») avec son chemin, et la signature exige une **2ᵉ fenêtre renforcée** (« Attention : compte inconnu »). Bitcoin, Litecoin, Dogecoin : seules les entrées du compte choisi sont signées ; une entrée d'un autre compte du coffre est étrangère (2ᵉ fenêtre déjà existante) et la monnaie n'est reconnue que dans le compte choisi.

**Fait côté UI** (commit de l'UI des comptes) : Réglages › Comptes (liste par chaîne, « Ajouter un compte » qui prévisualise `accounts_get({ account })` et son solde, renommer, retirer), un jeu d'adaptateurs par compte (`createAdapters(…, account)`, chaque adaptateur passe `account` à ses commandes de signature), le compte choisi par chaîne (mémorisé par réseau dans `localStorage`, donnée publique) utilisé par Envoyer / Recevoir / Swap / Staking / Actif, sélecteur « Compte » toujours affiché pour le coffre (même avec un seul compte ; pas pour un hardware wallet), une ligne par compte dans Actifs (totaux additionnés), historique de tous les comptes. **Mode démo** : listes, adresses, soldes et signatures BTC / EVM / Solana / LTC / DOGE par compte ; TRON, XRP, Stellar, Cardano et staking simulés pour le premier compte seulement (erreur explicite sinon).

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

### 2.11 Stellar (XLM)

Serveur : **Horizon de la SDF** (`horizon.stellar.org` / `horizon-testnet.stellar.org`, version 30 le 01/11/2026), famille Tor `stellar`, jamais de repli, pas encore de serveur personnalisé. Stellar RPC n'est pas utilisé : il n'a pas d'historique par compte, et la SDF ne publie de point d'accès RPC public que pour le testnet. Chaque construction, signature et diffusion vérifie d'abord la `network_passphrase` d'Horizon (autre réseau → `SERVER_WRONG_NETWORK`) ; la phrase du réseau est de toute façon dans ce qui est signé. **Rust construit la transaction** : numéro de séquence (`/accounts` + 1), frais (90ᵉ centile des frais prélevés de `/fee_stats`, au moins le frais de base, au plus **0,01 XLM**), **limites de temps obligatoires** `[0, heure du dernier registre + 300 s]`, une seule opération : **Payment** XLM si le destinataire existe, **CreateAccount** sinon ; encodée en XDR par wallet-core. Une enveloppe construite par le serveur n'est jamais signée.

| Commande | Arguments | Retour | Notes |
|---|---|---|---|
| `stellar_backend_info` | — | `{ kind: 'default', network: 'mainnet' \| 'testnet', label, tor }` | |
| `stellar_address` | `{ account? }` | `string` | `m/44'/148'/{account}'` (SEP-0005), coffre déverrouillé ; `stellar_build_tx`, `stellar_sign_tx`, `stellar_broadcast` prennent le même `account?` |
| `stellar_account` | `{ address }` | `{ address, exists, balance /*stroops*/, sequence /*chaîne*/, subentryCount, numSponsoring, numSponsored, sellingLiabilities, reserve, spendable, memoRequired, trustlines: [{ code, issuer, balance, limit }], baseReserve }` | `/accounts/{id}` + `base_reserve_in_stroops` du dernier registre (**0,5 XLM**, frais de base **100 stroops**, lus en direct le 01/11/2026 sur testnet et mainnet) ; `reserve` = (2 + entrées + parrainées − parrainantes) × réserve de base + XLM engagés dans des offres ; `spendable` = solde − réserve ; `memoRequired` = entrée de données SEP-0029 `config.memo_required` ; compte inexistant (404) : `exists: false` |
| `stellar_txs` | `{ address }` | `[{ id, hash, type, from, to, amount: { kind: 'native', stroops } \| { kind: 'credit', code, issuer, stroops }, fee, time, successful, memo, txSource }]` | 50 derniers paiements (`/accounts/{id}/payments?join=transactions`) : Payment, CreateAccount, path payments (montant **reçu**) ; fusions de comptes ignorées ; mémo texte nettoyé |
| `stellar_build_tx` | `{ to, amount /*stroops*/, memo?: { kind: 'text' \| 'id' \| 'hash', value }, account? }` | `{ envelope /*non signée, base64*/, summary: StellarTxSummary, context: { account, destination, baseReserve, baseFee, ledgerTime } }` | refusé avant toute construction : destinataire avec `config.memo_required` **sans mémo** ; compte destinataire inexistant et montant < 2 × réserve de base (1 XLM) ; montant + frais > disponible ; notre compte non créé ; adresse M… ou S… ; mémo texte > 28 octets ou avec caractère de contrôle / invisible, identifiant > 2⁶⁴ − 1, hash ≠ 64 hex |
| `stellar_sign_tx` | `{ envelope, password, account? }` | `{ envelope /*signée*/, hash, summary, context }` | décode (strict, source = nous), **XLM seulement** (Payment natif ou CreateAccount), vérifie la phrase réseau d'Horizon, refuse une limite de temps à moins de 30 s ou à plus de 5 min, une séquence périmée, un Payment vers un compte qui n'existe pas (ou un CreateAccount vers un compte qui existe), **relit en direct** les deux comptes et la réserve et refait les vérifications ci-dessus ; mot de passe → dialogue natif : compte signataire, destinataire, **MÉMO encadré sur sa propre ligne** (texte entre « … », identifiant, hash ; ou « AUCUN MÉMO » avec l'avertissement), montant, création du compte destinataire (réserve bloquée chez lui), frais maximum (et frais habituels), solde, réserve bloquée ((2 + entrées) × 0,5 XLM), disponible, heure limite et séquence, **phrase du réseau signée** ; 2ᵉ dialogue renforcé si `requiresExtraConfirmation` ; résumé de la signature = résumé affiché |
| `stellar_broadcast` | `{ envelope, account? }` | `string` (hash) | `stellar_verify_signed` (une signature ed25519 de la source = nous, valide **sur ce réseau**) puis `POST /transactions` (formulaire `tx=`) ; Horizon répond une fois la transaction dans un registre : 200 + hash identique → succès ; 400 → `INVALID_INPUT` avec les codes (`tx_bad_seq`, `tx_too_late`, `op_underfunded`, `op_low_reserve`…) expliqués en français ; 504 ou réponse perdue → `SERVER_UNREACHABLE` qui dit que la transaction a peut-être été transmise (jamais renvoyée en douce ; la renvoyer telle quelle est sans risque : même hash, séquence utilisable une seule fois) |
| `stellar_tx_status` | `{ hash }` | `{ found, successful }` | `/transactions/{hash}` |

Refusé avant toute signature : toute autre opération (SetOptions — prise de contrôle du compte —, AccountMerge, ManageData, offres, path payments, claimable balances, sponsoring, clawback, Soroban…), plus d'une opération, enveloppes fee bump et v0, comptes multiplexés, préconditions V2, mémo de type « remboursement » ou frais > 0,01 XLM sans 2ᵉ fenêtre. ChangeTrust (lignes de confiance, pour USDC) est décodé et testé dans wallet-core, mais **pas encore proposé** : `stellar_sign_tx` le refuse. Hardware wallets : Ledger (app « Stellar ») et Trezor (`StellarSignTx`), `hw_sign_stellar_tx` (§2.3) ; la signature est vérifiée sur le hash de Kyro et attachée à son enveloppe.

**Pour l'UI** : le champ **Mémo** (identifiant / texte / hash) est visible en permanence sur l'écran Envoyer XLM, obligatoire si `stellar_account(destination).memoRequired` (Rust refuse de toute façon) ; « au moins 1 XLM » pour un destinataire inexistant ; afficher `spendable` et la réserve expliquée ; adresse M… / S… : message dédié. **Fait** : `Family` `'xlm'` (chaîne `stellar`, actif `xlm`, 7 décimales, CoinGecko `stellar`), types `Commands` (`stellar_*`, `Accounts.stellar`, `AccountChain` `'xlm'`), backend démo (`mock-stellar.ts`), écrans Envoyer / Recevoir (adresse + QR, réserve) / Actifs / Historique (mémo, création de compte), « Connexions sortantes », comptes multiples. Adaptateur : `StellarAdapter` (`packages/chains/src/stellar/`), `stellarChain(network)`, strkeys TS dans `@kyro/shared` (`stellar.ts`).

### 2.11 NEAR Protocol (transferts de NEAR)

Serveurs **par défaut uniquement** (pas encore de serveur NEAR personnalisé) : RPC JSON `free.rpc.fastnear.com` (mainnet) / `test.rpc.fastnear.com` (testnet), historique par l'API explorateur de FastNEAR `tx.main.fastnear.com` / `tx.test.fastnear.com` ; famille Tor `near`, jamais de repli. `near_build_tx` et `near_sign_tx` vérifient d'abord le réseau par `status` (`chain_id` **et** `genesis_hash` attendus, nœud en synchronisation refusé : `near_backend::probe`) ; une transaction NEAR ne nomme pas son réseau, mais son bloc de référence n'existe que sur une chaîne.

**Clés.** SLIP-10 ed25519, chemin `m/44'/397'/{account}'` (trois niveaux durcis) : celui de `near-seed-phrase` (near-cli, MyNearWallet, Meteor ; le compte 0 est l'historique `m/44'/397'/0'`). Vecteur officiel vérifié : la phrase de test de `near-seed-phrase` donne `ed25519:r4yuiZE45mzeZAENDEF2pWeFBJkW8mQYGx3rU46zCqh` (`crates/wallet-core/tests/near.rs`). **Adresse = compte implicite** : les 64 caractères hexadécimaux minuscules de la clé publique ; il existe sur la chaîne après son premier NEAR reçu. Les comptes nommés (`alice.near`, `bob.testnet`) ne sont que des **destinataires** (règles de nearcore : 2–64 caractères, `a-z 0-9 - _ .`, pas de séparateur en tête, en fin ni doublé, majuscules refusées).

**Rust construit la transaction** : `TransactionV0 { signer_id = notre compte implicite, public_key = notre clé, nonce = nonce de la clé d'accès + 1, receiver_id, block_hash = bloc final lu avec la clé d'accès, actions: [Transfer { deposit }] }`, encodée en Borsh par wallet-core, signée en ed25519 sur `SHA-256(borsh)` (ce SHA-256 est aussi le hash de la transaction, connu avant la diffusion). **Décodage strict** : une seule action `Transfer`, clé ed25519, aucun octet en trop, ré-encodage identique ; `TransactionV1`, toute autre action (FunctionCall, AddKey, DeleteAccount, Delegate…), plusieurs actions, une autre clé ou un autre signataire : refusés avant toute signature. Pas de jetons NEP-141 (il faudrait signer des `FunctionCall`).

**Frais.** Ils ne figurent **pas** dans une transaction NEAR : ils sont prélevés au prix du gas du bloc qui l'inclut. Rust lit `EXPERIMENTAL_protocol_config` (coûts `action_receipt_creation` + `transfer`, et `create_account` + `add_key` quand le transfert crée un compte implicite ; prix du stockage) et `gas_price` : estimation = gas × prix actuel ; **borne** = 2 × gas × max(prix actuel, prix minimum du protocole). Montant + borne doivent tenir dans le disponible (solde − réserve de stockage), sinon refus.

| Commande | Arguments | Retour | Notes |
|---|---|---|---|
| `near_backend_info` | — | `{ kind: 'default', network, label /*hôte RPC*/, history /*hôte historique*/, tor }` | |
| `near_address` | `{ account? }` | `string` | compte implicite de `m/44'/397'/{account}'`, coffre déverrouillé ; `near_build_tx`, `near_sign_tx`, `near_broadcast`, `near_tx_status` prennent le même `account?` |
| `near_account` | `{ accountId }` | `{ accountId, exists, balance, locked, storageUsage, storageReserve, spendable, hasContract }` (yoctoNEAR, chaînes décimales) | `view_account` (finalité `final`) ; `storageReserve` = `storage_usage` × prix par octet (10¹⁹ yocto, lu en direct) − `locked` ; `spendable` = solde − réserve ; compte inexistant : `exists: false` |
| `near_txs` | `{ accountId }` | `[{ hash, from, to, kind: 'transfer' \| 'other', deposit, fee, height, time, success }]` | 20 dernières transactions (`/v0/account` puis `/v0/transactions` de FastNEAR) ; `deposit` = somme des actions `Transfer` **de la transaction elle-même** (un transfert interne d'un contrat n'y figure pas) ; `fee` = NEAR brûlés (transaction + reçus) |
| `near_build_tx` | `{ to, amount /*yoctoNEAR*/, account? }` | `{ tx /*Borsh hex, non signé*/, summary: NearTxSummary, context: NearContext }` | refusé avant toute construction : notre compte inexistant ; clé sans accès complet (`FunctionCall`) ou retirée ; destinataire **nommé** ou `0x…` inexistant (un compte nommé doit exister, sinon les frais sont perdus) ; montant + borne de frais > disponible ; transfert à soi-même |
| `near_sign_tx` | `{ tx, password, account? }` | `{ signed /*Borsh hex*/, hash, summary, context }` | décode (strict, signataire et clé = nous), **relit en direct** les deux comptes, la clé d'accès (nonce périmé → « reconstruis ») et les frais, refuse un bloc de référence de plus d'≈ 1 h ; mot de passe → dialogue natif : **compte signataire**, destinataire et sa nature (nommé / implicite / style Ethereum), création éventuelle du compte, montant (NEAR et yoctoNEAR), **frais estimés et borne**, solde, réserve de stockage, disponible, clé, nonce, bloc de référence, hash ; compte absent de la liste : « inconnu » + dialogue renforcé ; 2ᵉ dialogue renforcé si `requiresExtraConfirmation` ; résumé de la signature = résumé affiché |
| `near_broadcast` | `{ signed, account? }` | `{ hash, status: 'success' \| 'failure' \| 'pending', message }` | `near_verify_signed` (décodage strict, signature ed25519 vérifiée strictement, signataire = nous) puis `send_tx` (`wait_until: EXECUTED_OPTIMISTIC`) ; hash du nœud ≠ le nôtre → `SERVER_UNREACHABLE` ; `INVALID_TRANSACTION` → `INVALID_INPUT` avec la cause ; délai du nœud → `pending` |
| `near_tx_status` | `{ hash, account? }` | même forme | `tx` (`wait_until: NONE`) : `pending` tant qu'inconnue ou non exécutée |

```ts
type NearTxSummary = { signerId; publicKey /*ed25519:…*/; nonce; receiverId; receiverKind: 'implicit' | 'ethImplicit' | 'named'; deposit /*yocto*/; blockHash; hash; warnings: Array<{ kind: 'ethImplicitReceiver' }>; requiresExtraConfirmation };
type NearContext = { account: NearAccountInfo; receiver: NearAccountInfo; createsAccount; gasPrice; feeEstimate; feeBound };
```

Destinataire `0x…` (compte NEAR de style Ethereum, NEP-518, contrôlé par une clé Ethereum) : avertissement `ethImplicitReceiver` → dialogue renforcé (une adresse de dépôt EVM d'une plateforme n'est pas un compte NEAR). Hardware wallets : non pris en charge (l'UI désactive NEAR pour ces comptes). Comptes multiples : chaîne `near` des listes du coffre (§2.9).

**Fait côté UI** : `Family` `'near'`, `nearChain(network)` (24 décimales, CoinGecko `near`), `NearAdapter` (`packages/chains/src/near/`), règles d'identifiant partagées (`nearAccountKind`, `nearAccountIdProblem` dans `@kyro/shared`), backend démo (`mock-near.ts` : adresse de démonstration **non dérivée**, encodage de démonstration), écrans Envoyer (nature et existence du destinataire, disponible, récapitulatif décodé, suivi d'exécution), Recevoir (QR de l'adresse nue, pas de lien de paiement), lignes du portefeuille, Comptes, carnet d'adresses, « Connexions sortantes ».

### 2.11 Sui (SUI)

**Serveur** : l'API **GraphQL** publique de la Sui Foundation (`https://graphql.testnet.sui.io/graphql`, `https://graphql.mainnet.sui.io/graphql`), POST JSON en HTTPS, famille Tor `sui`, jamais de repli, pas (encore) de serveur personnalisé. Pourquoi pas JSON-RPC : il a été coupé sur les full nodes publics de la Sui Foundation la semaine du 27/07/2026 (`fullnode.testnet.sui.io` répond « Method not found. JSON-RPC on public fullnodes has been deprecated », vérifié le 01/11/2026) et retiré du code en octobre 2026 ; ses successeurs sont gRPC (HTTP/2 + protobuf, que `net.rs` ne parle pas) et GraphQL (même transport que les autres chaînes). Chaque réponse porte `chainIdentifier`, comparé au réseau attendu (mainnet `4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S`, testnet `69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD`) : autre valeur → `SERVER_WRONG_NETWORK`. La Sui Foundation présente ces points d'accès comme limités en débit et « pour le développement » : un fournisseur ou ton propre nœud GraphQL seraient plus sûrs pour un usage intensif.

**Rust construit le transfert** : pièces SUI de ton adresse (`address.objects(filter: { type: "0x2::coin::Coin<0x2::sui::SUI>" })`, type, propriétaire et identifiant vérifiés), les plus grosses d'abord jusqu'à couvrir montant + 0,05 SUI (toutes, au plus 256, pour « tout le solde ») ; prix du gaz = prix de référence de l'époque (`epoch.referenceGasPrice`) ; expiration = époque courante + 1 ; budget = calcul + 1 000 unités × prix + max(0, stockage − remboursement) d'après la **simulation d'un brouillon** (`simulateTransaction` sur les octets BCS exacts, formule du SDK officiel) ; encodé par wallet-core. Une transaction construite par le serveur n'est jamais signée.

| Commande | Arguments | Retour | Notes |
|---|---|---|---|
| `sui_backend_info` | — | `{ kind: 'default', network: 'mainnet' \| 'testnet', label, tor }` | |
| `sui_address` | `{ account? }` | `string` | `m/44'/784'/{account}'/0'/0'`, coffre déverrouillé ; `sui_build_tx`, `sui_sign_tx`, `sui_broadcast` prennent le même `account?` |
| `sui_balance` | `{ address }` | `{ address, total, coin, addressBalance }` (MIST) | `address.balance(coinType: "0x2::sui::SUI")` : `coin` = pièces (ce que Kyro dépense), `addressBalance` = « solde d'adresse » (accumulateur ajouté à Sui en 2026), **affiché mais pas dépensé** par Kyro |
| `sui_txs` | `{ address }` | `[{ digest, timestamp, checkpoint, success, sender, change, fee, counterparty, otherCoins }]` | 20 dernières transactions qui touchent l'adresse (`relation: AFFECTED`), plus récentes d'abord ; `change` = variation nette de SUI de l'adresse (frais compris), `fee` = gaz net si elle l'a envoyée |
| `sui_build_tx` | `{ to, amount? /*MIST*/, all?: boolean, account? }` | `{ bcs /*base64*/, summary: SuiTxSummary, context: SuiContext }` | refusé : adresse incomplète, forme courte, nom SuiNS ; aucune pièce SUI (message dédié si tout est dans le solde d'adresse) ; montant + budget > pièces ; simulation en échec. `context` = `{ balance, gasCoinsTotal, gasCoinBalances /*MIST de chaque pièce, ordre de summary.gasCoins*/, referenceGasPrice, epoch, computationCost, storageCost, storageRebate, fee /*signé*/, receives /*tout le solde : reçu selon la simulation*/ }` |
| `sui_sign_tx` | `{ bcs, password, account? }` | `{ bcs, signature, digest, summary, context }` | décode (strict, expéditeur = nous) ; **relit en direct** : époque et prix de référence (expiration ≥ époque courante, prix ≥ référence et ≤ 10 × référence), chaque pièce de gaz encore à nous **à la même version et empreinte**, montant + budget ≤ pièces ; **simule les octets exacts** (succès exigé ; seuls des SUI bougent, entre toi et le destinataire ; le destinataire reçoit exactement le montant) ; mot de passe → dialogue natif : compte signataire, destinataire **en entier** (rappel : pas de somme de contrôle), montant (SUI et MIST) ou « TOUT LE SOLDE » avec le reçu simulé, jeton `SUI (0x2::sui::SUI)`, frais estimés (calcul + stockage − remboursement), budget max, prix du gaz et référence, nombre et total des pièces de gaz puis **chaque pièce** (identifiant d'objet complet et version décodés des octets, solde relu en direct ; au-delà de 5 : « … et N autres pièces » avec leur total), solde dépensable, époque limite, empreinte ; compte hors liste → « inconnu » + fenêtre renforcée ; 2ᵉ fenêtre renforcée si `requiresExtraConfirmation` ; résumé de la signature = résumé affiché. Sans époque d'expiration : refusé (Kyro en met toujours une) |
| `sui_broadcast` | `{ bcs, signature, account? }` | `string` (digest) | `sui_verify_signed` (ed25519, clé = expéditeur = nous) puis `executeTransaction` (attend la finalité) ; empreinte des effets = empreinte locale sinon `SERVER_UNREACHABLE` ; exécutée mais en échec (gaz prélevé) → `INVALID_INPUT` avec l'erreur |
| `sui_tx_status` | `{ digest }` | `{ found, success, error, checkpoint }` | `transaction(digest)` : `found: false` tant que l'indexeur ne l'a pas |

Refusé avant toute signature (voir §1) : tout ce qui n'est pas ce transfert-là — appel Move, objet en entrée, autre jeton, transaction parrainée, gaz payé par le solde d'adresse, expiration `ValidDuring`, forme `Result(0)`… Plus strict que « inconnu → confirmation renforcée » : Kyro ne signe que les octets qu'il a construits. Hardware wallets : non pris en charge (`accounts.sui` absent → pas d'adaptateur). **USDC sur Sui : non fait** (il faudrait des entrées `Object` — pièces USDC — et `MergeCoins`, donc un second gabarit BCS et sa table de jetons ; laissé de côté pour garder un seul gabarit vérifié).

**Côté UI** : `Family` `'sui'`, `suiChain(network)`, actif `sui` (9 décimales, CoinGecko `sui`), `SuiAdapter` (`packages/chains/src/sui/`), écrans Envoyer (pas de frais à choisir, adresse complète exigée, solde dépensable, récapitulatif décodé, suivi `sui_tx_status`), Recevoir (QR de l'adresse nue : pas de lien de paiement standard), Actif, Historique, comptes multiples, « Connexions sortantes », mode démo (`mock-sui.ts` : adresses de démo au bon format mais pas dérivées de la graine, BCS remplacé par du JSON base64).

### 2.11 Hedera (HBAR)

Pas de serveur personnalisé : Rust joint le **nœud miroir** officiel (REST, lectures) et les **proxys gRPC-web** des nœuds de consensus (diffusion), famille Tor `hedera`, jamais de repli. **Rust construit le CryptoTransfer** : payeur = notre compte `0.0.x` (lu au nœud miroir), un débit du payeur et un crédit du destinataire, `transactionValidStart` = maintenant − 10 s, durée 180 s (maximum du réseau), frais **maximum** = 0,5 ¢ (10 ¢ si le transfert crée le compte destinataire) au taux de change du nœud miroir, borné à 0,01 … 5 HBAR (seuls les frais réels, ≈ 0,0001 $, sont prélevés) ; **une copie par nœud** (`nodeAccountID` est dans le corps signé), même identifiant de transaction : le réseau en exécute au plus une. Encodé par wallet-core.

**Clé et compte.** Clé ECDSA secp256k1 `m/44'/3030'/0'/0/{account}` (chemin standard des SDK Hedera et de HashPack pour un compte ECDSA ; vecteurs officiels des SDK). L'« adresse » du coffre est l'**adresse EVM** de cette clé : le premier HBAR envoyé à cette adresse **crée** le compte (HIP-583, compte « creux » sans clé tant que nous n'avons rien signé ; notre premier envoi fixe la clé : la `SignaturePair` porte la clé complète de 33 octets). Kyro cherche le compte par l'adresse EVM (`/api/v1/accounts/{0x…}`), puis par la clé publique (`account.publickey`) : un compte trouvé par la clé mais avec une autre adresse EVM ne doit recevoir **que** par son `0.0.x` (`foundBy: 'publicKey'`). ED25519 (Ledger, anciens comptes HashPack) : non pris en charge.

**Diffusion.** `POST https://{proxy}/proto.CryptoService/cryptoTransfer`, `content-type: application/grpc-web+proto`, corps = trame gRPC-web (`0x00`, longueur sur 4 octets, `Transaction`) ; la réponse contient une trame de données (`TransactionResponse.nodeTransactionPrecheckCode`) et une trame de fin (`grpc-status`). Un HTTP/1.1 ordinaire suffit : pas de HTTP/2, pas de relais JSON-RPC. Proxys (ceux du SDK JS Hedera, `MAINNET` / `WEB_TESTNET`, vérifiés le 01/11/2026) : mainnet `node00.swirldslabs.com` (0.0.3), `node01-00-grpc.swirlds.com` (0.0.4), `node04.swirldslabs.com` (0.0.7) ; testnet `testnet-node00-00-grpc.hedera.com` (0.0.3), `testnet-node01-00-grpc.hedera.com` (0.0.4), `testnet-node02-00-grpc.hedera.com` (0.0.5). Copie après copie : `OK` ou `DUPLICATE_TRANSACTION` → envoyé ; `BUSY`, `PLATFORM_NOT_ACTIVE`, `PLATFORM_TRANSACTION_NOT_CREATED`, `THROTTLED_AT_CONSENSUS` ou nœud injoignable → copie suivante ; tout autre code → `INVALID_INPUT` avec le nom du code (rien n'est exécuté, un refus en précontrôle n'est pas facturé).

| Commande | Arguments | Retour | Notes |
|---|---|---|---|
| `hbar_backend_info` | — | `{ network: 'mainnet' \| 'testnet', label /*hôte du nœud miroir*/, tor }` | |
| `hbar_address` | `{ account? }` | `string` | adresse EVM (EIP-55) de `m/44'/3030'/0'/0/{account}`, coffre déverrouillé ; `hbar_account`, `hbar_build_tx`, `hbar_sign_tx`, `hbar_broadcast` prennent le même `account?` |
| `hbar_account` | `{ account? }` | `{ address /*notre adresse EVM*/, accountIdChecksum, exists, accountId, evmAddress, balance /*tinybars*/, hollow, deleted, receiverSigRequired, foundBy }` | notre compte au nœud miroir (par alias, sinon par clé publique) ; la réponse doit porter notre adresse EVM ou notre clé, sinon `SERVER_UNREACHABLE` ; `exists: false` avant le premier HBAR reçu |
| `hbar_recipient` | `{ to }` | `{ to, isEvm, exists, accountId, evmAddress, balance, hollow, deleted, receiverSigRequired }` | `to` : `0.0.x` (somme HIP-15 facultative, vérifiée pour ce réseau) ou `0x…` (EIP-55 ; long-zero → `0.0.x`) |
| `hbar_txs` | `{ accountId }` | `[{ id, name, result, time, fee, memo, delta, amount, counterparty, outgoing }]` | 50 dernières transactions (`/api/v1/transactions?account.id=…`) ; montants en tinybars (chaînes) ; `amount` = HBAR échangés avec la contrepartie (frais exclus pour un envoi) ; mémo nettoyé |
| `hbar_build_tx` | `{ to, amount /*tinybars*/, memo?, account? }` | `{ bodies /*TransactionBody non signé par nœud, hex*/, summary: HbarTxSummary, context: { account, recipient, createsAccount } }` | refusé avant toute construction : notre compte inexistant ; destinataire `0.0.x` inconnu, supprimé ou exigeant sa signature (`receiverSigRequired`) ; transfert à soi-même ; mémo > 100 octets ou avec caractère de contrôle / invisible ; montant + frais max > solde |
| `hbar_sign_tx` | `{ bodies, password, account? }` | `{ signed /*Transaction signée par nœud, hex*/, summary, context }` | décode (strict, payeur = nous, nœuds de la liste), refuse un corps à moins de 45 s de sa fin de validité, **relit en direct** notre compte et le destinataire et refait les vérifications ci-dessus, mot de passe → dialogue natif : destinataire (adresse EVM signalée, et son compte selon le nœud miroir), montant, création du compte destinataire, frais maximum, payeur et solde, validité, identifiant, nœuds, puis le **MÉMO encadré sur sa propre ligne** (ou « AUCUN MÉMO » avec l'avertissement) ; 2ᵉ dialogue renforcé si `requiresExtraConfirmation` ; résumé de la signature = résumé affiché |
| `hbar_broadcast` | `{ signed, account? }` | `string` (`0.0.x@s.n`) | `hbar_verify_signed` de chaque copie (low-S, clé = la nôtre, copies identiques hors nœud, nœuds connus et distincts) puis soumission gRPC-web (voir ci-dessus) |
| `hbar_tx_status` | `{ id /*0.0.x@s.n ou 0.0.x-s-n*/ }` | `{ found, result }` | `/api/v1/transactions/{id}` : `found: true` et `result: 'SUCCESS'` une fois au consensus |
| `hbar_token_holdings` | `{ accountId /*0.0.x*/ }` | `[{ tokenId, associated, balance /*unités*/, frozen }]` | jetons connus seulement (USDC `0.0.456858` sur mainnet, `0.0.429274` sur testnet), nœud miroir `/accounts/{id}/tokens?token.id=…` |
| `hbar_build_associate_tx` | `{ tokenId, account? }` | comme `hbar_build_tx` (`summary.token.associate` = true, `amount` "0", `to` = notre compte) | `TokenAssociateTransactionBody` (champ 40 : compte = le payeur, un seul jeton connu) ; refusé si déjà associé ou compte absent ; frais maximum comme une création de compte (≈ 0,05 $). Signé par `hbar_sign_tx` : dialogue natif « Associer USDC » avec jeton, identifiant vérifié, décimales |
| `hbar_build_token_tx` | `{ tokenId, to, amount /*unités du jeton*/, memo?, account? }` | comme `hbar_build_tx` (`summary.token`, `amount` en unités du jeton, `context.token`) | CryptoTransfer avec une seule `TokenTransferList` (jeton connu, débit du payeur, crédit du destinataire, `expected_decimals` = table de Kyro), aucun transfert HBAR. wallet-core refuse tout autre jeton, NFT, plusieurs listes, HBAR + jetons, décimales absentes ou différentes, et (API sans réseau `hbar_decode_tx` / `hbar_sign`) tout jeton. Refusé avant : jeton non associé ou gelé chez nous, solde insuffisant, destinataire gelé, ou ni associé ni à association automatique (`max_automatic_token_associations` = 0) ; HBAR < frais maximum. Historique : `hbar_txs` ajoute `tokenTransfers` (variation nette par jeton), l'adaptateur garde les jetons connus |

Refusé avant toute signature : tout ce que `HbarTransfer::decode` refuse (§1) — autre type de transaction (CryptoUpdate, CryptoApproveAllowance, CryptoDelete, ContractCall, EthereumTransaction…), tokens HTS, `is_approval`, hooks, transactions programmées. Le nœud miroir peut mentir sur **notre** identifiant de compte (la transaction échouerait alors en `INVALID_SIGNATURE`, sans frais), le solde, l'existence du destinataire et son drapeau « signature exigée », le taux de change (frais max. affichés) ; pas sur ce qui est signé. Une adresse EVM est signée **telle quelle** (alias) : le réseau, pas le nœud miroir, décide du compte crédité. Hardware wallets : `HW_UNSUPPORTED`.

**Fait côté UI** : `Family` `'hbar'` (`hbarChain(network)`, clé `hedera`, CoinGecko `hedera-hashgraph`), `AccountChain` `'hbar'`, types `Commands` (`hbar_*`, `Accounts.hbar`), backend démo (`mock-hbar.ts`), écrans Envoyer (champ **Mémo** toujours visible sous le destinataire, état de notre compte, refus du destinataire avant construction, suivi `hbar_tx_status`), Recevoir (identifiant `0.0.x` avec somme HIP-15 quand le compte existe, sinon l'adresse EVM et l'explication de la création automatique), Actif (identifiant du compte), carnet d'adresses, « Connexions sortantes ». Adaptateur : `HbarAdapter` (`packages/chains/src/hedera/`).

### 2.11 Kaspa (KAS)

Serveur : l'API REST publique des développeurs Kaspa (`kaspa-rest-server`) — `api.kaspa.org` (mainnet), `api-tn10.kaspa.org` (testnet-10), sans clé, famille Tor `kaspa`, jamais de repli ; **pas de serveur personnalisé** pour l'instant. Réseau vérifié à chaque lecture (`GET /info/network` : `networkName` = `kaspa-mainnet` / `kaspa-testnet-10`, sinon `SERVER_WRONG_NETWORK`). **Rust construit la transaction** (wallet-core `kaspa_build_send`) depuis les pièces lues par Rust ; une transaction construite par le serveur n'est jamais signée.

**Dérivation** (identique à Kaspa NG, Kaspium et au portefeuille de rusty-kaspa, vecteurs officiels rejoués) : BIP39 → BIP32 secp256k1, `m/44'/111111'/a'/0/i` (réception) et `m/44'/111111'/a'/1/i` (monnaie), **même chemin sur testnet-10** (seul le préfixe change : `kaspatest:`). Adresse affichée : `…/0/0` ; monnaie : `…/1/0` ; lecture (solde, pièces, historique) : `…/0/0..19` et `…/1/0..19` (40 adresses, une requête). Adresses P2PK **Schnorr** (BIP340, clé x-only, script `OP_DATA_32 ‖ clé ‖ OP_CHECKSIG`). Hardware wallets : non proposé.

| Commande | Arguments | Retour | Notes |
|---|---|---|---|
| `kas_backend_info` | — | `{ kind: 'default', network: 'mainnet' \| 'testnet', label, tor }` | `label` = `api.kaspa.org` / `api-tn10.kaspa.org` |
| `kas_address` | `{ account? }` | `string` | coffre déverrouillé ; `m/44'/111111'/{account}'/0/0` (aussi dans `accounts_get` : `kas: { address, path }`) |
| `kas_account` | `{ account? }` | `{ address, balance, spendable, utxoCount, scanned }` | sompi en chaînes décimales ; `balance` : `POST /addresses/balances` des 40 adresses ; `spendable` / `utxoCount` : `POST /addresses/utxos`, sans les pièces de coinbase de moins de 2 000 DAA (2 × la maturité) ; **chaque pièce doit payer exactement le script P2PK de l'adresse sous laquelle elle est listée, qui doit être à nous**, sinon `SERVER_UNREACHABLE` pour toute la liste ; plus de 5 000 pièces : `INVALID_INPUT` (regrouper d'abord) |
| `kas_txs` | `{ account? }` | `[{ txid, time, delta /*signé*/, fee, counterparty, accepted }]` | `POST /addresses/active` puis `GET /addresses/{a}/full-transactions?limit=50&resolve_previous_outpoints=light` pour au plus 10 adresses actives (les plus récentes) ; fusion par txid, 50 au plus, plus récente d'abord ; `delta` = reçu − dépensé par nos adresses ; une transaction qui ne touche aucune de nos adresses est écartée ; `counterparty` seulement si c'est une adresse valide du réseau |
| `kas_tx_status` | `{ txid }` | `{ found, accepted }` | `GET /transactions/{txid}` (404 → `found: false`) |
| `kas_build_tx` | `{ to, amount? /*sompi*/, max?, account? }` | `{ tx /*JSON non signé*/, summary: KaspaTxSummary, context: { feerateEstimate, priorityFeerate, spendable } }` | refusé avant toute construction : adresse invalide ou d'un autre réseau, montant < **0,2 KAS** (masse de stockage KIP-9), fonds insuffisants, plus de 84 pièces nécessaires. Frais : `GET /info/fee-estimate` (`normalBuckets[0].feerate`, sompi/gramme) ; au minimum (100, réseau calme), frais = **100 sompi × masse de relais** (règle du mempool depuis Toccata, comme le portefeuille officiel) ; au-dessus, estimation (≤ 10 000) × masse totale. `max` : toutes les pièces (≤ 84), une seule sortie, pas de monnaie |
| `kas_sign_tx` | `{ tx, password, account? }` | `{ tx /*JSON signé*/, txId, summary }` | JSON strict (champs inconnus refusés), pas déjà signé ; **relit les pièces en direct** : chaque entrée doit être une pièce non dépensée de ce compte (sinon `INVALID_INPUT` « reconstruis ») ; montants et scripts viennent de cette relecture ; `kaspa_tx_summary` (refus listés au §1) → mot de passe → dialogue natif : chaque destinataire (adresse complète, montant), monnaie (« revient chez toi »), frais (KAS et sompi), **masse** (calcul, stockage KIP-9, transitoire), frais minimum de relais, nombre et total des entrées, « Pas de monnaie… » s'il n'y en a pas, identifiant ; **2ᵉ dialogue renforcé** si `requiresExtraConfirmation` (sortie de script inconnu, frais > 1 KAS ou > 10 × le minimum) ; résumé de la signature = résumé affiché |
| `kas_broadcast` | `{ tx, account? }` | `string` (txid) | pièces relues en direct, `kaspa_tx_summary`, **chaque signature vérifiée** (`kaspa_verify_signed`) puis `POST /transactions` `{ transaction, allowOrphan: false }` ; l'identifiant renvoyé doit être le nôtre, sinon `SERVER_UNREACHABLE` ; refus du nœud (HTTP 400) → `INVALID_INPUT` avec son message |

Transaction signée : **version 0** seulement (ce que construit encore le portefeuille officiel ; le format v1 de Toccata n'est ni produit ni signé), sous-réseau natif, gas 0, payload vide, lock time 0, séquence 0, un sig-op par entrée, `SIG_HASH_ALL`, script de signature `OP_DATA_65 ‖ signature(64) ‖ 0x01`. Masse (grammes) : calcul = octets + 10 × (2 + octets de script) par sortie + 1 000 par sig-op ; transitoire = 4 × octets (÷ 2 une fois normalisée) ; stockage KIP-9 = `C · (Σ p²/sortie − Σ p²/entrée)` (forme détendue pour 1 sortie, 1 entrée ou 2:2 ; sinon moyenne arithmétique des entrées), C = 10¹² ; masse totale ≤ 100 000. Exemple : 1 entrée, 2 sorties = 2 036 g → 0,002036 KAS.

**Fait côté UI** : `Family` `'kas'`, `kaspaChain(network)` (testnet = testnet-10), actif `kas` (CoinGecko `kaspa`), types `Commands` (`kas_*`, `Accounts.kas`, `AccountChain` `'kas'`), adresse TS (`isKaspaAddress`, `kaspaAddressProblem`, mêmes vecteurs que Rust), backend démo (`mock-kaspa.ts`), `KaspaAdapter` (`packages/chains/src/kaspa/`), écrans Envoyer (aucun frais à choisir, minimum 0,2 KAS, dépensable, transaction décodée avec masse avant le mot de passe, suivi d'acceptation), Recevoir (adresse `…/0/0`, pas de lien de paiement), Actif, Historique, carnet d'adresses, alerte d'empoisonnement (après `kaspa:q`), « Connexions sortantes ».

### 2.11 Polkadot (DOT sur Polkadot Asset Hub)

Depuis la migration vers Asset Hub (Polkadot, novembre 2025), les soldes DOT et les transferts vivent sur **Polkadot Asset Hub** (parachain 1000, `statemint`), pas sur la relay chain (vérifié le 01/11/2026 : `Balances.TotalIssuance` ≈ 1,71 milliard de DOT sur Asset Hub, ≈ 245 000 sur la relay chain). Testnet : **Westend Asset Hub** (`westmint`, WND, 12 décimales, préfixe SS58 42). Nœud : celui de Parity (`polkadot-asset-hub-rpc.polkadot.io`, `westend-asset-hub-rpc.polkadot.io`), JSON-RPC Substrate sur HTTPS, famille Tor `polkadot`, jamais de repli ; pas de serveur personnalisé pour l'instant.

**Clés** : sr25519 dérivées de l'**entropie** BIP39 par `substrate-bip39` (mini-secret = PBKDF2-HMAC-SHA512(entropie, « mnemonic » ‖ passphrase, 2048)[..32]), comme **Polkadot.js, Nova, Talisman et SubWallet** : le compte 0 de Kyro est le compte racine qu'ils affichent pour la même phrase. Compte `a ≥ 1` = dérivation dure `phrase//a` (notation Polkadot.js) : un autre portefeuille qui numérote ses comptes autrement (par exemple `//0` pour le 2ᵉ) donnera d'autres adresses pour ces comptes-là. **Pas compatible Ledger** : l'app Polkadot de Ledger dérive en ed25519 (`m/44'/354'/a'/0'/0'`, BIP32-Ed25519) ; une phrase Ledger importée dans Kyro donne une autre adresse. Vérifié contre Polkadot.js (racine, `//1`, `//2` de trois phrases).

**Rust construit le transfert** : genesis lu et comparé à l'épingle ; métadonnées V15 (`state_call Metadata_metadata_at_version(15)`, ≈ 0,7 Mo, mises en cache par version du runtime) **vérifiées par wallet-core** : l'index d'appel de `Balances.transfer_keep_alive` (`0x0a03`) est **épinglé** et doit être confirmé par les métadonnées, comme ses arguments et chaque extension de transaction (inconnue → refus) ; `spec_version` / `transaction_version` des métadonnées = celles de `state_getRuntimeVersion` ; nonce `system_accountNextIndex` ; ère mortelle de 256 blocs depuis le dernier bloc finalisé (`chain_getFinalizedHead`) ; pourboire 0 ; frais payés en DOT (`asset_id = None`) ; `CheckMetadataHash` désactivé (mode 0, `None`) ; frais estimés par `TransactionPaymentApi_query_info` sur une copie à signature nulle. Un nœud qui ment sur les métadonnées ne peut que rendre la transaction invalide : l'appel et son encodage sont ceux de Kyro, et genesis, versions et bloc de l'ère sont signés.

| Commande | Arguments | Retour | Notes |
|---|---|---|---|
| `dot_backend_info` | — | `{ network, chain, symbol, decimals, ss58, label, tor }` | |
| `dot_address` | `{ account? }` | `string` | coffre déverrouillé (racine sr25519 gardée en session, comme la racine Cardano) ; `dot_build_tx`, `dot_sign_tx`, `dot_broadcast` prennent le même `account?` |
| `dot_account` | `{ address }` | `{ address, exists, free, reserved, frozen, spendable, nonce, existentialDeposit }` (planck) | `System.Account` (`state_getStorage`) ; `spendable` = free − max(frozen − reserved, dépôt existentiel) : ce que `transfer_keep_alive` et les frais peuvent prendre ; dépôt existentiel lu dans les métadonnées (0,01 DOT ; Westend 0,001 WND) |
| `dot_build_tx` | `{ to, amount /*planck*/, account? }` | `{ payload /*hex*/, summary: DotTxSummary, context: { account, destination, existentialDeposit, fee, eraBirth, validUntil, finalized } }` | refusé avant toute construction : adresse d'un autre réseau (préfixe SS58), envoi à soi-même, destinataire inexistant et montant < dépôt existentiel, montant + frais > disponible, notre compte inexistant, runtime non reconnu |
| `dot_sign_tx` | `{ payload, password, account? }` | `{ extrinsic, hash, blockHash, summary, context }` | décode (strict, voir §1) avec le runtime **actuel**, vérifie le bloc de l'ère (connu, finalisé, phase cohérente, au moins 16 blocs de validité restants), le nonce, **relit en direct** les deux comptes et les frais, refait les vérifications ; mot de passe → racine sr25519 re-dérivée du coffre → dialogue natif : chaîne, destinataire, montant (DOT et planck), création du compte, frais estimés, solde, bloqué, dépôt existentiel, disponible, appel, pourboire, bloc limite, nonce, runtime ; résumé de la signature = résumé affiché. Pas de 2ᵉ dialogue : rien d'inhabituel n'est accepté, tout est refusé |
| `dot_broadcast` | `{ extrinsic, blockHash, account? }` | `string` (hash) | `dot_verify_extrinsic` (signature sr25519 de notre clé sur la charge reconstruite avec le runtime actuel et `blockHash`) puis `author_submitExtrinsic` ; refus du nœud (1010…) → `INVALID_INPUT` ; hash du nœud ≠ blake2-256(extrinsèque) → `SERVER_UNREACHABLE` |
| `dot_tx_status` | `{ address, nonce, validUntil }` | `{ state: 'pending' \| 'finalized' \| 'expired', finalized }` | par le nonce dans l'état **finalisé** : `finalized` = la transaction de ce nonce est incluse (Kyro ne décode pas les événements : un transfert inclus mais échoué consommerait aussi le nonce) ; `expired` = ère passée et nonce inutilisé |
| `dot_txs` | `{ address }` | `{ available, partial, items: [{ id, hash?, chain: 'assetHub' \| 'relay', blockHeight, extrinsicIndex?, eventIndex?, time (ms), from, to, amount (planck), direction: 'in' \| 'out' \| 'self' }] }` | **jamais d'erreur** : `available: false` (testnet, Statescan injoignable ou réponse inattendue) ; `partial` = une des deux chaînes n'a pas pu être lue ; `id` = hash de l'extrinsic si connu, sinon `ahp:{bloc}-{index}` / `relay:{bloc}-{index}` |
| `dot_asset_balances` | `{ address }` | `[{ assetId, balance /*unités*/, frozen, minBalance }]` | jetons connus seulement (Polkadot Asset Hub : USD₮ actif 1984, USDC actif 1337 ; aucun sur Westend) ; `Assets.Metadata` relu et comparé à la table de Kyro (symbole `USDt` / `USDC`, 6 décimales) avant tout, `Assets.Asset` (solde minimum, statut), `Assets.Account` |
| `dot_build_asset_tx` | `{ assetId, to, amount /*unités du jeton*/, account? }` | comme `dot_build_tx` (`summary.call` = `Assets.transfer_keep_alive`, `summary.asset`, `amount` / `symbol` / `decimals` du jeton ; `context.asset`) | `Assets.transfer_keep_alive(Compact(id), MultiAddress::Id, Compact(montant))`, indices épinglés (pallet 50, appel 9) et confirmés par les métadonnées V15 (arguments, dispositions de `Assets.Account` / `Asset` / `Metadata`) : sinon les jetons sont refusés, DOT continue. Frais en DOT (`asset_id = None`). Refusé : actif inconnu, actif gelé / non Live, notre solde gelé, destinataire bloqué, montant > solde − solde minimum du jeton (il reste sur le compte), nouveau détenteur sous le solde minimum, DOT insuffisants pour les frais. Signé par `dot_sign_tx` : dialogue natif avec jeton, identifiant vérifié, décimales, montant, notre solde du jeton. Pas d'historique des jetons (Statescan n'en fournit pas sous une forme vérifiée) |

**Historique : Statescan (sans clé, mainnet seulement).** Un nœud Substrate n'indexe pas les transferts par compte, et Subscan exige une clé API (« Unauthenticated access is disabled », vérifié le 01/11/2026). Rust lit l'API REST publique de **Statescan** : `GET https://ahp-api.statescan.io/accounts/{ss58}/transfers?page=0&page_size=50` (Asset Hub) et la même route sur `polkadot-api.statescan.io` (relay chain, transferts d'avant la migration), puis `GET /extrinsics/{bloc}-{index}` → `hash` (au plus 12 nouveaux par appel, mis en cache pour la session). API non documentée : lecture défensive (`balance` décimal ou `0x…` hexadécimal, `extrinsicIndex` absent pour un transfert sans extrinsic, entrées mal formées ignorées une à une), seuls les transferts natifs (`isNativeAsset`) où notre compte (comparé par identifiant de compte) est émetteur ou destinataire sont gardés. Westend : pas d'API Statescan, donc indisponible. L'UI dit « historique indisponible » au lieu d'afficher « aucune transaction » quand rien n'a pu être lu. Hardware wallets : `HW_UNSUPPORTED`.

**Fait côté UI** : `Family` `'dot'`, `AccountChain` `'dot'`, `Accounts.polkadot`, types `Commands` (`dot_*`), backend démo (`mock-dot.ts`, clé démo : pas la vraie dérivation sr25519), Envoyer (disponible, dépôt existentiel, frais, aperçu Rust, suivi par nonce), Recevoir (adresse, chemin, dépôt existentiel), Actif, « Connexions sortantes ». Adaptateur : `PolkadotAdapter` (`packages/chains/src/polkadot/`), `polkadotChain(network)`.

### 2.11 Algorand (paiements ALGO)

Serveurs par défaut, **sans clé** (offre gratuite d'AlgoNode / Nodely) : algod `mainnet-api.algonode.cloud` / `testnet-api.algonode.cloud` (comptes, paramètres, diffusion, suivi) et indexer `mainnet-idx.algonode.cloud` / `testnet-idx.algonode.cloud` (historique), famille Tor `algorand`, jamais de repli. Pas encore de serveur personnalisé (algod / indexer à toi) : seuls ces hôtes sont contactés. **Rust construit le paiement** : `fee` = max(`min-fee`, `fee` par octet × taille signée) de `/v2/transactions/params` (0,001 ALGO hors congestion), `fv` = `last-round`, `lv` = `fv` + 200 (≈ 9 min ; le protocole autorise 1000), `gen` / `gh` = ceux de wallet-core pour le réseau de l'app (le serveur doit annoncer exactement le même genesis, sinon `SERVER_WRONG_NETWORK`), note UTF-8 facultative ; encodé par wallet-core en msgpack canonique. Une transaction construite par le serveur n'est jamais signée.

Clés : BIP39 (la phrase du coffre), chemin **`m/44'/283'/a'/0/0` dérivé comme l'app Algorand de Ledger** (BIP32-Ed25519 du Ledger OS, vecteur des tests de l'app Ledger : compte 123). **Pas** le format Pera / « Algorand Wallet » à 25 mots (une clé brute, sans BIP39 ni dérivation) : une phrase de 25 mots ne s'importe pas dans Kyro, et une phrase Kyro ne s'ouvre pas dans Pera ; elle s'ouvre dans Ledger Live (app Algorand) avec les mêmes adresses.

| Commande | Arguments | Retour | Notes |
|---|---|---|---|
| `algo_backend_info` | — | `{ kind: 'default', network: 'mainnet' \| 'testnet', label /*algod*/, indexer, tor }` | |
| `algo_address` | `{ account? }` | `string` | `m/44'/283'/{account}'/0/0`, coffre déverrouillé ; `algo_build_tx`, `algo_sign_tx`, `algo_broadcast` prennent le même `account?` |
| `algo_account` | `{ address }` | `{ address, exists, balance /*µALGO*/, minBalance, spendable, assets, authAddr, round }` | algod `/v2/accounts/{a}?exclude=all` ; `minBalance` = celui calculé par algod (**0,1 ALGO** + 0,1 par ASA / application activés…) ; `spendable` = solde − `minBalance` ; compte vide : `exists: false` (il n'existe sur la chaîne qu'après ≥ 0,1 ALGO) ; `authAddr` ≠ null : compte « rekeyé », la clé de Kyro ne signe plus pour lui |
| `algo_txs` | `{ address }` | `[{ id, type, from, to, amount, fee, closeTo, closeAmount, round, time, note }]` | indexer, 50 dernières ; `note` = texte UTF-8 nettoyé (ou null) ; types autres que `pay` gardés avec `amount: '0'` |
| `algo_build_tx` | `{ to, amount /*µALGO*/, note?, account? }` | `{ blob /*msgpack non signé, hex*/, summary: AlgoTxSummary, context: { account, destination, round } }` | refusé avant toute construction : compte rekeyé ou vide ; montant + frais > `spendable` ; destinataire qui resterait sous son `minBalance` (compte vide : au moins 0,1 ALGO) ; note > 1024 octets |
| `algo_sign_tx` | `{ blob, password, account? }` | `{ blob /*signé*/, txid, summary, context }` | décode (strict, voir ci-dessous), refuse une fenêtre de validité dépassée, **relit en direct** paramètres (genesis) et les deux comptes et refait les vérifications ci-dessus, mot de passe → dialogue natif avec ce que Rust a décodé : destinataire, montant, création du compte destinataire, frais, solde / solde minimum / disponible, **réseau (genesis id et hash)**, rounds de validité, note (texte nettoyé, ou hexadécimal si binaire), identifiant ; 2ᵉ dialogue renforcé si `requiresExtraConfirmation` (note, frais > 0,01 ALGO) ; résumé de la signature = résumé affiché |
| `algo_broadcast` | `{ blob, account? }` | `string` (txid) | `algo_verify_signed` (décodage strict, mêmes refus, signature ed25519 `verify_strict` par l'expéditeur = nous, bon réseau) puis `POST /v2/transactions` (msgpack brut) ; refus du nœud → `INVALID_INPUT` avec son message ; `txId` du serveur ≠ le nôtre → `SERVER_UNREACHABLE` |
| `algo_tx_status` | `{ txid }` | `{ confirmed, round, error }` | algod `/v2/transactions/pending/{txid}` (`confirmed-round`, `pool-error`), puis l'indexer s'il n'y est plus ; un bloc Algorand est définitif |
| `algo_asset_holdings` | `{ address }` | `[{ assetId, optedIn, amount /*unités*/, frozen }]` | jetons connus seulement (mainnet : USDC ASA 31566704, USD₮ ASA 312769 ; testnet : USDC 10458941), algod `/v2/accounts/{a}/assets/{id}` (404 = pas activé), id de la réponse vérifié |
| `algo_build_optin_tx` | `{ assetId, account? }` | comme `algo_build_tx` (`summary.asset.optIn` = true, `context.asset`) | activation (opt-in) : transfert `axfer` de 0 unité à soi-même ; refusé si déjà activé ou si `spendable` < 0,1 ALGO (hausse du solde minimum) + frais. Signé par `algo_sign_tx` : le dialogue natif affiche « Activer USDC », le jeton, son identifiant vérifié, ses décimales et l'effet sur le solde minimum |
| `algo_build_asset_tx` | `{ assetId, to, amount /*unités du jeton*/, note?, account? }` | comme `algo_build_tx` (`summary.amount` = "0", `summary.asset`, `context.asset`) | transfert `axfer` d'un jeton connu ; refusé : jeton non activé ou gelé (chez nous ou chez le destinataire), solde du jeton < montant, ALGO dépensables < frais. wallet-core refuse tout autre actif, `aclose` (fermeture) et `asnd` (clawback) ; le dialogue natif affiche jeton, identifiant vérifié, décimales, montant, destinataire et notre solde du jeton. Pas encore sur hardware wallet |

Refusé avant toute signature (wallet-core `algo_decode_tx`) : tout autre type que `pay` (`axfer`, `appl`, `keyreg`, `acfg`, `afrz`…), **`close` (close-remainder-to : tout le solde restant partirait ailleurs et le compte serait fermé)**, **`rekey` (le contrôle du compte passerait à une autre clé)**, `grp` (transaction groupée), `lx` (bail), tout champ inconnu, tout encodage qui ne se ré-encode pas **octet pour octet** à l'identique (ordre des clés, champ vide explicite, forme d'entier ou de longueur non minimale, octets en trop), expéditeur ≠ nous, autre réseau (`gen` ou `gh`), destinataire nul ou nous-mêmes, montant nul, frais < 0,001 ALGO, fenêtre `fv`…`lv` invalide ou > 1000 rounds, note > 1024 octets. Transaction signée : exactement `{ sig, txn }` (pas de `sgnr`, `msig`, `lsig`). Hardware wallets : non proposé (l'UI masque Algorand pour un compte hardware wallet).

**Pour l'UI** : afficher `spendable` (pas seulement le solde) et le solde minimum ; pour un destinataire vide, « au moins 0,1 ALGO » ; la note est facultative, publique pour toujours, ≤ 1024 octets ; après `algo_broadcast`, suivre `algo_tx_status`. **Fait côté UI** : `Family` `'algo'`, `AccountChain` `'algo'`, types `Commands` (`algo_*`, `Accounts.algo`), backend démo (`mock-algo.ts`), écrans Envoyer (note, solde dépensable, minimum du destinataire, résumé décodé, suivi) / Recevoir (solde minimum expliqué, Ledger ≠ Pera) / Actif / Historique, « Connexions sortantes ». Adaptateur : `AlgorandAdapter` (`packages/chains/src/algorand/`), `algorandChain(network)`, prix CoinGecko `algorand`.

### 2.11 Monero (XMR)

**Conception : nœud `monerod` + analyse locale.** Rust télécharge les blocs (`get_blocks.bin`, élagués) et les analyse **lui-même** avec monero-wallet (`Scanner`, clé de vue privée en mémoire uniquement) ; les sorties dépensées sont reconnues par leurs *key images*, calculées localement avec la clé de dépense. **Aucun serveur « light wallet »** (MyMonero, `monero-lws`) : ils exigent la clé de vue, donc voient tout l'historique entrant. En contrepartie, la première synchronisation télécharge chaque bloc depuis la hauteur de restauration (coffre créé : 1 jour avant la première ouverture du compte sur cet appareil ; phrase restaurée : la première version de Kyro, bloc 3 790 000 ≈ 2026-10-22, car un portefeuille Monero dérivé par Kyro ne peut pas être plus ancien, sauf date plus ancienne ou genèse choisie à la restauration pour une phrase déjà utilisée avec Monero sur un Ledger ; plus ancienne ensuite avec `xmr_set_restore_height`). Le scan reprend après un redémarrage depuis la hauteur enregistrée après chaque lot. État de scan chiffré à côté du coffre (`monero/<réseau>-<compte>-<clé>.bin`). Réorganisation : le hash du dernier bloc est revérifié ; en cas d'écart, les 30 derniers blocs sont rescannés. Hardware wallet : `HW_UNSUPPORTED`.

| Commande | Arguments | Retour | Notes |
|---|---|---|---|
| `xmr_backend_info` | — | `{ kind: 'default' \| 'node', network: 'mainnet' \| 'stagenet', label, tor }` | |
| `xmr_address` | `{ index?, account? }` | `string` | 0 = adresse principale ; `n ≥ 1` = sous-adresse déjà distribuée seulement ; le premier appel crée l'état de scan |
| `xmr_new_subaddress` | `{ account? }` | `{ index, address, received }` | sous-adresse suivante (100 000 au plus), surveillée avec 200 d'avance |
| `xmr_subaddresses` | `{ account? }` | `[{ index, address, received /*piconero*/ }]` | |
| `xmr_status` | `{ account? }` | `{ running, restoreHeight, scanned, tip, tipTime, progress /*0…1*/, balance, unlocked, syncedAt, error, subaddresses, ignoredOutputs, node }` | `unlocked` = dépensable (10 confirmations, 60 pour un coinbase) ; sorties brûlées en double ou à timelock ignorées et comptées |
| `xmr_sync` | `{ account? }` | `XmrStatus` | lance le scan en arrière-plan (sans effet s'il tourne) ; s'arrête au verrouillage ; `LOCKED` si verrouillé |
| `xmr_txs` | `{ account? }` | `[{ txid, direction: 'in' \| 'out' \| 'self', amount, fee?, to?, height, time, confirmations }]` | historique local (500 au plus) ; `to` seulement pour nos envois |
| `xmr_validate_address` | `{ address }` | `XmrDestination` | décodage Rust (voir §1) |
| `xmr_set_restore_height` | `{ height, account? }` | `XmrStatus` | oublie l'état de scan et repart de `height` ; refusé pendant un scan |
| `xmr_prepare_tx` | `{ to, amount? /*piconero, absent = tout le disponible*/, account? }` | `{ id, summary: XmrTxSummary }` | Rust choisit les entrées (16 au plus), télécharge distribution et leurres, borne le taux de frais du nœud (4 000 000 piconero/poids max), fixe la monnaie vers l'adresse principale ; le transfert **reste dans Rust** (usage unique, 10 min) |
| `xmr_send_tx` | `{ id, password, account? }` | `{ txid, summary }` | mot de passe → dialogue natif (destination et son type, montant, frais, monnaie, entrées, anneau, nœud) → 2ᵉ fenêtre renforcée si `requiresExtraConfirmation` → signature → vérification (sorties exactes, frais, key images = sorties prévues) → `send_raw_transaction` → sorties marquées dépensées localement (libérées après 24 h si la transaction n'apparaît pas) |
| `xmr_seed_show` | `{ password, account? }` | — | phrase Monero de 25 mots + hauteur de restauration, **en fenêtre native uniquement** (rien n'est renvoyé à l'interface) |

Serveur : `Servers.monero.{mainnet,testnet}` = `{ kind: 'default' } | { kind: 'node', url }` (`https://` ou `.onion` via Tor), vérifié à l'enregistrement (`get_info.nettype` et hash du bloc 0), jamais de repli sur le nœud par défaut. Famille Tor `monero`, **échec fermé** (`TOR_UNAVAILABLE` reste `TOR_UNAVAILABLE` à travers monero-daemon-rpc).

### 2.11 TON (Gram, ex-Toncoin — ticker GRAM depuis juin 2026 ; portefeuille v4R2)

Serveur : **TON Center** (API v3), `toncenter.com` sur mainnet, `testnet.toncenter.com` sur testnet, famille Tor `ton`, jamais de repli ; pas de serveur personnalisé TON pour l'instant. Offre sans clé ≈ 1 requête/s par IP : toutes les requêtes TON de l'app sont espacées d'au moins 1,1 s, une à la fois, et un `429` est réessayé trois fois (voir [NETWORK.md](NETWORK.md)). **Rust construit le transfert** : seqno et états lus à TON Center (`walletInformation`), `valid_until` = maintenant + 10 min, wallet id du réseau, cellules écrites par wallet-core ; un message construit par le serveur n'est jamais signé. Frais : **estimés** par émulation (`estimateFee`, signature non vérifiée), affichés « ≈ ».

| Commande | Arguments | Retour | Notes |
|---|---|---|---|
| `ton_backend_info` | — | `{ network: 'mainnet' \| 'testnet', label /*hôte*/, tor }` | |
| `ton_address` | `{ account? }` | `string` | `m/44'/607'/{account}'`, coffre déverrouillé, forme non rebondissante `UQ…` (testnet `0Q…`) |
| `ton_account` | `{ address }` | `{ address /*UQ…*/, raw /*0:hex*/, status: 'active' \| 'uninit' \| 'frozen' \| 'nonexist', balance /*nanotons*/, seqno: number \| null, walletType: string \| null }` | forme lisible seulement (brute `0:…` refusée) ; adresse marquée testnet (`kQ…` / `0Q…`) refusée sur mainnet ; masterchain refusée |
| `ton_txs` | `{ address }` | `[{ hash /*tx, hex*/, time, direction: 'in' \| 'out', counterparty, amount, fee, comment, bounced, success }]` | 50 dernières transactions du compte ; un message externe de notre portefeuille donne une ligne par message sortant (aucun : ligne « échouée » à 0) ; `success` = phases calcul **et** action réussies, aucune action ignorée |
| `ton_build_tx` | `{ to, amount /*nanotons*/, comment?, sendAll?, account? }` | `{ boc /*non signé, base64*/, summary: TonTxSummary, context: { account, destination, fee } }` | refusé avant toute construction : destinataire gelé, masterchain, notre portefeuille vide (`uninit` à 0, `nonexist`) ou gelé, montant + frais estimés ≥ solde, commentaire > 123 octets. **Rebond** = drapeau de l'adresse saisie (`EQ…` oui, `UQ…` non), **coupé** si le destinataire n'est pas un contrat actif (sinon les fonds reviendraient). Portefeuille pas encore déployé (`uninit` avec un solde) : seqno 0 et notre `StateInit` dans le message. `sendAll` : mode 130 (tout le solde, frais déduits), montant 0 |
| `ton_jetton_balances` | `{ address }` | `[{ master /*EQ…*/, wallet /*EQ…*/, balance /*unités*/ }]` | une ligne par jeton connu (USD₮ sur mainnet, aucun sur testnet). `wallet` = portefeuille de jetons **calculé par wallet-core** (code du portefeuille de jetons du master + notre adresse) ; une ligne de TON Center pour un autre contrat est ignorée (solde 0) |
| `ton_jetton_txs` | `{ address }` | `[{ hash, time, direction, master, counterparty, amount /*unités*/, comment, success }]` | `jetton/transfers` par jeton connu ; ligne gardée seulement si `source_wallet` est le portefeuille de jetons calculé pour l'expéditeur (un faux contrat de jeton ne passe pas) |
| `ton_build_jetton_tx` | `{ master /*EQ…*/, to, amount /*unités du jeton*/, comment?, account? }` | `{ boc, summary: TonTxSummary /*jetton renseigné*/, context: { account, destination /*notre portefeuille de jetons*/, fee } }` | jeton connu de wallet-core seulement ; message interne (mode 3, rebond) vers **notre** portefeuille de jetons calculé, 0,05 TON joints, corps TEP-74 `transfer#0f8a7ea5` (destinataire, `response_destination` = notre portefeuille, `forward_ton_amount` 1 nanoton, commentaire dans la charge transmise). Refusé : portefeuille de jetons absent, solde du jeton < montant (relu en direct, et encore à la signature), TON < 0,05 + frais. `ton_sign_tx` décode le corps et le dialogue natif affiche jeton, contrat (master), décimales, montant, destinataire (deux formes), commentaire encadré |
| `ton_sign_tx` | `{ boc, password, account? }` | `{ boc /*signé*/, hash, normalizedHash, summary, context }` | décode (strict, wallet id du réseau, notre portefeuille), refuse un message expiré (ou à moins de 15 s de l'être) ou valable plus de 12 min, **relit en direct** notre portefeuille (seqno et déploiement doivent correspondre) et le destinataire, réestime les frais et refait les vérifications ci-dessus ; mot de passe → dialogue natif : destinataire dans la forme de son drapeau de rebond **et** dans l'autre forme (« même compte »), **COMMENTAIRE encadré sur sa propre ligne** (ou « AUCUN COMMENTAIRE », avec l'avertissement plateforme d'échange), montant en TON et nanotons (ou « TOUT LE SOLDE »), rebond expliqué, frais estimés, solde, déploiement du portefeuille, validité et seqno ; 2ᵉ fenêtre si le commentaire contient des caractères invisibles ou de contrôle ; signature, résumé identique exigé |
| `ton_broadcast` | `{ boc, account? }` | `string` (hash normalisé, hex) | `ton_verify_signed` (strict, signature ed25519 valide par notre clé, notre réseau), refuse un message expiré, puis `POST /message` ; un refus du nœud (seqno, expiration, signature) → `INVALID_INPUT` avec son message ; les hashes renvoyés par TON Center doivent être les nôtres, sinon `SERVER_UNREACHABLE` |
| `ton_tx_status` | `{ hash /*normalisé*/ }` | `{ found, success, txHash }` | `transactionsByMessage` : la transaction de notre portefeuille qui a traité le message |

**Pour l'UI** : le champ **Commentaire** est visible en permanence sous le destinataire sur l'écran Envoyer TON (pas caché dans « options »), compteur d'octets (123 au plus), caractères de contrôle et invisibles refusés avant même l'appel ; avertissement « plateforme d'échange » quand il est vide ; état du destinataire (pas encore actif → envoi sans rebond, gelé → bloqué) ; « MAX » = `sendAll`. Comparer une adresse TON se fait **par compte** (`EQ…` et `UQ…` d'un même compte sont la même adresse : `sameTonAccount`). Lien de paiement à la réception : `ton://transfer/<adresse>?amount=<nanotons>`. Hardware wallets : pas de TON.

### 2.11 Cosmos Hub (ATOM)

Rust choisit le serveur : le LCD (REST) par défaut — `cosmos-rest.publicnode.com` (mainnet, `cosmoshub-4`) ou `rest.provider-sentry-01.hub-testnet.polypore.xyz` (testnet public du Hub, chain-id `provider`) —, famille Tor `cosmos`, jamais de repli (ni vers un autre serveur, ni en clair). **Pas encore de serveur personnalisé** pour Cosmos. Chaque lecture d'état vérifie le chain-id du dernier bloc (`blocks/latest`) : un autre réseau → `SERVER_WRONG_NETWORK`.

**Rust construit la transaction** : chain-id et hauteur (`/cosmos/base/tendermint/v1beta1/blocks/latest`), `account_number` et `sequence` (`/cosmos/auth/v1beta1/accounts/{a}` : `BaseAccount` ou compte de vesting ; un autre type est refusé ; une clé publique enregistrée qui n'est pas la nôtre aussi), `timeout_height` = hauteur + 100 (≈ 10 min), un seul `MsgSend` d'uatom, mémo, SIGN_MODE_DIRECT ; la transaction **exacte** (frais 0, signature vide) est simulée (`POST /cosmos/tx/v1beta1/simulate`) : gas = utilisé × 1,4 (refusé au-delà de 500 000), frais = gas × prix du marché des frais (`/feemarket/v1/gas_price/uatom`, refusé au-delà de 1 uatom/gas ; 0,005 uatom/gas — le `min_base_gas_price` du Hub, lu le 01/11/2026 — si le serveur n'a pas ce module) × 1,2, arrondi au-dessus. Encodé par wallet-core ; une transaction construite par le serveur n'est jamais signée.

| Commande | Arguments | Retour | Notes |
|---|---|---|---|
| `cosmos_backend_info` | — | `{ kind: 'default', network, label, chainId, tor }` | |
| `cosmos_address` | `{ account? }` | `string` | `m/44'/118'/{account}'/0/0`, coffre déverrouillé ; une adresse par compte ; `cosmos_build_tx`, `cosmos_sign_tx`, `cosmos_broadcast` prennent le même `account?` |
| `cosmos_account` | `{ address }` | `{ address, exists, accountNumber, sequence, pubKey /*base64 ou null*/, balance /*uatom*/, spendable /*uatom*/ }` | `auth/accounts` + `bank/balances/{a}/by_denom?denom=uatom` + `bank/spendable_balances/…` (vesting) ; compte jamais vu (gRPC NotFound, HTTP 404) : `exists: false` |
| `cosmos_txs` | `{ address }` | `[{ hash, height, time, from, to, amount, fee, memo, success }]` | `MsgSend` d'uatom seulement (les autres messages et les tokens IBC sont ignorés), 25 derniers envoyés (`message.sender`) + 25 derniers reçus (`transfer.recipient`), triés, 50 au plus ; `memo` nettoyé ; `fee` = `"0"` si ce n'est pas nous qui l'avons payé. **Le nœud public n'indexe que les blocs récents** : l'historique ancien n'apparaît pas |
| `cosmos_build_tx` | `{ to, amount /*uatom*/, memo?, account? }` | `{ signDoc /*hex*/, summary: CosmosTxSummary, context: { account, height } }` | refusé avant toute construction : envoi à soi-même, adresse invalide, mémo > 512 caractères, notre compte inconnu du réseau, montant + frais > `spendable`, simulation refusée (message du nœud, `INVALID_INPUT`) |
| `cosmos_sign_tx` | `{ signDoc, password, account? }` | `{ tx /*TxRaw base64*/, hash, summary, context }` | décode (strict, clé = nous, chain-id du réseau), **relit en direct** le dernier bloc et notre compte : refuse `timeout_height` dépassé, `account_number` différent, séquence périmée, solde insuffisant ; mot de passe → dialogue natif : destinataire, montant (ATOM + uatom), frais (ATOM + uatom) et gas maximum, disponible et reste après l'envoi, chain-id, numéro de compte, séquence, bloc limite, puis **MÉMO encadré sur sa propre ligne** (ou « AUCUN MÉMO » avec l'avertissement des plateformes d'échange), après les montants ; 2ᵉ dialogue renforcé si `requiresExtraConfirmation` (avec le mémo exact en hexadécimal s'il a été nettoyé) ; résumé de la signature = résumé affiché |
| `cosmos_broadcast` | `{ tx, account? }` | `string` (hash) | `cosmos_verify_signed` avec l'`account_number` lu en direct (signature low-S de notre clé sur le SignDoc reconstruit) puis `POST /cosmos/tx/v1beta1/txs` (`BROADCAST_MODE_SYNC`) ; code 0 (ou 19 du codespace `sdk` : déjà dans le mempool) accepté, sinon `INVALID_INPUT` avec le code et le journal ; hash du serveur = `SHA-256(TxRaw)` sinon `SERVER_UNREACHABLE` |
| `cosmos_tx_status` | `{ hash }` | `{ included, success, code, height, log }` | `GET /cosmos/tx/v1beta1/txs/{hash}` ; pas encore dans un bloc : `included: false` |

```ts
type CosmosWarning = { kind: 'highFee' } | { kind: 'unusualText' };   // toutes → confirmation renforcée
type CosmosTxSummary = { chainId; accountNumber; sequence; from; to; amount /*uatom*/; fee /*uatom*/; gasLimit;
                         memo: string | null /*nettoyé*/; memoHex: string | null; timeoutHeight; warnings: CosmosWarning[];
                         requiresExtraConfirmation: boolean };
```

Refusé avant toute signature : tout autre message (**MsgDelegate**, **MsgGrant** / authz, **MsgTransfer** IBC, MsgExec, MsgMultiSend…), une autre dénomination qu'`uatom` (tokens IBC), plusieurs messages ou pièces, SIGN_MODE_LEGACY_AMINO_JSON / TEXTUAL, multisig, frais payés par un tiers (`payer`, `granter` / feegrant), transactions « unordered » (SDK 0.53), `timeout_timestamp`, options d'extension, `tip`. Plus strict que « inconnu → confirmation renforcée » : un champ que Kyro ne déclare pas n'est jamais signé. Hardware wallets : pas de commande `hw_*` Cosmos (Ledger app « Cosmos », SIGN_MODE_LEGACY_AMINO_JSON : non fait) ; l'UI désactive Cosmos pour ces comptes.

**Pour l'UI** : le champ **Mémo** est visible en permanence sous le destinataire (pas dans « options »), vide par défaut, avec l'avertissement « les plateformes d'échange exigent presque toujours un mémo » ; 256 caractères au plus et aucun caractère de contrôle (ce que la fenêtre native affiche en entier ; Rust en accepte 512 mais affiche alors un mémo coupé, donc renforcé) ; afficher `spendable` quand il diffère du solde (vesting) ; après `cosmos_broadcast`, suivre `cosmos_tx_status`.

### 2.11 Aptos (APT)

Serveur : fullnode REST d'Aptos Labs, `https://api.mainnet.aptoslabs.com/v1` / `https://api.testnet.aptoslabs.com/v1` (offre publique **sans clé**), et son indexeur `/v1/graphql` (même hôte) pour l'historique ; famille Tor `aptos`, jamais de repli. **Pas de serveur personnalisé pour l'instant.** Avant toute construction, Rust lit `/v1` et refuse un `chain_id` autre que celui du réseau de l'app (1 mainnet, 2 testnet : `SERVER_WRONG_NETWORK`). **Rust construit le transfert** : numéro de séquence (`/accounts/{a}`), prix du gaz (`/estimate_gas_price`, borné à 10 000 octas par unité), gaz maximum = gaz de la simulation (`/transactions/simulate`, signature nulle) × 1,5, entre 200 et 20 000 unités, expiration = heure du registre + 10 min ; BCS écrit par wallet-core. Une transaction construite par le serveur n'est jamais signée. Le réseau exige que le solde couvre **montant + gaz maximum × prix** d'avance : « tout envoyer » envoie donc solde − frais maximum (la part non utilisée reste).

| Commande | Arguments | Retour | Notes |
|---|---|---|---|
| `aptos_backend_info` | — | `{ network: 'mainnet' \| 'testnet', label, tor }` | |
| `aptos_address` | `{ account? }` | `string` | `m/44'/637'/{account}'/0'/0'`, coffre déverrouillé ; `aptos_build_tx`, `aptos_sign_tx`, `aptos_broadcast` prennent le même `account?` |
| `aptos_account` | `{ address }` | `{ address, balance /*octas*/, sequenceNumber, authenticationKey, keyMatches }` | solde `/accounts/{a}/balance/0x1::aptos_coin::AptosCoin` (pièce + magasin primaire d'actif fongible) ; compte jamais vu : séquence 0, solde 0 ; `keyMatches: false` = la clé du compte a été changée (rotation) : Kyro refuse alors de construire et de signer |
| `aptos_txs` | `{ address }` | `[{ version, hash, time, direction, amount, fee, counterparty, success, function, sentByUs }]` | 50 dernières, indexeur (`fungible_asset_activities`, APT en pièce et en actif fongible `0xa`, regroupées par transaction : dépôts − retraits, gaz à part) + `/accounts/{a}/transactions` (nos envois : hash et destinataire) ; `counterparty` connu seulement pour nos envois |
| `aptos_build_tx` | `{ to, amount /*octas*/, account? }` | `{ raw /*RawTransaction BCS hex*/, summary: AptosTxSummary, context: { account, recipientNew, gasUsed, ledgerTime } }` | refusé avant toute construction : adresse refusée (voir §1), clé changée, montant > solde, simulation qui échoue (son `vm_status` est donné), gaz simulé > 13 333 unités, montant + frais maximum > solde |
| `aptos_sign_tx` | `{ raw, password, account? }` | `{ signed /*hex*/, hash, summary, context }` | décode (strict, expéditeur = nous, `chain_id` de l'app), refuse une expiration à moins de 30 s ou à plus de 11 min, **relit en direct** le compte (séquence identique, clé, solde ≥ montant + frais maximum) et **re-simule** ; mot de passe → dialogue natif : destinataire complet (« sans somme de contrôle »), montant (APT et octas), création du compte destinataire, frais estimés (gaz simulé × prix) et maximum, solde, fonction, séquence, chaîne, expiration ; 2ᵉ dialogue renforcé si `requiresExtraConfirmation` ; résumé de la signature = résumé affiché |
| `aptos_broadcast` | `{ signed, account? }` | `string` (hash `0x…`) | `aptos_verify_signed` (une seule clé ed25519 = expéditeur = nous, bonne chaîne) puis `POST /transactions` (BCS, `application/x.aptos.signed_transaction+bcs`) ; refus du nœud → `INVALID_INPUT` avec son message ; hash du nœud ≠ hash calculé → `SERVER_UNREACHABLE` |
| `aptos_tx_status` | `{ hash }` | `{ committed, success, vmStatus }` | `/transactions/by_hash` : en attente ou introuvable = `committed: false` |

**Limite de débit** : Aptos Labs limite les requêtes anonymes par IP (50 000 unités de calcul par 5 minutes, documentation Geomi lue le 01/11/2026). En mode Tor, l'IP du relais de sortie est partagée : une réponse 429 donne `SERVER_UNREACHABLE` avec un message clair, jamais de nouvel essai en clair. Clé API : non prise en charge pour l'instant.

Hardware wallets : non proposé (aucune commande `hw_*`). Ce qu'il faudrait : Ledger app « Aptos » (signature d'un `RawTransaction` BCS que l'app affiche) ; Kyro vérifierait la signature contre son propre message de signature, comme ailleurs.

**Fait côté UI** : `Family` `'apt'`, `AccountChain` `'apt'`, types `Commands` (`aptos_*`, `Accounts.aptos`), backend démo (`mock-aptos.ts`), écrans Portefeuille / Actif / Recevoir (adresse seule, sans lien de paiement) / Envoyer (adresse complète obligatoire, avertissement « sans somme de contrôle », création du compte destinataire, frais estimés et maximum, résumé Rust avant le mot de passe, suivi `aptos_tx_status`) / Historique (leurres de poisoning : montant nul, retrait non signé par nous), carnet d'adresses, « Connexions sortantes ». Adaptateur : `AptosAdapter` (`packages/chains/src/aptos/`), `aptosChain(network)`. Prix : CoinGecko `aptos`.

## 3. Allowlist réseau (`net_fetch`)

| Hôte | Usage |
|---|---|
| `api.coingecko.com`, `pro-api.coingecko.com` | prix, top 250, graphiques |
| `mempool.space` | Bitcoin : UTXO, frais, diffusion (Esplora) |
| `litecoinspace.org` | Litecoin (Esplora/mempool, mainnet `/api`, testnet4 `/testnet/api`) : utilisé par les commandes Rust `ltc_*`, famille Tor `litecoin` |
| `s.altnet.rippletest.net` (port 51234), `xrplcluster.com` | XRP Ledger testnet et mainnet (JSON-RPC rippled) : utilisés par les commandes Rust `xrp_*`, famille Tor `xrp` |
| `horizon-testnet.stellar.org`, `horizon.stellar.org` | Stellar testnet et mainnet (Horizon de la SDF) : utilisés par les commandes Rust `stellar_*`, famille Tor `stellar` |
| `free.rpc.fastnear.com`, `test.rpc.fastnear.com`, `tx.main.fastnear.com`, `tx.test.fastnear.com` | NEAR mainnet et testnet (FastNEAR : RPC JSON et API d'historique) : utilisés par les commandes Rust `near_*`, famille Tor `near` |
| `graphql.testnet.sui.io`, `graphql.mainnet.sui.io` | Sui testnet et mainnet (GraphQL de la Sui Foundation, POST JSON) : utilisés par les commandes Rust `sui_*` (solde, pièces de gaz, époque et prix de référence, simulation, exécution, historique), famille Tor `sui` |
| `westend-asset-hub-rpc.polkadot.io`, `polkadot-asset-hub-rpc.polkadot.io` | Polkadot : nœuds JSON-RPC publics de Parity pour Westend Asset Hub et Polkadot Asset Hub, utilisés par les commandes Rust `dot_*`, famille Tor `polkadot` |
| `ahp-api.statescan.io`, `polkadot-api.statescan.io` | Polkadot : API REST publique sans clé de Statescan (Asset Hub, relay chain), lue par la seule commande Rust `dot_txs` (historique, mainnet), famille Tor `polkadot` |
| `mainnet-api.algonode.cloud`, `testnet-api.algonode.cloud`, `mainnet-idx.algonode.cloud`, `testnet-idx.algonode.cloud` | Algorand mainnet et testnet (AlgoNode / Nodely, sans clé : algod et indexer) : utilisés par les commandes Rust `algo_*` uniquement, famille Tor `algorand` (`net::ALGORAND_HOSTS`) |
| `toncenter.com`, `testnet.toncenter.com` | TON mainnet et testnet (TON Center, API v3, offre publique sans clé, ≈ 1 requête/s) : utilisés par les commandes Rust `ton_*`, famille Tor `ton` ; clé optionnelle `KYRO_TONCENTER_API_KEY` (dev) en `X-API-Key`, jamais injectée dans une requête de l'interface |
| `cosmos-rest.publicnode.com`, `rest.provider-sentry-01.hub-testnet.polypore.xyz` | Cosmos Hub mainnet et testnet (`provider`), LCD REST du Cosmos SDK : utilisés par les commandes Rust `cosmos_*`, famille Tor `cosmos` |
| `preprod.koios.rest`, `api.koios.rest` | Cardano preprod et mainnet (Koios REST, offre publique sans clé) : utilisés par les commandes Rust `ada_*` et `ada_stake_*` (`account_info`, `pool_list`, `pool_info`, `drep_info`), famille Tor `cardano` |
| `api.kaspa.org`, `api-tn10.kaspa.org` | Kaspa mainnet et testnet-10 (`kaspa-rest-server`, API publique sans clé) : utilisés par les commandes Rust `kas_*`, famille Tor `kaspa` |
| `xmr-node.cakewallet.com` (port 18081), `monero-stagenet.stackwallet.com` (port 38081) | Monero mainnet et stagenet (RPC `monerod`, JSON et `.bin`) : utilisés par les commandes Rust `xmr_*`, famille Tor `monero`, réponses « bulk » (64 Mio / 180 s) |
| `api.mainnet.aptoslabs.com`, `api.testnet.aptoslabs.com` | Aptos mainnet et testnet (fullnode REST d'Aptos Labs + indexeur `/v1/graphql`, offre publique sans clé) : utilisés par les commandes Rust `aptos_*`, famille Tor `aptos` |
| `api.trongrid.io`, `nile.trongrid.io` | TRON mainnet et Nile (TronGrid, API HTTP java-tron + `/v1`) : utilisés par les commandes Rust `tron_*` et `tron_stake_*` (`getReward`, `listwitnesses`, `getBrokerage`, `getnextmaintenancetime`), famille Tor `tron` |
| `testnet.mirrornode.hedera.com`, `mainnet-public.mirrornode.hedera.com` | Hedera testnet et mainnet, nœud miroir REST officiel (compte, solde, historique, taux de change, statut) : utilisés par les commandes Rust `hbar_*`, famille Tor `hedera` |
| `testnet-node00-00-grpc.hedera.com`, `testnet-node01-00-grpc.hedera.com`, `testnet-node02-00-grpc.hedera.com`, `node00.swirldslabs.com`, `node01-00-grpc.swirlds.com`, `node04.swirldslabs.com` | Hedera : proxys gRPC-web des nœuds de consensus (diffusion de `CryptoService/cryptoTransfer`, HTTPS port 443) : utilisés par `hbar_broadcast` (Rust) seulement, famille Tor `hedera` |
| `ethereum-sepolia-rpc.publicnode.com`, `ethereum-rpc.publicnode.com` | RPC Ethereum |
| `arbitrum-one-rpc.publicnode.com`, `optimism-rpc.publicnode.com`, `base-rpc.publicnode.com`, `polygon-bor-rpc.publicnode.com`, `bsc-rpc.publicnode.com`, `avalanche-c-chain-rpc.publicnode.com` | RPC EVM (phase 2) |
| `cronos-evm-rpc.publicnode.com`, `mantle-rpc.publicnode.com`, `sonic-rpc.publicnode.com`, `gnosis-rpc.publicnode.com`, `hyperliquid-rpc.publicnode.com`, `sei-evm-rpc.publicnode.com` ; `rpc.ankr.com` (Flare, `/flare`), `kaia.api.pocket.network` (Kaia), `evm.confluxrpc.com` (Conflux eSpace) | RPC EVM (phase 2) : Cronos 25, Mantle 5000, Sonic 146, Gnosis 100, HyperEVM 999, Sei 1329, Flare 14, Kaia 8217, Conflux 1030 ; famille Tor `evm`. Les RPC publics de Flare et de Kaia répondent 403 aux sorties Tor : Ankr et Pocket Network à la place |
| `mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion` | Bitcoin (Esplora) en mode Tor uniquement, `http://` (service onion officiel de mempool) ; réécriture automatique de `mempool.space` |
| `api.devnet.solana.com`, `api.mainnet-beta.solana.com` | RPC Solana (aussi : tables d'adresses v0 lues par Rust pour `sol_decode_tx` / `sol_sign_tx` ; staking `sol_stake_*` lu et diffusé par Rust : `getProgramAccounts`, `getVoteAccounts`, sysvar StakeHistory, `sendTransaction` ; ou le RPC `servers.solana[cluster]` des réglages) |
| `github.com`, `release-assets.githubusercontent.com` | mises à jour automatiques (`updater.rs`) : `latest.json` et paquets signés des releases de `shuntraa/kyro-wallet` (CDN de GitHub après redirection). **Rust uniquement** : `net_fetch` les refuse (`HOST_NOT_ALLOWED`, `net::UPDATE_HOSTS`), famille Tor `update`, corps jusqu'à 256 Mio |
| `api.0x.org`, `li.quest`, `lite-api.jup.ag` | devis de swap (`li.quest` aussi : `/v1/status` d'un swap entre chaînes) |
| `1click.chaindefuser.com` | NEAR Intents 1Click (public, sans clé) : `/v0/status?depositAddress=` et `/v0/tokens`, confirmation d'un dépôt de swap entre chaînes avant signature ; `POST /v0/quote` (JSON) pour les swaps directs (départ BTC / LTC / DOGE / TRON / XRP / Cardano, arrivée LTC / DOGE / TRON / XRP / Cardano) ; famille Tor `swap` |
| + hôtes des serveurs HTTP personnalisés (`servers.bitcoin.*` de type `esplora`, `servers.evm.*`, `servers.solana.*`) | autorisés **uniquement pour leur famille** (circuits Tor de la famille) ; le serveur par défaut remplacé est refusé (`DEFAULT_SERVER_DISABLED`) |
| Electrum et Bitcoin Core | **pas** joignables par `net_fetch` : uniquement via les commandes `btc_*` (Rust) |
| `bch.imaginary.cash:50002`, `bch.loping.net:50002`, `cashnode.bch.ninja:50002`, `chipnet.imaginary.cash:50002`, `chipnet.bch.ninja:50002` (Fulcrum publics, défaut Bitcoin Cash mainnet / chipnet) ; `dash.electrum1.cipig.net:20061`, `dash.electrum2.cipig.net:20061` (ElectrumX de Komodo, défaut Dash mainnet) ; `net::ELECTRUM_HOSTS` | **pas** joignables par `net_fetch` (sockets TLS brutes) : uniquement via `bch_*` / `dash_*` (Rust), circuits Tor des familles `bitcoincash` / `dash`, hôte **et** port allowlistés |
| `doge.electrum1.cipig.net:20060`, `doge.electrum2.cipig.net:20060` (ElectrumX de Komodo, défaut Dogecoin mainnet ; `net::ELECTRUM_HOSTS`) | **pas** joignables par `net_fetch` (sockets TLS brutes, hors `ALLOWED_HOSTS`) : uniquement via `doge_*` (Rust), circuits Tor `dogecoin`, hôte **et** port vérifiés |
| `zec.electrum1.cipig.net:20058`, `zec.electrum2.cipig.net:20058` (ElectrumX de Komodo, défaut Zcash mainnet, transparent seulement ; `net::ELECTRUM_HOSTS`) | **pas** joignables par `net_fetch` (sockets TLS brutes, hors `ALLOWED_HOSTS`) : uniquement via `zec_*` (Rust), circuits Tor `zcash`, hôte **et** port vérifiés |
| serveurs Esplora Litecoin / Dogecoin / Bitcoin Cash / Dash personnalisés (`servers.litecoin.*`, `servers.dogecoin.*`, `servers.bitcoincash.*`, `servers.dash.*`) | **pas** joignables par `net_fetch` : uniquement via `ltc_*` / `doge_*` (Rust), circuits Tor de leur famille ; le défaut remplacé (`litecoinspace.org`) est refusé (`DEFAULT_SERVER_DISABLED`) |

HTTPS uniquement (sauf `.onion` via Tor : mempool, ou un serveur personnalisé), pas de redirection vers un hôte hors liste ni vers un serveur personnalisé (redirections suivies par Kyro lui-même dans les deux modes ; une clé API n'est jamais renvoyée vers un autre hôte), réponse plafonnée à 5 Mo, timeout 20 s, cache CoinGecko borné (128 réponses, 16 Mio). Un serveur personnalisé n'entre dans cette liste qu'après la fenêtre native « Nouveau serveur ».
