// SPDX-License-Identifier: GPL-3.0-or-later
// Send: recipient with clipboard guard + 4-char blocks, amount + MAX,
// fees slow/normal/fast/custom, recap decoded by the Rust core, password.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { call, kaspaAddressProblem, toIpcError, type AccountChain, type EvmTxSummary, type SolTxSummary } from '@kyro/shared';
import {
  assetsFor,
  checkSolSummary,
  feeCost,
  findChain,
  isXAddress,
  parseStellarMemo,
  stellarAddressProblem,
  parseDestinationTag,
  cardanoAddressProblem,
  cardanoTokenLabel,
  classifyHistoryAddresses,
  findLookalike,
  isDustAmount,
  isSuspectAddress,
  type KnownAddress,
  DOGE_SOFT_DUST,
  bchDashDust,
  evmHwDisplay,
  litecoinDust,
  signAndBroadcast,
  signAndBroadcastHw,
  tronCoverage,
  tryParseUnits,
  unitsToNumber,
  validateBtcFeeRate,
  validateEvmCustomFee,
  validateSolPriorityFee,
  weiToGwei,
  type AnyAdapter,
  type AnyUnsigned,
  type AssetDef,
  type EvmAdapter,
  type FeeChoice,
  type FeeEstimates,
  type FeeLevel,
  type FeeParams,
  type SolanaAdapter,
  type XrpAdapter,
  type CardanoAdapter,
  type StellarAdapter,
  type NearAdapter,
  nearAccountIdProblem,
  type SuiAdapter,
  suiAddressProblem,
  type HbarAdapter,
  hbarMemoError,
  normalizeHbarRecipient,
  type KaspaAdapter,
  KASPA_MIN_SEND,
  type PolkadotAdapter,
  dotAddressProblem,
  type AlgorandAdapter,
  type XmrAdapter,
} from '@kyro/chains';
import { useApp, useVault } from '../state/app';
import { usePortfolio } from '../state/portfolio';
import { cn } from '../lib/cn';
import { decimalSep, fmtCrypto, fmtEta, fmtFiat, sanitizeDecimalInput, shortAddress, toInputDecimal } from '../lib/format';
import { getLanguage, t, tp, useT } from '../i18n';
import { rt } from '../i18n/rich';
import { guardAllowsSend, guardOnInput, guardVerify, handedOverGuard, initialGuard, pickedGuard, type GuardState } from '../lib/clipboardGuard';
import { addLocalTx, bumpContactSends, findContact, getContacts, getLastPrice, getLocalTxs, saveContacts, setLastPrice, type ContactFamily } from '../lib/storage';
import { checkPricePlausible } from '@kyro/market';
import { useAsync, useDebounced } from '../lib/useAsync';
import { AddressBlocks, CoinIcon, CopyButton, EnClair, PasswordField } from '../components/kit';
import { useTorBlocked } from '../components/Tor';
import { ServerDownLine, ServerMissingLine, serverDown, serverMissing } from '../components/ServerDown';
import { DeviceBadge, HwErrorNotice, HwWaiting } from '../components/hw';
import { BRAND, pickDevice, withDevice } from '../state/hw';
import { useOnTorReady } from '../state/tor';
import { SolSummaryView } from '../components/SolSummaryView';
import { TronEstimateView } from '../components/TronEstimateView';
import { XRP_ACTIVATION, XrpSpendable, XrpSummaryView, XrpTagField, XrpTxStatusLine } from '../components/XrpSend';
import { StellarMemoField, StellarSpendable, StellarSummaryView, StellarTxStatusLine, XLM_ACTIVATION, type StellarMemoKind } from '../components/StellarSend';
import { NearReceiverLine, NearSpendable, NearSummaryView, NearTxStatusLine, nearReceiverBlocked } from '../components/NearSend';
import { SuiSpendable, SuiSummaryView, SuiTxStatusLine } from '../components/SuiSend';
import { HbarAccountState, HbarMemoField, HbarSummaryView, HbarTxStatusLine, hbarRecipientProblem } from '../components/HbarSend';
import { DotDestinationNote, DotSpendable, DotSummaryView, DotTxStatusLine } from '../components/PolkadotSend';
import { ALGO_ACTIVATION, AlgoNoteField, AlgoSpendable, AlgoSummaryView, AlgoTxStatusLine } from '../components/AlgoSend';
import { CardanoSendFields, CardanoSummaryView, CardanoTxStatusLine, tokenKey } from '../components/Cardano';
import { KaspaSpendable, KaspaSummaryView, KaspaTxStatusLine } from '../components/KaspaSend';
import { DustOnlyNote, PoisoningWarning } from '../components/Poisoning';
import { XmrDestinationLine, XmrLockedNote, XmrSendNotes, XmrSummaryView, XmrSyncLine, useXmrStatus } from '../components/Monero';
import { SecondConfirmNotice, btcWarningText, evmWarningText } from '../components/SecondConfirm';
import { useHistory } from '../state/history';
import { AccountPicker, useCreateAccounts } from '../components/AccountPicker';
import { ACCOUNT_CHAIN_LABEL, accountAddress, defaultAccountName, otherOwnAccounts, ownAccountLabel, ownAccountOf, planNewAccounts } from '../lib/accounts';
import { Menu } from '../components/ui/menu';
import { Button, IconButton, Notice, Spinner } from '../components/ui/primitives';
import { IconBack, IconCheck, IconChevronDown, IconLock, IconShield, IconUpDown, IconWarn } from '../components/icons';

type Built = { unsigned: AnyUnsigned; summary: EvmTxSummary | null; sol: SolTxSummary | null; key: string };

function adapterFor(asset: AssetDef, adapters: ReturnType<typeof useVault>['adapters']): AnyAdapter | undefined {
  if (asset.family === 'btc') return adapters.btc ?? undefined;
  if (asset.family === 'sol') return adapters.sol ?? undefined;
  if (asset.family === 'ltc') return adapters.ltc ?? undefined;
  if (asset.family === 'doge') return adapters.doge ?? undefined;
  if (asset.family === 'bch') return adapters.bch ?? undefined;
  if (asset.family === 'dash') return adapters.dash ?? undefined;
  if (asset.family === 'tron') return adapters.tron ?? undefined;
  if (asset.family === 'xrp') return adapters.xrp ?? undefined;
  if (asset.family === 'ada') return adapters.cardano ?? undefined;
  if (asset.family === 'xlm') return adapters.stellar ?? undefined;
  if (asset.family === 'near') return adapters.near ?? undefined;
  if (asset.family === 'sui') return adapters.sui ?? undefined;
  if (asset.family === 'hbar') return adapters.hbar ?? undefined;
  if (asset.family === 'kas') return adapters.kaspa ?? undefined;
  if (asset.family === 'dot') return adapters.polkadot ?? undefined;
  if (asset.family === 'algo') return adapters.algo ?? undefined;
  if (asset.family === 'xmr') return adapters.xmr ?? undefined;
  return adapters.evm.get(asset.chainKey);
}

const LEVELS: Array<{ level: FeeLevel; label: 'send.feeSlow' | 'send.feeNormal' | 'send.feeFast' }> = [
  { level: 'slow', label: 'send.feeSlow' },
  { level: 'normal', label: 'send.feeNormal' },
  { level: 'fast', label: 'send.feeFast' },
];

export function Send({ assetId, to: initialTo }: { assetId?: string; to?: string }) {
  const { t } = useT();
  const { back, settings, navigate, hideBalances, accountSources, accountName, selectedAccounts, vaultLists } = useApp();
  const { adapters, accounts, activeHw } = useVault();
  const pf = usePortfolio();
  const network = accounts.network;
  const cur = settings.currency;

  // Only the chains of the active account (a hardware wallet may hold only some of them).
  const sendable = useMemo(() => assetsFor(network).filter((a) => !a.readOnly && !!adapterFor(a, adapters) && (a.kind === 'native' || (pf.balances.get(a.id) ?? 0n) > 0n)), [network, pf.balances, adapters]);
  const defaultAsset = sendable.find((a) => a.id === assetId) ?? pf.holdings.find((h) => h.amount > 0n && !h.asset.readOnly)?.asset ?? sendable[0];
  const [selectedId, setSelectedId] = useState(defaultAsset?.id ?? '');
  const asset = sendable.find((a) => a.id === selectedId) ?? defaultAsset;
  const adapter = asset ? adapterFor(asset, adapters) : undefined;
  const chain = asset ? findChain(network, asset.chainKey) : undefined;
  const nativeAsset = chain ? assetsFor(network).find((a) => a.chainKey === chain.key && a.kind === 'native') : undefined;
  const balance = asset ? pf.balances.get(asset.id) ?? 0n : 0n;
  const price = asset ? pf.price(asset.coingeckoId)?.price ?? null : null;
  // Fiat entry turns a price from the network into a crypto amount: only with a plausible price
  // (close to the last one seen here and to the 7-day median), never an unbounded one.
  const priceCheck = useMemo(
    () => (asset ? checkPricePlausible(price, { sparkline7d: pf.marketById.get(asset.coingeckoId)?.sparkline7d ?? [], lastKnown: getLastPrice(asset.coingeckoId, cur) }) : { ok: false, deviation: null }),
    [asset, price, pf.marketById, cur],
  );
  useEffect(() => {
    if (asset && priceCheck.ok && price !== null) setLastPrice(asset.coingeckoId, cur, price);
  }, [asset, priceCheck.ok, price, cur]);
  const fiatPrice = priceCheck.ok ? price : null;
  const nativePrice = nativeAsset ? pf.price(nativeAsset.coingeckoId)?.price ?? null : null;

  // Recipient + clipboard guard.
  const [to, setTo] = useState(initialTo ?? '');
  // An address handed over by the search palette: its origin is unknown (typed or pasted there), never « pasted here ».
  const [guard, setGuard] = useState<GuardState>(initialTo ? handedOverGuard : initialGuard);
  const toRef = useRef<HTMLInputElement>(null);
  const toTrim = to.trim();
  const addrValid = !!adapter && toTrim.length > 0 && adapter.isValidAddress(toTrim);
  const contact = asset && addrValid ? findContact(toTrim, asset.family as ContactFamily) : undefined;
  // Every account of the wallet counts as « own » (§2.9: a send between two of your accounts).
  const ownAddresses = [accounts.btc?.segwit.address, accounts.btc?.taproot.address, accounts.evm?.address.toLowerCase(), accounts.sol?.address, accounts.tron?.address, accounts.xrp?.address, accounts.cardano?.address, accounts.xmr?.address, accounts.algo?.address, accounts.polkadot?.address, accounts.kas?.address, accounts.stellar?.address, accounts.near?.address, accounts.sui?.address.toLowerCase(), accounts.hbar?.address.toLowerCase(), ...accountSources.flatMap((x) => x.addresses.map((a) => (x.family === 'evm' || x.family === 'sui' || x.family === 'hbar' ? a.toLowerCase() : a)))].filter((a): a is string => !!a);
  const isOwn = ownAddresses.includes(asset?.family === 'evm' || asset?.family === 'sui' || asset?.family === 'hbar' ? toTrim.toLowerCase() : toTrim);
  // « Mes comptes »: the user's OTHER accounts of this chain. A transfer between two of them is an
  // ordinary send (same Rust decoding, native dialog, poisoning check: own addresses are known).
  const family = asset?.family as AccountChain | undefined;
  const ownAccount = family && addrValid ? ownAccountOf(accountSources, family, toTrim) : undefined;
  const myOtherAccounts = family && !activeHw ? otherOwnAccounts(accountSources, family, selectedAccounts[family]) : [];
  const nextOwn = family && !activeHw && vaultLists ? (planNewAccounts(vaultLists[family], 1)[0] ?? null) : null;
  const createAccounts = useCreateAccounts();
  const [ownBusy, setOwnBusy] = useState(false);
  const [ownError, setOwnError] = useState<string | null>(null);
  const pickRecipient = (addr: string) => {
    setTo(addr);
    setGuard(pickedGuard(addr));
  };
  /** Creates the next account of this chain (without switching the sending one) and fills its address. */
  const createOwnRecipient = async () => {
    if (!family) return;
    setOwnBusy(true);
    setOwnError(null);
    try {
      const [index] = await createAccounts(family, 1);
      if (index === undefined) return;
      pickRecipient(accountAddress(await call('accounts_get', { account: index }), family).address);
    } catch (e) {
      setOwnError(toIpcError(e).message);
    } finally {
      setOwnBusy(false);
    }
  };
  const noChecksum = asset?.family === 'evm' && addrValid && toTrim.slice(2) === toTrim.slice(2).toLowerCase();

  // Address poisoning: compare the recipient with every reference address of this chain family
  // (address book, own addresses, recipients of sends signed by this device, other non-suspect
  // counterparties). The server's history is never « trusted »: zero-value, dust and unsigned
  // transfers are suspects, never references (see packages/chains/src/poisoning.ts).
  const history = useHistory();
  const poisoning = useMemo(() => {
    if (!asset || !addrValid) return { lookalike: null, suspect: false };
    const family = asset.family;
    const own: Record<string, Array<string | undefined>> = {
      btc: [accounts.btc?.segwit.address, accounts.btc?.taproot.address],
      evm: [accounts.evm?.address],
      sol: [accounts.sol?.address],
      ltc: [accounts.ltc?.address],
      doge: [accounts.doge?.address],
      bch: [accounts.bch?.address],
      dash: [accounts.dash?.address],
      tron: [accounts.tron?.address],
      xrp: [accounts.xrp?.address],
      ada: [accounts.cardano?.address],
      xlm: [accounts.stellar?.address],
      near: [accounts.near?.address],
      sui: [accounts.sui?.address],
      hbar: [accounts.hbar?.address],
      kas: [accounts.kas?.address],
      dot: [accounts.polkadot?.address],
      algo: [accounts.algo?.address],
      xmr: [accounts.xmr?.address],
    };
    // The other accounts of the vault are trusted too.
    for (const x of accountSources) own[x.family] = [...(own[x.family] ?? []), ...x.addresses];
    // Recipients of transfers this device signed and broadcast (Kyro's own record, by txid).
    const signedHere = getLocalTxs(network)
      .filter((t) => t.kind === 'transfer' && t.status !== 'failed' && !!t.counterparty && findChain(network, t.chainKey)?.family === family)
      .map((t) => t.counterparty as string);
    const events = (history.data?.entries ?? [])
      .filter((e) => e.asset?.family === family && e.counterparty && e.kind === 'transfer')
      .map((e) => {
        const p = e.asset ? pf.price(e.asset.coingeckoId)?.price ?? null : null;
        const fiat = p !== null && e.asset ? unitsToNumber(e.amount, e.asset.decimals) * p : null;
        return { counterparty: e.counterparty!, suspect: !!e.suspect || isDustAmount(family, e.amount, fiat) };
      });
    const { trusted, references, suspects } = classifyHistoryAddresses(events, signedHere, family);
    const known: KnownAddress[] = [
      ...getContacts()
        .filter((c) => c.family === family)
        .map((c) => ({ address: c.address, source: 'contact' as const, label: c.name })),
      ...(own[family] ?? []).filter((a): a is string => !!a).map((address) => ({ address, source: 'own' as const, label: t('send.yourAddress') })),
      ...trusted.map((address) => ({ address, source: 'sent' as const })),
      ...references.map((address) => ({ address, source: 'history' as const })),
    ];
    return { lookalike: findLookalike(toTrim, known, family), suspect: isSuspectAddress(toTrim, suspects, family) };
  }, [asset, addrValid, toTrim, accounts, accountSources, history.data, pf, network]);
  const [poisonAck, setPoisonAck] = useState(false);
  useEffect(() => setPoisonAck(false), [toTrim, asset?.id]);
  const poisonBlocked = !!poisoning.lookalike && !poisonAck;

  // Amount.
  const [amountStr, setAmountStr] = useState('');
  const [fiatMode, setFiatMode] = useState(false);
  const [max, setMax] = useState(false);
  const decimals = asset?.decimals ?? 18;
  /** Litecoin / Dogecoin / Bitcoin Cash / Dash: Bitcoin-style UTXO chains (same fee field, PSBT, change). */
  const utxoLike = asset?.family === 'btc' || asset?.family === 'ltc' || asset?.family === 'doge' || asset?.family === 'bch' || asset?.family === 'dash';
  const rateUnit = asset?.family === 'ltc' ? 'litoshi/vB' : asset?.family === 'doge' ? 'koinus/octet' : asset?.family === 'bch' ? 'sat/octet' : asset?.family === 'dash' ? 'duff/octet' : 'sat/vB';
  /** TRON: no fee to choose; Rust's resource estimate is shown with the summary. */
  const isTron = asset?.family === 'tron';
  /** XRP Ledger: no fee to choose; destination tag, reserve and activation rules (§2.6). */
  const isXrp = asset?.family === 'xrp';
  const xrpAdapter = isXrp ? (adapter as XrpAdapter | undefined) : undefined;
  const [tagStr, setTagStr] = useState('');
  const tagParsed = useMemo((): { tag?: number; error: string | null } => {
    try {
      const t = parseDestinationTag(tagStr);
      return t === undefined ? { error: null } : { tag: t, error: null };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [tagStr]);
  /** A pasted X-address (tag embedded): Rust refuses it, Kyro asks for the classic address + tag. */
  const xAddress = isXrp && isXAddress(toTrim);
  // Destination as Rust reads it (exists? lsfRequireDestTag?), and our own reserve / spendable.
  const xrpDest = useAsync(xrpAdapter && addrValid ? () => xrpAdapter.destinationInfo(toTrim) : null, [xrpAdapter, addrValid, toTrim]);
  const xrpDestInfo = xrpDest.data?.address === toTrim ? xrpDest.data : undefined;
  const xrpMe = useAsync(xrpAdapter ? () => xrpAdapter.account() : null, [xrpAdapter], { intervalMs: 30_000 });
  /** Stellar: no fee to choose; memo (required by some destinations), reserve, CreateAccount (§2.11). */
  const isXlm = asset?.family === 'xlm';
  const xlmAdapter = isXlm ? (adapter as StellarAdapter | undefined) : undefined;
  const [xlmMemoKind, setXlmMemoKind] = useState<StellarMemoKind>('id');
  const [xlmMemo, setXlmMemo] = useState('');
  const xlmMemoParsed = useMemo((): { memo?: ReturnType<typeof parseStellarMemo>; error: string | null } => {
    try {
      return { memo: parseStellarMemo(xlmMemoKind, xlmMemo), error: null };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [xlmMemoKind, xlmMemo]);
  /** M… (muxed) addresses and S… secret keys: refused with their own message (Rust's rule). */
  const xlmProblem = isXlm && toTrim ? stellarAddressProblem(toTrim) : null;
  const xlmDest = useAsync(xlmAdapter && addrValid ? () => xlmAdapter.destinationInfo(toTrim) : null, [xlmAdapter, addrValid, toTrim]);
  const xlmDestInfo = xlmDest.data?.address === toTrim ? xlmDest.data : undefined;
  const xlmMe = useAsync(xlmAdapter ? () => xlmAdapter.account() : null, [xlmAdapter], { intervalMs: 30_000 });
  /** NEAR: receiver kind / existence and spendable (balance − storage reserve), §2.11. */
  const isNear = asset?.family === 'near';
  const nearAdapter = isNear ? (adapter as NearAdapter | undefined) : undefined;
  const nearRecv = useAsync(nearAdapter && addrValid ? () => nearAdapter.receiverInfo(toTrim) : null, [nearAdapter, addrValid, toTrim]);
  const nearRecvInfo = nearRecv.data?.accountId === toTrim ? nearRecv.data : undefined;
  const nearMe = useAsync(nearAdapter ? () => nearAdapter.account() : null, [nearAdapter], { intervalMs: 30_000 });
  /** NEAR: a named or 0x… receiver that does not exist, or not read yet: nothing is built. */
  const nearBlocked = isNear && (!nearRecvInfo || nearReceiverBlocked(toTrim, nearRecvInfo));
  const nearProblem = isNear && toTrim ? nearAccountIdProblem(toTrim) : null;
  /** Sui: no fee to choose; full 0x + 64 hex address; spendable = SUI in coin objects (§2.11). */
  const isSui = asset?.family === 'sui';
  const suiAdapter = isSui ? (adapter as SuiAdapter | undefined) : undefined;
  const suiMe = useAsync(suiAdapter ? () => suiAdapter.balanceInfo() : null, [suiAdapter], { intervalMs: 30_000 });
  const suiProblem = isSui && toTrim ? suiAddressProblem(toTrim) : null;
  /** Polkadot: existential deposit and keep-alive rules (§2.11), no fee to choose. */
  const isDot = asset?.family === 'dot';
  const dotAdapter = isDot ? (adapter as PolkadotAdapter | undefined) : undefined;
  const dotDest = useAsync(dotAdapter && addrValid ? () => dotAdapter.destinationInfo(toTrim) : null, [dotAdapter, addrValid, toTrim]);
  const dotDestInfo = dotDest.data?.address === toTrim ? dotDest.data : undefined;
  const dotMe = useAsync(dotAdapter ? () => dotAdapter.account() : null, [dotAdapter], { intervalMs: 30_000 });
  const dotProblem = isDot && toTrim && !addrValid ? dotAddressProblem(toTrim, network) : null;
  /** Cardano: ADA or a native token from the balance, optional CIP-20 memo (§2.7). */
  const isAda = asset?.family === 'ada';
  const adaAdapter = isAda ? (adapter as CardanoAdapter | undefined) : undefined;
  const adaMe = useAsync(adaAdapter ? () => adaAdapter.account() : null, [adaAdapter], { intervalMs: 30_000 });
  const [tokenSel, setTokenSel] = useState('');
  const [tokenQty, setTokenQty] = useState('');
  const [memo, setMemo] = useState('');
  const adaToken = isAda ? adaMe.data?.tokens.find((t) => tokenKey(t) === tokenSel) : undefined;
  const adaTokenMode = !!adaToken;
  const adaTokenQty = adaToken && /^\d+$/.test(tokenQty) ? BigInt(tokenQty) : null;
  const adaTokenOver = !!adaToken && adaTokenQty !== null && adaTokenQty > BigInt(adaToken.quantity);
  const adaMemoTooLong = isAda && new TextEncoder().encode(memo).length > 1024;
  /** Refused Cardano address types, in Rust's words (Byron, script, pointer, stake, other network). */
  const adaProblem = isAda && toTrim ? cardanoAddressProblem(toTrim, network) : null;
  const adaBlocked = isAda && (adaMemoTooLong || (adaTokenMode && (adaTokenQty === null || adaTokenQty <= 0n || adaTokenOver)));
  /** Hedera: memo always visible, recipient facts and our account from the mirror node (§2.11). */
  const isHbar = asset?.family === 'hbar';
  const hbarAdapter = isHbar ? (adapter as HbarAdapter | undefined) : undefined;
  const hbarDest = useAsync(hbarAdapter && addrValid ? () => hbarAdapter.recipientInfo(toTrim) : null, [hbarAdapter, addrValid, toTrim]);
  const hbarDestInfo = hbarDest.data && addrValid && normalizeHbarRecipient(hbarDest.data.to) === normalizeHbarRecipient(toTrim) ? hbarDest.data : undefined;
  const hbarMe = useAsync(hbarAdapter ? () => hbarAdapter.account() : null, [hbarAdapter], { intervalMs: 30_000 });
  const hbarProblem = isHbar ? hbarRecipientProblem(hbarDestInfo) : null;
  const hbarBlocked = isHbar && (!hbarDestInfo || !!hbarMemoError(memo.trim()) || !!hbarProblem || hbarMe.data?.exists === false);
  /** Kaspa: no fee to choose; Rust builds from the account's coins (§2.11). */
  const isKas = asset?.family === 'kas';
  const kasAdapter = isKas ? (adapter as KaspaAdapter | undefined) : undefined;
  const kasMe = useAsync(kasAdapter ? () => kasAdapter.account() : null, [kasAdapter], { intervalMs: 30_000 });
  const kasProblem = isKas && toTrim ? kaspaAddressProblem(toTrim, network) : null;
  /** Algorand: optional note (the `memo` field), minimum balance rules (§2.11). */
  const isAlgo = asset?.family === 'algo';
  const algoAdapter = isAlgo ? (adapter as AlgorandAdapter | undefined) : undefined;
  const algoDest = useAsync(algoAdapter && addrValid ? () => algoAdapter.destinationInfo(toTrim) : null, [algoAdapter, addrValid, toTrim]);
  const algoDestInfo = algoDest.data?.address === toTrim ? algoDest.data : undefined;
  const algoMe = useAsync(algoAdapter ? () => algoAdapter.account() : null, [algoAdapter], { intervalMs: 30_000 });
  const algoNoteTooLong = isAlgo && new TextEncoder().encode(memo.trim()).length > 1024;
  /**
   * Monero (§2.11): Rust decodes the destination (standard / subaddress / integrated), the scan
   * must be complete, and the transfer is prepared on demand only (decoys and the output
   * distribution are downloaded for it: never on every keystroke).
   */
  const isXmr = asset?.family === 'xmr';
  const xmrAdapter = isXmr ? (adapter as XmrAdapter | undefined) : undefined;
  const xmr = useXmrStatus(xmrAdapter);
  const xmrDest = useAsync(xmrAdapter && addrValid ? () => xmrAdapter.backend.validate(toTrim) : null, [xmrAdapter, addrValid, toTrim]);
  const xmrDestInfo = xmrDest.data?.address === toTrim ? xmrDest.data : undefined;
  const xmrSynced = !!xmr.status && !xmr.status.running && xmr.status.restoreHeight !== null && xmr.status.progress >= 1;
  const [xmrGo, setXmrGo] = useState(0);
  const xmrBlocked = isXmr && (!xmrDestInfo || !xmrSynced || xmrGo === 0);
  const amountBase = useMemo(() => {
    if (!amountStr) return null;
    if (fiatMode) {
      const f = Number(amountStr.replace(',', '.'));
      if (!fiatPrice || !Number.isFinite(f) || f <= 0) return null;
      return tryParseUnits((f / fiatPrice).toFixed(Math.min(decimals, 12)), decimals);
    }
    return tryParseUnits(amountStr, decimals);
  }, [amountStr, fiatMode, fiatPrice, decimals]);
  /** Share of the balance this amount represents (fiat entry: the market price decided it). */
  const balanceShare = amountBase !== null && balance > 0n ? Number((amountBase * 10_000n) / balance) / 100 : null;
  // XRP: a new account needs at least the base reserve (1 XRP), else tecNO_DST_INSUF_XRP.
  const xrpBelowActivation = isXrp && !!xrpDestInfo && !xrpDestInfo.exists && !max && amountBase !== null && amountBase > 0n && amountBase < XRP_ACTIVATION;
  const xrpTagMissing = isXrp && !!xrpDestInfo?.requireDestTag && tagParsed.tag === undefined;
  // Stellar: creating an account needs at least 2 × base reserve (1 XLM).
  const xlmBelowActivation = isXlm && !!xlmDestInfo && !xlmDestInfo.exists && !max && amountBase !== null && amountBase > 0n && amountBase < XLM_ACTIVATION;
  const xlmMemoMissing = isXlm && !!xlmDestInfo?.memoRequired && !xlmMemoParsed.memo;
  const xlmBlocked = isXlm && (!xlmDestInfo || !!xlmMemoParsed.error || xlmMemoMissing || xlmBelowActivation);
  /** XRP: everything that must be right before Rust is even asked to build. */
  const xrpBlocked = isXrp && (!xrpDestInfo || !!tagParsed.error || xrpTagMissing || xrpBelowActivation);
  // Polkadot: a new account needs at least the existential deposit, else the transfer fails.
  const dotBelowEd = isDot && !!dotDestInfo && !dotDestInfo.exists && !max && amountBase !== null && amountBase > 0n && amountBase < BigInt(dotDestInfo.existentialDeposit);
  const dotBlocked = isDot && (!dotDestInfo || dotBelowEd);
  // Algorand: a receiver must end at or above its minimum balance (0.1 ALGO for a new account).
  const algoDestMin = algoDestInfo ? BigInt(algoDestInfo.minBalance) - BigInt(algoDestInfo.balance) : ALGO_ACTIVATION;
  const algoBelowMinimum = isAlgo && !!algoDestInfo && !max && amountBase !== null && amountBase > 0n && amountBase < algoDestMin;
  const algoBlocked = isAlgo && (!algoDestInfo || algoNoteTooLong || algoBelowMinimum || !!algoMe.data?.authAddr);
  // Dogecoin dust (Dogecoin Core policy): no output under 0.01 DOGE.
  const dogeBelowDust = asset?.family === 'doge' && amountBase !== null && amountBase > 0n && amountBase < DOGE_SOFT_DUST && !max;
  // Kaspa: KIP-9 storage mass makes outputs under 0.2 KAS non-standard (Rust refuses them).
  const kasBelowMin = isKas && amountBase !== null && amountBase > 0n && amountBase < KASPA_MIN_SEND && !max;

  // Fees.
  const fees = useAsync<FeeEstimates>(adapter ? () => adapter.estimateFees() : null, [adapter], { intervalMs: 30_000 });
  const feesTorBlocked = useTorBlocked(fees.error);
  // Compact filters: rates are an average of recent blocks, not a mempool estimate.
  const blockAverage = fees.data?.source === 'block-average';
  useOnTorReady(fees.reload);
  const [choice, setChoice] = useState<FeeChoice>('normal');
  const [customEvm, setCustomEvm] = useState({ maxFeeGwei: '', priorityGwei: '' });
  const [customBtc, setCustomBtc] = useState('');
  const [customSol, setCustomSol] = useState('');
  useEffect(() => {
    const n = fees.data?.options.normal.params;
    if (!n) return;
    if (n.family === 'evm' && !customEvm.maxFeeGwei) setCustomEvm({ maxFeeGwei: trimNum(weiToGwei(n.maxFeePerGas)), priorityGwei: trimNum(weiToGwei(n.maxPriorityFeePerGas)) });
    if (n.family === 'btc' && !customBtc) setCustomBtc(String(n.satPerVb));
    if (n.family === 'sol' && !customSol) setCustomSol(n.microLamports.toString());
  }, [fees.data]);

  const custom = useMemo(() => {
    if (choice !== 'custom' || !asset) return null;
    if (asset.family === 'evm') return validateEvmCustomFee(customEvm, fees.data);
    if (asset.family === 'btc') return validateBtcFeeRate(customBtc, fees.data);
    if (asset.family === 'ltc') return validateBtcFeeRate(customBtc, fees.data, { unit: 'litoshi/vB' });
    if (asset.family === 'doge') return validateBtcFeeRate(customBtc, fees.data, { unit: 'koinus/octet', floor: 1_000, ceiling: 100_000, high: 10_000 });
    // Bitcoin Cash / Dash: relay minimum 1 per byte, Rust's ceiling 100 (high-fee threshold).
    if (asset.family === 'bch' || asset.family === 'dash') return validateBtcFeeRate(customBtc, fees.data, { unit: rateUnit, floor: 1, ceiling: 100, high: 10 });
    return validateSolPriorityFee(customSol);
  }, [choice, asset, customEvm, customBtc, customSol, fees.data, rateUnit]);
  const feeParams: FeeParams | null = choice === 'custom' ? custom?.params ?? null : fees.data?.options[choice].params ?? null;

  // Build (debounced) → unsigned tx + Rust decoding for EVM.
  const buildKey = useDebounced(JSON.stringify([asset?.id, toTrim, isXmr && max ? 'max' : amountBase?.toString(), max, feeParams, addrValid, isXrp ? tagStr : null, xrpBlocked, dotBlocked, isXlm ? [xlmMemoKind, xlmMemo, xlmBlocked] : null, nearBlocked, isAda ? [tokenSel, tokenQty, memo.trim(), adaBlocked] : null, isHbar ? [memo.trim(), hbarBlocked] : null, isAlgo ? [memo.trim(), algoBlocked] : null, isXmr ? [xmrGo, xmrBlocked] : null], (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)), 450);
  const [built, setBuilt] = useState<Built | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  // XRP: what can be sent is the spendable part (balance − reserve), not the balance.
  const xrpSpendable = isXrp && xrpMe.data ? BigInt(xrpMe.data.spendable) : null;
  const kasSpendable = isKas && kasMe.data ? BigInt(kasMe.data.spendable) : isXlm && xlmMe.data ? BigInt(xlmMe.data.spendable) : null;
  // NEAR: likewise, balance − storage reserve.
  const nearSpendable = isNear && nearMe.data ? BigInt(nearMe.data.spendable) : null;
  // Sui: the address balance is not spent by Kyro, only SUI coin objects.
  const suiSpendable = isSui && suiMe.data ? BigInt(suiMe.data.coin) : null;
  // Polkadot: the existential deposit and the frozen part cannot be sent.
  const dotSpendable = isDot && dotMe.data ? BigInt(dotMe.data.spendable) : null;
  // Algorand: likewise, balance − minimum balance.
  const algoSpendable = isAlgo && algoMe.data ? BigInt(algoMe.data.spendable) : null;
  // Monero: only unlocked outputs (10 confirmations) can be spent.
  const xmrSpendable = isXmr && xmr.status ? BigInt(xmr.status.unlocked) : null;
  const overBalance = !max && amountBase !== null && amountBase > (xrpSpendable ?? nearSpendable ?? suiSpendable ?? kasSpendable ?? dotSpendable ?? algoSpendable ?? xmrSpendable ?? balance);
  // Monero: a new preparation is needed whenever the request changes.
  // (MAX writes the prepared amount back into the field: that is not a new request.)
  useEffect(() => setXmrGo(0), [toTrim, max ? 'max' : amountBase?.toString(), max, asset?.id]);

  const doBuild = async (): Promise<Built> => {
    if (!asset || !adapter || !feeParams) throw new Error(t('send.incompleteParams'));
    const tag = isXrp && tagParsed.tag !== undefined ? { destinationTag: tagParsed.tag } : {};
    const xlm = isXlm && xlmMemoParsed.memo ? { stellarMemo: xlmMemoParsed.memo } : {};
    const hbarMemo = isHbar && memo.trim() ? { memo: memo.trim() } : {};
    const algoNote = isAlgo && memo.trim() ? { memo: memo.trim() } : {};
    const ada = isAda ? { ...(adaToken && adaTokenQty !== null ? { cardanoToken: { policy: adaToken.policy, name: adaToken.name, quantity: adaTokenQty.toString() } } : {}), ...(memo.trim() ? { memo: memo.trim() } : {}) } : {};
    const unsigned = (await (adapter as { buildTx: (p: unknown) => Promise<AnyUnsigned> }).buildTx({ asset, to: toTrim, amount: amountBase ?? 0n, fee: feeParams, max: max && !adaTokenMode, ...tag, ...xlm, ...ada, ...hbarMemo, ...algoNote })) as AnyUnsigned;
    let summary: EvmTxSummary | null = null;
    if (unsigned.family === 'evm') {
      summary = await (adapter as EvmAdapter).decode(unsigned);
      const expectedTo = unsigned.recipient.toLowerCase();
      if (summary.to.toLowerCase() !== expectedTo || summary.amount !== unsigned.amount.toString()) {
        throw new Error(t('send.decodedMismatch'));
      }
    }
    let sol: SolTxSummary | null = null;
    if (unsigned.family === 'sol') {
      // Solana: the recap comes from the Rust decoder only (sol_decode_tx).
      sol = await (adapter as SolanaAdapter).decode(unsigned);
      const problem = checkSolSummary(unsigned, sol, adapter.getAddress());
      if (problem) throw new Error(t('send.solProblemBlocked', { problem }));
    }
    return { unsigned, summary, sol, key: buildKey };
  };

  useEffect(() => {
    setBuilt(null);
    setBuildError(null);
    if (!addrValid || !feeParams || dogeBelowDust || kasBelowMin || xrpBlocked || xlmBlocked || nearBlocked || dotBlocked || adaBlocked || hbarBlocked || algoBlocked || xmrBlocked) return;
    // A Cardano token payment carries only its min-ADA: no ADA amount to type.
    if (!adaTokenMode && (overBalance || (!max && (amountBase === null || amountBase <= 0n)))) return;
    let alive = true;
    setBuilding(true);
    doBuild()
      .then((b) => alive && setBuilt(b))
      .catch((e: unknown) => alive && setBuildError(e instanceof Error ? e.message : toIpcError(e).message))
      .finally(() => alive && setBuilding(false));
    return () => {
      alive = false;
    };
  }, [buildKey]);

  // Reflect MAX in the amount field.
  useEffect(() => {
    if (max && built) setAmountStr(fiatMode && price ? sanitizeDecimalInput(String(unitsToNumber(built.unsigned.amount, decimals) * price), 2) : toInputDecimal(built.unsigned.amount, decimals));
  }, [max, built]);

  const size = built?.unsigned.size;
  const optionCost = (p: FeeParams | null | undefined): bigint | null => (p && size ? safeCost(p, size) : null);
  const maxFee = built?.unsigned.maxFee ?? null;
  const sendAmount = built?.unsigned.amount ?? amountBase;
  const rent = built?.unsigned.family === 'sol' ? built.unsigned.ataRent : 0n;
  const feeFiat = maxFee !== null && nativeAsset && nativePrice !== null ? unitsToNumber(maxFee, nativeAsset.decimals) * nativePrice : null;
  const rentFiat = rent > 0n && nativeAsset && nativePrice !== null ? unitsToNumber(rent, nativeAsset.decimals) * nativePrice : 0;
  const amountFiat = sendAmount !== null && price !== null ? unitsToNumber(sendAmount, decimals) * price : null;
  const after = sendAmount !== null ? balance - sendAmount - (asset?.kind === 'native' && maxFee !== null ? maxFee : 0n) : null;

  // Sign.
  const [password, setPassword] = useState('');
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  /** Hardware wallet: the device in use while signing, and its error (precise HW_* message). */
  const [hwDevice, setHwDevice] = useState<string | null>(null);
  const [hwError, setHwError] = useState<unknown>(null);
  const [done, setDone] = useState<{ id: string; dot?: { nonce: number; validUntil: number } } | null>(null);
  const guardOk = guardAllowsSend(guard, settings.clipboardGuard);
  // TRON: the TRX balance must cover the amount (TRX) plus the expected burn, else the network refuses it.
  const tronShort = built?.unsigned.family === 'tron' && !tronCoverage(built.unsigned.estimate, built.unsigned.token ? 0n : built.unsigned.amount).expected;
  // Hardware wallet: no Kyro password (no key in Kyro); native dialog then the device's screen.
  const canSign = !!built && !building && (activeHw ? true : !!password) && guardOk && !signing && !buildError && !tronShort && !poisonBlocked;
  const blindSigning = !!activeHw && built?.unsigned.family === 'evm' && built.summary !== null && evmHwDisplay(activeHw.device, built.unsigned.tx.chainId, built.summary) === 'blind';

  const sign = async () => {
    if (!asset || !adapter || !built) return;
    const verified = guardVerify(guard, toRef.current?.value ?? '', to);
    setGuard(verified);
    if (!guardAllowsSend(verified, settings.clipboardGuard)) return;
    setSigning(true);
    setSignError(null);
    setHwError(null);
    try {
      // Fresh build (nonce, blockhash) with the same inputs, re-decoded by Rust. Monero: the
      // transfer Rust prepared (kept in Rust, single use) is signed as is.
      const fresh = isXmr ? built : await doBuild();
      let id: string;
      if (activeHw) {
        const device = await pickDevice(activeHw.device);
        setHwDevice(device.id);
        id = await withDevice(device.id, () => signAndBroadcastHw(adapter, fresh.unsigned, device.id));
      } else {
        id = await signAndBroadcast(adapter, fresh.unsigned, password);
      }
      setPassword('');
      addLocalTx({
        id,
        network,
        chainKey: asset.chainKey,
        assetId: asset.id,
        kind: 'transfer',
        direction: isOwn ? 'self' : 'out',
        amount: fresh.unsigned.amount.toString(),
        fee: fresh.unsigned.maxFee.toString(),
        counterparty: toTrim,
        time: Date.now(),
        status: 'pending',
      });
      if (contact) bumpContactSends(contact.id);
      setDone({ id, ...(fresh.unsigned.family === 'dot' ? { dot: { nonce: fresh.unsigned.summary.nonce, validUntil: fresh.unsigned.context.validUntil } } : {}) });
      pf.refresh();
    } catch (e) {
      const err = toIpcError(e);
      if (activeHw && (err.code.startsWith('HW_') || err.code === 'USER_REJECTED')) setHwError(e);
      else setSignError(err.code === 'USER_REJECTED' ? t('send.signCancelled') : err.message);
      // Monero: a prepared transfer is used once by Rust, even on failure: prepare it again.
      if (isXmr) {
        setBuilt(null);
        setXmrGo(0);
      }
    } finally {
      setSigning(false);
      setHwDevice(null);
    }
  };

  if (!asset || !adapter || !chain) {
    return (
      <div className="flex flex-1 items-center justify-center text-[14px] text-mute">
        <Spinner /> &nbsp;{t('send.loadingAccounts')}
      </div>
    );
  }

  // Review label: « Ton compte "X" » for one of the user's accounts, else the contact or the address.
  const recipientName = ownAccount ? ownAccountLabel(ownAccount.name) : (contact?.name ?? shortAddress(toTrim || '—'));
  const step1 = addrValid;
  const step2 = !!built;

  if (done) {
    return (
      <SendDone
        id={done.id}
        asset={asset}
        amount={built?.unsigned.amount ?? 0n}
        {...(adaTokenMode && adaToken ? { what: t('send.doneWhatToken', { qty: tokenQty, token: cardanoTokenLabel(adaToken), ada: fmtCrypto(built?.unsigned.amount ?? 0n, 6, 'ADA') }) } : {})}
        to={toTrim}
        contactKnown={!!contact || !!ownAccount}
        onBack={back}
        onHistory={() => navigate({ name: 'history' })}
      >
        {xrpAdapter && <XrpTxStatusLine adapter={xrpAdapter} hash={done.id} recipient={toTrim} onValidated={pf.refresh} />}
        {xlmAdapter && <StellarTxStatusLine adapter={xlmAdapter} hash={done.id} recipient={toTrim} onIncluded={pf.refresh} />}
        {dotAdapter && done.dot && <DotTxStatusLine adapter={dotAdapter} nonce={done.dot.nonce} validUntil={done.dot.validUntil} onFinalized={pf.refresh} />}
        {algoAdapter && <AlgoTxStatusLine adapter={algoAdapter} txid={done.id} recipient={toTrim} onConfirmed={pf.refresh} />}
        {adaAdapter && <CardanoTxStatusLine adapter={adaAdapter} hash={done.id} onConfirmed={pf.refresh} />}
        {nearAdapter && <NearTxStatusLine adapter={nearAdapter} hash={done.id} recipient={toTrim} onDone={pf.refresh} />}
        {suiAdapter && <SuiTxStatusLine adapter={suiAdapter} digest={done.id} recipient={toTrim} onIndexed={pf.refresh} />}
        {hbarAdapter && <HbarTxStatusLine adapter={hbarAdapter} id={done.id} recipient={toTrim} onDone={pf.refresh} />}
        {kasAdapter && <KaspaTxStatusLine adapter={kasAdapter} txid={done.id} onAccepted={pf.refresh} />}
      </SendDone>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 px-7 pt-6 pb-5">
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <IconButton label={t('send.backToWallet')} onClick={back} className="size-9">
            <IconBack size={16} />
          </IconButton>
          <h1 className="screen-title">{t('send.title')}</h1>
        </div>
        <ol aria-label={t('send.steps')} className="m-0 flex list-none items-center gap-2.5 p-0 text-[13px]">
          <Step n={1} done={step1} current={!step1} label={t('send.recipient')} />
          <li aria-hidden="true" className={cn('h-px w-6 transition-colors duration-300', step1 ? 'bg-ice/60' : 'bg-line-3')} />
          <Step n={2} done={step2} current={step1 && !step2} label={t('send.stepAmount')} />
          <li aria-hidden="true" className={cn('h-px w-6 transition-colors duration-300', step2 ? 'bg-ice/60' : 'bg-line-3')} />
          <Step n={3} done={false} current={step2} label={t('send.stepReview')} />
        </ol>
      </header>

      <div className="flex min-h-0 flex-1 gap-5">
        <form onSubmit={(e) => e.preventDefault()} className="flex min-w-0 flex-1 flex-col gap-6 overflow-y-auto rounded-panel border border-line bg-card px-[26px] py-6 scroll-thin">
          {/* From */}
          <div className="flex flex-col gap-2">
            <span className="eyebrow">{t('send.from')}</span>
            <Menu
              value={asset.id}
              onSelect={(id) => {
                setSelectedId(id);
                setMax(false);
                setAmountStr('');
                setChoice('normal');
                setCustomEvm({ maxFeeGwei: '', priorityGwei: '' });
                setCustomBtc('');
                setCustomSol('');
                setTagStr('');
                setXlmMemo('');
                setTokenSel('');
                setTokenQty('');
                setMemo('');
              }}
              className="w-[520px]"
              items={sendable.map((a) => ({
                value: a.id,
                label: `${a.name} · ${findChain(network, a.chainKey)?.label ?? ''}`,
                hint: t('send.availableAmount', { amount: fmtCrypto(pf.balances.get(a.id) ?? 0n, a.decimals, a.symbol) }),
                icon: <CoinIcon glyph={a.glyph} color={a.color} size={26} />,
              }))}
              trigger={
                <button type="button" className="press flex h-[58px] items-center gap-3 rounded-box border border-line-2 bg-bg px-4 text-left hover:border-line-3 hover:bg-raised/50">
                  <CoinIcon glyph={asset.glyph} color={asset.color} />
                  <span className="flex flex-1 flex-col">
                    <span className="text-[14px] font-medium">
                      {asset.name} · {accountName(asset.family)}
                    </span>
                    <span className="text-[12px] text-mute">
                      {t('send.availableAmount', { amount: hideBalances ? '•••••' : fmtCrypto(balance, decimals, asset.symbol) })} · {chain.name}
                    </span>
                  </span>
                  <IconChevronDown size={16} className="text-mute" />
                </button>
              }
            />
            <AccountPicker family={asset.family} label={t('common.account')} />
            {activeHw && <span className="text-[12px] text-faint">{t('send.hwUnsupportedChains')}</span>}
            {fees.error && serverMissing(fees.error) && <ServerMissingLine coin={asset.name} />}
          </div>

          {/* To */}
          <div className="flex flex-col gap-2">
            <label htmlFor="dest" className="eyebrow">
              {t('send.to')}
            </label>
            <div className={cn('overflow-hidden rounded-box border bg-bg transition-[border-color,box-shadow] duration-200 focus-within:shadow-[0_0_0_1px_rgba(124,196,255,.35)]', guard.tampered && settings.clipboardGuard ? 'border-down/70' : addrValid ? 'border-ice-line' : 'border-line-2')}>
              <div className={cn('flex h-12 items-center gap-2.5 pr-2 pl-4', addrValid && 'border-b border-control-2')}>
                <input
                  id="dest"
                  ref={toRef}
                  type="text"
                  value={to}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={asset.family === 'btc' ? (network === 'testnet' ? 'tb1…' : 'bc1…') : asset.family === 'ltc' ? (network === 'testnet' ? 'tltc1…' : 'ltc1…') : asset.family === 'doge' ? (network === 'testnet' ? 'n…' : 'D…') : asset.family === 'bch' ? (network === 'testnet' ? 'bchtest:q…' : 'bitcoincash:q…') : asset.family === 'dash' ? (network === 'testnet' ? 'y…' : 'X…') : asset.family === 'tron' ? 'T…' : asset.family === 'xrp' ? t('send.xrpPlaceholder') : asset.family === 'xlm' ? t('send.xlmPlaceholder') : asset.family === 'ada' ? (network === 'testnet' ? 'addr_test1…' : 'addr1…') : asset.family === 'xmr' ? (network === 'testnet' ? '5… ou 7… (stagenet)' : '4… ou 8…') : asset.family === 'algo' ? 'Adresse Algorand (58 caractères)' : asset.family === 'dot' ? (network === 'testnet' ? '5… (Westend)' : '1… (Polkadot)') : asset.family === 'kas' ? (network === 'testnet' ? 'kaspatest:q…' : 'kaspa:q…') : asset.family === 'near' ? (network === 'testnet' ? t('send.nearPlaceholderTestnet') : t('send.nearPlaceholder')) : asset.family === 'sol' ? t('send.solPlaceholder') : asset.family === 'sui' ? t('send.suiPlaceholder') : asset.family === 'hbar' ? t('send.hbarPlaceholder') : '0x…'}
                  onChange={(e) => {
                    const v = e.target.value;
                    setTo(v);
                    setGuard((g) => guardOnInput(g, v, (e.nativeEvent as InputEvent).inputType));
                  }}
                  className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-text2"
                />
                {guard.source === 'paste' && <span className="pop-in inline-flex h-6 items-center rounded-[4px] border border-line-3 px-2 font-mono text-[10.5px] tracking-[0.04em] text-text2">{t('send.badgePasted')}</span>}
                {guard.source === 'typed' && <span className="pop-in inline-flex h-6 items-center rounded-[4px] border border-line-3 px-2 font-mono text-[10.5px] tracking-[0.04em] text-text2">{t('send.badgeTyped')}</span>}
                {guard.source === 'picked' && <span className="pop-in inline-flex h-6 items-center rounded-[4px] border border-line-3 px-2 font-mono text-[10.5px] tracking-[0.04em] text-text2">{t('send.badgePicked')}</span>}
                {!activeHw && (
                  <Menu
                    align="end"
                    label={t('send.myAccountsOf', { chain: ACCOUNT_CHAIN_LABEL[asset.family as AccountChain] })}
                    className="w-[340px]"
                    onSelect={(v) => (v === '__new__' ? void createOwnRecipient() : pickRecipient(v))}
                    items={[
                      ...myOtherAccounts.map((x) => {
                        const bal = pf.accountBalances.get(`${x.family}:${x.index}`)?.get(asset.id);
                        return {
                          value: x.addresses[0] ?? '',
                          label: x.name,
                          hint: [shortAddress(x.addresses[0] ?? ''), bal === undefined ? null : hideBalances ? '•••••' : fmtCrypto(bal, asset.decimals, asset.symbol)].filter(Boolean).join(' · '),
                        };
                      }),
                      {
                        value: '__new__',
                        label: myOtherAccounts.length === 0 ? t('send.createAnotherAccount') : t('send.newAccount'),
                        hint: nextOwn === null ? t('send.accountLimit') : t('send.newAccountHint', { name: defaultAccountName(asset.family as AccountChain, nextOwn) }),
                        disabled: nextOwn === null || ownBusy,
                      },
                    ]}
                    trigger={
                      <button type="button" className="press h-7 rounded-[5px] px-2.5 text-[12px] font-medium whitespace-nowrap text-ice hover:bg-control">
                        {ownBusy ? <Spinner /> : t('send.myAccounts')}
                      </button>
                    }
                  />
                )}
                <Menu
                  align="end"
                  label={t('send.addressBook')}
                  onSelect={pickRecipient}
                  items={getContacts()
                    .filter((c) => c.family === asset.family)
                    .map((c) => ({ value: c.address, label: c.name, hint: shortAddress(c.address) }))}
                  trigger={
                    <button type="button" className="press h-7 rounded-[5px] px-2.5 text-[12px] font-medium text-ice hover:bg-control">
                      {t('send.addressBookShort')}
                    </button>
                  }
                />
              </div>
              {addrValid && (
                <div className="fade-in flex flex-col gap-3 p-4">
                  <div className="flex items-center gap-2.5">
                    <span className="flex size-8 items-center justify-center rounded-full bg-ice-deep text-[13px] font-semibold text-ice-text">{(ownAccount?.name ?? contact?.name ?? '?').slice(0, 1).toUpperCase()}</span>
                    <span className="flex flex-col">
                      <span className="text-[14px] font-medium">{ownAccount ? ownAccountLabel(ownAccount.name) : contact ? contact.name : isOwn ? t('send.yourOwnAccount') : t('send.unknownAddress')}</span>
                      <span className="text-[12px] text-mute">{ownAccount ? t('send.ownAccountSub', { chain: ACCOUNT_CHAIN_LABEL[ownAccount.family], n: ownAccount.index + 1 }) : contact ? tp('send.contactSub', contact.sends ?? 0) : isOwn ? t('send.ownVaultSub') : t('send.unknownSub')}</span>
                    </span>
                  </div>
                  <AddressBlocks address={toTrim} />
                  <div className="flex flex-wrap gap-[18px] text-[12px] font-medium">
                    {/* No « identical to what you pasted »: a clipper swaps the clipboard BEFORE the paste. */}
                    {!contact && !isOwn && !ownAccount && <span className="text-warn">{t('send.unknownCompare')}</span>}
                    {guard.source === 'typed' && <span className="text-warn">{t('send.typedCheck')}</span>}
                    {contact && <span className="text-up">{t('send.knownAddress')}</span>}
                    {noChecksum && <span className="text-warn">{t('send.noChecksum')}</span>}
                    <span className="font-normal text-mute">{contact ? t('send.compareWith', { name: contact.name }) : t('send.compareWithSource')}</span>
                  </div>
                </div>
              )}
            </div>
            {ownError && <span className="text-[12px] text-down">{ownError}</span>}
            {dotProblem && <span className="text-[12px] text-down">{dotProblem}</span>}
            {xlmProblem && <span className="text-[12px] text-down">{xlmProblem}</span>}
            {toTrim && !addrValid && !xAddress && !adaProblem && !kasProblem && !xlmProblem && !dotProblem && <span className="text-[12px] text-down">{nearProblem ? `${nearProblem}.` : t('send.invalidAddressFor', { chain: chain.name })}</span>}
            {adaProblem && <span className="text-[12px] text-down">{adaProblem.charAt(0).toUpperCase() + adaProblem.slice(1)}.</span>}
            {kasProblem && <span className="text-[12px] text-down">{kasProblem.charAt(0).toUpperCase() + kasProblem.slice(1)}.</span>}
            {poisoning.lookalike && <PoisoningWarning recipient={toTrim} lookalike={poisoning.lookalike} family={asset.family} acknowledged={poisonAck} onAcknowledge={setPoisonAck} />}
            {!poisoning.lookalike && poisoning.suspect && !contact && !isOwn && <DustOnlyNote />}
            {xAddress && (
              <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
                {rt('send.xAddress', { b: (c) => <strong className="font-semibold">{c}</strong> })}
              </Notice>
            )}
            {suiProblem && <span className="text-[12px] text-down">{suiProblem}</span>}
            {isSui && addrValid && <span className="text-[12px] leading-[1.45] text-mute">Les adresses Sui n’ont pas de somme de contrôle : une faute de frappe donne une autre adresse valide. Compare-la en entier ; la fenêtre système la répète au complet.</span>}
            {isXrp && <XrpTagField value={tagStr} onChange={setTagStr} error={tagParsed.error} dest={xrpDestInfo} destLoading={addrValid && xrpDest.loading && !xrpDestInfo} />}
            {isAlgo && <AlgoNoteField value={memo} onChange={setMemo} dest={addrValid ? algoDestInfo : undefined} destLoading={addrValid && algoDest.loading && !algoDestInfo} />}
            {isAlgo && algoDest.error && addrValid && <span className="text-[12px] text-down">{t('send.destUnreadable', { message: algoDest.error.message })}</span>}
            {isDot && addrValid && <DotDestinationNote dest={dotDestInfo} decimals={asset.decimals} symbol={asset.symbol} />}
            {isDot && dotDest.error && addrValid && <span className="text-[12px] text-down">{t('send.destUnreadable', { message: dotDest.error.message })}</span>}
            {isXlm && <StellarMemoField kind={xlmMemoKind} onKind={(k) => { setXlmMemoKind(k); setXlmMemo(''); }} value={xlmMemo} onChange={setXlmMemo} error={xlmMemoParsed.error} dest={xlmDestInfo} destLoading={addrValid && xlmDest.loading && !xlmDestInfo} />}
            {isXlm && xlmDest.error && addrValid && <span className="text-[12px] text-down">{t('send.destUnreadable', { message: xlmDest.error.message })}</span>}
            {isXrp && xrpDest.error && addrValid && <span className="text-[12px] text-down">{t('send.destUnreadable', { message: xrpDest.error.message })}</span>}
            {isNear && addrValid && <NearReceiverLine id={toTrim} info={nearRecvInfo} loading={nearRecv.loading} />}
            {isNear && nearRecv.error && addrValid && <span className="text-[12px] text-down">{t('send.destUnreadable', { message: nearRecv.error.message })}</span>}
            {isHbar && <HbarMemoField value={memo} onChange={setMemo} dest={hbarDestInfo} destLoading={addrValid && hbarDest.loading && !hbarDestInfo} />}
            {isHbar && hbarProblem && <span className="text-[12px] text-down">{hbarProblem}</span>}
            {isHbar && hbarDest.error && addrValid && <span className="text-[12px] text-down">{t('send.destUnreadable', { message: hbarDest.error.message })}</span>}
            {isXmr && addrValid && <XmrDestinationLine dest={xmrDestInfo} error={xmrDest.error ? xmrDest.error.message : null} loading={xmrDest.loading} />}
            {guard.tampered && settings.clipboardGuard && (
              <Notice tone="error" icon={<IconWarn size={16} className="mt-0.5 shrink-0" />}>
                {t('send.tampered')}
              </Notice>
            )}
          </div>

          {isAda && <CardanoSendFields account={adaMe.data} tokenSel={tokenSel} onTokenSel={(k) => { setTokenSel(k); setTokenQty(''); setMax(false); }} quantity={tokenQty} onQuantity={setTokenQty} memo={memo} onMemo={setMemo} />}
          {adaTokenOver && <span className="-mt-3 text-[12px] text-down">{t('send.tokenOver')}</span>}
          {adaTokenMode ? (
            <span className="-mt-2 text-[12px] leading-[1.45] text-mute">{t('send.adaWithToken')}</span>
          ) : (
          <>
          {/* Amount */}
          <div className="flex flex-col gap-2">
            <div className="flex justify-between">
              <label htmlFor="amount" className="eyebrow">
                {t('common.amount')}
              </label>
              <span className="text-[12px] text-mute">{after !== null && after >= 0n && !hideBalances ? t('send.balanceAfter', { amount: fmtCrypto(after, decimals, asset.symbol) }) : ''}</span>
            </div>
            <div className={cn('flex h-[72px] items-center gap-3 rounded-box border bg-bg pr-2.5 pl-[18px] transition-colors duration-150 focus-within:border-ice-line', overBalance ? 'border-down/60' : 'border-line-2 hover:border-line-3')}>
              <input
                id="amount"
                type="text"
                inputMode="decimal"
                value={amountStr}
                placeholder="0"
                onChange={(e) => {
                  setMax(false);
                  setAmountStr(sanitizeDecimalInput(e.target.value, fiatMode ? 2 : decimals));
                }}
                className="figure w-[200px] bg-transparent text-[36px] tracking-[-0.035em]"
              />
              <span className="font-mono text-[14px] font-medium text-mute">{fiatMode ? cur : asset.symbol}</span>
              <span className="flex-1 text-[14px] text-faint">
                {fiatMode ? (amountBase !== null ? `≈ ${fmtCrypto(amountBase, decimals, asset.symbol)}` : '') : amountFiat !== null ? `≈ ${fmtFiat(amountFiat, cur)}` : ''}
              </span>
              <button
                type="button"
                aria-label={t('send.enterIn', { unit: fiatMode ? asset.symbol : cur })}
                disabled={fiatPrice === null && !fiatMode}
                title={!priceCheck.ok && priceCheck.reason ? t('send.fiatDisabled', { reason: priceCheck.reason, cur }) : undefined}
                onClick={() => {
                  setFiatMode((f) => !f);
                  setAmountStr('');
                  setMax(false);
                }}
                className="press flex size-10 items-center justify-center rounded-ctl border border-line-2 text-text2 hover:border-line-3 hover:bg-raised hover:text-text disabled:opacity-40"
              >
                <IconUpDown size={16} />
              </button>
              <button type="button" onClick={() => setMax(true)} className={cn('press h-10 rounded-ctl border px-3.5 font-mono text-[11px] font-medium tracking-[0.06em]', max ? 'border-ice/40 bg-ice/[.1] text-ice-text' : 'border-line-2 text-text hover:border-line-3 hover:bg-raised')}>
                MAX
              </button>
            </div>
            {overBalance && <span className="text-[12px] text-down">{isXrp || isXlm ? t('send.overSpendable') : isNear ? t('send.overSpendableNear') : isDot ? t('send.overSpendableDot') : isAlgo ? t('send.overSpendableAlgo') : t('send.overBalance')}</span>}
            {fiatMode && !priceCheck.ok && <span className="text-[12px] text-down">{priceCheck.reason ?? t('send.priceUnavailable')} {t('send.enterAmountIn', { symbol: asset.symbol })}</span>}
            {fiatMode && !overBalance && amountBase !== null && balanceShare !== null && balanceShare >= 50 && (
              <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
                {rt('send.fiatShare', { b: (c) => <strong className="font-semibold">{c}</strong> }, { amount: fmtCrypto(amountBase, decimals, asset.symbol), pct: Math.round(balanceShare), cur, symbol: asset.symbol })}
              </Notice>
            )}
            {isXrp && <XrpSpendable account={xrpMe.data} hidden={hideBalances} />}
            {isXlm && <StellarSpendable account={xlmMe.data} hidden={hideBalances} />}
            {xlmBelowActivation && <span className="text-[12px] text-down">{t('send.xlmBelowActivation')}</span>}
            {isNear && <NearSpendable account={nearMe.data} hidden={hideBalances} />}
            {isSui && <SuiSpendable balance={suiMe.data} hidden={hideBalances} />}
            {isHbar && <HbarAccountState account={hbarMe.data} hidden={hideBalances} />}
            {isKas && <KaspaSpendable account={kasMe.data} hidden={hideBalances} />}
            {kasBelowMin && <span className="text-[12px] text-down">Minimum 0,2 KAS par envoi : en dessous, la masse de stockage de Kaspa (KIP-9) rend la sortie non standard et Kyro la refuse.</span>}
            {isDot && <DotSpendable account={dotMe.data} decimals={asset.decimals} symbol={asset.symbol} hidden={hideBalances} />}
            {dotBelowEd && dotDestInfo && <span className="text-[12px] text-down">Ce compte n’existe pas encore : il faut lui envoyer au moins {fmtCrypto(BigInt(dotDestInfo.existentialDeposit), asset.decimals, asset.symbol)} (dépôt existentiel).</span>}
            {isAlgo && <AlgoSpendable account={algoMe.data} hidden={hideBalances} />}
            {algoBelowMinimum && <span className="text-[12px] text-down">{algoDestInfo?.exists ? `Ce destinataire resterait sous son solde minimum : envoie au moins ${fmtCrypto(algoDestMin, 6, 'ALGO', 6)}.` : 'Ce compte n’existe pas encore : il faut lui envoyer au moins 0,1 ALGO.'}</span>}
            {isXmr && <XmrLockedNote status={xmr.status} hidden={hideBalances} />}
            {isXmr && <XmrSyncLine status={xmr.status} error={xmr.error} onRetry={xmr.sync} />}
            {isAda && adaMe.data && (
              <span className="text-[12px] leading-[1.45] text-mute">
                {t('send.adaBalance', {
                  balance: hideBalances ? '•••••' : fmtCrypto(BigInt(adaMe.data.balance), 6, 'ADA'),
                  locked: BigInt(adaMe.data.lockedWithTokens) > 0n ? t('send.adaLocked', { amount: fmtCrypto(BigInt(adaMe.data.lockedWithTokens), 6, 'ADA') }) : '',
                })}
              </span>
            )}
            {xrpBelowActivation && <span className="text-[12px] text-down">{t('send.xrpBelowActivation')}</span>}
            {dogeBelowDust && <span className="text-[12px] text-down">{t('send.dogeBelowDust')}</span>}
            {asset.family === 'doge' && (
              <span className="text-[12px] leading-[1.5] text-mute">
                {t('send.dogeNote')}
              </span>
            )}
            {asset.family === 'bch' && (
              <span className="text-[12px] leading-[1.5] text-mute">
                Bitcoin Cash : adresses CashAddr seulement (bitcoincash:q…) ; une adresse 1… ou 3… est refusée, on ne peut pas la distinguer d’une adresse Bitcoin. Destinataire minimum {bchDashDust('p2pkh').toString()} satoshis ; une monnaie plus petite est ajoutée aux frais. Les pièces portant des CashTokens ne sont jamais dépensées.
              </span>
            )}
            {asset.family === 'dash' && (
              <span className="text-[12px] leading-[1.5] text-mute">
                Dash : destinataire minimum {bchDashDust('p2pkh').toString()} duffs ; une monnaie plus petite est ajoutée aux frais. Envoi classique (pas de PrivateSend ni d’InstantSend demandé).
              </span>
            )}
            {asset.family === 'ltc' && (
              <span className="text-[12px] leading-[1.5] text-mute">
                {t('send.ltcNote', { dust: litecoinDust('p2wpkh').toString() })}
              </span>
            )}
          </div>

          </>
          )}
          {/* Fees */}
          {isKas ? (
            <div className="flex flex-col gap-2">
              <span className="eyebrow">Frais réseau</span>
              <div className="rounded-box border border-line-2 bg-bg px-4 py-3 text-[13px] leading-[1.5] text-text2">
                <strong className="font-semibold text-text">Rien à choisir sur Kaspa.</strong> Les frais dépendent de la masse de la transaction : 100 sompi par gramme (d’habitude ≈ 0,002 KAS), davantage si le réseau est chargé. Le coffre les calcule ; le montant exact et la masse sont dans la vérification.
              </div>
            </div>
          ) : isXmr ? (
            <div className="flex flex-col gap-2">
              <span className="eyebrow">Frais réseau</span>
              <div className="flex flex-col gap-1 rounded-box border border-line-2 bg-bg px-4 py-3 text-[13px] leading-[1.5] text-text2">
                <span>
                  <strong className="font-semibold text-text">Rien à choisir sur Monero.</strong> Le coffre prend le tarif « normal » du nœud (plafonné) et le poids exact de la transaction : d’habitude ≈ 0,0001 XMR.
                </span>
                <XmrSendNotes />
              </div>
              <Button
                variant="primary"
                size="lg"
                disabled={!addrValid || !xmrDestInfo || !xmrSynced || building || overBalance || (!max && (amountBase === null || amountBase <= 0n))}
                onClick={() => setXmrGo((n) => n + 1)}
                className="self-start"
              >
                {building && <Spinner />} Préparer le transfert
              </Button>
              {!xmrSynced && xmr.status && <span className="text-[12px] text-mute">Attends la fin du scan Monero pour préparer un transfert.</span>}
            </div>
          ) : isAda ? (
            <div className="flex flex-col gap-2">
              <span className="eyebrow">{t('send.networkFees')}</span>
              <div className="rounded-box border border-line-2 bg-bg px-4 py-3 text-[13px] leading-[1.5] text-text2">
                {rt('send.adaFees', { b: (c) => <strong className="font-semibold text-text">{c}</strong> })}
              </div>
            </div>
          ) : isXlm ? (
            <div className="flex flex-col gap-2">
              <span className="eyebrow">{t('send.networkFees')}</span>
              <div className="rounded-box border border-line-2 bg-bg px-4 py-3 text-[13px] leading-[1.5] text-text2">
                {rt('send.xlmFees', { b: (c) => <strong className="font-semibold text-text">{c}</strong> })}
              </div>
            </div>
          ) : isSui ? (
            <div className="flex flex-col gap-2">
              <span className="eyebrow">Frais réseau</span>
              <div className="rounded-box border border-line-2 bg-bg px-4 py-3 text-[13px] leading-[1.5] text-text2">
                <strong className="font-semibold text-text">Rien à choisir sur Sui.</strong> Le coffre prend le prix du gaz de référence de l’époque et fixe le budget d’après une simulation de la transaction exacte (d’habitude ≈ 0,002 SUI). Le budget est un plafond : seul le gaz consommé est prélevé.
              </div>
            </div>
          ) : isHbar ? (
            <div className="flex flex-col gap-2">
              <span className="eyebrow">Frais réseau</span>
              <div className="rounded-box border border-line-2 bg-bg px-4 py-3 text-[13px] leading-[1.5] text-text2">
                <strong className="font-semibold text-text">Rien à choisir sur Hedera.</strong> Un transfert coûte ≈ 0,0001 $ en HBAR. Le coffre fixe un plafond (frais maximum) au taux de change du réseau ; seuls les frais réels sont prélevés. Vers une adresse EVM sans compte, le réseau crée le compte (≈ 0,05 $).
              </div>
            </div>
          ) : isDot ? (
            <div className="flex flex-col gap-2">
              <span className="eyebrow">Frais réseau</span>
              <div className="rounded-box border border-line-2 bg-bg px-4 py-3 text-[13px] leading-[1.5] text-text2">
                <strong className="font-semibold text-text">Rien à choisir sur Polkadot.</strong> Les frais dépendent du poids et de la taille de la transaction (d’habitude ≈ 0,015 {asset.symbol}), sans pourboire ; le nœud les estime et le montant s’affiche dans la vérification.
              </div>
            </div>
          ) : isAlgo ? (
            <div className="flex flex-col gap-2">
              <span className="eyebrow">Frais réseau</span>
              <div className="rounded-box border border-line-2 bg-bg px-4 py-3 text-[13px] leading-[1.5] text-text2">
                <strong className="font-semibold text-text">Rien à choisir sur Algorand.</strong> Le coffre fixe les frais minimum du protocole (0,001 ALGO), un peu plus seulement si le réseau est saturé ; le montant exact est dans la vérification.
              </div>
            </div>
          ) : isXrp ? (
            <div className="flex flex-col gap-2">
              <span className="eyebrow">{t('send.networkFees')}</span>
              <div className="rounded-box border border-line-2 bg-bg px-4 py-3 text-[13px] leading-[1.5] text-text2">
                {rt('send.xrpFees', { b: (c) => <strong className="font-semibold text-text">{c}</strong> })}
              </div>
            </div>
          ) : isNear ? (
            <div className="flex flex-col gap-2">
              <span className="eyebrow">Frais réseau</span>
              <div className="rounded-box border border-line-2 bg-bg px-4 py-3 text-[13px] leading-[1.5] text-text2">
                <strong className="font-semibold text-text">Rien à choisir sur NEAR.</strong> Les frais sont prélevés au prix du gas du bloc (d’habitude ≈ 0,00005 NEAR pour un transfert, un peu plus s’il crée le compte destinataire). Ils ne figurent pas dans la transaction : le coffre vérifie que ton solde couvre le montant plus une borne de frais, affichée dans la vérification.
              </div>
            </div>
          ) : isTron ? (
            <div className="flex flex-col gap-2">
              <span className="eyebrow">{t('send.networkFees')}</span>
              <div className="flex flex-col gap-1 rounded-box border border-line-2 bg-bg px-4 py-3 text-[13px] leading-[1.5] text-text2">
                <span>
                  {rt('send.tronFees', { b: (c) => <strong className="font-semibold text-text">{c}</strong> })}
                </span>
                <span className="text-[12px] text-mute">{t('send.tronFeesSub')}</span>
              </div>
            </div>
          ) : (
          <div className="flex flex-col gap-2">
            <div className="flex justify-between">
              <span className="eyebrow">{t('send.networkFees')}</span>
              <span className="text-[12px] text-faint">{fees.data ? t('send.currentNetwork', { hint: getLanguage() === 'fr' ? fees.data.hint.replace('.', ',') : fees.data.hint }) : fees.error ? (feesTorBlocked ? t('send.waitingTor') : serverMissing(fees.error) ? <span className="text-warn">{t('send.noServer')}</span> : serverDown(fees.error) ? <span className="text-warn">{t('send.serverDown')}</span> : <span className="text-down">{t('send.feesUnavailable')}</span>) : t('send.estimating')}</span>
            </div>
            <div role="radiogroup" aria-label={t('send.networkFees')} className="flex gap-2">
              {LEVELS.map(({ level, label }) => {
                const opt = fees.data?.options[level];
                const c = optionCost(opt?.params);
                const fiat = c !== null && nativeAsset && nativePrice !== null ? fmtFiat(unitsToNumber(c, nativeAsset.decimals) * nativePrice, cur) : c !== null && nativeAsset ? fmtCrypto(c, nativeAsset.decimals, nativeAsset.symbol) : null;
                return (
                  <FeeOption key={level} active={choice === level} onClick={() => setChoice(level)} title={`${t(label)}${fiat ? ` · ${fiat}` : ''}`} sub={opt ? fmtEta(opt.etaSecs) : '…'} disabled={!opt} />
                );
              })}
              <FeeOption active={choice === 'custom'} onClick={() => setChoice('custom')} title={t('send.feeCustom')} sub={blockAverage ? t('send.feeSuggested') : t('send.feeYouChoose')} ice disabled={!fees.data} />
            </div>
            {blockAverage && (
              <span className="flex items-start gap-1.5 text-[12px] leading-[1.45] text-mute">
                <IconWarn size={13} className="mt-0.5 shrink-0 text-warn" />
                <span>
                  {t('send.blockAverage')}
                </span>
              </span>
            )}
            {choice === 'custom' && (
              <div className="fade-in flex items-end gap-3 rounded-box border border-ice-line bg-bg px-4 py-3.5">
                {asset.family === 'evm' && (
                  <>
                    <UnitField label={t('send.maxFeePerGas')} unit="gwei" value={customEvm.maxFeeGwei} onChange={(v) => setCustomEvm((c) => ({ ...c, maxFeeGwei: v }))} />
                    <UnitField label={t('send.priorityTip')} unit="gwei" value={customEvm.priorityGwei} onChange={(v) => setCustomEvm((c) => ({ ...c, priorityGwei: v }))} />
                  </>
                )}
                {utxoLike && <UnitField label={t('send.rate')} unit={rateUnit} value={customBtc} onChange={setCustomBtc} decimals={asset.family === 'doge' ? 0 : 2} />}
                {asset.family === 'sol' && <UnitField label="Priority fee" unit="µL/CU" value={customSol} onChange={(v) => setCustomSol(v.replace(/\D/g, ''))} decimals={0} wide />}
                <span className="flex flex-1 flex-col items-end gap-0.5 pb-0.5">
                  <span className="text-[18px] font-medium">{feeFiat !== null && choice === 'custom' && built ? fmtFiat(feeFiat, cur) : '—'}</span>
                  <span className="text-[12px] text-mute">{maxFee !== null && nativeAsset && built ? t('send.maxSuffix', { amount: fmtCrypto(maxFee, nativeAsset.decimals, nativeAsset.symbol) }) : t('send.liveCost')}</span>
                </span>
              </div>
            )}
            {custom && custom.errors.map((e) => <span key={e} className="text-[12px] text-down">{e}</span>)}
            {custom && custom.warnings.map((w) => <span key={w} className="text-[12px] text-warn">{w}</span>)}
          </div>
          )}

          <div className="mt-auto flex items-center gap-3 border-t border-line pt-4 text-[13px] text-text2">
            <IconLock size={18} className="shrink-0 text-mute" />
            <span>{settings.clipboardGuard ? t('send.guardOn') : t('send.guardOff')}</span>
          </div>
        </form>

        {/* Verification */}
        {/* Verification: a receipt. Ice top rule, dashed tear lines between parts. */}
        <aside aria-label={t('send.review')} className="relative flex w-[400px] shrink-0 flex-col gap-4 overflow-y-auto rounded-panel border border-line bg-panel px-6 py-[22px] scroll-thin before:absolute before:inset-x-0 before:top-0 before:h-[2px] before:bg-ice/70">
          <div className="flex items-center justify-between">
            <span className="text-[15px] font-medium tracking-[-0.01em]">{t('send.review')}</span>
            <span className="inline-flex h-6 items-center gap-1.5 rounded-[4px] border border-ice/25 px-2 font-mono text-[10.5px] font-medium tracking-[0.02em] text-ice-text2">
              <IconShield size={12} sw={2.2} className="text-ice" />
              {built?.summary || built?.sol || built?.unsigned.family === 'tron' || built?.unsigned.family === 'xrp' || built?.unsigned.family === 'xlm' || built?.unsigned.family === 'ada' || built?.unsigned.family === 'xmr' || built?.unsigned.family === 'algo' || built?.unsigned.family === 'dot' || built?.unsigned.family === 'kas' || built?.unsigned.family === 'hbar' || built?.unsigned.family === 'sui' || built?.unsigned.family === 'near' ? t('send.decodedInVault') : utxoLike ? t('send.psbtLocal') : t('send.localSummary')}
            </span>
          </div>
          <div className="flex flex-col items-center gap-1 border-b border-dashed border-line-2 pt-2 pb-4">
            <span key={asset.id} className="figure fade-in text-[40px] leading-[1.05]">{sendAmount !== null && sendAmount > 0n ? fmtCrypto(sendAmount, decimals, asset.symbol) : `0 ${asset.symbol}`}</span>
            <span className="text-[13px] text-mute">{amountFiat !== null ? fmtFiat(amountFiat, cur) : '—'}</span>
            {fiatMode && fiatPrice !== null && sendAmount !== null && sendAmount > 0n && (
              <span className="text-center text-[12px] text-warn">{t('send.fiatEntered', { cur, price: fmtFiat(fiatPrice, cur), symbol: asset.symbol })}</span>
            )}
          </div>
          <div className="flex items-center gap-2.5 rounded-box border border-line bg-bg px-3.5 py-3">
            <CoinIcon glyph={asset.glyph} color={asset.color} size={30} />
            <span className="flex flex-col text-[12px]">
              <span className="font-medium">{ownAccount && !activeHw ? accountName(asset.family) : t('send.you')}</span>
              <span className="font-mono text-[11px] text-mute">{shortAddress(adapter.getAddress())}</span>
            </span>
            <span aria-hidden="true" className="relative h-0 flex-1 border-t-[1.5px] border-dashed border-ice-line">
              <span className="absolute -top-[7px] -right-0.5 text-[10px] text-ice">▶</span>
            </span>
            <span className="flex flex-col items-end text-[12px]">
              <span className="font-medium">{addrValid ? (ownAccount ? ownAccountLabel(ownAccount.name) : (contact?.name ?? t('send.recipient'))) : '—'}</span>
              <span className="font-mono text-[11px] text-mute">{addrValid ? shortAddress(toTrim) : ''}</span>
            </span>
            <span className="flex size-[30px] items-center justify-center rounded-full bg-ice-deep text-[12px] font-semibold text-ice-text">{(ownAccount?.name ?? contact?.name ?? '?').slice(0, 1).toUpperCase()}</span>
          </div>
          <dl className="m-0 flex flex-col text-[13px]">
            <Row k={t('common.network')} v={chain.name} />
            <Row
              k={isTron ? t('send.burnMax') : t('send.feeMax')}
              v={
                maxFee !== null && nativeAsset ? (
                  <>
                    {fmtCrypto(maxFee, nativeAsset.decimals, nativeAsset.symbol)}
                    {feeFiat !== null ? ` · ${fmtFiat(feeFiat, cur)}` : ''} {choice === 'custom' && <span className="text-ice-text2">{t('send.customTag')}</span>}
                  </>
                ) : (
                  '—'
                )
              }
            />
            <Row k={t('send.data')} v={dataLabel(built, asset.family)} />
            <div className="flex h-[42px] items-center justify-between">
              <dt className="font-medium">{t('common.total')}</dt>
              <dd className="figure m-0 text-[19px] tracking-[-0.03em]">{amountFiat !== null ? fmtFiat(amountFiat + (feeFiat ?? 0) + rentFiat, cur) : '—'}</dd>
            </div>
          </dl>
          {built?.sol && built.unsigned.family === 'sol' && nativeAsset && (
            <SolSummaryView s={built.sol} unsigned={built.unsigned} asset={asset} sol={nativeAsset} solPrice={nativePrice} currency={cur} />
          )}
          {built?.unsigned.family === 'tron' && <TronEstimateView u={built.unsigned} network={network} trxPrice={nativePrice} currency={cur} />}
          {/* Bitcoin / EVM: Rust's reinforced-confirmation triggers, before the password. */}
          {built && asset.family === 'btc' && built.unsigned.family === 'btc' && built.unsigned.summary.requiresExtraConfirmation && <SecondConfirmNotice lines={built.unsigned.summary.warnings.map(btcWarningText)} />}
          {built?.summary?.requiresExtraConfirmation && nativeAsset && (
            <SecondConfirmNotice lines={built.summary.warnings.map((w) => evmWarningText(w, nativeAsset, asset.kind === 'erc20' ? asset : undefined))} />
          )}
          {built?.unsigned.family === 'xrp' && <XrpSummaryView u={built.unsigned} xrpPrice={nativePrice} currency={cur} />}
          {built?.unsigned.family === 'xlm' && <StellarSummaryView u={built.unsigned} xlmPrice={nativePrice} currency={cur} />}
          {built?.unsigned.family === 'dot' && <DotSummaryView u={built.unsigned} price={nativePrice} currency={cur} />}
          {built?.unsigned.family === 'algo' && <AlgoSummaryView u={built.unsigned} algoPrice={nativePrice} currency={cur} />}
          {built?.unsigned.family === 'algo' && built.unsigned.summary.requiresExtraConfirmation && <SecondConfirmNotice lines={built.unsigned.summary.warnings.map((w) => (w.kind === 'note' ? 'La transaction porte une note, lisible par tous et pour toujours.' : w.kind === 'highFee' ? 'Frais supérieurs à 0,01 ALGO.' : w.kind === 'binaryNote' ? 'La note n’est pas du texte.' : 'La note contient des caractères invisibles ou de contrôle.'))} />}
          {built?.unsigned.family === 'ada' && <CardanoSummaryView u={built.unsigned} adaPrice={nativePrice} currency={cur} />}
          {built?.unsigned.family === 'near' && <NearSummaryView u={built.unsigned} nearPrice={nativePrice} currency={cur} />}
          {built?.unsigned.family === 'sui' && <SuiSummaryView u={built.unsigned} suiPrice={nativePrice} currency={cur} />}
          {built?.unsigned.family === 'hbar' && <HbarSummaryView u={built.unsigned} hbarPrice={nativePrice} currency={cur} />}
          {built?.unsigned.family === 'kas' && <KaspaSummaryView u={built.unsigned} kasPrice={nativePrice} currency={cur} />}
          {built?.unsigned.family === 'kas' && built.unsigned.summary.requiresExtraConfirmation && (
            <SecondConfirmNotice lines={built.unsigned.summary.warnings.map((w) => (w.kind === 'highFee' ? 'Frais élevés (réseau chargé, ou plus de 10 fois le minimum de relais)' : `Sortie ${w.index} : script inconnu`))} />
          )}
          {built?.unsigned.family === 'xmr' && <XmrSummaryView u={built.unsigned} xmrPrice={nativePrice} currency={cur} />}

          {building && (
            <span className="flex items-center gap-2 text-[12px] text-mute">
              <Spinner /> {t('send.preparing')}
            </span>
          )}
          {buildError && (serverMissing(buildError) ? <ServerMissingLine coin={asset.name} /> : serverDown(buildError) ? <ServerDownLine /> : <Notice tone="error">{buildError}</Notice>)}
          {built && addrValid && sendAmount !== null && built.unsigned.family === 'tron' && (
            <EnClair tone={tronShort ? 'warn' : 'ice'}>
              {rt('send.clearTron', { b: (c) => <strong>{c}</strong> }, {
                amount: fmtCrypto(sendAmount, decimals, asset.symbol),
                recipient: recipientName,
                burn: fmtCrypto(BigInt(built.unsigned.estimate.totalBurn), 6, 'TRX', 6),
                burnMax: fmtCrypto(BigInt(built.unsigned.estimate.totalBurnMax), 6, 'TRX', 6),
                fiat: feeFiat !== null ? ` (${fmtFiat(feeFiat, cur)})` : '',
              })}
              {!built.unsigned.estimate.recipientExists ? t('send.clearTronActivation') : ''}
              {tronShort ? t('send.clearTronShort') : ''}
            </EnClair>
          )}
          {built && addrValid && sendAmount !== null && built.unsigned.family === 'xrp' && (
            <EnClair tone={built.unsigned.summary.destinationTag === null ? 'warn' : 'ice'}>
              {rt(built.unsigned.summary.destinationTag !== null ? 'send.clearXrpTag' : 'send.clearXrpNoTag', { b: (c) => <strong>{c}</strong>, tag: (c) => <strong className="font-mono">{c}</strong> }, {
                amount: fmtCrypto(sendAmount, decimals, asset.symbol),
                recipient: recipientName,
                tag: String(built.unsigned.summary.destinationTag ?? ''),
                fee: fmtCrypto(built.unsigned.maxFee, 6, 'XRP', 6),
              })}
              {!built.unsigned.context.destination.exists ? t('send.clearXrpCreates') : ''}
              {built.unsigned.summary.destinationTag === null ? t('send.clearXrpCheckTag') : ''}
            </EnClair>
          )}
          {built && addrValid && sendAmount !== null && built.unsigned.family === 'xlm' && (
            <EnClair tone={built.unsigned.summary.memo.kind === 'none' ? 'warn' : 'ice'}>
              {rt(built.unsigned.memo ? 'send.clearXlmMemo' : 'send.clearXlmNoMemo', { b: (c) => <strong>{c}</strong>, memo: (c) => <strong className="font-mono">{c}</strong> }, {
                amount: fmtCrypto(sendAmount, decimals, asset.symbol),
                recipient: recipientName,
                memo: built.unsigned.memo?.value ?? '',
                fee: fmtCrypto(built.unsigned.maxFee, 7, 'XLM', 7),
              })}
              {built.unsigned.createsAccount ? t('send.clearXlmCreates') : ''}
              {built.unsigned.summary.memo.kind === 'none' ? t('send.clearXlmCheckMemo') : ''}
            </EnClair>
          )}
          {built && addrValid && sendAmount !== null && built.unsigned.family === 'near' && (
            <EnClair tone={built.unsigned.summary.requiresExtraConfirmation || built.unsigned.context.createsAccount ? 'warn' : 'ice'}>
              Tu envoies <strong>{fmtCrypto(sendAmount, decimals, asset.symbol)}</strong> à <strong>{recipientName}</strong>. Frais : environ {fmtCrypto(BigInt(built.unsigned.context.feeEstimate), 24, 'NEAR', 6)}, au plus {fmtCrypto(built.unsigned.maxFee, 24, 'NEAR', 6)}
              {feeFiat !== null ? ` (${fmtFiat(feeFiat, cur)})` : ''}.
              {built.unsigned.context.createsAccount ? ' Ce compte implicite n’existe pas encore : ce transfert le crée.' : ''}
              {built.unsigned.summary.requiresExtraConfirmation ? ' Compte de style Ethereum : une 2ᵉ confirmation te sera demandée.' : ''}
            </EnClair>
          )}
          {built && addrValid && sendAmount !== null && built.unsigned.family === 'dot' && (
            <EnClair>
              Tu envoies <strong>{fmtCrypto(sendAmount, decimals, asset.symbol)}</strong> à <strong>{recipientName}</strong> avec Balances.transfer_keep_alive : ton compte garde au moins son dépôt existentiel. Frais estimés : {fmtCrypto(built.unsigned.maxFee, decimals, asset.symbol)}{feeFiat !== null ? ` (${fmtFiat(feeFiat, cur)})` : ''}.
              {!built.unsigned.context.destination.exists ? ' Ce transfert crée le compte du destinataire.' : ''}
            </EnClair>
          )}
          {built && addrValid && built.unsigned.family === 'ada' && (
            <EnClair tone={built.unsigned.summary.requiresExtraConfirmation ? 'warn' : 'ice'}>
              {rt('send.clearAda', { b: (c) => <strong>{c}</strong> }, {
                what: built.unsigned.token && adaToken ? `${built.unsigned.token.quantity} ${cardanoTokenLabel(adaToken)} + ${fmtCrypto(built.unsigned.amount, 6, 'ADA')} (min-ADA)` : fmtCrypto(built.unsigned.amount, 6, 'ADA'),
                recipient: recipientName,
                fee: fmtCrypto(built.unsigned.maxFee, 6, 'ADA'),
                leaving: fmtCrypto(BigInt(built.unsigned.context.leaving), 6, 'ADA'),
              })}
              {built.unsigned.summary.memo ? t('send.clearAdaMemo') : ''}
              {built.unsigned.summary.warnings.some((w) => w.kind === 'unknownToken') ? t('send.clearAdaUnverified') : ''}
            </EnClair>
          )}
          {built && addrValid && built.unsigned.family === 'sui' && (
            <EnClair tone={built.unsigned.all ? 'warn' : 'ice'}>
              Tu envoies{' '}
              <strong>{built.unsigned.all ? `tout ton solde SUI${built.unsigned.context.receives ? ` (≈ ${fmtCrypto(BigInt(built.unsigned.context.receives), 9, 'SUI')} reçus)` : ''}` : fmtCrypto(built.unsigned.amount, 9, 'SUI')}</strong> à <strong>{recipientName}</strong>. Gaz : ≈ {fmtCrypto(BigInt(built.unsigned.context.fee) > 0n ? BigInt(built.unsigned.context.fee) : 0n, 9, 'SUI')} selon la simulation, au plus {fmtCrypto(built.unsigned.maxFee, 9, 'SUI')}.
              {built.unsigned.all ? ' Il ne restera aucun SUI sur ce compte : une 2ᵉ confirmation te sera demandée.' : ''}
            </EnClair>
          )}
          {built && addrValid && built.unsigned.family === 'xmr' && (
            <EnClair tone={built.unsigned.summary.requiresExtraConfirmation ? 'warn' : 'ice'}>
              {rt('send.clearXmr', { b: (c) => <strong>{c}</strong> }, { amount: fmtCrypto(built.unsigned.amount, 12, 'XMR'), recipient: recipientName, fee: fmtCrypto(built.unsigned.maxFee, 12, 'XMR'), change: fmtCrypto(BigInt(built.unsigned.summary.change), 12, 'XMR') })}
            </EnClair>
          )}
          {built && addrValid && sendAmount !== null && built.unsigned.family === 'algo' && (
            <EnClair tone={built.unsigned.summary.requiresExtraConfirmation ? 'warn' : 'ice'}>
              {rt('send.clearAlgo', { b: (c) => <strong>{c}</strong> }, { amount: fmtCrypto(sendAmount, decimals, asset.symbol), recipient: recipientName, fee: fmtCrypto(built.unsigned.maxFee, 6, 'ALGO', 6) })}
              {!built.unsigned.context.destination.exists ? t('send.clearAlgoCreates') : ''}
              {built.unsigned.summary.noteLen > 0 ? t('send.clearAlgoNote') : ''}
            </EnClair>
          )}
          {built && addrValid && sendAmount !== null && built.unsigned.family === 'kas' && (
            <EnClair tone={built.unsigned.summary.requiresExtraConfirmation ? 'warn' : 'ice'}>
              {rt('send.clearKas', { b: (c) => <strong>{c}</strong> }, { amount: fmtCrypto(sendAmount, decimals, asset.symbol), recipient: recipientName, fee: fmtCrypto(built.unsigned.maxFee, 8, 'KAS', 8), fiat: feeFiat !== null ? ` (${fmtFiat(feeFiat, cur)})` : '' })}
              {built.unsigned.summary.hasChange ? t('send.clearKasChange') : t('send.clearKasNoChange')}
            </EnClair>
          )}
          {built && addrValid && sendAmount !== null && built.unsigned.family === 'hbar' && (
            <EnClair tone={built.unsigned.summary.memo === null ? 'warn' : 'ice'}>
              Tu envoies <strong>{fmtCrypto(sendAmount, decimals, asset.symbol)}</strong> à <strong>{recipientName}</strong>
              {built.unsigned.summary.memo !== null ? (
                <>
                  {' '}avec le mémo <strong className="font-mono">« {built.unsigned.summary.memo} »</strong>
                </>
              ) : (
                ', sans mémo'
              )}
              . Frais maximum : {fmtCrypto(built.unsigned.maxFee, 8, 'HBAR', 8)} (≈ 0,0001 $ réellement prélevés).
              {built.unsigned.context.createsAccount ? ' Ce transfert crée le compte du destinataire (≈ 0,05 $ de frais).' : ''}
              {built.unsigned.summary.memo === null ? ' Si c’est une plateforme d’échange, vérifie qu’elle ne t’a pas donné de mémo.' : ''}
            </EnClair>
          )}
          {built && addrValid && sendAmount !== null && built.unsigned.family !== 'tron' && built.unsigned.family !== 'xrp' && built.unsigned.family !== 'xlm' && built.unsigned.family !== 'ada' && built.unsigned.family !== 'near' && built.unsigned.family !== 'sui' && built.unsigned.family !== 'hbar' && built.unsigned.family !== 'kas' && built.unsigned.family !== 'dot' && built.unsigned.family !== 'algo' && built.unsigned.family !== 'xmr' && (
            <EnClair>
              {rt('send.clearGeneric', { b: (c) => <strong>{c}</strong> }, {
                amount: fmtCrypto(sendAmount, decimals, asset.symbol),
                recipient: recipientName,
                change: utxoLike && built.unsigned.family === 'btc' && built.unsigned.summary.outputs.some((o) => o[2]) ? t('send.clearChange') : '',
                fee: feeFiat !== null ? fmtFiat(feeFiat, cur) : maxFee !== null && nativeAsset ? fmtCrypto(maxFee, nativeAsset.decimals, nativeAsset.symbol) : '—',
                custom: choice === 'custom' ? t('send.clearCustom') : '',
              })}
              {rent > 0n && nativeAsset ? t('send.clearRent', { rent: fmtCrypto(rent, nativeAsset.decimals, nativeAsset.symbol) }) : ''}
              {'dustFolded' in built.unsigned && typeof built.unsigned.dustFolded === 'bigint' && built.unsigned.dustFolded > 0n
                ? t('send.clearDust', { amount: fmtCrypto(built.unsigned.dustFolded, decimals, asset.symbol) })
                : ''}
            </EnClair>
          )}
          {!built && !buildError && !building && <p className="m-0 text-[13px] leading-[1.5] text-mute">{!addrValid ? (xAddress ? t('send.hintXAddress') : t('send.hintRecipient')) : dogeBelowDust ? t('send.hintDogeDust') : kasBelowMin ? t('send.hintKasMin') : xlmMemoMissing ? t('send.hintXlmMemo') : xlmBelowActivation ? t('send.hintXlmActivation') : isXlm && !xlmDestInfo ? t('send.hintXrpReading') : xrpTagMissing ? t('send.hintXrpTag') : xrpBelowActivation ? t('send.hintXrpActivation') : isXrp && !xrpDestInfo ? t('send.hintXrpReading') : dotBelowEd ? t('send.hintDotBelowEd') : algoBelowMinimum ? t('send.hintAlgoBelowMin') : isAlgo && algoMe.data?.authAddr ? t('send.hintAlgoRekeyed') : isAlgo && !algoDestInfo ? t('send.hintXrpReading') : isDot && !dotDestInfo ? t('send.hintXrpReading') : isNear && nearRecvInfo && nearReceiverBlocked(toTrim, nearRecvInfo) ? t('send.hintNearNoReceiver') : isNear && !nearRecvInfo ? t('send.hintXrpReading') : isHbar && hbarMe.data?.exists === false ? t('send.hintHbarNoAccount') : isHbar && hbarProblem ? t('send.hintHbarRefused') : isHbar && !hbarDestInfo ? t('send.hintXrpReading') : isXmr ? (!xmrSynced ? t('send.hintXmrScanning') : t('send.hintXmrPrepare')) : t('send.hintAmount')}</p>}

          {blindSigning && activeHw && (
            <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
              {rt('send.blind', { b: (c) => <strong className="font-semibold">{c}</strong> }, { device: BRAND[activeHw.device] })}
              {activeHw.device === 'ledger' ? t('send.blindLedger') : ''}
            </Notice>
          )}

          <div className="flex-1" />
          {activeHw ? (
            <div className="flex items-center gap-2 rounded-ctl border border-line bg-bg px-3.5 py-2.5 text-[12px] text-mute">
              <DeviceBadge device={activeHw.device} model={activeHw.model} />
              <span>{t('send.hwNoPassword')}</span>
            </div>
          ) : (
            <PasswordField id="send-pw" value={password} onChange={setPassword} onEnter={() => canSign && void sign()} />
          )}
          {signing && activeHw && hwDevice && (
            <HwWaiting
              deviceId={hwDevice}
              idle={t('send.hwChecking')}
              confirm={{ title: t('send.hwConfirmTitle'), detail: t('send.hwConfirmDetail') }}
            />
          )}
          {hwError !== null && <HwErrorNotice error={hwError} onRetry={() => void sign()} />}
          {signError && (serverDown(signError) ? <ServerDownLine /> : <Notice tone="error">{signError}</Notice>)}
          <Button variant="primary" size="xl" disabled={!canSign} onClick={() => void sign()}>
            {signing && <Spinner />} {activeHw ? t('send.signHw') : t('send.sign')}
          </Button>
          <span className="text-center text-[11px] leading-[1.5] text-faint">
            {activeHw ? t('send.footHw') : t('send.foot')}
          </span>
        </aside>
      </div>
    </div>
  );
}

function safeCost(p: FeeParams, size: NonNullable<AnyUnsigned['size']>): bigint | null {
  try {
    return feeCost(p, size);
  } catch {
    return null;
  }
}

function trimNum(s: string): string {
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return String(n >= 10 ? Math.ceil(n) : Math.ceil(n * 100) / 100).replace('.', decimalSep());
}

function dataLabel(b: Built | null, family?: string): string {
  if (!b) return '—';
  const u = b.unsigned;
  if (u.family === 'btc') {
    const outs = u.summary.outputs.length;
    // Dogecoin, Bitcoin Cash and Dash have no SegWit: bytes, not vbytes.
    return `${tp('send.dataOutputs', outs)} · ${u.size.family === 'btc' ? u.size.vsize : '?'} ${family === 'doge' || family === 'bch' || family === 'dash' ? t('send.dataBytes') : 'vB'}`;
  }
  if (u.family === 'ada') return `${tp('send.dataInputs', u.summary.inputs.length)} · ${t('send.dataAdaOutputs', { n: u.summary.outputs.length })}${u.token ? ' · token' : ''}`;
  if (u.family === 'xmr') return `${u.summary.inputCount} entrée${u.summary.inputCount > 1 ? 's' : ''} · anneaux de ${u.summary.ringSize} · 2 sorties${u.summary.memo ? ` · ${t('send.dataMessage')}` : ''}`;
  if (u.family === 'algo') return `pay${u.summary.noteLen > 0 ? ` · ${t('send.dataAlgoNote', { n: u.summary.noteLen })}` : ''}`;
  if (u.family === 'dot') return `transfer_keep_alive · nonce ${u.summary.nonce}`;
  if (u.family === 'kas') return `${tp('send.dataInputs', u.summary.inputs)} · ${tp('send.dataOutputs', u.summary.outputs.length)} · ${u.summary.mass.total} g`;
  if (u.family === 'hbar') return `CryptoTransfer · ${u.summary.memo !== null ? t('send.dataMemo') : t('send.dataNoMemo')} · ${t('send.dataHbarNodes', { n: u.summary.nodes.length })}`;
  if (u.family === 'sui') return u.all ? t('send.dataSuiAll') : 'SplitCoins + TransferObjects';
  if (u.family === 'near') return `Transfer · nonce ${u.summary.nonce}${u.context.createsAccount ? ` · ${t('send.dataNearCreates')}` : ''}`;
  if (u.family === 'xlm') return `${u.createsAccount ? 'CreateAccount' : 'Payment'}${u.memo ? ` · ${t('send.dataXlmMemo', { kind: u.memo.kind === 'id' ? t('send.dataXlmMemoId') : u.memo.kind })}` : ` · ${t('send.dataNoMemo')}`}`;
  if (u.family === 'xrp') return `Payment${u.summary.destinationTag !== null ? ` · tag ${u.summary.destinationTag}` : ` · ${t('send.dataNoTag')}`}`;
  if (u.family === 'tron') return u.token ? t('send.dataTronToken', { n: u.size.bandwidth }) : t('send.dataTronNative', { n: u.size.bandwidth });
  if (u.family === 'sol') return u.mint ? `TransferChecked ${u.tokenProgram === 'token2022' ? 'Token-2022' : 'SPL'}${u.createsAta ? t('send.dataAtaCreate') : ''}` : t('send.dataSystemTransfer');
  if (b.summary?.kind === 'NativeTransfer') return t('send.dataSimpleTransfer');
  if (b.summary?.kind === 'Erc20Transfer') return 'transfer() ERC-20';
  return b.summary?.kind ?? t('send.dataContractCall');
}

function Step({ n, done, current, label }: { n: number; done: boolean; current: boolean; label: string }) {
  return (
    <li aria-current={current ? 'step' : undefined} className={cn('flex h-8 items-center gap-2 transition-colors duration-200', current ? 'font-medium text-text' : done ? 'text-text2' : 'text-faint')}>
      <span className={cn('flex size-5 items-center justify-center rounded-[4px] border font-mono text-[10.5px] transition-colors duration-200', done ? 'border-up/40 text-up' : current ? 'border-ice bg-ice text-on-primary' : 'border-line-3 text-faint')}>
        <span key={done ? 'done' : 'n'} className="pop-in">{done ? '✓' : n}</span>
      </span>
      {label}
    </li>
  );
}

function FeeOption({ active, onClick, title, sub, ice, disabled }: { active: boolean; onClick: () => void; title: string; sub: string; ice?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      onClick={onClick}
      className={cn('press flex h-14 flex-1 basis-0 flex-col items-start justify-center gap-0.5 rounded-box border px-3.5 text-left disabled:opacity-50', active ? 'border-ice bg-ice/[.07] shadow-[inset_0_0_0_0.5px_var(--color-ice)]' : 'border-line-2 bg-bg hover:border-line-3 hover:bg-raised/50')}
    >
      <span className="truncate text-[13px] font-medium">{title}</span>
      <span className={cn('text-[11px]', active && ice ? 'text-ice-text2' : 'text-mute')}>{sub}</span>
    </button>
  );
}

function UnitField({ label, unit, value, onChange, decimals = 9, wide }: { label: string; unit: string; value: string; onChange: (v: string) => void; decimals?: number; wide?: boolean }) {
  return (
    <label className="flex flex-col gap-1.5 text-[12px] text-mute">
      {label}
      <span className={cn('flex h-[42px] items-center gap-2 rounded-ctl border border-line-3 bg-bg px-3 focus-within:border-ice-line', wide ? 'w-[210px]' : 'w-[170px]')}>
        <input type="text" inputMode="decimal" value={value} onChange={(e) => onChange(decimals === 0 ? e.target.value : sanitizeDecimalInput(e.target.value, decimals))} className="w-full min-w-0 bg-transparent text-[16px] font-medium text-text" />
        <span className="shrink-0 text-[13px] text-mute">{unit}</span>
      </span>
    </label>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex h-9 items-center justify-between gap-3 border-b border-line">
      <dt className="text-mute">{k}</dt>
      <dd className="m-0 truncate text-right">{v}</dd>
    </div>
  );
}

function SendDone({ id, asset, amount, what, to, contactKnown, onBack, onHistory, children }: { id: string; asset: AssetDef; amount: bigint; what?: string; to: string; contactKnown: boolean; onBack: () => void; onHistory: () => void; children?: ReactNode }) {
  const { t } = useT();
  const [name, setName] = useState('');
  const [saved, setSaved] = useState(false);
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="rise flex w-[520px] flex-col items-center gap-5 rounded-panel border border-line bg-card px-8 py-9 text-center">
        <span className="dialog flex size-14 items-center justify-center rounded-full border border-up/40 text-up" data-state="open">
          <IconCheck size={26} />
        </span>
        <h1 className="m-0 text-[28px] font-[560] tracking-[-0.035em]">{t('send.doneTitle')}</h1>
        <p className="m-0 text-[14px] leading-[1.6] text-mute">
          {t('send.doneBody', { what: what ?? fmtCrypto(amount, asset.decimals, asset.symbol), to: shortAddress(to) })}
        </p>
        <div className="flex w-full items-center justify-between gap-2 rounded-ctl border border-line bg-bg py-2 pr-2 pl-3.5">
          <span className="truncate font-mono text-[12px] text-text2">{id}</span>
          <CopyButton text={id} />
        </div>
        {children}
        {!contactKnown && !saved && (
          <div className="flex w-full items-center gap-2">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('send.doneContactName')} className="h-10 min-w-0 flex-1 rounded-ctl border border-line-2 bg-bg px-3 text-[13px] focus:border-ice-line" />
            <Button
              size="md"
              disabled={!name.trim()}
              onClick={() => {
                saveContacts([...getContacts(), { id: crypto.randomUUID(), name: name.trim(), address: to, family: asset.family as ContactFamily, sends: 1 }]);
                setSaved(true);
              }}
            >
              {t('common.save')}
            </Button>
          </div>
        )}
        <div className="flex gap-2">
          <Button variant="primary" size="lg" onClick={onHistory}>
            {t('send.doneViewHistory')}
          </Button>
          <Button size="lg" onClick={onBack}>
            {t('common.back')}
          </Button>
        </div>
      </div>
    </div>
  );
}
