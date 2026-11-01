//! Solana message decoder (legacy and v0) and plain-language summary.
//!
//! Hand-written parser for the documented wire format
//! (<https://solana.com/docs/core/transactions>): compact-u16 ("short-vec") lengths, message
//! header, static account keys, recent blockhash, compiled instructions and, for v0, address
//! lookup tables. No signing happens here.
//!
//! Fail-closed rules:
//! - any structural error (truncation, non-canonical short-vec, out-of-range index, trailing
//!   bytes, duplicate keys, unsupported version) is an [`Error`];
//! - every address-lookup-table referenced by a v0 message must be supplied, and every index
//!   must resolve, otherwise the whole decode fails (no "unknown" placeholder);
//! - a recognised program with malformed instruction data is an error, not "unknown";
//! - anything not recognised is reported as [`SolInstruction::Unknown`] and sets
//!   `requires_extra_confirmation`;
//! - so does every recognised instruction whose effect Kyro cannot fully show: an account
//!   created for a program outside a closed list, an SPL `Transfer` without mint / decimals, a
//!   memo or seed that is long or had to be cleaned for display ([`crate::sanitize_text`]).

use serde::{Deserialize, Serialize};

use crate::display::sanitize_text;
use crate::error::{Error, Result};

const SYSTEM_PROGRAM: &str = "11111111111111111111111111111111";
const TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA_PROGRAM: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const COMPUTE_BUDGET_PROGRAM: &str = "ComputeBudget111111111111111111111111111111";
const MEMO_PROGRAM_V2: &str = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const MEMO_PROGRAM_V1: &str = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";
const LOOKUP_TABLE_PROGRAM: &str = "AddressLookupTab1e1111111111111111111111111";
pub(crate) const STAKE_PROGRAM: &str = "Stake11111111111111111111111111111111111111";
pub(crate) const STAKE_CONFIG: &str = "StakeConfig11111111111111111111111111111111";
pub(crate) const SYSVAR_CLOCK: &str = "SysvarC1ock11111111111111111111111111111111";
pub(crate) const SYSVAR_RENT: &str = "SysvarRent111111111111111111111111111111111";
pub(crate) const SYSVAR_STAKE_HISTORY: &str = "SysvarStakeHistory1111111111111111111111111";
/// `StakeStateV2` serialized size: every stake account Kyro accepts to create has this space.
pub(crate) const STAKE_STATE_SIZE: u64 = 200;
/// `MAX_SEED_LEN` of `create_with_seed`.
pub(crate) const MAX_SEED_LEN: usize = 32;

/// Lamports charged per required signature (base fee).
const LAMPORTS_PER_SIGNATURE: u64 = 5_000;
/// Legacy runtime default when no `SetComputeUnitLimit` is present: 200k CU per
/// non-compute-budget instruction, capped at 1.4M. Newer runtimes may allot less to builtin
/// programs, so a priority fee computed from this default is an upper bound.
const DEFAULT_CU_PER_INSTRUCTION: u64 = 200_000;
const MAX_COMPUTE_UNITS: u64 = 1_400_000;
/// AddressLookupTable account: 56-byte metadata header, then 32-byte addresses.
const LOOKUP_TABLE_META_SIZE: usize = 56;
const MAX_MEMO_DISPLAY: usize = 566;
/// A memo longer than this (in characters) needs the reinforced confirmation: a short memo is
/// read at a glance, a long one can hide something in the middle of the dialog.
const MEMO_PLAIN_MAX_CHARS: usize = 80;
/// Seeds are at most 32 bytes for `CreateAccountWithSeed`; `TransferWithSeed` is not checked.
const MAX_SEED_DISPLAY: usize = 64;
/// SPL Token account (`Account::LEN`) and mint (`Mint::LEN`) sizes.
const TOKEN_ACCOUNT_SIZE: u64 = 165;
const TOKEN_MINT_SIZE: u64 = 82;
/// Largest Token-2022 account Kyro accepts without a warning (token account or mint with
/// extensions).
const MAX_TOKEN_2022_SIZE: u64 = 1_024;

/// Resolved contents of an address lookup table, as fetched from the chain by the caller.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolLookupTable {
    /// Table account address (base58).
    pub key: String,
    /// Addresses stored in the table, in order (base58).
    pub addresses: Vec<String>,
}

/// Which SPL token program an instruction targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SolTokenProgram {
    /// `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`.
    Token,
    /// `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`.
    Token2022,
}

/// A decoded instruction. Amounts are decimal strings in the smallest unit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SolInstruction {
    /// System Program `Transfer`.
    SystemTransfer {
        /// Funding account (signer).
        from: String,
        /// Recipient.
        to: String,
        /// Lamports moved.
        lamports: String,
    },
    /// System Program `TransferWithSeed`.
    SystemTransferWithSeed {
        /// Funding account (derived from `base` + seed).
        from: String,
        /// Base account (signer).
        base: String,
        /// Recipient.
        to: String,
        /// Lamports moved.
        lamports: String,
        /// Seed string.
        seed: String,
    },
    /// System Program `CreateAccount`.
    SystemCreateAccount {
        /// Funding account (signer).
        from: String,
        /// New account (signer).
        new_account: String,
        /// Lamports transferred to the new account.
        lamports: String,
        /// Allocated space in bytes.
        space: String,
        /// Program that will own the account.
        owner: String,
    },
    /// System Program `CreateAccountWithSeed`.
    SystemCreateAccountWithSeed {
        /// Funding account (signer).
        from: String,
        /// New (derived) account.
        new_account: String,
        /// Base public key.
        base: String,
        /// Seed string.
        seed: String,
        /// Lamports transferred to the new account.
        lamports: String,
        /// Allocated space in bytes.
        space: String,
        /// Program that will own the account.
        owner: String,
    },
    /// SPL Token / Token-2022 `Transfer` (3) or `TransferChecked` (12).
    TokenTransfer {
        /// Token program.
        token_program: SolTokenProgram,
        /// `true` for `TransferChecked`.
        checked: bool,
        /// Source token account.
        source: String,
        /// Destination token account.
        destination: String,
        /// Owner or delegate of the source account.
        authority: String,
        /// Mint (only known for `TransferChecked`).
        mint: Option<String>,
        /// Raw amount (base units).
        amount: String,
        /// Mint decimals (only for `TransferChecked`).
        decimals: Option<u8>,
        /// Extra signer accounts when `authority` is a multisig.
        multisig_signers: Vec<String>,
    },
    /// SPL Token / Token-2022 `Approve` (4) or `ApproveChecked` (13): a DELEGATION allowing
    /// `delegate` to move up to `amount` from `source`.
    TokenApprove {
        /// Token program.
        token_program: SolTokenProgram,
        /// `true` for `ApproveChecked`.
        checked: bool,
        /// Token account being delegated.
        source: String,
        /// Delegate receiving spending rights.
        delegate: String,
        /// Owner of the source account.
        owner: String,
        /// Mint (only known for `ApproveChecked`).
        mint: Option<String>,
        /// Raw amount (base units).
        amount: String,
        /// Mint decimals (only for `ApproveChecked`).
        decimals: Option<u8>,
        /// Extra signer accounts when `owner` is a multisig.
        multisig_signers: Vec<String>,
    },
    /// Associated Token Account program `Create` / `CreateIdempotent`.
    AtaCreate {
        /// `true` for `CreateIdempotent`.
        idempotent: bool,
        /// Funding account (pays rent).
        payer: String,
        /// Associated token account being created.
        account: String,
        /// Wallet that will own the token account.
        owner: String,
        /// Token mint.
        mint: String,
        /// Token program passed to the ATA program (base58), when present.
        token_program: Option<String>,
    },
    /// Compute Budget `SetComputeUnitLimit`.
    ComputeUnitLimit {
        /// Compute units.
        units: u32,
    },
    /// Compute Budget `SetComputeUnitPrice`.
    ComputeUnitPrice {
        /// Price in micro-lamports per compute unit.
        micro_lamports: String,
    },
    /// Memo program (v1 or v2).
    Memo {
        /// Memo text (UTF-8, truncated for display).
        text: String,
    },
    /// Stake program `Initialize`, accepted only with staker = withdrawer = our address and a
    /// zero lockup (no custodian): anything else is refused by the decoder.
    StakeInitialize {
        /// Stake account being initialised.
        stake_account: String,
        /// Stake authority (always our address).
        staker: String,
        /// Withdraw authority (always our address).
        withdrawer: String,
    },
    /// Stake program `DelegateStake`: delegates the stake account to a validator's vote account.
    /// The stake authority must be our address.
    StakeDelegate {
        /// Stake account.
        stake_account: String,
        /// Validator vote account.
        vote_account: String,
        /// Stake authority (always our address).
        authority: String,
    },
    /// Stake program `Deactivate` (start of the cool-down). The stake authority must be us.
    StakeDeactivate {
        /// Stake account.
        stake_account: String,
        /// Stake authority (always our address).
        authority: String,
    },
    /// Stake program `Withdraw`, accepted only to our own address with our withdraw authority.
    StakeWithdraw {
        /// Stake account.
        stake_account: String,
        /// Recipient (always our address).
        to: String,
        /// Lamports withdrawn.
        lamports: String,
        /// Withdraw authority (always our address).
        authority: String,
    },
    /// Not recognised: shown with its program id and requires an extra confirmation.
    Unknown {
        /// Program id (base58).
        program_id: String,
        /// Number of accounts passed.
        accounts: usize,
        /// The accounts passed (base58, lookup-table entries resolved), in order.
        account_keys: Vec<String>,
        /// Instruction data length in bytes.
        data_len: usize,
    },
}

/// Reasons for caution attached to a summary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SolWarning {
    /// The fee payer is not our address.
    FeePayerNotUs {
        /// Fee payer.
        fee_payer: String,
    },
    /// Another writable signer is required besides us.
    ExtraWritableSigner {
        /// That signer.
        address: String,
    },
    /// A transfer / approve / create authority is not our address.
    AuthorityNotUs {
        /// Instruction index.
        instruction: usize,
        /// The authority.
        authority: String,
    },
    /// The instruction delegates spending rights (`Approve` / `ApproveChecked`).
    Delegation {
        /// Instruction index.
        instruction: usize,
    },
    /// The instruction is not recognised.
    UnknownInstruction {
        /// Instruction index.
        instruction: usize,
        /// Program id.
        program_id: String,
    },
    /// Token-2022 transfer: mint extensions (transfer fee, transfer hook, ...) are not verified.
    Token2022ExtensionsUnverified {
        /// Instruction index.
        instruction: usize,
    },
    /// No explicit compute-unit limit: the priority fee is an upper-bound estimate.
    PriorityFeeEstimated,
    /// `CreateAccount` / `CreateAccountWithSeed` for an owner program outside Kyro's closed list
    /// (System, SPL Token / Token-2022 with a token account or mint size, Stake): that program
    /// will control — and can spend — the lamports moved into the new account.
    UnknownOwnerProgram {
        /// Instruction index.
        instruction: usize,
        /// Owner program of the created account.
        owner: String,
        /// Allocated space in bytes.
        space: String,
    },
    /// SPL `Transfer` (tag 3): unlike `TransferChecked`, neither the mint nor the decimals are
    /// stated, so the token and the amount in token units are not verified.
    UncheckedTokenTransfer {
        /// Instruction index.
        instruction: usize,
    },
    /// Memo or seed text that had control / invisible / bidi characters removed, was cut, or is
    /// long: the dialog shows a cleaned version.
    UnusualText {
        /// Instruction index.
        instruction: usize,
    },
}

/// Plain-language summary of a Solana message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolTxSummary {
    /// `"legacy"` or `"v0"`.
    pub version: String,
    /// Fee payer (first account).
    pub fee_payer: String,
    /// Every required signer, in signature order.
    pub signers: Vec<String>,
    /// Index of our signature in the transaction's signature list, if we must sign.
    pub our_signer_index: Option<usize>,
    /// Recent blockhash (or durable nonce), base58.
    pub recent_blockhash: String,
    /// Decoded instructions, in order.
    pub instructions: Vec<SolInstruction>,
    /// Address lookup tables used (v0), base58.
    pub lookup_tables: Vec<String>,
    /// Base fee: 5000 lamports per required signature.
    pub base_fee_lamports: String,
    /// Explicit `SetComputeUnitLimit`, if any.
    pub compute_unit_limit: Option<u32>,
    /// Explicit `SetComputeUnitPrice` (micro-lamports per CU), if any.
    pub compute_unit_price_micro_lamports: Option<String>,
    /// `ceil(price * limit / 1e6)` lamports; `None` without a price. Uses the runtime default
    /// limit (upper bound) when no explicit limit is set.
    pub priority_fee_lamports: Option<String>,
    /// Reasons for caution.
    pub warnings: Vec<SolWarning>,
    /// `true` if the UI must show an explicit second confirmation before signing.
    pub requires_extra_confirmation: bool,
}

// ---------------------------------------------------------------------------------------------
// Byte reader
// ---------------------------------------------------------------------------------------------

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

fn truncated() -> Error {
    Error::input("Solana message truncated")
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Reader { buf, pos: 0 }
    }

    fn u8(&mut self) -> Result<u8> {
        let b = *self.buf.get(self.pos).ok_or_else(truncated)?;
        self.pos += 1;
        Ok(b)
    }

    fn bytes(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self.pos.checked_add(n).ok_or_else(truncated)?;
        let out = self.buf.get(self.pos..end).ok_or_else(truncated)?;
        self.pos = end;
        Ok(out)
    }

    fn key(&mut self) -> Result<[u8; 32]> {
        let mut k = [0u8; 32];
        k.copy_from_slice(self.bytes(32)?);
        Ok(k)
    }

    /// compact-u16: 1–3 bytes, 7 bits each, little-endian; canonical encodings only.
    fn short_vec_len(&mut self) -> Result<usize> {
        let mut value: u32 = 0;
        for i in 0..3 {
            let byte = self.u8()?;
            if i == 2 && byte > 0x03 {
                return Err(Error::input("invalid compact-u16 length"));
            }
            value |= u32::from(byte & 0x7f) << (7 * i);
            if byte & 0x80 == 0 {
                if i > 0 && byte == 0 {
                    return Err(Error::input("non-canonical compact-u16 length"));
                }
                return usize::try_from(value).map_err(|_| Error::input("invalid length"));
            }
        }
        Err(Error::input("invalid compact-u16 length"))
    }

    fn u64_le(&mut self) -> Result<u64> {
        let mut b = [0u8; 8];
        b.copy_from_slice(self.bytes(8)?);
        Ok(u64::from_le_bytes(b))
    }

    fn u32_le(&mut self) -> Result<u32> {
        let mut b = [0u8; 4];
        b.copy_from_slice(self.bytes(4)?);
        Ok(u32::from_le_bytes(b))
    }

    /// bincode `String`: u64 LE length + UTF-8 bytes.
    fn bincode_string(&mut self) -> Result<String> {
        let len = usize::try_from(self.u64_le()?).map_err(|_| truncated())?;
        if len > self.buf.len() {
            return Err(truncated());
        }
        let bytes = self.bytes(len)?;
        String::from_utf8(bytes.to_vec()).map_err(|_| Error::input("seed is not UTF-8"))
    }

    fn finish(&self) -> Result<()> {
        if self.pos == self.buf.len() {
            Ok(())
        } else {
            Err(Error::input("trailing bytes"))
        }
    }
}

fn b58(key: &[u8]) -> String {
    bs58::encode(key).into_string()
}

fn decode_pubkey(s: &str) -> Result<[u8; 32]> {
    let bytes = bs58::decode(s.trim())
        .into_vec()
        .map_err(|_| Error::input("invalid base58 address"))?;
    bytes
        .try_into()
        .map_err(|_| Error::input("address must be 32 bytes"))
}

// ---------------------------------------------------------------------------------------------
// Lookup tables
// ---------------------------------------------------------------------------------------------

/// Parses the raw data of an AddressLookupTable account (owner
/// `AddressLookupTab1e1111111111111111111111111`): a 56-byte metadata header
/// (`u32` state = 1, `u64` deactivation slot, `u64` last extended slot, `u8` start index,
/// `Option<Pubkey>` authority, 2 bytes padding) followed by 32-byte addresses.
/// Rejects uninitialised and deactivated tables.
pub fn sol_parse_lookup_table(account_data: &[u8]) -> Result<Vec<String>> {
    if account_data.len() < LOOKUP_TABLE_META_SIZE {
        return Err(Error::input("lookup table account too short"));
    }
    if (account_data.len() - LOOKUP_TABLE_META_SIZE) % 32 != 0 {
        return Err(Error::input("lookup table length is not header + n*32"));
    }
    let mut r = Reader::new(account_data);
    if r.u32_le()? != 1 {
        return Err(Error::input("not an initialised lookup table"));
    }
    if r.u64_le()? != u64::MAX {
        return Err(Error::input("lookup table is deactivated"));
    }
    Ok(account_data[LOOKUP_TABLE_META_SIZE..]
        .chunks_exact(32)
        .map(b58)
        .collect())
}

/// Owner program expected for lookup-table accounts (for callers validating RPC responses).
pub const SOL_LOOKUP_TABLE_PROGRAM: &str = LOOKUP_TABLE_PROGRAM;

// ---------------------------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------------------------

struct CompiledIx<'a> {
    program_index: usize,
    accounts: Vec<usize>,
    data: &'a [u8],
}

struct Lookup {
    table: [u8; 32],
    writable: Vec<u8>,
    readonly: Vec<u8>,
}

struct RawMessage<'a> {
    v0: bool,
    num_required_signatures: usize,
    num_readonly_signed: usize,
    static_keys: Vec<[u8; 32]>,
    blockhash: [u8; 32],
    instructions: Vec<CompiledIx<'a>>,
    lookups: Vec<Lookup>,
}

fn parse_message(message: &[u8]) -> Result<RawMessage<'_>> {
    let mut r = Reader::new(message);
    let first = r.u8()?;
    let (v0, num_required_signatures) = if first & 0x80 != 0 {
        if first & 0x7f != 0 {
            return Err(Error::input("unsupported Solana message version"));
        }
        (true, r.u8()?)
    } else {
        (false, first)
    };
    let num_readonly_signed = usize::from(r.u8()?);
    let num_readonly_unsigned = usize::from(r.u8()?);
    let num_required_signatures = usize::from(num_required_signatures);

    let n_keys = r.short_vec_len()?;
    let mut static_keys = Vec::with_capacity(n_keys.min(256));
    for _ in 0..n_keys {
        static_keys.push(r.key()?);
    }
    let blockhash = r.key()?;

    let n_ix = r.short_vec_len()?;
    let mut instructions = Vec::with_capacity(n_ix.min(64));
    for _ in 0..n_ix {
        let program_index = usize::from(r.u8()?);
        let n_acc = r.short_vec_len()?;
        let accounts = r.bytes(n_acc)?.iter().map(|b| usize::from(*b)).collect();
        let n_data = r.short_vec_len()?;
        let data = r.bytes(n_data)?;
        instructions.push(CompiledIx {
            program_index,
            accounts,
            data,
        });
    }

    let mut lookups = Vec::new();
    if v0 {
        let n_lookups = r.short_vec_len()?;
        for _ in 0..n_lookups {
            let table = r.key()?;
            let nw = r.short_vec_len()?;
            let writable = r.bytes(nw)?.to_vec();
            let nr = r.short_vec_len()?;
            let readonly = r.bytes(nr)?.to_vec();
            if writable.is_empty() && readonly.is_empty() {
                return Err(Error::input("empty address table lookup"));
            }
            lookups.push(Lookup {
                table,
                writable,
                readonly,
            });
        }
    }
    r.finish()?;

    // Header sanity (mirrors the runtime's sanitize checks).
    if num_required_signatures == 0 || num_required_signatures > static_keys.len() {
        return Err(Error::input("invalid message header"));
    }
    if num_readonly_signed >= num_required_signatures {
        return Err(Error::input(
            "invalid message header: fee payer must be writable",
        ));
    }
    if num_readonly_unsigned > static_keys.len() - num_required_signatures {
        return Err(Error::input("invalid message header"));
    }
    for (i, k) in static_keys.iter().enumerate() {
        if static_keys[..i].contains(k) {
            return Err(Error::input("duplicate account key"));
        }
    }
    Ok(RawMessage {
        v0,
        num_required_signatures,
        num_readonly_signed,
        static_keys,
        blockhash,
        instructions,
        lookups,
    })
}

/// Lookup-table accounts referenced by a v0 message (empty for legacy messages), so the caller
/// knows which tables to fetch before calling [`sol_decode_message`].
pub fn sol_message_lookup_tables(message: &[u8]) -> Result<Vec<String>> {
    Ok(parse_message(message)?
        .lookups
        .iter()
        .map(|l| b58(&l.table))
        .collect())
}

/// Account keys written in the message itself (base58). In a v0 message, every other account
/// an instruction uses was loaded from a lookup table, i.e. comes from the RPC that served the
/// table: the shell marks those in the confirmation dialog.
pub fn sol_message_static_keys(message: &[u8]) -> Result<Vec<String>> {
    Ok(parse_message(message)?
        .static_keys
        .iter()
        .map(|k| b58(k))
        .collect())
}

struct Account {
    key: String,
}

/// Builds the full account list: static keys, then all writable lookups, then all readonly ones.
fn resolve_accounts(raw: &RawMessage<'_>, tables: &[SolLookupTable]) -> Result<Vec<Account>> {
    let mut writable = Vec::new();
    let mut readonly = Vec::new();
    for l in &raw.lookups {
        let key = b58(&l.table);
        let table = tables
            .iter()
            .find(|t| t.key == key)
            .ok_or_else(|| Error::input(format!("lookup table {key} not resolved")))?;
        for (dst, indexes) in [(&mut writable, &l.writable), (&mut readonly, &l.readonly)] {
            for i in indexes {
                let a = table.addresses.get(usize::from(*i)).ok_or_else(|| {
                    Error::input(format!("lookup index {i} out of range for {key}"))
                })?;
                decode_pubkey(a)?;
                dst.push(Account { key: a.clone() });
            }
        }
    }
    let mut out: Vec<Account> = raw
        .static_keys
        .iter()
        .map(|k| Account { key: b58(k) })
        .collect();
    out.extend(writable);
    out.extend(readonly);
    if out.len() > 256 {
        return Err(Error::input("too many accounts"));
    }
    for (i, a) in out.iter().enumerate() {
        if out[..i].iter().any(|b| b.key == a.key) {
            return Err(Error::input("account loaded twice"));
        }
    }
    let total = out.len();
    for ix in &raw.instructions {
        // Programs must be static keys and cannot be the fee payer.
        if ix.program_index == 0 || ix.program_index >= raw.static_keys.len() {
            return Err(Error::input("invalid program id index"));
        }
        if ix.accounts.iter().any(|&a| a >= total) {
            return Err(Error::input("instruction account index out of range"));
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// Instruction decoding
// ---------------------------------------------------------------------------------------------

struct Ctx<'a> {
    accounts: &'a [Account],
    /// Our address (base58): staking authorities must be it.
    me: &'a str,
}

impl Ctx<'_> {
    fn acc(&self, ix: &CompiledIx<'_>, n: usize, name: &str) -> Result<String> {
        let idx = ix
            .accounts
            .get(n)
            .ok_or_else(|| Error::input(format!("missing account: {name}")))?;
        Ok(self.accounts[*idx].key.clone())
    }

    fn rest(&self, ix: &CompiledIx<'_>, from: usize) -> Vec<String> {
        ix.accounts
            .iter()
            .skip(from)
            .map(|i| self.accounts[*i].key.clone())
            .collect()
    }
}

fn bad_data(program: &str) -> Error {
    Error::input(format!("malformed {program} instruction"))
}

fn decode_system(ctx: &Ctx<'_>, ix: &CompiledIx<'_>) -> Result<Option<SolInstruction>> {
    let mut r = Reader::new(ix.data);
    let tag = r.u32_le().map_err(|_| bad_data("System"))?;
    let decoded = match tag {
        0 => {
            let lamports = r.u64_le()?;
            let space = r.u64_le()?;
            let owner = b58(&r.key()?);
            SolInstruction::SystemCreateAccount {
                from: ctx.acc(ix, 0, "funding")?,
                new_account: ctx.acc(ix, 1, "new account")?,
                lamports: lamports.to_string(),
                space: space.to_string(),
                owner,
            }
        }
        2 => SolInstruction::SystemTransfer {
            lamports: r.u64_le()?.to_string(),
            from: ctx.acc(ix, 0, "from")?,
            to: ctx.acc(ix, 1, "to")?,
        },
        3 => {
            let base = b58(&r.key()?);
            let seed = r.bincode_string()?;
            let lamports = r.u64_le()?;
            let space = r.u64_le()?;
            let owner = b58(&r.key()?);
            SolInstruction::SystemCreateAccountWithSeed {
                from: ctx.acc(ix, 0, "funding")?,
                new_account: ctx.acc(ix, 1, "new account")?,
                base,
                seed,
                lamports: lamports.to_string(),
                space: space.to_string(),
                owner,
            }
        }
        11 => {
            let lamports = r.u64_le()?;
            let seed = r.bincode_string()?;
            let _from_owner = r.key()?;
            SolInstruction::SystemTransferWithSeed {
                from: ctx.acc(ix, 0, "from")?,
                base: ctx.acc(ix, 1, "base")?,
                to: ctx.acc(ix, 2, "to")?,
                lamports: lamports.to_string(),
                seed,
            }
        }
        _ => return Ok(None),
    };
    r.finish().map_err(|_| bad_data("System"))?;
    Ok(Some(decoded))
}

fn decode_token(
    ctx: &Ctx<'_>,
    ix: &CompiledIx<'_>,
    token_program: SolTokenProgram,
) -> Result<Option<SolInstruction>> {
    let mut r = Reader::new(ix.data);
    let tag = r.u8().map_err(|_| bad_data("SPL Token"))?;
    let decoded = match tag {
        3 => SolInstruction::TokenTransfer {
            token_program,
            checked: false,
            amount: r.u64_le()?.to_string(),
            source: ctx.acc(ix, 0, "source")?,
            destination: ctx.acc(ix, 1, "destination")?,
            authority: ctx.acc(ix, 2, "authority")?,
            mint: None,
            decimals: None,
            multisig_signers: ctx.rest(ix, 3),
        },
        12 => SolInstruction::TokenTransfer {
            token_program,
            checked: true,
            amount: r.u64_le()?.to_string(),
            decimals: Some(r.u8()?),
            source: ctx.acc(ix, 0, "source")?,
            mint: Some(ctx.acc(ix, 1, "mint")?),
            destination: ctx.acc(ix, 2, "destination")?,
            authority: ctx.acc(ix, 3, "authority")?,
            multisig_signers: ctx.rest(ix, 4),
        },
        4 => SolInstruction::TokenApprove {
            token_program,
            checked: false,
            amount: r.u64_le()?.to_string(),
            source: ctx.acc(ix, 0, "source")?,
            delegate: ctx.acc(ix, 1, "delegate")?,
            owner: ctx.acc(ix, 2, "owner")?,
            mint: None,
            decimals: None,
            multisig_signers: ctx.rest(ix, 3),
        },
        13 => SolInstruction::TokenApprove {
            token_program,
            checked: true,
            amount: r.u64_le()?.to_string(),
            decimals: Some(r.u8()?),
            source: ctx.acc(ix, 0, "source")?,
            mint: Some(ctx.acc(ix, 1, "mint")?),
            delegate: ctx.acc(ix, 2, "delegate")?,
            owner: ctx.acc(ix, 3, "owner")?,
            multisig_signers: ctx.rest(ix, 4),
        },
        _ => return Ok(None),
    };
    r.finish().map_err(|_| bad_data("SPL Token"))?;
    Ok(Some(decoded))
}

fn decode_ata(ctx: &Ctx<'_>, ix: &CompiledIx<'_>) -> Result<Option<SolInstruction>> {
    let idempotent = match ix.data {
        [] | [0] => false,
        [1] => true,
        _ => return Ok(None), // RecoverNested and future instructions
    };
    Ok(Some(SolInstruction::AtaCreate {
        idempotent,
        payer: ctx.acc(ix, 0, "payer")?,
        account: ctx.acc(ix, 1, "associated account")?,
        owner: ctx.acc(ix, 2, "wallet")?,
        mint: ctx.acc(ix, 3, "mint")?,
        token_program: ctx.acc(ix, 5, "token program").ok(),
    }))
}

fn decode_compute_budget(ix: &CompiledIx<'_>) -> Result<Option<SolInstruction>> {
    let mut r = Reader::new(ix.data);
    let decoded = match r.u8().map_err(|_| bad_data("Compute Budget"))? {
        2 => SolInstruction::ComputeUnitLimit { units: r.u32_le()? },
        3 => SolInstruction::ComputeUnitPrice {
            micro_lamports: r.u64_le()?.to_string(),
        },
        _ => return Ok(None),
    };
    r.finish().map_err(|_| bad_data("Compute Budget"))?;
    Ok(Some(decoded))
}

/// Memo text, cleaned for display. The flag is set when the memo had to be cleaned or cut, or
/// is longer than [`MEMO_PLAIN_MAX_CHARS`].
fn decode_memo(ix: &CompiledIx<'_>) -> Option<(SolInstruction, bool)> {
    let text = core::str::from_utf8(ix.data).ok()?;
    let clean = sanitize_text(text, MAX_MEMO_DISPLAY);
    let unusual = clean.altered || text.chars().count() > MEMO_PLAIN_MAX_CHARS;
    Some((SolInstruction::Memo { text: clean.text }, unusual))
}

fn stake_refused(msg: impl Into<String>) -> Error {
    Error::input(format!("Solana staking: {}", msg.into()))
}

/// Name of a Stake program instruction Kyro refuses (for the error message).
fn stake_instruction_name(tag: u32) -> &'static str {
    match tag {
        1 => "Authorize (authority change)",
        3 => "Split",
        6 => "SetLockup (lockup)",
        7 => "Merge",
        8 => "AuthorizeWithSeed (authority change)",
        9 => "InitializeChecked",
        10 => "AuthorizeChecked (authority change)",
        11 => "AuthorizeCheckedWithSeed (authority change)",
        12 => "SetLockupChecked (lockup)",
        13 => "GetMinimumDelegation",
        14 => "DeactivateDelinquent",
        15 => "Redelegate",
        16 => "MoveStake",
        17 => "MoveLamports",
        _ => "unknown",
    }
}

/// Stake program: only `Initialize` (zero lockup, staker = withdrawer = us), `DelegateStake`,
/// `Deactivate` and `Withdraw` (to us), each with its exact account list and our authority.
/// Every other instruction of the program — authority changes, lockups, split, merge… — and any
/// authority that is not us is an error, not an "unknown instruction".
fn decode_stake(ctx: &Ctx<'_>, ix: &CompiledIx<'_>) -> Result<SolInstruction> {
    let mut r = Reader::new(ix.data);
    let tag = r.u32_le().map_err(|_| bad_data("Stake"))?;
    let accounts = |n: &[usize]| -> Result<()> {
        if n.contains(&ix.accounts.len()) {
            Ok(())
        } else {
            Err(stake_refused(format!(
                "unexpected number of accounts ({}) for instruction {tag}",
                ix.accounts.len()
            )))
        }
    };
    let expect = |n: usize, key: &str, what: &str| -> Result<()> {
        if ctx.acc(ix, n, what)? == key {
            Ok(())
        } else {
            Err(stake_refused(format!("{what} expected at position {n}")))
        }
    };
    let ours = |n: usize, what: &str| -> Result<String> {
        let a = ctx.acc(ix, n, what)?;
        if a != ctx.me {
            return Err(stake_refused(format!(
                "{what} ({a}) is not your address: refused"
            )));
        }
        Ok(a)
    };
    let decoded = match tag {
        0 => {
            accounts(&[2])?;
            let staker = b58(&r.key()?);
            let withdrawer = b58(&r.key()?);
            let unix_timestamp = r.u64_le()?;
            let epoch = r.u64_le()?;
            let custodian = r.key()?;
            if unix_timestamp != 0 || epoch != 0 || custodian != [0u8; 32] {
                return Err(stake_refused("non-zero lockup or custodian: refused"));
            }
            if staker != ctx.me || withdrawer != ctx.me {
                return Err(stake_refused(format!(
                    "the stake account's authorities must be your address (staker {staker}, withdrawer {withdrawer}): refused"
                )));
            }
            expect(1, SYSVAR_RENT, "sysvar Rent")?;
            SolInstruction::StakeInitialize {
                stake_account: ctx.acc(ix, 0, "stake account")?,
                staker,
                withdrawer,
            }
        }
        2 => {
            accounts(&[6])?;
            expect(2, SYSVAR_CLOCK, "sysvar Clock")?;
            expect(3, SYSVAR_STAKE_HISTORY, "sysvar StakeHistory")?;
            expect(4, STAKE_CONFIG, "StakeConfig account")?;
            SolInstruction::StakeDelegate {
                stake_account: ctx.acc(ix, 0, "stake account")?,
                vote_account: ctx.acc(ix, 1, "vote account")?,
                authority: ours(5, "stake authority")?,
            }
        }
        5 => {
            accounts(&[3])?;
            expect(1, SYSVAR_CLOCK, "sysvar Clock")?;
            SolInstruction::StakeDeactivate {
                stake_account: ctx.acc(ix, 0, "stake account")?,
                authority: ours(2, "stake authority")?,
            }
        }
        4 => {
            accounts(&[5, 6])?;
            let lamports = r.u64_le()?;
            expect(2, SYSVAR_CLOCK, "sysvar Clock")?;
            expect(3, SYSVAR_STAKE_HISTORY, "sysvar StakeHistory")?;
            let authority = ours(4, "withdraw authority")?;
            if ix.accounts.len() == 6 {
                // Lockup custodian: only accepted when it is us (Kyro never sets a lockup).
                ours(5, "custodian")?;
            }
            SolInstruction::StakeWithdraw {
                stake_account: ctx.acc(ix, 0, "stake account")?,
                to: ours(1, "withdrawal recipient")?,
                lamports: lamports.to_string(),
                authority,
            }
        }
        other => {
            return Err(stake_refused(format!(
                "instruction {other} ({}) refused by Kyro",
                stake_instruction_name(other)
            )))
        }
    };
    r.finish().map_err(|_| bad_data("Stake"))?;
    Ok(decoded)
}

/// `Pubkey::create_with_seed`: sha256(base ‖ seed ‖ owner).
pub(crate) fn create_with_seed(base: &[u8; 32], seed: &str, owner: &[u8; 32]) -> Result<[u8; 32]> {
    use sha2::{Digest, Sha256};
    if seed.len() > MAX_SEED_LEN {
        return Err(Error::input("seed longer than 32 bytes"));
    }
    if owner.ends_with(b"ProgramDerivedAddress") {
        return Err(Error::input("illegal owner for create_with_seed"));
    }
    let mut h = Sha256::new();
    h.update(base);
    h.update(seed.as_bytes());
    h.update(owner);
    Ok(h.finalize().into())
}

/// Whether an account created for `owner` with `space` bytes is one Kyro understands: a plain
/// System account, or an SPL Token / Token-2022 token account or mint (Token-2022 accounts with
/// extensions are larger than a plain token account). Stake accounts are checked separately.
fn known_owner(owner: &str, space: &str) -> bool {
    let space = space.parse::<u64>().unwrap_or(u64::MAX);
    match owner {
        SYSTEM_PROGRAM => true,
        TOKEN_PROGRAM => space == TOKEN_ACCOUNT_SIZE || space == TOKEN_MINT_SIZE,
        TOKEN_2022_PROGRAM => {
            space == TOKEN_MINT_SIZE || (TOKEN_ACCOUNT_SIZE..=MAX_TOKEN_2022_SIZE).contains(&space)
        }
        _ => false,
    }
}

/// Checks every account creation: a `CreateAccountWithSeed` must create the address derived
/// from its base, seed and owner; an account created for the Stake program must have the stake
/// account size and be initialised by a later instruction of the same message (an
/// uninitialised stake account can be initialised by anyone, with any authority). Returns the
/// creations whose owner program is outside the closed list of [`known_owner`] as
/// `(instruction, owner, space)`: the caller warns and requires the reinforced confirmation.
fn check_creations(instructions: &[SolInstruction]) -> Result<Vec<(usize, String, String)>> {
    let mut unknown = Vec::new();
    for (i, ins) in instructions.iter().enumerate() {
        let (new_account, space, owner) = match ins {
            SolInstruction::SystemCreateAccountWithSeed {
                new_account,
                base,
                seed,
                space,
                owner,
                ..
            } => {
                let derived =
                    create_with_seed(&decode_pubkey(base)?, seed, &decode_pubkey(owner)?)?;
                if b58(&derived) != *new_account {
                    return Err(Error::input(
                        "CreateAccountWithSeed: the created address is not derived from base, seed and owner",
                    ));
                }
                (new_account, space, owner)
            }
            SolInstruction::SystemCreateAccount {
                new_account,
                space,
                owner,
                ..
            } => (new_account, space, owner),
            _ => continue,
        };
        if owner != STAKE_PROGRAM {
            if !known_owner(owner, space) {
                unknown.push((i, owner.clone(), space.clone()));
            }
            continue;
        }
        if *space != STAKE_STATE_SIZE.to_string() {
            return Err(stake_refused(format!(
                "stake account created with {space} bytes instead of {STAKE_STATE_SIZE}"
            )));
        }
        let initialized = instructions[i + 1..].iter().any(|later| {
            matches!(later, SolInstruction::StakeInitialize { stake_account, .. } if stake_account == new_account)
        });
        if !initialized {
            return Err(stake_refused(
                "stake account created without being initialized in the same transaction: refused",
            ));
        }
    }
    Ok(unknown)
}

/// Decodes one instruction; the flag marks memo text that needs the reinforced confirmation.
fn decode_instruction(ctx: &Ctx<'_>, ix: &CompiledIx<'_>) -> Result<(SolInstruction, bool)> {
    let program = ctx.accounts[ix.program_index].key.as_str();
    if matches!(program, MEMO_PROGRAM_V2 | MEMO_PROGRAM_V1) {
        if let Some(memo) = decode_memo(ix) {
            return Ok(memo);
        }
    }
    let decoded = match program {
        STAKE_PROGRAM => Some(decode_stake(ctx, ix)?),
        SYSTEM_PROGRAM => decode_system(ctx, ix)?,
        TOKEN_PROGRAM => decode_token(ctx, ix, SolTokenProgram::Token)?,
        TOKEN_2022_PROGRAM => decode_token(ctx, ix, SolTokenProgram::Token2022)?,
        ATA_PROGRAM => decode_ata(ctx, ix)?,
        COMPUTE_BUDGET_PROGRAM => decode_compute_budget(ix)?,
        _ => None,
    };
    let decoded = decoded.unwrap_or_else(|| SolInstruction::Unknown {
        program_id: program.to_owned(),
        accounts: ix.accounts.len(),
        account_keys: ctx.rest(ix, 0),
        data_len: ix.data.len(),
    });
    Ok((decoded, false))
}

/// Replaces a seed by its display form; `true` if it had to be cleaned or cut.
fn sanitize_seed(seed: &mut String) -> bool {
    let clean = sanitize_text(seed, MAX_SEED_DISPLAY);
    *seed = clean.text;
    clean.altered
}

// ---------------------------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------------------------

/// Decodes a serialized Solana message (legacy or v0) into a plain-language summary.
///
/// `tables` must contain every lookup table referenced by a v0 message (fetched from the chain
/// by the caller, see [`sol_message_lookup_tables`] and [`sol_parse_lookup_table`]); a missing
/// table or index is an error. `our_address` is the wallet's base58 address, used for warnings.
pub fn sol_decode_message(
    message: &[u8],
    tables: &[SolLookupTable],
    our_address: &str,
) -> Result<SolTxSummary> {
    decode_pubkey(our_address)?;
    let raw = parse_message(message)?;
    let accounts = resolve_accounts(&raw, tables)?;
    let ctx = Ctx {
        accounts: &accounts,
        me: our_address.trim(),
    };

    let mut instructions = Vec::with_capacity(raw.instructions.len());
    let mut unusual_text = Vec::with_capacity(raw.instructions.len());
    for ix in &raw.instructions {
        let (ins, unusual) = decode_instruction(&ctx, ix)?;
        instructions.push(ins);
        unusual_text.push(unusual);
    }
    let unknown_owners = check_creations(&instructions)?;
    // Seeds are cleaned for display only now: the derivation check above used the raw bytes.
    for (ins, unusual) in instructions.iter_mut().zip(unusual_text.iter_mut()) {
        if let SolInstruction::SystemCreateAccountWithSeed { seed, .. }
        | SolInstruction::SystemTransferWithSeed { seed, .. } = ins
        {
            *unusual |= sanitize_seed(seed);
        }
    }

    let signers: Vec<String> = accounts[..raw.num_required_signatures]
        .iter()
        .map(|a| a.key.clone())
        .collect();
    let fee_payer = signers[0].clone();
    let our_signer_index = signers.iter().position(|s| s == our_address);
    let mut warnings = Vec::new();
    let mut extra = false;

    if fee_payer != our_address {
        warnings.push(SolWarning::FeePayerNotUs {
            fee_payer: fee_payer.clone(),
        });
        extra = true;
    }
    let writable_signers = raw.num_required_signatures - raw.num_readonly_signed;
    for s in &signers[..writable_signers] {
        if s != our_address {
            warnings.push(SolWarning::ExtraWritableSigner { address: s.clone() });
            extra = true;
        }
    }

    let mut cu_limit: Option<u32> = None;
    let mut cu_price: Option<u64> = None;
    let mut non_budget_ix: u64 = 0;
    for (i, ins) in instructions.iter().enumerate() {
        let authority = match ins {
            SolInstruction::SystemTransfer { from, .. }
            | SolInstruction::SystemCreateAccount { from, .. }
            | SolInstruction::SystemCreateAccountWithSeed { from, .. } => Some(from),
            SolInstruction::SystemTransferWithSeed { base, .. } => Some(base),
            SolInstruction::TokenTransfer { authority, .. } => Some(authority),
            SolInstruction::TokenApprove { owner, .. } => Some(owner),
            // Stake authorities are checked (= us) by the decoder itself.
            SolInstruction::StakeDelegate { authority, .. }
            | SolInstruction::StakeDeactivate { authority, .. }
            | SolInstruction::StakeWithdraw { authority, .. } => Some(authority),
            _ => None,
        };
        if let Some(a) = authority {
            if a != our_address {
                warnings.push(SolWarning::AuthorityNotUs {
                    instruction: i,
                    authority: a.clone(),
                });
                extra = true;
            }
        }
        match ins {
            SolInstruction::TokenApprove { .. } => {
                warnings.push(SolWarning::Delegation { instruction: i });
                extra = true;
            }
            SolInstruction::TokenTransfer {
                token_program,
                checked,
                ..
            } => {
                if !checked {
                    warnings.push(SolWarning::UncheckedTokenTransfer { instruction: i });
                    extra = true;
                }
                if *token_program == SolTokenProgram::Token2022 {
                    warnings.push(SolWarning::Token2022ExtensionsUnverified { instruction: i });
                }
            }
            SolInstruction::Unknown { program_id, .. } => {
                warnings.push(SolWarning::UnknownInstruction {
                    instruction: i,
                    program_id: program_id.clone(),
                });
                extra = true;
            }
            _ => {}
        }
        if let Some((_, owner, space)) = unknown_owners.iter().find(|(at, _, _)| *at == i) {
            warnings.push(SolWarning::UnknownOwnerProgram {
                instruction: i,
                owner: owner.clone(),
                space: space.clone(),
            });
            extra = true;
        }
        if unusual_text[i] {
            warnings.push(SolWarning::UnusualText { instruction: i });
            extra = true;
        }
        match ins {
            SolInstruction::ComputeUnitLimit { units } => {
                if cu_limit.replace(*units).is_some() {
                    return Err(Error::input("duplicate SetComputeUnitLimit"));
                }
            }
            SolInstruction::ComputeUnitPrice { micro_lamports } => {
                let price = micro_lamports
                    .parse::<u64>()
                    .map_err(|_| Error::input("invalid compute unit price"))?;
                if cu_price.replace(price).is_some() {
                    return Err(Error::input("duplicate SetComputeUnitPrice"));
                }
            }
            _ => {
                // Unknown compute-budget instructions still count as "budget" for the default.
                let is_budget = matches!(ins, SolInstruction::Unknown { program_id, .. } if program_id == COMPUTE_BUDGET_PROGRAM);
                if !is_budget {
                    non_budget_ix += 1;
                }
            }
        }
    }

    let priority_fee_lamports = match cu_price {
        None => None,
        Some(price) => {
            let limit = match cu_limit {
                Some(l) => u64::from(l).min(MAX_COMPUTE_UNITS),
                None => {
                    warnings.push(SolWarning::PriorityFeeEstimated);
                    (non_budget_ix * DEFAULT_CU_PER_INSTRUCTION).min(MAX_COMPUTE_UNITS)
                }
            };
            let micro = u128::from(price) * u128::from(limit);
            Some(micro.div_ceil(1_000_000).to_string())
        }
    };

    let base_fee = LAMPORTS_PER_SIGNATURE * raw.num_required_signatures as u64;
    Ok(SolTxSummary {
        version: if raw.v0 { "v0" } else { "legacy" }.to_owned(),
        fee_payer,
        signers,
        our_signer_index,
        recent_blockhash: b58(&raw.blockhash),
        instructions,
        lookup_tables: raw.lookups.iter().map(|l| b58(&l.table)).collect(),
        base_fee_lamports: base_fee.to_string(),
        compute_unit_limit: cu_limit,
        compute_unit_price_micro_lamports: cu_price.map(|p| p.to_string()),
        priority_fee_lamports,
        warnings,
        requires_extra_confirmation: extra,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sv(n: usize) -> Vec<u8> {
        let mut out = Vec::new();
        let mut v = n;
        loop {
            let mut b = (v & 0x7f) as u8;
            v >>= 7;
            if v != 0 {
                b |= 0x80;
            }
            out.push(b);
            if v == 0 {
                return out;
            }
        }
    }

    fn short_vec(bytes: &[u8]) -> Result<usize> {
        Reader::new(bytes).short_vec_len()
    }

    #[test]
    fn compact_u16() {
        assert_eq!(short_vec(&[0x00]).unwrap(), 0);
        assert_eq!(short_vec(&[0x7f]).unwrap(), 127);
        assert_eq!(short_vec(&[0x80, 0x01]).unwrap(), 128);
        assert_eq!(short_vec(&[0xff, 0x7f]).unwrap(), 16383);
        assert_eq!(short_vec(&[0x80, 0x80, 0x01]).unwrap(), 16384);
        assert_eq!(short_vec(&[0xff, 0xff, 0x03]).unwrap(), 65535);
        for n in [0usize, 1, 127, 128, 255, 16383, 16384, 65535] {
            assert_eq!(short_vec(&sv(n)).unwrap(), n);
        }
        // Non-canonical aliases, overflow, truncation.
        assert!(short_vec(&[0x80, 0x00]).is_err());
        assert!(short_vec(&[0x80, 0x80, 0x00]).is_err());
        assert!(short_vec(&[0xff, 0xff, 0x04]).is_err());
        assert!(short_vec(&[0x80, 0x80, 0x80, 0x01]).is_err());
        assert!(short_vec(&[0x80]).is_err());
        assert!(short_vec(&[]).is_err());
    }

    const PAYER: [u8; 32] = [7u8; 32];
    const OTHER: [u8; 32] = [9u8; 32];

    fn program_key(s: &str) -> [u8; 32] {
        decode_pubkey(s).unwrap()
    }

    /// Legacy message: payer (writable signer), `to` (writable), program (readonly).
    fn legacy(program: &str, data: &[u8], accounts: &[u8]) -> Vec<u8> {
        let mut m = vec![1, 0, 1];
        m.extend(sv(3));
        m.extend_from_slice(&PAYER);
        m.extend_from_slice(&OTHER);
        m.extend_from_slice(&program_key(program));
        m.extend_from_slice(&[3u8; 32]); // blockhash
        m.extend(sv(1));
        m.push(2);
        m.extend(sv(accounts.len()));
        m.extend_from_slice(accounts);
        m.extend(sv(data.len()));
        m.extend_from_slice(data);
        m
    }

    fn me() -> String {
        b58(&PAYER)
    }

    #[test]
    fn system_transfer_built() {
        let mut data = 2u32.to_le_bytes().to_vec();
        data.extend_from_slice(&1_500_000_000u64.to_le_bytes());
        let s = sol_decode_message(&legacy(SYSTEM_PROGRAM, &data, &[0, 1]), &[], &me()).unwrap();
        assert_eq!(
            s.instructions,
            vec![SolInstruction::SystemTransfer {
                from: me(),
                to: b58(&OTHER),
                lamports: "1500000000".into()
            }]
        );
        assert!(!s.requires_extra_confirmation);
        assert_eq!(s.our_signer_index, Some(0));
        assert_eq!(s.base_fee_lamports, "5000");
        // Somebody else's wallet: fee payer + authority warnings.
        let s =
            sol_decode_message(&legacy(SYSTEM_PROGRAM, &data, &[0, 1]), &[], &b58(&OTHER)).unwrap();
        assert!(s.requires_extra_confirmation);
        assert_eq!(s.our_signer_index, None);
        // Trailing data in a known instruction: fail closed.
        let mut long = data.clone();
        long.push(0);
        assert!(sol_decode_message(&legacy(SYSTEM_PROGRAM, &long, &[0, 1]), &[], &me()).is_err());
        // Missing account.
        assert!(sol_decode_message(&legacy(SYSTEM_PROGRAM, &data, &[0]), &[], &me()).is_err());
    }

    #[test]
    fn system_create_and_seeded_layouts() {
        // CreateAccount: u32 0, u64 lamports, u64 space, Pubkey owner.
        let mut data = 0u32.to_le_bytes().to_vec();
        data.extend_from_slice(&2_039_280u64.to_le_bytes());
        data.extend_from_slice(&165u64.to_le_bytes());
        data.extend_from_slice(&program_key(TOKEN_PROGRAM));
        let s = sol_decode_message(&legacy(SYSTEM_PROGRAM, &data, &[0, 1]), &[], &me()).unwrap();
        assert_eq!(
            s.instructions[0],
            SolInstruction::SystemCreateAccount {
                from: me(),
                new_account: b58(&OTHER),
                lamports: "2039280".into(),
                space: "165".into(),
                owner: TOKEN_PROGRAM.into()
            }
        );
        // TransferWithSeed: u32 11, u64 lamports, bincode String seed, Pubkey from_owner.
        let mut data = 11u32.to_le_bytes().to_vec();
        data.extend_from_slice(&7u64.to_le_bytes());
        data.extend_from_slice(&4u64.to_le_bytes());
        data.extend_from_slice(b"seed");
        data.extend_from_slice(&program_key(SYSTEM_PROGRAM));
        let s = sol_decode_message(&legacy(SYSTEM_PROGRAM, &data, &[1, 0, 1]), &[], &me()).unwrap();
        assert_eq!(
            s.instructions[0],
            SolInstruction::SystemTransferWithSeed {
                from: b58(&OTHER),
                base: me(),
                to: b58(&OTHER),
                lamports: "7".into(),
                seed: "seed".into()
            }
        );
        assert!(!s.requires_extra_confirmation, "base (authority) is us");
        // Seed length larger than the data: error, not panic.
        let mut bad = 11u32.to_le_bytes().to_vec();
        bad.extend_from_slice(&7u64.to_le_bytes());
        bad.extend_from_slice(&u64::MAX.to_le_bytes());
        assert!(sol_decode_message(&legacy(SYSTEM_PROGRAM, &bad, &[1, 0, 1]), &[], &me()).is_err());
        // Unrecognised System instruction (e.g. Assign = 1) is Unknown.
        let s =
            sol_decode_message(&legacy(SYSTEM_PROGRAM, &[1, 0, 0, 0], &[0]), &[], &me()).unwrap();
        assert!(matches!(s.instructions[0], SolInstruction::Unknown { .. }));
        assert!(s.requires_extra_confirmation);
    }

    #[test]
    fn approve_checked_on_token_2022() {
        let mut data = vec![13u8];
        data.extend_from_slice(&5_000_000u64.to_le_bytes());
        data.push(6);
        let s = sol_decode_message(
            &legacy(TOKEN_2022_PROGRAM, &data, &[1, 1, 1, 0]),
            &[],
            &me(),
        )
        .unwrap();
        assert_eq!(
            s.instructions[0],
            SolInstruction::TokenApprove {
                token_program: SolTokenProgram::Token2022,
                checked: true,
                source: b58(&OTHER),
                mint: Some(b58(&OTHER)),
                delegate: b58(&OTHER),
                owner: me(),
                amount: "5000000".into(),
                decimals: Some(6),
                multisig_signers: vec![]
            }
        );
        assert!(s
            .warnings
            .contains(&SolWarning::Delegation { instruction: 0 }));
        assert!(s.requires_extra_confirmation);
    }

    #[test]
    fn approve_is_delegation() {
        let mut data = vec![4u8];
        data.extend_from_slice(&u64::MAX.to_le_bytes());
        // source = OTHER, delegate = program slot is not allowed (index 2 is the program) so
        // use the payer as owner and OTHER as both source and delegate is invalid; build a
        // 3-account instruction [1, 1, 0] -> duplicate indices are legal in instructions.
        let s = sol_decode_message(&legacy(TOKEN_PROGRAM, &data, &[1, 1, 0]), &[], &me()).unwrap();
        assert!(matches!(
            &s.instructions[0],
            SolInstruction::TokenApprove { amount, checked: false, .. } if amount == &u64::MAX.to_string()
        ));
        assert!(s
            .warnings
            .contains(&SolWarning::Delegation { instruction: 0 }));
        assert!(s.requires_extra_confirmation);
    }

    #[test]
    fn compute_budget_and_unknown() {
        let mut data = vec![3u8];
        data.extend_from_slice(&10_000u64.to_le_bytes());
        let s =
            sol_decode_message(&legacy(COMPUTE_BUDGET_PROGRAM, &data, &[]), &[], &me()).unwrap();
        assert_eq!(
            s.compute_unit_price_micro_lamports.as_deref(),
            Some("10000")
        );
        // No limit and no other instruction: estimate 0 CU.
        assert_eq!(s.priority_fee_lamports.as_deref(), Some("0"));
        assert!(s.warnings.contains(&SolWarning::PriorityFeeEstimated));

        let s = sol_decode_message(&legacy(LOOKUP_TABLE_PROGRAM, &[1, 2, 3], &[0]), &[], &me())
            .unwrap();
        assert_eq!(
            s.instructions[0],
            SolInstruction::Unknown {
                program_id: LOOKUP_TABLE_PROGRAM.into(),
                accounts: 1,
                account_keys: vec![me()],
                data_len: 3
            }
        );
        assert!(s.requires_extra_confirmation);
    }

    #[test]
    fn malformed_messages_error() {
        let mut data = 2u32.to_le_bytes().to_vec();
        data.extend_from_slice(&1u64.to_le_bytes());
        let good = legacy(SYSTEM_PROGRAM, &data, &[0, 1]);
        // Every truncation fails.
        for n in 0..good.len() {
            assert!(
                sol_decode_message(&good[..n], &[], &me()).is_err(),
                "len {n}"
            );
        }
        // Trailing byte.
        let mut t = good.clone();
        t.push(0);
        assert!(sol_decode_message(&t, &[], &me()).is_err());
        // Account index out of range.
        assert!(sol_decode_message(&legacy(SYSTEM_PROGRAM, &data, &[0, 9]), &[], &me()).is_err());
        // Program index out of range / fee payer as program.
        let mut p = good.clone();
        let prog_pos = 3 + 1 + 96 + 32 + 1;
        p[prog_pos] = 7;
        assert!(sol_decode_message(&p, &[], &me()).is_err());
        p[prog_pos] = 0;
        assert!(sol_decode_message(&p, &[], &me()).is_err());
        // Bad header: zero signers, readonly fee payer, too many readonly.
        for header in [[0u8, 0, 1], [1, 1, 1], [1, 0, 3]] {
            let mut h = good.clone();
            h[..3].copy_from_slice(&header);
            assert!(sol_decode_message(&h, &[], &me()).is_err(), "{header:?}");
        }
        // Unsupported version, non-canonical length, duplicate key.
        assert!(sol_decode_message(&[0x81, 1, 0, 0], &[], &me()).is_err());
        let mut nc = good.clone();
        nc.splice(3..4, [0x83, 0x00]);
        assert!(sol_decode_message(&nc, &[], &me()).is_err());
        let mut dup = good.clone();
        dup.copy_within(4..36, 36);
        assert!(sol_decode_message(&dup, &[], &me()).is_err());
        // Garbage never panics.
        for seed in 0u8..=255 {
            let junk: Vec<u8> = (0..200u16)
                .map(|i| (i as u8).wrapping_mul(seed).wrapping_add(seed))
                .collect();
            let _ = sol_decode_message(&junk, &[], &me());
        }
        // Bad own address.
        assert!(sol_decode_message(&good, &[], "not-base58!").is_err());
    }

    fn v0_with_lookup(writable: &[u8], readonly: &[u8], ix_accounts: &[u8]) -> Vec<u8> {
        let mut m = vec![0x80, 1, 0, 1];
        m.extend(sv(2));
        m.extend_from_slice(&PAYER);
        m.extend_from_slice(&program_key(SYSTEM_PROGRAM));
        m.extend_from_slice(&[3u8; 32]);
        m.extend(sv(1));
        m.push(1);
        m.extend(sv(ix_accounts.len()));
        m.extend_from_slice(ix_accounts);
        let mut data = 2u32.to_le_bytes().to_vec();
        data.extend_from_slice(&42u64.to_le_bytes());
        m.extend(sv(data.len()));
        m.extend_from_slice(&data);
        m.extend(sv(1));
        m.extend_from_slice(&[5u8; 32]);
        m.extend(sv(writable.len()));
        m.extend_from_slice(writable);
        m.extend(sv(readonly.len()));
        m.extend_from_slice(readonly);
        m
    }

    #[test]
    fn v0_lookup_resolution_fails_closed() {
        let table = SolLookupTable {
            key: b58(&[5u8; 32]),
            addresses: vec![b58(&[10u8; 32]), b58(&[11u8; 32])],
        };
        let msg = v0_with_lookup(&[1], &[], &[0, 2]);
        assert_eq!(
            sol_message_lookup_tables(&msg).unwrap(),
            vec![table.key.clone()]
        );
        let s = sol_decode_message(&msg, core::slice::from_ref(&table), &me()).unwrap();
        assert_eq!(s.version, "v0");
        assert!(matches!(
            &s.instructions[0],
            SolInstruction::SystemTransfer { to, lamports, .. } if *to == b58(&[11u8; 32]) && lamports == "42"
        ));
        // Table not supplied, index out of range, empty lookup: errors.
        assert!(sol_decode_message(&msg, &[], &me()).is_err());
        assert!(sol_decode_message(
            &v0_with_lookup(&[2], &[], &[0, 2]),
            core::slice::from_ref(&table),
            &me()
        )
        .is_err());
        assert!(sol_decode_message(
            &v0_with_lookup(&[], &[], &[0, 1]),
            core::slice::from_ref(&table),
            &me()
        )
        .is_err());
        // Lookup duplicating a static key.
        let dup = SolLookupTable {
            key: table.key.clone(),
            addresses: vec![me()],
        };
        assert!(sol_decode_message(&v0_with_lookup(&[0], &[], &[0, 2]), &[dup], &me()).is_err());
    }

    fn create_account(owner: &[u8; 32], space: u64) -> Vec<u8> {
        let mut data = 0u32.to_le_bytes().to_vec();
        data.extend_from_slice(&2_039_280u64.to_le_bytes());
        data.extend_from_slice(&space.to_le_bytes());
        data.extend_from_slice(owner);
        legacy(SYSTEM_PROGRAM, &data, &[0, 1])
    }

    /// Audit finding: an account created for an arbitrary program used to need no second
    /// dialog, although that program then controls (and can spend) the lamports moved into it.
    #[test]
    fn create_account_for_unknown_owner_needs_extra_confirmation() {
        let foreign = [42u8; 32];
        let s = sol_decode_message(&create_account(&foreign, 0), &[], &me()).unwrap();
        assert!(s.requires_extra_confirmation);
        assert!(s.warnings.contains(&SolWarning::UnknownOwnerProgram {
            instruction: 0,
            owner: b58(&foreign),
            space: "0".into()
        }));
        // Token program, but neither a token account nor a mint size.
        let s = sol_decode_message(
            &create_account(&program_key(TOKEN_PROGRAM), 1000),
            &[],
            &me(),
        )
        .unwrap();
        assert!(s.requires_extra_confirmation);
        assert!(matches!(
            s.warnings[0],
            SolWarning::UnknownOwnerProgram { .. }
        ));
        // Closed list: System, Token account / mint, Token-2022 with extensions.
        for (owner, space) in [
            (SYSTEM_PROGRAM, 0),
            (TOKEN_PROGRAM, 165),
            (TOKEN_PROGRAM, 82),
            (TOKEN_2022_PROGRAM, 82),
            (TOKEN_2022_PROGRAM, 170),
        ] {
            let s = sol_decode_message(&create_account(&program_key(owner), space), &[], &me())
                .unwrap();
            assert!(s.warnings.is_empty(), "{owner} {space}: {:?}", s.warnings);
            assert!(!s.requires_extra_confirmation, "{owner} {space}");
        }
        // CreateAccountWithSeed (derived address) for an unknown owner: same rule.
        let base = PAYER;
        let derived = create_with_seed(&base, "s", &foreign).unwrap();
        let mut data = 3u32.to_le_bytes().to_vec();
        data.extend_from_slice(&base);
        data.extend_from_slice(&1u64.to_le_bytes());
        data.extend_from_slice(b"s");
        data.extend_from_slice(&5u64.to_le_bytes());
        data.extend_from_slice(&0u64.to_le_bytes());
        data.extend_from_slice(&foreign);
        let mut m = vec![1, 0, 1];
        m.extend(sv(3));
        m.extend_from_slice(&PAYER);
        m.extend_from_slice(&derived);
        m.extend_from_slice(&program_key(SYSTEM_PROGRAM));
        m.extend_from_slice(&[3u8; 32]);
        m.extend(sv(1));
        m.push(2);
        m.extend(sv(2));
        m.extend_from_slice(&[0, 1]);
        m.extend(sv(data.len()));
        m.extend_from_slice(&data);
        let s = sol_decode_message(&m, &[], &me()).unwrap();
        assert!(s.requires_extra_confirmation);
        assert!(matches!(
            s.warnings[0],
            SolWarning::UnknownOwnerProgram { instruction: 0, .. }
        ));
    }

    /// Audit finding: SPL `Transfer` (no mint, no decimals) used to be signed without the second
    /// dialog; only `TransferChecked` may skip it.
    #[test]
    fn unchecked_spl_transfer_needs_extra_confirmation() {
        let mut data = vec![3u8];
        data.extend_from_slice(&1_000u64.to_le_bytes());
        let s = sol_decode_message(&legacy(TOKEN_PROGRAM, &data, &[1, 1, 0]), &[], &me()).unwrap();
        assert!(matches!(
            s.instructions[0],
            SolInstruction::TokenTransfer { checked: false, .. }
        ));
        assert_eq!(
            s.warnings,
            vec![SolWarning::UncheckedTokenTransfer { instruction: 0 }]
        );
        assert!(s.requires_extra_confirmation);
        let mut data = vec![12u8];
        data.extend_from_slice(&1_000u64.to_le_bytes());
        data.push(6);
        let s =
            sol_decode_message(&legacy(TOKEN_PROGRAM, &data, &[1, 1, 1, 0]), &[], &me()).unwrap();
        assert!(s.warnings.is_empty());
        assert!(!s.requires_extra_confirmation);
    }

    /// Audit finding: memo text was shown with its control / bidi characters, and a memo never
    /// triggered the second dialog.
    #[test]
    fn memo_is_sanitized_and_unusual_memos_need_extra_confirmation() {
        let s = sol_decode_message(&legacy(MEMO_PROGRAM_V2, b"order 42", &[]), &[], &me()).unwrap();
        assert_eq!(
            s.instructions[0],
            SolInstruction::Memo {
                text: "order 42".into()
            }
        );
        assert!(!s.requires_extra_confirmation);
        let tricky = "pay\u{202E}evil\n\n\n\nsee below\u{200B}".as_bytes();
        let s = sol_decode_message(&legacy(MEMO_PROGRAM_V1, tricky, &[]), &[], &me()).unwrap();
        assert_eq!(
            s.instructions[0],
            SolInstruction::Memo {
                text: "payevil    see below".into()
            }
        );
        assert_eq!(s.warnings, vec![SolWarning::UnusualText { instruction: 0 }]);
        assert!(s.requires_extra_confirmation);
        let long = "a".repeat(MEMO_PLAIN_MAX_CHARS + 1);
        let s =
            sol_decode_message(&legacy(MEMO_PROGRAM_V2, long.as_bytes(), &[]), &[], &me()).unwrap();
        assert!(s.requires_extra_confirmation);
        let huge = "b".repeat(2_000);
        let s =
            sol_decode_message(&legacy(MEMO_PROGRAM_V2, huge.as_bytes(), &[]), &[], &me()).unwrap();
        let SolInstruction::Memo { text } = &s.instructions[0] else {
            panic!("memo expected");
        };
        assert_eq!(text.chars().count(), MAX_MEMO_DISPLAY);
        assert!(text.ends_with('…'));
    }

    #[test]
    fn transfer_with_seed_seed_is_sanitized() {
        let mut data = 11u32.to_le_bytes().to_vec();
        data.extend_from_slice(&7u64.to_le_bytes());
        data.extend_from_slice(&3u64.to_le_bytes());
        data.extend_from_slice(b"a\nb");
        data.extend_from_slice(&program_key(SYSTEM_PROGRAM));
        let s = sol_decode_message(&legacy(SYSTEM_PROGRAM, &data, &[1, 0, 1]), &[], &me()).unwrap();
        assert!(matches!(
            &s.instructions[0],
            SolInstruction::SystemTransferWithSeed { seed, .. } if seed == "a b"
        ));
        assert!(s
            .warnings
            .contains(&SolWarning::UnusualText { instruction: 0 }));
        assert!(s.requires_extra_confirmation);
    }

    #[test]
    fn lookup_table_parser_rejects_bad_accounts() {
        let mut data = vec![0u8; 56];
        data[..4].copy_from_slice(&1u32.to_le_bytes());
        data[4..12].copy_from_slice(&u64::MAX.to_le_bytes());
        data.extend_from_slice(&[1u8; 32]);
        assert_eq!(
            sol_parse_lookup_table(&data).unwrap(),
            vec![b58(&[1u8; 32])]
        );
        let mut deactivated = data.clone();
        deactivated[4..12].copy_from_slice(&123u64.to_le_bytes());
        assert!(sol_parse_lookup_table(&deactivated).is_err());
        let mut uninit = data.clone();
        uninit[0] = 0;
        assert!(sol_parse_lookup_table(&uninit).is_err());
        assert!(sol_parse_lookup_table(&data[..60]).is_err());
        assert!(sol_parse_lookup_table(&data[..40]).is_err());
    }
}
