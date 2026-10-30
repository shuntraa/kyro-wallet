//! Kyro wallet core.
//!
//! Pure, synchronous, I/O-free cryptographic core of the Kyro wallet:
//! BIP39 mnemonics, an Argon2id + XChaCha20-Poly1305 vault, BIP32/BIP84/BIP86
//! Bitcoin derivation and PSBT signing, Litecoin (BIP84) and Dogecoin (BIP44) PSBT
//! signing, TRON (TRX / TRC-20), XRP Ledger (Payment) and Cardano (CIP-1852 payments) signing, EVM (EIP-1559) signing and Solana (SLIP-10 ed25519) signing, plus
//! human-readable transaction decoding.
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
mod btc_hw;
mod btc_watch;
mod cardano;
mod error;
mod evm;
mod keys;
mod ledger_cal;
mod mnemonic;
mod network;
mod sol;
mod sol_decode;
mod sol_stake;
mod tron;
mod utxo;
mod vault;
mod watch;
mod xrp;

pub use btc::{
    btc_account, btc_address, btc_decode_psbt, btc_psbt_summary, btc_sign_psbt, BtcAccount,
    BtcTxSummary, BtcWarning, BTC_HIGH_FEE_SAT_PER_VB,
};
pub use btc_hw::{
    btc_hw_finalize, btc_hw_own_addresses, btc_hw_plan, HwBtcChange, HwBtcInput, HwBtcPlan,
    HwBtcSignature,
};
pub use btc_watch::{
    btc_address_from_xpub, btc_address_of_script, btc_decode_raw_tx, btc_descriptors,
    btc_genesis_hash, btc_script_pubkey, btc_scripthash, btc_scripthash_of_script, verify_tx_hex,
    BtcDescriptor, BtcRawTx,
};
pub use cardano::{
    cardano_account_stake_address, cardano_account_xpub, cardano_address, cardano_address_bytes,
    cardano_address_string, cardano_base_address, cardano_blake2b256, cardano_cip20_aux,
    cardano_decode_tx, cardano_enterprise_address, cardano_min_utxo, cardano_payment_public_key,
    cardano_sign, cardano_signed_size, cardano_signed_witnesses, cardano_stake_address,
    cardano_tx_body, cardano_unsigned_tx, cardano_verify, CardanoAssets, CardanoBody,
    CardanoContext, CardanoInput, CardanoOutput, CardanoOutputView, CardanoRoot, CardanoTokenView,
    CardanoTxSummary, CardanoWarning,
};
pub use cardano::{
    cardano_blake2b224, cardano_decode_stake_tx, cardano_drep_id, cardano_drep_parse,
    cardano_pool_bech32, cardano_pool_id, cardano_reward_address_bytes, cardano_sign_stake,
    cardano_stake_public_key, cardano_stake_tx_body, CardanoCert, CardanoCertView, CardanoDrep,
    CardanoDrepView, CardanoStakeSummary, CardanoWithdrawalView,
};
pub use error::{Error, Result};
pub use evm::{
    evm_address, evm_address_from_xpub, evm_address_of_pubkey, evm_checksum_address, evm_decode,
    evm_high_fee_threshold_wei, evm_hw_finalize, evm_sign_tx, evm_signing_payload, evm_tx_fields,
    evm_xpub_from_node, EvmTxFields, EvmTxKind, EvmTxRequest, EvmTxSummary, EvmWarning,
    EVM_KNOWN_CHAINS,
};
pub use ledger_cal::{
    ledger_erc20_lookup, ledger_erc20_payload, ledger_erc20_verify, LedgerErc20Descriptor,
    LEDGER_ERC20_SIGNER,
};
pub use mnemonic::{Mnemonic, Seed, WordCount};
pub use network::{BtcKind, Network};
pub use sol::{sol_address, sol_address_of_pubkey, sol_sign_message, sol_verify_signature};
pub use sol_decode::{
    sol_decode_message, sol_message_lookup_tables, sol_parse_lookup_table, SolInstruction,
    SolLookupTable, SolTokenProgram, SolTxSummary, SolWarning, SOL_LOOKUP_TABLE_PROGRAM,
};
pub use sol_stake::{
    sol_create_with_seed, sol_parse_stake_account, sol_parse_stake_history, sol_stake_activation,
    sol_stake_message, sol_stake_withdrawable, SolDelegation, SolStakeAccount, SolStakeActivation,
    SolStakeHistoryEntry, SolStakeOp, SOL_STAKE_ACCOUNT_SIZE, SOL_STAKE_HISTORY_SYSVAR,
    SOL_STAKE_PROGRAM,
};
pub use tron::{
    tron_address, tron_address_bytes, tron_address_from_bytes, tron_address_of_pubkey,
    tron_decode_raw, tron_recover_signer, tron_ref_block, tron_sign, tron_signed_transaction,
    tron_trc20_transfer_data, TronAction, TronContract, TronRaw, TronTxSummary, TronWarning,
    TRC20_TRANSFER_SELECTOR, TRON_ADDRESS_PREFIX,
};
pub use tron::{
    tron_decode_stake_raw, tron_stake_sign, TronResource, TronStakeAction, TronStakeSummary,
    TronVote, TRON_MAX_VOTES,
};
pub use utxo::{
    utxo_account, utxo_address, utxo_address_from_xpub, utxo_address_of_script, utxo_decode_raw_tx,
    utxo_dust_threshold, utxo_genesis_hash, utxo_psbt_summary, utxo_script_pubkey, utxo_sign_psbt,
    UtxoAccount, UtxoCoin, UtxoOutput, UtxoOutputKind, UtxoTxSummary, UtxoWarning, DOGE_HARD_DUST,
    DOGE_MIN_RELAY_FEE_PER_KB, DOGE_RECOMMENDED_FEE_PER_KB, DOGE_SOFT_DUST,
    LTC_DUST_RELAY_FEE_PER_KVB, LTC_MIN_RELAY_FEE_PER_KVB,
};
pub use vault::{open, seal, KdfParams, VaultFile, VAULT_VERSION};
pub use watch::{
    sol_path, HwDeviceKind, WatchEvm, WatchOnlyAccount, WatchOnlyStore, WatchSol, EVM_NODE_PATH,
    MAX_HW_ACCOUNT, WATCH_ONLY_VERSION,
};

/// Re-exported so callers can build [`Seed`] values and wipe their own buffers
/// without adding a direct dependency.
pub use xrp::{
    xrp_account_id, xrp_address, xrp_address_from_id, xrp_address_of_pubkey, xrp_currency_code,
    xrp_decode_tx, xrp_issued_amount, xrp_public_key, xrp_sign, xrp_verify_signed, XrpAmount,
    XrpAmountView, XrpMemo, XrpMemoView, XrpPayment, XrpTxSummary, XrpWarning, LSF_DISALLOW_XRP,
    LSF_REQUIRE_DEST_TAG, TF_FULLY_CANONICAL_SIG, TF_LIMIT_QUALITY, TF_NO_RIPPLE_DIRECT,
    TF_PARTIAL_PAYMENT,
};
pub use zeroize::{Zeroize, Zeroizing};
