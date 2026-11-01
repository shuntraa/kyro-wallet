//! Kyro wallet core.
//!
//! Pure, synchronous, I/O-free cryptographic core of the Kyro wallet:
//! BIP39 mnemonics, an Argon2id + XChaCha20-Poly1305 vault, BIP32/BIP84/BIP86
//! Bitcoin derivation and PSBT signing, Litecoin (BIP84), Dogecoin, Zcash transparent (v5, ZIP 244), Bitcoin Cash (CashAddr,
//! FORKID) and Dash (BIP44) PSBT signing, TRON (TRX / TRC-20), XRP Ledger (Payment), Aptos (APT transfers, BCS), Cosmos Hub (MsgSend, SIGN_MODE_DIRECT)
//!, TON (wallet v4R2 transfers), Algorand (pay), Polkadot Asset Hub (sr25519, `transfer_keep_alive`), Hedera (HBAR CryptoTransfer), Sui (SUI transfers, BCS), Stellar (XLM payments, SEP-0005), NEAR (Transfer), Cardano (CIP-1852 payments) and Monero (CLSAG, via monero-oxide) signing, Kaspa (BIP340 Schnorr, KIP-9 mass) payments, EVM (EIP-1559) signing and Solana (SLIP-10 ed25519) signing, plus
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

mod algorand;
mod aptos;
mod btc;
mod btc_hw;
mod btc_watch;
mod cardano;
mod cashaddr;
mod cosmos;
mod display;
mod error;
mod evm;
mod hedera;
mod hw_chains;
mod hw_keys;
mod kaspa;
mod keys;
mod ledger_cal;
mod mnemonic;
mod monero;
mod monero_words;
mod near;
mod network;
mod polkadot;
mod sol;
mod sol_decode;
mod sol_stake;
mod stellar;
mod sui;
mod sui_tx;
mod ton;
mod tron;
mod utxo;
mod vault;
mod watch;
mod xrp;
mod zcash;

pub use algorand::{
    algo_address, algo_address_bytes, algo_address_of_pubkey, algo_decode_signed, algo_decode_tx,
    algo_encode_signed, algo_genesis, algo_hw_message, algo_hw_signed, algo_path, algo_public_key,
    algo_known_asset, algo_known_assets, algo_sign, algo_verify_signed, AlgoAssetSummary,
    AlgoAssetTransfer, AlgoKnownAsset, AlgoPayment, AlgoTxSummary, AlgoWarning, ALGO_MAINNET_GENESIS,
    ALGO_MAX_NOTE, ALGO_MAX_VALIDITY, ALGO_MIN_BALANCE, ALGO_MIN_FEE, ALGO_TESTNET_GENESIS,
};
pub use aptos::{
    aptos_address, aptos_address_bytes_of_pubkey, aptos_address_of_pubkey, aptos_address_string,
    aptos_decode_tx, aptos_hw_message, aptos_hw_signed, aptos_parse_address, aptos_path,
    aptos_public_key, aptos_sign, aptos_signing_message, aptos_simulation_bytes, aptos_tx_hash,
    aptos_verify_signed, AptosTransfer, AptosTxSummary, AptosWarning, APTOS_ED25519_SCHEME,
    APTOS_HIGH_FEE_OCTAS, APTOS_MAINNET_CHAIN_ID, APTOS_TESTNET_CHAIN_ID, APTOS_TRANSFER_FUNCTION,
    OCTAS_PER_APT,
};
pub use btc::{
    btc_account, btc_address, btc_decode_psbt, btc_psbt_summary, btc_sign_psbt, BtcAccount,
    BtcTxSummary, BtcWarning, BTC_HIGH_FEE_SAT_PER_VB, MAX_CHANGE_INDEX,
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
    cardano_account_path, cardano_account_stake_address, cardano_account_xpub, cardano_address,
    cardano_address_bytes, cardano_address_string, cardano_base_address, cardano_blake2b256,
    cardano_cip20_aux, cardano_decode_tx, cardano_enterprise_address, cardano_min_utxo,
    cardano_payment_public_key, cardano_sign, cardano_signed_size, cardano_signed_witnesses,
    cardano_stake_address, cardano_tx_body, cardano_unsigned_tx, cardano_verify, CardanoAssets,
    CardanoBody, CardanoContext, CardanoInput, CardanoOutput, CardanoOutputView, CardanoRoot,
    CardanoTokenView, CardanoTxSummary, CardanoWarning,
};
pub use cardano::{
    cardano_blake2b224, cardano_decode_stake_tx, cardano_drep_id, cardano_drep_parse,
    cardano_pool_bech32, cardano_pool_id, cardano_reward_address_bytes, cardano_sign_stake,
    cardano_stake_public_key, cardano_stake_tx_body, CardanoCert, CardanoCertView, CardanoDrep,
    CardanoDrepView, CardanoStakeSummary, CardanoWithdrawalView,
};
pub use cosmos::{
    cosmos_address, cosmos_address_bytes, cosmos_address_from_bytes, cosmos_address_of_pubkey,
    cosmos_amino_json, cosmos_amino_sign_doc, cosmos_amino_signed, cosmos_chain_id,
    cosmos_decode_sign_doc, cosmos_normalize_address, cosmos_path, cosmos_public_key,
    cosmos_send_sign_doc, cosmos_sign, cosmos_simulation_tx, cosmos_verify_signed,
    proto as cosmos_proto, CosmosSendRequest, CosmosTxSummary, CosmosWarning,
    COSMOS_CHAIN_ID_MAINNET, COSMOS_CHAIN_ID_TESTNET, COSMOS_DENOM, COSMOS_HRP, COSMOS_MAX_MEMO,
    COSMOS_MSG_SEND, COSMOS_SECP256K1_PUBKEY, COSMOS_SIGN_MODE_AMINO_JSON, COSMOS_SIGN_MODE_DIRECT,
};
pub use display::{sanitize_text, SanitizedText, CONTROL_MARKER};
pub use error::{Error, Result};
pub use evm::{
    evm_address, evm_address_from_xpub, evm_address_of_pubkey, evm_chain_network,
    evm_checksum_address, evm_decode, evm_high_fee_threshold_wei, evm_hw_finalize, evm_path,
    evm_sign_tx, evm_signing_payload, evm_tx_fields, evm_xpub_from_node, EvmTxFields, EvmTxKind,
    EvmTxRequest, EvmTxSummary, EvmWarning, EVM_KNOWN_CHAINS,
};
pub use hedera::{
    hbar_check_memo, hbar_checksum, hbar_decode_precheck, hbar_decode_tx, hbar_evm_address,
    hbar_evm_address_of_pubkey, hbar_parse_account_id, hbar_parse_recipient, hbar_path,
    hbar_public_key, hbar_response_name, hbar_sign, hbar_verify_signed, HbarRecipient,
    HbarSignedTransfer, HbarTransfer, HbarTxSummary, HbarWarning, HBAR_HIGH_FEE_TINYBARS,
    HBAR_MAX_MEMO_BYTES, HBAR_MAX_NODES, HBAR_MAX_VALID_DURATION, HBAR_TINYBARS,
};
pub use hw_chains::{stellar_hw_assemble, stellar_signature_base, xrp_hw_assemble};
pub use hw_keys::{HwKeyChain, HwWatchKey};
pub use kaspa::{
    kaspa_account_path, kaspa_address, kaspa_address_decode, kaspa_address_encode,
    kaspa_address_of_script, kaspa_address_of_xonly, kaspa_build_send, kaspa_compute_mass,
    kaspa_hash, kaspa_keys_from_master, kaspa_mass, kaspa_own_keys, kaspa_path, kaspa_prefix,
    kaspa_priority_feerate, kaspa_public_key, kaspa_script_pubkey, kaspa_serialized_size,
    kaspa_sighash, kaspa_sign, kaspa_storage_mass, kaspa_tx_from_json, kaspa_tx_hash, kaspa_tx_id,
    kaspa_tx_summary, kaspa_tx_to_json, kaspa_verify_signed, kaspa_with_dummy_signatures,
    KaspaAddressKind, KaspaAmount, KaspaBuilt, KaspaHashDomain, KaspaInput, KaspaMass,
    KaspaOutpoint, KaspaOutput, KaspaOutputKind, KaspaOutputView, KaspaOwnKey, KaspaSpendable,
    KaspaTx, KaspaTxSummary, KaspaUtxoEntry, KaspaWarning, KASPA_COINBASE_MATURITY,
    KASPA_COIN_TYPE, KASPA_HIGH_FEE, KASPA_HIGH_FEE_FACTOR, KASPA_MAX_FEERATE,
    KASPA_MAX_FOLDED_CHANGE, KASPA_MAX_INPUTS, KASPA_MAX_SOMPI, KASPA_MAX_STANDARD_MASS,
    KASPA_MIN_FEERATE, KASPA_MIN_SEND, KASPA_SCAN_WINDOW, KASPA_STORAGE_MASS_PARAMETER,
    SOMPI_PER_KAS,
};
pub use ledger_cal::{
    ledger_erc20_lookup, ledger_erc20_payload, ledger_erc20_verify, LedgerErc20Descriptor,
    LEDGER_ERC20_SIGNER,
};
pub use mnemonic::{Mnemonic, Seed, WordCount};
pub use monero::{
    monero_wallet, xmr_address, xmr_addresses, xmr_build, xmr_cache_open, xmr_cache_seal,
    xmr_key_images, xmr_parse_address, xmr_path, xmr_public_keys, xmr_rng, xmr_scanner,
    xmr_seed_words, xmr_sign, xmr_spent_key_images, xmr_tx_fee, xmr_view_pair, xmr_words_to_key,
    XmrAddressKind, XmrDestination, XmrSigned, XmrTxSummary, XmrUnsigned, XmrWarning,
    XMR_COINBASE_AGE, XMR_DECIMALS, XMR_HIGH_FEE, XMR_MAX_SUBADDRESS, XMR_RING_LEN,
    XMR_SPENDABLE_AGE, XMR_SUBADDRESS_LOOKAHEAD,
};
pub use near::{
    near_account_kind, near_address, near_decode_tx, near_hash_string, near_hw_message,
    near_hw_signed, near_parse_hash, near_parse_public_key, near_path, near_public_key,
    near_public_key_string, near_sign, near_verify_signed, NearAccountKind, NearTransfer,
    NearTxSummary, NearWarning, NEAR_DECIMALS,
};
pub use network::{BtcKind, Network};
pub use polkadot::{
    dot_account_id, dot_account_storage_key, dot_address, dot_blake2_256, dot_chain,
    dot_decode_account_info, dot_decode_fee_info, dot_decode_payload, dot_fee_probe_extrinsic,
    dot_fee_query_arg, dot_parse_payload, dot_path, dot_public_key, dot_runtime, dot_sign,
    dot_ss58_decode, dot_ss58_encode, dot_transfer_payload, dot_verify_extrinsic, DotAccountInfo,
    DotChain, DotEra, DotExtension, DotRuntime, DotTransfer, DotTxSummary, PolkadotRoot,
    DOT_POLKADOT_ASSET_HUB, DOT_WESTEND_ASSET_HUB,
};
pub use polkadot::{
    dot_asset_account_key, dot_asset_details_key, dot_asset_metadata_key,
    dot_decode_asset_account, dot_decode_asset_details, dot_decode_asset_metadata,
    dot_known_asset, dot_known_assets, DotAssetAccount, DotAssetDetails, DotAssetSummary,
    DotKnownAsset,
};
pub use sol::{sol_address, sol_address_of_pubkey, sol_sign_message, sol_verify_signature};
pub use sol_decode::{
    sol_decode_message, sol_message_lookup_tables, sol_message_static_keys, sol_parse_lookup_table,
    SolInstruction, SolLookupTable, SolTokenProgram, SolTxSummary, SolWarning,
    SOL_LOOKUP_TABLE_PROGRAM,
};
pub use sol_stake::{
    sol_create_with_seed, sol_parse_stake_account, sol_parse_stake_history, sol_stake_activation,
    sol_stake_message, sol_stake_withdrawable, SolDelegation, SolStakeAccount, SolStakeActivation,
    SolStakeHistoryEntry, SolStakeOp, SOL_STAKE_ACCOUNT_SIZE, SOL_STAKE_HISTORY_SYSVAR,
    SOL_STAKE_PROGRAM,
};
pub use stellar::{
    stellar_account_id, stellar_address, stellar_address_from_key, stellar_asset,
    stellar_decode_tx, stellar_muxed_parts, stellar_network_passphrase, stellar_path,
    stellar_public_key, stellar_sign, stellar_verify_signed, StellarAsset, StellarAssetView,
    StellarEnvelope, StellarMemo, StellarMemoView, StellarOp, StellarOpView, StellarOperation,
    StellarSignature, StellarTransaction, StellarTxSummary, StellarWarning,
    STELLAR_HIGH_FEE_STROOPS, STELLAR_MAINNET_PASSPHRASE, STELLAR_MAX_MEMO_TEXT,
    STELLAR_TESTNET_PASSPHRASE, STROOPS_PER_XLM,
};
pub use sui::{
    sui_address, sui_address_bytes_of_pubkey, sui_address_of_pubkey, sui_address_string,
    sui_parse_address, sui_path, sui_public_key, SUI_ED25519_FLAG,
};
pub use sui_tx::{
    sui_decode_tx, sui_hw_message, sui_hw_signature, sui_sign, sui_tx_digest, sui_verify_signed,
    SuiGasCoinView, SuiObjectRef, SuiTransfer, SuiTransferAmount, SuiTxSummary, SuiWarning,
    MIST_PER_SUI, SUI_COIN_TYPE, SUI_HIGH_GAS_BUDGET, SUI_MAX_GAS_OBJECTS,
};
pub use ton::{
    ton_address, ton_decode_tx, ton_jetton_wallet_address, ton_known_jetton, ton_known_jettons,
    ton_parse_address, ton_parse_raw_address, ton_path, ton_public_key, ton_sign,
    ton_unsigned_transfer, ton_verify_signed, ton_wallet_address, ton_wallet_id, TonAddress,
    TonEstimateParts, TonFriendly, TonJettonBody, TonJettonInfo, TonJettonSummary, TonSigned,
    TonTransfer, TonTxSummary, TonWarning, TON_JETTON_ATTACHED_NANOTON, TON_JETTON_FORWARD_NANOTON,
    TON_MAX_COMMENT_BYTES, TON_MODE_ALL_BALANCE, TON_MODE_PAY_FEES, TON_V4R2_CODE_HASH,
    TON_WALLET_ID_MAINNET, TON_WALLET_ID_TESTNET,
};
pub use tron::{
    tron_address, tron_address_at, tron_address_bytes, tron_address_from_bytes,
    tron_address_of_pubkey, tron_decode_raw, tron_path, tron_recover_signer, tron_ref_block,
    tron_sign, tron_signed_transaction, tron_trc20_transfer_data, TronAction, TronContract,
    TronRaw, TronTxSummary, TronWarning, TRC20_TRANSFER_SELECTOR, TRON_ADDRESS_PREFIX,
};
pub use tron::{
    tron_decode_stake_raw, tron_stake_sign, TronResource, TronStakeAction, TronStakeSummary,
    TronVote, TRON_MAX_VOTES,
};
pub use utxo::{
    bch_forkid_sighash, utxo_account, utxo_address, utxo_address_from_xpub, utxo_address_of_script,
    utxo_checkpoint, utxo_decode_raw_tx, utxo_dust_threshold, utxo_genesis_hash, utxo_header_hash,
    utxo_hw_finalize, utxo_hw_plan, utxo_is_special_tx, utxo_psbt_summary, utxo_script_pubkey,
    utxo_sign_psbt, UtxoAccount, UtxoCoin, UtxoHwChange, UtxoHwInput, UtxoHwPlan, UtxoOutput,
    UtxoOutputKind, UtxoTxSummary, UtxoWarning, BCH_DASH_DUST_RELAY_FEE_PER_KB,
    BCH_DASH_MIN_RELAY_FEE_PER_KB, BCH_SIGHASH_ALL_FORKID, DOGE_HARD_DUST,
    DOGE_MIN_RELAY_FEE_PER_KB, DOGE_RECOMMENDED_FEE_PER_KB, DOGE_SOFT_DUST,
    LTC_DUST_RELAY_FEE_PER_KVB, LTC_MIN_RELAY_FEE_PER_KVB,
};
pub use vault::{open, seal, KdfParams, VaultFile, VAULT_VERSION};
pub use watch::{
    sol_path, HwDeviceKind, WatchEvm, WatchKey, WatchOnlyAccount, WatchOnlyStore, WatchSol,
    EVM_NODE_PATH, MAX_HW_ACCOUNT, WATCH_ONLY_VERSION,
};

/// Re-exported so callers can build [`Seed`] values and wipe their own buffers
/// without adding a direct dependency.
pub use xrp::{
    xrp_account_id, xrp_address, xrp_address_at, xrp_address_from_id, xrp_address_of_pubkey,
    xrp_currency_code, xrp_decode_tx, xrp_issued_amount, xrp_path, xrp_public_key,
    xrp_public_key_at, xrp_sign, xrp_sign_at, xrp_verify_signed, XrpAmount, XrpAmountView, XrpMemo,
    XrpMemoView, XrpPayment, XrpTxSummary, XrpWarning, LSF_DISALLOW_XRP, LSF_REQUIRE_DEST_TAG,
    TF_FULLY_CANONICAL_SIG, TF_LIMIT_QUALITY, TF_NO_RIPPLE_DIRECT, TF_PARTIAL_PAYMENT,
};
pub use zcash::{
    zec_account, zec_address, zec_address_from_xpub, zec_address_of_script, zec_consensus,
    zec_decode_raw_tx, zec_genesis_hash, zec_header_branch_id, zec_input_sighash, zec_next_upgrade,
    zec_parse_address, zec_script_pubkey, zec_sign, zec_tx_summary, ZecAccount, ZecAddressKind,
    ZecChange, ZecCoin, ZecConsensus, ZecRawTx, ZecSendRequest, ZecTxSummary, ZecWarning, ZEC_DUST,
    ZEC_EXPIRY_DELTA, ZEC_MAX_INPUTS, ZEC_MIN_CHANGE,
};
pub use zeroize::{Zeroize, Zeroizing};
