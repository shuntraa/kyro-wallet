# Roadmap — part B

Feasibility study of 2026-10-30 (versions and dependencies checked on crates.io). Constraints: no home-made crypto, no `k256` / `crypto-bigint` 0.5 (RUSTSEC-2026-0387), GPL-compatible licenses, Rust 1.97.1, versions published at least two weeks ago.

## Order and estimate

| # | Step | Chosen approach | Days |
|---|---|---|---|
| B1 | Solana decoding + SPL send | hand-written decoder (documented format), `solana-message` as a test dependency only | 3–4 |
| B4a | Litecoin, Dogecoin | `bitcoin` crate (BIP143/legacy sighash) + home-made address encoding on `bech32`/`bs58` | 4–6 |
| B2a | Built-in Tor | `arti-client` 0.47 (rustls/ring, static SQLite), dedicated HTTP client on hyper, **fail closed** | 6–10 |
| B2b | Custom Bitcoin servers | Electrum TLS over Tor (`electrum-client`), read-only `bdk_wallet` (persisted in the vault), Bitcoin Core via `corepc-types` | 8–12 |
| B3a | Ledger BTC, Trezor BTC/EVM | `ledger_bitcoin_client` (official) + home-made HID transport on `hidapi` (instead of `ledger-transport-hid`: bounded timeouts, cancellation), `trezor-client` (official, messages + framing; home-made USB transport on `rusb`) — **done on the Rust side (B3), to be tested on a device** | 8–12 |
| B4b | Tron | protobuf via `prost` (hand-written derivations, no `protoc`), local transaction construction | 5–7 |
| B4c | XRP | home-made STObject codec tested on the official `ripple-binary-codec` fixtures | 6–9 |
| B3b | Ledger EVM and Solana | APDUs from the apps' official specs — **done on the Rust side (B3), to be tested on a device** | 8–12 |
| B4d | Cardano | `pallas` 1.4 + `ed25519-bip32` (Icarus), CIP-0003/0019 vectors | 10–15 |

**Estimated total: 60 to 90 days of work.**

## B2c follow-ups (compact filters)

- **Enable `cbf` by default on or after 2026-11-11**, once `bip157 0.8.1` (published 2026-10-28) and `bitcoin-address-book 0.2.2` (2026-10-23) are at least two weeks old: rerun `cargo audit` and `cargo deny check` with the feature, and re-read the diff of each crate against the version reviewed on 2026-10-30 (no `build.rs`, no procedural macro, file access only in dead code or tests).
- **Propose upstream (bip157) RFC 1929 SOCKS5 authentication** (username / password): our bridge could then require a random token per launch, in addition to the peer list. Do not maintain a local patch.

## What cannot be done safely today

- alloy's Ledger/Trezor signers and the `xrpl-rust` crate: they reintroduce `k256` or `crypto-bigint` 0.5.
- `solana-remote-wallet`: requires Rust 1.98.1.
- ~~BIP157/158 compact filters through the built-in Tor~~: done in B2c behind the `cbf` feature (internal SOCKS bridge locked to the peer list, see NETWORK.md).
- ERC-20 / SPL clear signing on Ledger: depends on the signed descriptors of Ledger's metadata service; without them the device shows raw data. B3 embeds three verified ERC-20 descriptors (USDC, USDT mainnet; tUSDC Sepolia); the other tokens and SPL remain in blind signing (hardened dialog).
- Solana signing on Trezor (experimental support). ~~Trezor models with a THP channel~~: Trezor Safe 7 done on the Rust side (`hw/thp.rs`, code pairing; tested against Trezor's device-side THP code, not on a real Safe 7; code entry UI still to do, IPC.md §2.3).
- Trezor authenticity check (`AuthenticateDevice`, Safe 3/5/7): P-256 / Ed25519 / ML-DSA-44 X.509 chains up to the Trezor roots; requires an X.509 parser, `ml-dsa` (RustCrypto, 0.1, young) and a P-256 without `crypto-bigint` 0.5 (advisory RUSTSEC-2026-0387). Not done: to be done in Trezor Suite.
- Dogecoin testnet through a public API: none works; a custom testnet node is needed.
- Cardano derivation on audited code: the only maintained Icarus implementation relies on `cryptoxide`, which is unaudited (mitigated by the CIP vectors and a cross-check with ed25519-dalek).
- `arti` vendors an `rsa` 0.9 dependency (RUSTSEC-2023-0071, Marvin attack): not exploitable here (RSA verification only), but to be explicitly ignored and documented in `cargo audit`.
