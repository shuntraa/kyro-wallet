# Contrat d'interface Kyro

Ce document fige les frontières entre les trois couches. Toute modification se fait ici d'abord.

```
React (apps/desktop/src)  ──invoke()──►  Tauri shell (apps/desktop/src-tauri)  ──►  wallet-core (crates/wallet-core)
   aucun secret                         session, réseau, dialogues natifs            crypto pure, sans I/O
```

Règles :
- **Aucun secret ne remonte au frontend**, sauf la phrase de récupération affichée *une fois* à la création et via `vault_reveal_mnemonic` (mot de passe requis). Le frontend ne la stocke jamais (pas de state global, pas de localStorage).
- Toute signature exige le **mot de passe** (re-vérifié par Argon2id) **et** une **confirmation native** (dialogue système) affichant le résumé décodé par Rust.
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
pub struct BtcDescriptor { pub kind: BtcKind, pub internal: bool, pub descriptor: String /*sans checksum*/ }
pub fn btc_descriptors(seed: &Seed, net: Network, account: u32) -> Result<Vec<BtcDescriptor>>;
// wpkh([fp/84h/coin'h/0h]xpub/{0,1}/*) et tr([fp/86h/coin'h/0h]xpub/{0,1}/*) — clés publiques uniquement

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
| `accounts_get` | — | `Accounts` | adresses publiques uniquement |
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
| `btc_backend_info` | — | `{ kind, network, label, tor }` | serveur Bitcoin actif : `kind` = `default` \| `esplora` \| `electrum` \| `core`, `network` = `mainnet` \| `testnet4`, `label` = hôte (jamais d'identifiants) |
| `btc_address_info` | `{ address }` | forme Esplora `GET /address/{a}` | voir §2.2 |
| `btc_address_utxos` | `{ address }` | forme Esplora `GET /address/{a}/utxo` | voir §2.2 |
| `btc_address_txs` | `{ address }` | forme Esplora `GET /address/{a}/txs` | voir §2.2 (50 plus récentes au plus) |
| `btc_fee_rates` | — | forme mempool `GET /v1/fees/recommended` | sat/vB |
| `btc_tip_height` | — | `number` | |
| `btc_broadcast` | `{ hex }` | `string` (txid) | le txid renvoyé par le serveur doit correspondre à la transaction, sinon erreur |
| `btc_core_setup` | `{ rescanFrom: 'now' \| number /*horodatage UNIX en s*/ }` | `CoreStatus` (`state: 'importing'`) | Bitcoin Core uniquement, session déverrouillée. **Vérification préalable synchrone** (erreurs renvoyées par l'appel lui-même) : nœud joignable (`SERVER_UNREACHABLE`), authentification (`SERVER_INVALID`), bonne chaîne (`SERVER_WRONG_NETWORK`), portefeuille `kyro-watch-<empreinte8>` créé ou chargé et bien sans clé privée (`SERVER_INVALID`), checksums des descripteurs. Seul `importdescriptors` (et son rescan) tourne ensuite en arrière-plan. Aucun nœud Core configuré pour ce réseau : `INVALID_INPUT` |
| `btc_core_status` | — | `CoreStatus` | progression du rescan (`getwalletinfo.scanning`). L'état d'import est propre à **(réseau, URL, portefeuille)** : un autre nœud ou un autre réseau ne voit pas l'import d'un premier. Aucun nœud Core configuré : réponse normale `{ state: 'not-configured', wallet: '', walletLoaded: false }` (pas d'erreur) |
| `btc_cbf_status` | — | `CbfStatus` | mode filtres compacts (fonction `cbf`) ; build sans la fonction : `FEATURE_DISABLED` |
| `btc_cbf_sync` | — | `CbfStatus` | lance (ou rejoint) une synchronisation en arrière-plan ; progression par l'événement `cbf-status` ; build sans la fonction : `FEATURE_DISABLED` |
| `set_capture_protection` | `{ enabled }` | `void` | `set_content_protected` |
| `config_get` | — | `{ network, hasCoingeckoKey, hasZeroxKey, hasOneinchKey }` | jamais les clés elles-mêmes |

```ts
type Accounts = {
  network: 'mainnet' | 'testnet';
  btc: { segwit: { address: string; xpub: string; fingerprint: string; path: string };
         taproot: { address: string; xpub: string; fingerprint: string; path: string } };
  evm: { address: string };
  sol: { address: string };
};
type Settings = { currency: 'EUR' | 'USD'; autoLockSecs: number; hideBalancesOnStart: boolean;
                  captureProtection: boolean; clipboardGuard: boolean;
                  servers: Servers;               // remplace l'ancien `rpc` (encore accepté en entrée, migré, jamais renvoyé)
                  apiKeys: { coingecko?: string; zerox?: string; oneinch?: string };
                  tor: { enabled: boolean } };   // défaut : { enabled: true }
// ---- serveurs personnalisés (B2b) ----
// Clé absente = serveur par défaut. Un serveur personnalisé n'est autorisé que pour sa famille
// et emprunte les circuits Tor isolés de cette famille ; le serveur par défaut de la même chaîne
// est alors REFUSÉ (`DEFAULT_SERVER_DISABLED`) : jamais de repli silencieux.
type Servers = {
  bitcoin: { mainnet?: BtcServer; testnet4?: BtcServer };
  evm: { [chainId: string]: { url: string } };          // clé = chainId décimal, ex. "11155111"
  solana: { 'devnet'?: { url: string }; 'mainnet-beta'?: { url: string } };
};
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
                   tipHeight?: number; scannedHeight?: number; birthHeight: number; progress: number /*0..1*/;
                   peers: string[]; tor: boolean; lastSyncUnix?: number; watchedScripts: number;
                   matchedBlocks: number; message?: string };
// Mot de passe Core : `settings_get` ne le renvoie JAMAIS (`hasPassword: true` à la place).
// Dans `settings_set` : `password` absent = garder celui enregistré (même URL et même user),
// `password: ""` = l'effacer, une valeur = le remplacer.
type ServerTestTarget =
  | { family: 'bitcoin'; network: 'mainnet' | 'testnet4'; server: BtcServer }
  | { family: 'evm'; chainId: number; server: { url: string } }
  | { family: 'solana'; cluster: 'devnet' | 'mainnet-beta'; server: { url: string } };
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

Erreurs : rejet de la promesse avec `{ code: 'WRONG_PASSWORD' | 'LOCKED' | 'RATE_LIMITED' | 'USER_REJECTED' | 'HOST_NOT_ALLOWED' | 'INVALID_INPUT' | 'INTERNAL' | 'TOR_UNAVAILABLE' | 'SERVER_INVALID' | 'SERVER_WRONG_NETWORK' | 'SERVER_UNREACHABLE' | 'DEFAULT_SERVER_DISABLED' | 'FEATURE_DISABLED', message }`. `TOR_UNAVAILABLE` : Tor activé mais pas prêt (démarrage trop long, échec, arrêté) — la requête n'a **pas** été envoyée.

- `SERVER_INVALID` : configuration refusée avant tout réseau (URL, schéma, identifiants dans l'URL, `.onion` sans Tor, empreinte mal formée, mot de passe manquant, fichier `.cookie` illisible, authentification RPC refusée, portefeuille `kyro-watch-…` absent).
- `SERVER_WRONG_NETWORK` : le serveur répond mais n'est pas sur la bonne chaîne (genesis Bitcoin, `getblockchaininfo.chain`, `eth_chainId`, `getGenesisHash`).
- `SERVER_UNREACHABLE` : le serveur personnalisé ne répond pas (connexion, TLS, épinglage non concordant, délai, réponse invalide). **Kyro ne se rabat jamais sur le serveur par défaut.**
- `FEATURE_DISABLED` : fonction absente de ce build (aujourd'hui : filtres compacts `cbf`, désactivés par défaut jusqu'à revue).
- `DEFAULT_SERVER_DISABLED` : requête vers le serveur par défaut d'une chaîne pour laquelle un serveur personnalisé est configuré (signe que l'UI n'utilise pas encore le bon serveur).

### 2.1 Vérifications des serveurs (à l'enregistrement et dans `server_test`)

| Type | Règles d'URL | Vérification en direct |
|---|---|---|
| Esplora | `https://` ; `http://` uniquement pour un `.onion`, via Tor ; jamais d'identifiants dans l'URL | `GET {url}/block-height/0` = genesis du réseau (mainnet `000000000019d6…e26f`, testnet4 `00000000da84f2…f043`) |
| Electrum | `host` + `port` ; `tls: 'none'` uniquement pour un `.onion` via Tor ; `pinned` exige `certSha256` | `server.version` (protocole 1.4) puis `server.features.genesis_hash` = genesis du réseau |
| Bitcoin Core | `http://` uniquement pour une adresse locale/LAN (127.0.0.0/8, ::1, RFC 1918, fc00::/7, fe80::/10, `localhost`) ; sinon `https://` ou `.onion` via Tor | `getblockchaininfo.chain` = `main` ou `testnet4` |
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

## 3. Allowlist réseau (`net_fetch`)

| Hôte | Usage |
|---|---|
| `api.coingecko.com`, `pro-api.coingecko.com` | prix, top 200, graphiques |
| `mempool.space` | Bitcoin : UTXO, frais, diffusion (Esplora) |
| `ethereum-sepolia-rpc.publicnode.com`, `ethereum-rpc.publicnode.com` | RPC Ethereum |
| `arbitrum-one-rpc.publicnode.com`, `optimism-rpc.publicnode.com`, `base-rpc.publicnode.com`, `polygon-bor-rpc.publicnode.com`, `bsc-rpc.publicnode.com`, `avalanche-c-chain-rpc.publicnode.com` | RPC EVM (phase 2) |
| `mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion` | Bitcoin (Esplora) en mode Tor uniquement, `http://` (service onion officiel de mempool) ; réécriture automatique de `mempool.space` |
| `api.devnet.solana.com`, `api.mainnet-beta.solana.com` | RPC Solana (aussi : tables d'adresses v0 lues par Rust pour `sol_decode_tx` / `sol_sign_tx`, ou le RPC `servers.solana[cluster]` des réglages) |
| `api.0x.org`, `api.1inch.dev`, `li.quest`, `lite-api.jup.ag` | devis de swap |
| + hôtes des serveurs HTTP personnalisés (`servers.bitcoin.*` de type `esplora`, `servers.evm.*`, `servers.solana.*`) | autorisés **uniquement pour leur famille** (circuits Tor de la famille) ; le serveur par défaut remplacé est refusé (`DEFAULT_SERVER_DISABLED`) |
| Electrum et Bitcoin Core | **pas** joignables par `net_fetch` : uniquement via les commandes `btc_*` (Rust) |

HTTPS uniquement (sauf `.onion` via Tor : mempool, ou un serveur personnalisé), pas de redirection vers un hôte hors liste ni vers un serveur personnalisé, réponse plafonnée à 5 Mo, timeout 20 s.
