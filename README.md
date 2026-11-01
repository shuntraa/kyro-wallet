<p align="center">
  <img src="https://kyrowallet.com/img/kyro-mark-dark.svg" width="88" alt="Kyro Wallet logo">
</p>

<h1 align="center">Kyro Wallet</h1>

<p align="center">
  <b>A free, open-source, non-custodial desktop wallet.</b><br>
  One recovery phrase for 37 blockchains. Keys stay in the Rust core. Traffic goes over Tor.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0--or--later-blue" alt="License: GPL-3.0-or-later"></a>
  <a href="https://github.com/shuntraa/kyro-wallet/releases/latest"><img src="https://img.shields.io/github/v/release/shuntraa/kyro-wallet?label=release" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-informational" alt="Platforms: Windows, macOS, Linux">
  <img src="https://img.shields.io/badge/built%20with-Tauri%202%20%2B%20Rust-orange" alt="Built with Tauri 2 and Rust">
</p>

<p align="center">
  <a href="https://github.com/shuntraa/kyro-wallet/releases/latest"><b>Download</b></a> ·
  <a href="https://kyrowallet.com">Website</a> ·
  <a href="SECURITY.md">Security</a> ·
  <a href="https://github.com/shuntraa/kyro-wallet/security/advisories/new">Report a vulnerability</a>
</p>

<p align="center">
  <img src="docs/assets/hero.webp" width="860" alt="Kyro Wallet portfolio screen">
</p>

---

## What Kyro is

Kyro is a desktop wallet for Windows, macOS and Linux. You hold the keys: your recovery phrase is encrypted on your own computer, and nobody else — the developers included — can move your funds.

- **37 blockchains, one recovery phrase**, with **220+ tokens**.
- **Send, receive and swap** from the same window. Swaps carry a service fee from 0.7%, included in the rate — see [fees](https://kyrowallet.com/fees/).
- **Staking** where available, from accounts that stay in your name: SOL, ADA and TRX.
- **Ledger and Trezor** hardware wallets on supported chains (see [below](#hardware-wallets)).
- **Automatic signed updates**, downloaded silently over Tor, signature-checked, applied at the next start.
- **Tor by default.** If Tor is unavailable, Kyro stops instead of silently connecting in the clear.
- **No account, no tracking, no analytics, no telemetry.**
- Interface in **English and French**.

### Supported blockchains

| Group | Networks |
|---|---|
| **Bitcoin & UTXO** | Bitcoin, Litecoin, Dogecoin, Bitcoin Cash, Dash, Zcash (transparent addresses), Kaspa |
| **Ethereum & EVM** | Ethereum, BNB Chain, Polygon, Arbitrum, Optimism, Base, Avalanche, Cronos, Mantle, Sonic, Flare, Kaia, Gnosis, HyperEVM, Sei, Conflux |
| **Other networks** | Solana, TRON, Cardano, XRP Ledger, Stellar, NEAR, Sui, Monero, TON, Cosmos Hub, Polkadot, Aptos, Algorand, Hedera |

Tokens include ERC-20 and other EVM standards, SPL (Solana), TRC-20 (TRON), Cardano native tokens and XRP Ledger issued currencies. Stablecoins are also supported on non-EVM chains: USDT on TON, USDC on Sui, USDC and USDT on Aptos, USDC on Stellar (the account needs a USDC trustline) and USDC and USDT on NEAR. TON's native coin is now named **Gram** (GRAM). Per-chain details: [kyrowallet.com/chains](https://kyrowallet.com/chains/).

## Why Kyro

**Keys never leave the Rust core.** The interface is a sandboxed web view that never sees a secret. Encryption, key derivation and signing happen in `wallet-core`, a pure Rust crate with no network and no file access. Private keys are derived for each signature, then wiped from memory.

**No blind signing.** Every signature needs your password *and* a confirmation in a native system window, drawn by the app shell rather than the web view. It shows what Rust itself decoded from the transaction, not what the interface claims. Unusual transactions get a second, reinforced confirmation.

**Private by default.** All traffic goes through an embedded Tor client, with a separate circuit per blockchain. Kyro contacts only the servers listed in [docs/NETWORK.md](docs/NETWORK.md), and you can point most chains at your own node.

**Scam protection built in.** Address-poisoning alerts, clipboard-tampering detection after a paste, refused invalid recipients, and exact ERC-20 approvals by default — an unlimited approval needs an explicit action and shows a warning.

**Swaps you can check.** Kyro decodes the provider's transaction before asking for your password and checks that it targets the provider's official contract. The fee is collected through each provider's official integrator-fee mechanism; Kyro never adds a separate transfer. Details: [docs/SWAP_FEES.md](docs/SWAP_FEES.md).

**Open and accountable.** GPL-3.0-or-later, dependencies pinned to exact versions, committed lockfiles, `cargo audit`, `cargo deny` and `pnpm audit` in CI, and a pinned Rust toolchain.

## Screenshots

| Portfolio | Swap | Send |
|:-:|:-:|:-:|
| <img src="docs/assets/portfolio.webp" width="280" alt="Portfolio screen"> | <img src="docs/assets/swap.webp" width="280" alt="Swap screen"> | <img src="docs/assets/send.webp" width="280" alt="Send screen"> |

## Hardware wallets

Your keys stay in the device and every transaction is confirmed on its screen. Kyro still decodes the transaction in Rust, shows it in a native window, and verifies the device's signature before broadcasting.

| Device | Chains |
|---|---|
| **Ledger and Trezor** | Bitcoin, all EVM chains, Solana, Litecoin, Dogecoin, Bitcoin Cash, Dash, Stellar, Cardano (not the Trezor One) |
| **Ledger only** | XRP, TRON, Sui, Aptos, Algorand, Cosmos Hub, TON, NEAR, Hedera |
| **Trezor only** | Zcash (transparent) |

Caveats: on NEAR and TON the Ledger account is a different account than the software wallet for the same phrase; on Hedera the Ledger account must first be created with Ledger Live or HashPack. Not available on hardware wallets: Monero, Polkadot, Kaspa. Details in [SECURITY.md](SECURITY.md).

## Automatic updates

Kyro checks for updates over Tor and downloads them silently in the background. Each update is signed; the signature is verified against the public key built into the app before anything is installed, and a bad signature is rejected. The update is installed when you quit Kyro or at the next start, never in the middle of a session.

## Security model

| Layer | Holds | Role |
|---|---|---|
| React interface (web view) | No secrets | Calls an allowlist of Tauri commands. Strict CSP, no remote scripts, no direct network or file access. |
| Tauri shell (Rust) | Session | Auto-lock, filtered network access over Tor, native confirmation windows. |
| `wallet-core` (pure Rust) | Encrypted vault | Encrypts (Argon2id + XChaCha20-Poly1305), derives, decodes, signs. No network, no files. |

The recovery phrase is only ever displayed in a native window opened by Rust, never in the interface. A compromised interface still cannot sign without your password and the native window.

**Audit status:** an internal security review has been done; no independent external audit has been published yet. Like all GPL software, Kyro comes with no warranty. What Kyro protects against — and what no software can — is described in [SECURITY.md](SECURITY.md), including a per-chain threat model.

## Architecture at a glance

```
kyro-wallet/
├─ crates/wallet-core/     Pure Rust: vault, BIP39/32, derivation, decoding, signing
├─ apps/desktop/
│  ├─ src-tauri/           Tauri 2 shell: IPC commands, session + auto-lock, filtered net_fetch, native dialogs
│  └─ src/                 React + strict TypeScript interface (no secrets)
├─ packages/
│  ├─ shared/              IPC contract types
│  ├─ chains/              Chain adapters (build unsigned transactions)
│  ├─ market/              Prices and charts (CoinGecko)
│  └─ swap/                Swap providers and fee logic
└─ docs/                   ARCHITECTURE, IPC, NETWORK, SWAP_FEES
```

```mermaid
flowchart LR
  UI["React UI<br/>no secrets"] -- "invoke() allowlist" --> Shell["Tauri shell<br/>session · Tor · native dialogs"]
  Shell --> Core["wallet-core<br/>decode · sign"]
  Core -- "decoded summary" --> Dialog["Native confirmation window"]
  Dialog -- "you approve" --> Core
  Shell -- "Tor" --> Net["Listed servers / your node"]
```

TypeScript builds unsigned transactions and broadcasts signed ones; Rust decodes what will actually be signed and shows it to you. TypeScript can be wrong or compromised without being able to redirect funds. More in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/IPC.md](docs/IPC.md).

## Download & verify

Kyro is published **only** on [GitHub Releases](https://github.com/shuntraa/kyro-wallet/releases/latest). There is no mobile app; anything in an app store using the name is not ours.

| Platform | File |
|---|---|
| Windows | [Kyro-windows-x64-setup.exe](https://github.com/shuntraa/kyro-wallet/releases/latest/download/Kyro-windows-x64-setup.exe) · [.msi](https://github.com/shuntraa/kyro-wallet/releases/latest/download/Kyro-windows-x64.msi) |
| macOS (Apple Silicon & Intel) | [Kyro-macos.dmg](https://github.com/shuntraa/kyro-wallet/releases/latest/download/Kyro-macos.dmg) |
| Linux | [AppImage](https://github.com/shuntraa/kyro-wallet/releases/latest/download/Kyro-linux-x86_64.AppImage) · [.deb](https://github.com/shuntraa/kyro-wallet/releases/latest/download/Kyro-linux-amd64.deb) |

Download [SHA256SUMS](https://github.com/shuntraa/kyro-wallet/releases/latest/download/SHA256SUMS) next to the installer and compare:

```bash
Get-FileHash .\Kyro-windows-x64-setup.exe -Algorithm SHA256   # Windows (PowerShell)
shasum -a 256 Kyro-macos.dmg                                  # macOS
sha256sum -c SHA256SUMS --ignore-missing                      # Linux
```

If the hashes differ, delete the file and download it again.

**First launch.** The installers are not code-signed yet, so your OS warns you the first time. Verify the checksum first, then:

- **Windows (SmartScreen):** click **More info → Run anyway**.
- **macOS (Gatekeeper):** right-click Kyro in Applications → **Open**, or go to *System Settings → Privacy & Security → Open Anyway*.

## Build from source

Requirements: [Rust](https://rustup.rs) **1.97.1** (pinned in `rust-toolchain.toml`; rustup installs it automatically), Node.js 22+, pnpm 11 (`corepack enable`), and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```bash
git clone https://github.com/shuntraa/kyro-wallet.git
cd kyro-wallet
pnpm install --frozen-lockfile
pnpm dev        # run the app in development mode
pnpm build      # build the installers
```

### Tests and checks

```bash
pnpm test       # TypeScript tests in every package + cargo test --workspace
pnpm typecheck  # TypeScript, every package
pnpm lint       # ESLint + cargo clippy (warnings are errors)
pnpm audit      # pnpm audit --prod + cargo audit
```

## Contributing

Issues and pull requests are welcome. Before opening a PR, run `pnpm lint`, `pnpm typecheck` and `pnpm test`. Any new server Kyro contacts must be listed in [docs/NETWORK.md](docs/NETWORK.md), and changes to the IPC contract belong in [docs/IPC.md](docs/IPC.md).

**Never post a recovery phrase, private key or password** in an issue, pull request or log.

## Reporting a vulnerability

Please do **not** open a public issue. Report privately through [GitHub security advisories](https://github.com/shuntraa/kyro-wallet/security/advisories/new) (*Security → Report a vulnerability*), with a proof of concept if possible. Reports are acknowledged within 72 hours, with a fix and coordinated disclosure within 90 days at most. See [SECURITY.md](SECURITY.md).

## Support the project

Kyro is free. If you'd like to help keep it going:

- **GitHub Sponsors:** [github.com/sponsors/shuntraa](https://github.com/sponsors/shuntraa)

| Network | Address |
|---|---|
| Bitcoin | `bc1qta8efdy72ge9qy8yj8s0ckwar0lg44ggwnaard` |
| Ethereum & EVM chains | `0x86cD9af8067fF5e0001c709a550cD62b5e968B44` |
| Solana | `ptsbLdrhmEfC2eQ9gj4aieF4irdhQqYzK1fdNwHBZcM` |
| Litecoin | `LWePW8iwa8RxxYB6av4KBriBNkRgLWvNyw` |
| Dogecoin | `DKCSjtypvD9qg3R175YdijmwvKh5FnAU14` |
| TRON | `TT9j25bsbBAgxCDEXTN1cpjcD54Jz51pES` |
| Cardano | `addr1qy9d3jctafj2cgfm8sgllfjkrxrgxn9mz9dy0qzxuwscx6c2mr9sh6ny4ssnk0q3l7n9vxvxsdxtky26g7qydcapsd4sux3dj3` |

## License

Kyro Wallet is free software, released under the [GNU General Public License v3.0 or later](LICENSE).
