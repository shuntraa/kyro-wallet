//! Kyro wallet core.
//!
//! Pure, synchronous, I/O-free cryptographic core of the Kyro wallet:
//! BIP39 mnemonics, an Argon2id + XChaCha20-Poly1305 vault, BIP32/BIP84/BIP86
//! Bitcoin derivation and PSBT signing, EVM (EIP-1559) signing and Solana
//! (SLIP-10 ed25519) signing, plus human-readable transaction decoding.
//!
//! Design rules:
//! - no network, no filesystem, no async, no Tauri;
//! - no home-made cryptography: every primitive comes from an audited, maintained crate;
//! - secrets live in zeroize-on-drop containers, private keys are derived per call and
//!   dropped immediately; `Debug` never prints secrets;
//! - user input never panics: every failure is a [`Error`].
//!
//! The public API mirrors `docs/IPC.md` §1.

#![forbid(unsafe_code)]
#![deny(missing_docs)]
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

mod btc;
mod error;
mod evm;
mod keys;
mod mnemonic;
mod network;
mod sol;
mod sol_decode;
mod vault;

pub use btc::{btc_account, btc_address, btc_decode_psbt, btc_sign_psbt, BtcAccount, BtcTxSummary};
pub use error::{Error, Result};
pub use evm::{evm_address, evm_decode, evm_sign_tx, EvmTxKind, EvmTxRequest, EvmTxSummary};
pub use mnemonic::{Mnemonic, Seed, WordCount};
pub use network::{BtcKind, Network};
pub use sol::{sol_address, sol_sign_message};
pub use sol_decode::{
    sol_decode_message, sol_message_lookup_tables, sol_parse_lookup_table, SolInstruction,
    SolLookupTable, SolTokenProgram, SolTxSummary, SolWarning, SOL_LOOKUP_TABLE_PROGRAM,
};
pub use vault::{open, seal, KdfParams, VaultFile, VAULT_VERSION};

/// Re-exported so callers can build [`Seed`] values and wipe their own buffers
/// without adding a direct dependency.
pub use zeroize::{Zeroize, Zeroizing};
