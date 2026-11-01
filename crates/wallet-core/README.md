# wallet-core

Kyro's cryptographic core, in pure Rust. License GPL-3.0-or-later. The public contract is in `docs/IPC.md` §1.

## What it does

- **BIP39 recovery phrase** (English, 12 or 24 words, OsRng): generation, checksum validation, seed computation.
- **Encrypted vault**: Argon2id (256 MiB, t=3, p=4) → XChaCha20-Poly1305. The salt and nonce are random; the header (version, KDF parameters, salt) is authenticated via the AAD. Serialized as JSON with base64 fields.
- **Bitcoin**: BIP84 (P2WPKH) and BIP86 (P2TR) accounts, xpub, addresses, PSBT signing and summary (outputs, change, fees).
- **EVM**: address `m/44'/60'/0'/0/i` (EIP-55), EIP-1559 (type 2) signing, decoding of native transfers, of ERC-20 `transfer`/`approve` calls (with detection of unlimited approvals) and of other contract calls.
- **Solana**: SLIP-10 ed25519 derivation `m/44'/501'/i'/0'` (same convention as Phantom and Solflare), ed25519 signature of a transaction message.
- **Solana decoding** (legacy and v0, address tables): SOL and SPL/Token-2022 transfers, delegations, associated token accounts, priority fees, memos. Anything not recognized is flagged and requires one more confirmation. Verified on real devnet transactions and compared with the reference crate `solana-message` (as a dev-dependency only).

## What it never does

- No network or file access, no async, no Tauri. The crate is purely synchronous.
- No home-made crypto: only `bip39`, `bitcoin`/`secp256k1` (libsecp256k1, also for EVM), `sha3` (Keccak), `alloy-rlp`, `uint`, `ed25519-dalek`, `ed25519-dalek-bip32`, `argon2` and `chacha20poly1305` are used.
- No secrets in logs: `Debug` output is masked, and keys are derived on each call then erased (`zeroize`).
- No panic on user input: every error is surfaced as `wallet_core::Error`.
- Does not sign overly permissive PSBTs: an input is signed only if all of the following conditions are met:
  - its fingerprint and path match this wallet and the network;
  - the derived key matches the script;
  - the sighash is ALL or DEFAULT.

  Taproot script trees are rejected.

## Tests

```sh
cargo test   --manifest-path crates/wallet-core/Cargo.toml
cargo clippy --manifest-path crates/wallet-core/Cargo.toml --all-targets -- -D warnings
cargo test   --manifest-path crates/wallet-core/Cargo.toml --release -- --ignored  # Argon2 with production parameters
```

The tests use the following official vectors:
- BIP39 (Trezor);
- BIP32 (vectors 1 and 2);
- BIP84 and BIP86;
- SLIP-10 ed25519.

Added to these are the EVM address and Solana address of the "abandon … about" phrase, as well as EIP-1559 and PSBT signing round trips (verified by key recovery or by secp256k1 verification) and vault tampering tests.
