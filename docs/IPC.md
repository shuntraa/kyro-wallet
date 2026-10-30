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
pub fn sol_sign_message(seed: &Seed, account: u32, message: &[u8]) -> Result<[u8; 64]>;

// --- decoding (résumé « en clair », indépendant du frontend) ---
pub struct EvmTxSummary { pub kind: EvmTxKind /*NativeTransfer|Erc20Transfer|Erc20Approve|ContractCall*/,
                          pub to: String, pub token_contract: Option<String>, pub amount: String, pub spender: Option<String>,
                          pub unlimited_approval: bool, pub max_fee_wei: String, pub chain_id: u64 }
pub fn evm_decode(tx: &EvmTxRequest) -> Result<EvmTxSummary>;
pub struct BtcTxSummary { pub outputs: Vec<(String /*address*/, u64 /*sats*/, bool /*is_change*/)>, pub fee_sats: u64 }
pub fn btc_decode_psbt(net: Network, psbt_b64: &str, own: &[String] /*our addresses*/) -> Result<BtcTxSummary>;
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
| `sol_sign_message` | `{ message /*b64*/, password, summary }` | `{ signature /*b64*/ }` | dialogue natif obligatoire |
| `net_fetch` | `{ req: { url, method, headers?, body? } }` | `{ status, body }` | allowlist + cache + rate-limit ; seuls `accept`, `content-type`, `0x-version` sont transmis, les clés API sont ajoutées par Rust |
| `settings_get` / `settings_set` | — / `{ settings: Settings }` | `Settings` | stocké dans le dossier de l'app |
| `set_capture_protection` | `{ enabled }` | `void` | `set_content_protected` |
| `config_get` | — | `{ network, hasZeroxKey, hasOneinchKey }` | jamais les clés elles-mêmes |

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
                  rpc: { ethereum?: string; solana?: string; esplora?: string };
                  apiKeys: { coingecko?: string; zerox?: string; oneinch?: string } };
```

Événement : `vault-locked` (sans contenu) émis par Rust à l'auto-lock.

Erreurs : rejet de la promesse avec `{ code: 'WRONG_PASSWORD' | 'LOCKED' | 'RATE_LIMITED' | 'USER_REJECTED' | 'HOST_NOT_ALLOWED' | 'INVALID_INPUT' | 'INTERNAL', message }`.

## 3. Allowlist réseau (`net_fetch`)

| Hôte | Usage |
|---|---|
| `api.coingecko.com`, `pro-api.coingecko.com` | prix, top 200, graphiques |
| `mempool.space` | Bitcoin : UTXO, frais, diffusion (Esplora) |
| `ethereum-sepolia-rpc.publicnode.com`, `ethereum-rpc.publicnode.com` | RPC Ethereum |
| `arbitrum-one-rpc.publicnode.com`, `optimism-rpc.publicnode.com`, `base-rpc.publicnode.com`, `polygon-bor-rpc.publicnode.com`, `bsc-rpc.publicnode.com`, `avalanche-c-chain-rpc.publicnode.com` | RPC EVM (phase 2) |
| `api.devnet.solana.com`, `api.mainnet-beta.solana.com` | RPC Solana |
| `api.0x.org`, `api.1inch.dev`, `li.quest`, `lite-api.jup.ag` | devis de swap |
| + hôtes des RPC personnalisés saisis par l'utilisateur | |

HTTPS uniquement, pas de redirection vers un hôte hors liste, réponse plafonnée à 5 Mo, timeout 20 s.
