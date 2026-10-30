// SPDX-License-Identifier: GPL-3.0-or-later
// Send: recipient with clipboard guard + 4-char blocks, amount + MAX,
// fees slow/normal/fast/custom, recap decoded by the Rust core, password.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toIpcError, type EvmTxSummary, type SolTxSummary } from '@kyro/shared';
import {
  assetsFor,
  checkSolSummary,
  feeCost,
  findChain,
  isXAddress,
  parseDestinationTag,
  cardanoAddressProblem,
  cardanoTokenLabel,
  classifyHistoryAddresses,
  findLookalike,
  isDustOnlyAddress,
  type KnownAddress,
  DOGE_SOFT_DUST,
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
} from '@kyro/chains';
import { useApp, useVault } from '../state/app';
import { usePortfolio } from '../state/portfolio';
import { cn } from '../lib/cn';
import { fmtCrypto, fmtEta, fmtFiat, sanitizeDecimalInput, shortAddress, toInputDecimal } from '../lib/format';
import { guardAllowsSend, guardOnInput, guardVerify, initialGuard, type GuardState } from '../lib/clipboardGuard';
import { addLocalTx, bumpContactSends, findContact, getContacts, saveContacts, type ContactFamily } from '../lib/storage';
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
import { CardanoSendFields, CardanoSummaryView, CardanoTxStatusLine, tokenKey } from '../components/Cardano';
import { DustOnlyNote, PoisoningWarning } from '../components/Poisoning';
import { SecondConfirmNotice, btcWarningText, evmWarningText } from '../components/SecondConfirm';
import { useHistory } from '../state/history';
import { Menu } from '../components/ui/menu';
import { Button, IconButton, Notice, Spinner } from '../components/ui/primitives';
import { IconBack, IconCheck, IconChevronDown, IconLock, IconShield, IconUpDown, IconWarn } from '../components/icons';

type Built = { unsigned: AnyUnsigned; summary: EvmTxSummary | null; sol: SolTxSummary | null; key: string };

function adapterFor(asset: AssetDef, adapters: ReturnType<typeof useVault>['adapters']): AnyAdapter | undefined {
  if (asset.family === 'btc') return adapters.btc ?? undefined;
  if (asset.family === 'sol') return adapters.sol ?? undefined;
  if (asset.family === 'ltc') return adapters.ltc ?? undefined;
  if (asset.family === 'doge') return adapters.doge ?? undefined;
  if (asset.family === 'tron') return adapters.tron ?? undefined;
  if (asset.family === 'xrp') return adapters.xrp ?? undefined;
  if (asset.family === 'ada') return adapters.cardano ?? undefined;
  return adapters.evm.get(asset.chainKey);
}

const LEVELS: Array<{ level: FeeLevel; label: string }> = [
  { level: 'slow', label: 'Lent' },
  { level: 'normal', label: 'Normal' },
  { level: 'fast', label: 'Rapide' },
];

export function Send({ assetId, to: initialTo }: { assetId?: string; to?: string }) {
  const { back, settings, navigate, hideBalances } = useApp();
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
  const nativePrice = nativeAsset ? pf.price(nativeAsset.coingeckoId)?.price ?? null : null;

  // Recipient + clipboard guard.
  const [to, setTo] = useState(initialTo ?? '');
  const [guard, setGuard] = useState<GuardState>(initialTo ? { pasted: initialTo, tampered: false, source: 'paste' } : initialGuard);
  const toRef = useRef<HTMLInputElement>(null);
  const toTrim = to.trim();
  const addrValid = !!adapter && toTrim.length > 0 && adapter.isValidAddress(toTrim);
  const contact = asset && addrValid ? findContact(toTrim, asset.family as ContactFamily) : undefined;
  const ownAddresses = [accounts.btc?.segwit.address, accounts.btc?.taproot.address, accounts.evm?.address.toLowerCase(), accounts.sol?.address, accounts.tron?.address, accounts.xrp?.address, accounts.cardano?.address].filter((a): a is string => !!a);
  const isOwn = ownAddresses.includes(asset?.family === 'evm' ? toTrim.toLowerCase() : toTrim);
  const noChecksum = asset?.family === 'evm' && addrValid && toTrim.slice(2) === toTrim.slice(2).toLowerCase();

  // Address poisoning: compare the recipient with every trusted address of this chain family
  // (address book, own addresses, real past counterparties). Senders of incoming dust or
  // zero-value transfers are suspects, never references (see packages/chains/src/poisoning.ts).
  const history = useHistory();
  const poisoning = useMemo(() => {
    if (!asset || !addrValid) return { lookalike: null, dustOnly: false };
    const family = asset.family;
    const own: Record<string, Array<string | undefined>> = {
      btc: [accounts.btc?.segwit.address, accounts.btc?.taproot.address],
      evm: [accounts.evm?.address],
      sol: [accounts.sol?.address],
      ltc: [accounts.ltc?.address],
      doge: [accounts.doge?.address],
      tron: [accounts.tron?.address],
      xrp: [accounts.xrp?.address],
      ada: [accounts.cardano?.address],
    };
    const events = (history.data?.entries ?? [])
      .filter((e) => e.asset?.family === family && e.counterparty)
      .map((e) => {
        const p = e.asset ? pf.price(e.asset.coingeckoId)?.price ?? null : null;
        const fiat = p !== null && e.asset ? unitsToNumber(e.amount, e.asset.decimals) * p : null;
        return { counterparty: e.counterparty!, direction: e.direction, dust: e.direction === 'in' && (e.amount === 0n || (fiat !== null && fiat < 0.01)) };
      });
    const { trusted, dustOnly } = classifyHistoryAddresses(events, family);
    const known: KnownAddress[] = [
      ...getContacts()
        .filter((c) => c.family === family)
        .map((c) => ({ address: c.address, source: 'contact' as const, label: c.name })),
      ...(own[family] ?? []).filter((a): a is string => !!a).map((address) => ({ address, source: 'own' as const, label: 'ton adresse' })),
      ...trusted.map((address) => ({ address, source: 'history' as const })),
    ];
    return { lookalike: findLookalike(toTrim, known, family), dustOnly: isDustOnlyAddress(toTrim, dustOnly, family) };
  }, [asset, addrValid, toTrim, accounts, history.data, pf]);
  const [poisonAck, setPoisonAck] = useState(false);
  useEffect(() => setPoisonAck(false), [toTrim, asset?.id]);
  const poisonBlocked = !!poisoning.lookalike && !poisonAck;

  // Amount.
  const [amountStr, setAmountStr] = useState('');
  const [fiatMode, setFiatMode] = useState(false);
  const [max, setMax] = useState(false);
  const decimals = asset?.decimals ?? 18;
  /** Litecoin / Dogecoin: Bitcoin-style UTXO chains (same fee field, PSBT, change). */
  const utxoLike = asset?.family === 'btc' || asset?.family === 'ltc' || asset?.family === 'doge';
  const rateUnit = asset?.family === 'ltc' ? 'litoshi/vB' : asset?.family === 'doge' ? 'koinus/octet' : 'sat/vB';
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
  const amountBase = useMemo(() => {
    if (!amountStr) return null;
    if (fiatMode) {
      const f = Number(amountStr.replace(',', '.'));
      if (!price || !Number.isFinite(f) || f <= 0) return null;
      return tryParseUnits((f / price).toFixed(Math.min(decimals, 12)), decimals);
    }
    return tryParseUnits(amountStr, decimals);
  }, [amountStr, fiatMode, price, decimals]);
  // XRP: a new account needs at least the base reserve (1 XRP), else tecNO_DST_INSUF_XRP.
  const xrpBelowActivation = isXrp && !!xrpDestInfo && !xrpDestInfo.exists && !max && amountBase !== null && amountBase > 0n && amountBase < XRP_ACTIVATION;
  const xrpTagMissing = isXrp && !!xrpDestInfo?.requireDestTag && tagParsed.tag === undefined;
  /** XRP: everything that must be right before Rust is even asked to build. */
  const xrpBlocked = isXrp && (!xrpDestInfo || !!tagParsed.error || xrpTagMissing || xrpBelowActivation);
  // Dogecoin dust (Dogecoin Core policy): no output under 0.01 DOGE.
  const dogeBelowDust = asset?.family === 'doge' && amountBase !== null && amountBase > 0n && amountBase < DOGE_SOFT_DUST && !max;

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
    return validateSolPriorityFee(customSol);
  }, [choice, asset, customEvm, customBtc, customSol, fees.data]);
  const feeParams: FeeParams | null = choice === 'custom' ? custom?.params ?? null : fees.data?.options[choice].params ?? null;

  // Build (debounced) → unsigned tx + Rust decoding for EVM.
  const buildKey = useDebounced(JSON.stringify([asset?.id, toTrim, amountBase?.toString(), max, feeParams, addrValid, isXrp ? tagStr : null, xrpBlocked, isAda ? [tokenSel, tokenQty, memo.trim(), adaBlocked] : null], (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)), 450);
  const [built, setBuilt] = useState<Built | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  // XRP: what can be sent is the spendable part (balance − reserve), not the balance.
  const xrpSpendable = isXrp && xrpMe.data ? BigInt(xrpMe.data.spendable) : null;
  const overBalance = !max && amountBase !== null && amountBase > (xrpSpendable ?? balance);

  const doBuild = async (): Promise<Built> => {
    if (!asset || !adapter || !feeParams) throw new Error('Paramètres incomplets');
    const tag = isXrp && tagParsed.tag !== undefined ? { destinationTag: tagParsed.tag } : {};
    const ada = isAda ? { ...(adaToken && adaTokenQty !== null ? { cardanoToken: { policy: adaToken.policy, name: adaToken.name, quantity: adaTokenQty.toString() } } : {}), ...(memo.trim() ? { memo: memo.trim() } : {}) } : {};
    const unsigned = (await (adapter as { buildTx: (p: unknown) => Promise<AnyUnsigned> }).buildTx({ asset, to: toTrim, amount: amountBase ?? 0n, fee: feeParams, max: max && !adaTokenMode, ...tag, ...ada })) as AnyUnsigned;
    let summary: EvmTxSummary | null = null;
    if (unsigned.family === 'evm') {
      summary = await (adapter as EvmAdapter).decode(unsigned);
      const expectedTo = unsigned.recipient.toLowerCase();
      if (summary.to.toLowerCase() !== expectedTo || summary.amount !== unsigned.amount.toString()) {
        throw new Error('Le résumé décodé par le coffre ne correspond pas à ta saisie : envoi bloqué.');
      }
    }
    let sol: SolTxSummary | null = null;
    if (unsigned.family === 'sol') {
      // Solana: the recap comes from the Rust decoder only (sol_decode_tx).
      sol = await (adapter as SolanaAdapter).decode(unsigned);
      const problem = checkSolSummary(unsigned, sol, adapter.getAddress());
      if (problem) throw new Error(`${problem} Envoi bloqué.`);
    }
    return { unsigned, summary, sol, key: buildKey };
  };

  useEffect(() => {
    setBuilt(null);
    setBuildError(null);
    if (!addrValid || !feeParams || dogeBelowDust || xrpBlocked || adaBlocked) return;
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
  const [done, setDone] = useState<{ id: string } | null>(null);
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
      // Fresh build (nonce, blockhash) with the same inputs, re-decoded by Rust.
      const fresh = await doBuild();
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
      setDone({ id });
      pf.refresh();
    } catch (e) {
      const err = toIpcError(e);
      if (activeHw && (err.code.startsWith('HW_') || err.code === 'USER_REJECTED')) setHwError(e);
      else setSignError(err.code === 'USER_REJECTED' ? 'Signature annulée dans la fenêtre système. Rien n’a été envoyé.' : err.message);
    } finally {
      setSigning(false);
      setHwDevice(null);
    }
  };

  if (!asset || !adapter || !chain) {
    return (
      <div className="flex flex-1 items-center justify-center text-[14px] text-mute">
        <Spinner /> &nbsp;Chargement des comptes…
      </div>
    );
  }

  const recipientName = contact?.name ?? shortAddress(toTrim || '—');
  const step1 = addrValid;
  const step2 = !!built;

  if (done) {
    return (
      <SendDone
        id={done.id}
        asset={asset}
        amount={built?.unsigned.amount ?? 0n}
        {...(adaTokenMode && adaToken ? { what: `${tokenQty} ${cardanoTokenLabel(adaToken)} (+ ${fmtCrypto(built?.unsigned.amount ?? 0n, 6, 'ADA')} de min-ADA)` } : {})}
        to={toTrim}
        contactKnown={!!contact}
        onBack={back}
        onHistory={() => navigate({ name: 'history' })}
      >
        {xrpAdapter && <XrpTxStatusLine adapter={xrpAdapter} hash={done.id} recipient={toTrim} onValidated={pf.refresh} />}
        {adaAdapter && <CardanoTxStatusLine adapter={adaAdapter} hash={done.id} onConfirmed={pf.refresh} />}
      </SendDone>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 px-[26px] py-[22px]">
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <IconButton label="Retour au portefeuille" onClick={back} className="size-10 border-control-2">
            <IconBack size={16} />
          </IconButton>
          <h1 className="m-0 text-[28px] font-semibold tracking-[-0.03em]">Envoyer</h1>
        </div>
        <ol aria-label="Étapes" className="m-0 flex list-none items-center gap-2 p-0 text-[13px]">
          <Step n={1} done={step1} current={!step1} label="Destinataire" />
          <li aria-hidden="true" className="h-px w-[18px] bg-line-3" />
          <Step n={2} done={step2} current={step1 && !step2} label="Montant" />
          <li aria-hidden="true" className="h-px w-[18px] bg-line-3" />
          <Step n={3} done={false} current={step2} label="Vérifier et signer" />
        </ol>
      </header>

      <div className="flex min-h-0 flex-1 gap-4">
        <form onSubmit={(e) => e.preventDefault()} className="flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto rounded-panel border border-line bg-card px-[26px] py-6 scroll-thin">
          {/* From */}
          <div className="flex flex-col gap-2">
            <span className="text-[12px] font-medium text-mute">Depuis</span>
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
                setTokenSel('');
                setTokenQty('');
                setMemo('');
              }}
              className="w-[520px]"
              items={sendable.map((a) => ({
                value: a.id,
                label: `${a.name} · ${findChain(network, a.chainKey)?.label ?? ''}`,
                hint: `${fmtCrypto(pf.balances.get(a.id) ?? 0n, a.decimals, a.symbol)} disponibles`,
                icon: <CoinIcon glyph={a.glyph} color={a.color} size={26} />,
              }))}
              trigger={
                <button type="button" className="flex h-[60px] items-center gap-3 rounded-box border border-line-2 bg-raised px-4 text-left hover:border-ice-line">
                  <CoinIcon glyph={asset.glyph} color={asset.color} />
                  <span className="flex flex-1 flex-col">
                    <span className="text-[14px] font-semibold">
                      {asset.name} · {activeHw ? activeHw.label : 'Compte principal'}
                    </span>
                    <span className="text-[12px] text-mute">
                      {hideBalances ? '•••••' : fmtCrypto(balance, decimals, asset.symbol)} disponibles · {chain.name}
                    </span>
                  </span>
                  <IconChevronDown size={16} className="text-mute" />
                </button>
              }
            />
            {activeHw && <span className="text-[12px] text-faint">Litecoin, Dogecoin, TRON, XRP et Cardano : pas encore sur hardware wallet (ils restent disponibles dans le coffre Kyro).</span>}
            {fees.error && serverMissing(fees.error) && <ServerMissingLine coin={asset.name} />}
          </div>

          {/* To */}
          <div className="flex flex-col gap-2">
            <label htmlFor="dest" className="text-[12px] font-medium text-mute">
              À
            </label>
            <div className={cn('overflow-hidden rounded-box border bg-raised', guard.tampered && settings.clipboardGuard ? 'border-down/70' : addrValid ? 'border-ice-line' : 'border-line-2')}>
              <div className={cn('flex h-12 items-center gap-2.5 pr-2 pl-4', addrValid && 'border-b border-control-2')}>
                <input
                  id="dest"
                  ref={toRef}
                  type="text"
                  value={to}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={asset.family === 'btc' ? (network === 'testnet' ? 'tb1…' : 'bc1…') : asset.family === 'ltc' ? (network === 'testnet' ? 'tltc1…' : 'ltc1…') : asset.family === 'doge' ? (network === 'testnet' ? 'n…' : 'D…') : asset.family === 'tron' ? 'T…' : asset.family === 'xrp' ? 'r… (adresse classique)' : asset.family === 'ada' ? (network === 'testnet' ? 'addr_test1…' : 'addr1…') : asset.family === 'sol' ? 'Adresse Solana' : '0x…'}
                  onChange={(e) => {
                    const v = e.target.value;
                    setTo(v);
                    setGuard((g) => guardOnInput(g, v, (e.nativeEvent as InputEvent).inputType));
                  }}
                  className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-text2"
                />
                {guard.source === 'paste' && <span className="inline-flex h-7 items-center rounded-[8px] bg-control-2 px-2.5 text-[12px] text-text2">Collé</span>}
                {guard.source === 'typed' && <span className="inline-flex h-7 items-center rounded-[8px] bg-control-2 px-2.5 text-[12px] text-text2">Saisi</span>}
                <Menu
                  align="end"
                  label="Carnet d’adresses"
                  onSelect={(addr) => {
                    setTo(addr);
                    setGuard({ pasted: addr, tampered: false, source: 'paste' });
                  }}
                  items={getContacts()
                    .filter((c) => c.family === asset.family)
                    .map((c) => ({ value: c.address, label: c.name, hint: shortAddress(c.address) }))}
                  trigger={
                    <button type="button" className="h-7 rounded-[8px] px-2.5 text-[12px] font-medium text-ice hover:bg-control">
                      Carnet
                    </button>
                  }
                />
              </div>
              {addrValid && (
                <div className="flex flex-col gap-3 p-4">
                  <div className="flex items-center gap-2.5">
                    <span className="flex size-8 items-center justify-center rounded-full bg-ice-deep text-[13px] font-semibold text-ice-text">{(contact?.name ?? '?').slice(0, 1).toUpperCase()}</span>
                    <span className="flex flex-col">
                      <span className="text-[14px] font-semibold">{contact ? contact.name : isOwn ? 'Ton propre compte' : 'Adresse inconnue'}</span>
                      <span className="text-[12px] text-mute">{contact ? `Carnet d’adresses · ${contact.sends ?? 0} envoi${(contact.sends ?? 0) > 1 ? 's' : ''}` : isOwn ? 'Cette adresse appartient à ce coffre' : 'Première fois : compare chaque bloc avec ton destinataire'}</span>
                    </span>
                  </div>
                  <AddressBlocks address={toTrim} />
                  <div className="flex flex-wrap gap-[18px] text-[12px] font-medium">
                    {settings.clipboardGuard && guard.source === 'paste' && !guard.tampered && <span className="text-up">✓ Identique à ce que tu as collé</span>}
                    {guard.source === 'typed' && <span className="text-warn">Saisie manuelle : vérifie chaque bloc</span>}
                    {contact && <span className="text-up">✓ Adresse connue</span>}
                    {noChecksum && <span className="text-warn">Sans somme de contrôle EIP-55 (minuscules)</span>}
                    <span className="font-normal text-mute">Compare les blocs bleus {contact ? `avec ${contact.name}` : 'avec la source'}</span>
                  </div>
                </div>
              )}
            </div>
            {toTrim && !addrValid && !xAddress && !adaProblem && <span className="text-[12px] text-down">Adresse invalide pour {chain.name}.</span>}
            {adaProblem && <span className="text-[12px] text-down">{adaProblem.charAt(0).toUpperCase() + adaProblem.slice(1)}.</span>}
            {poisoning.lookalike && <PoisoningWarning recipient={toTrim} known={poisoning.lookalike.known} family={asset.family} acknowledged={poisonAck} onAcknowledge={setPoisonAck} />}
            {!poisoning.lookalike && poisoning.dustOnly && guard.source === 'paste' && <DustOnlyNote />}
            {xAddress && (
              <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
                <strong className="font-semibold">Adresse X (X… / T…) :</strong> elle contient l’adresse et le tag mélangés. Kyro veut l’adresse classique (r…) et le tag de destination séparément, pour que tu les voies tous les deux : demande-les à ton destinataire ou à ta plateforme (rubrique « dépôt XRP »).
              </Notice>
            )}
            {isXrp && <XrpTagField value={tagStr} onChange={setTagStr} error={tagParsed.error} dest={xrpDestInfo} destLoading={addrValid && xrpDest.loading && !xrpDestInfo} />}
            {isXrp && xrpDest.error && addrValid && <span className="text-[12px] text-down">Compte destinataire illisible : {xrpDest.error.message}</span>}
            {guard.tampered && settings.clipboardGuard && (
              <Notice tone="error" icon={<IconWarn size={16} className="mt-0.5 shrink-0" />}>
                L’adresse a changé après ton collage sans que tu tapes : envoi bloqué. Efface le champ et recolle l’adresse depuis une source sûre.
              </Notice>
            )}
          </div>

          {isAda && <CardanoSendFields account={adaMe.data} tokenSel={tokenSel} onTokenSel={(k) => { setTokenSel(k); setTokenQty(''); setMax(false); }} quantity={tokenQty} onQuantity={setTokenQty} memo={memo} onMemo={setMemo} />}
          {adaTokenOver && <span className="-mt-3 text-[12px] text-down">Quantité supérieure à ce que tu détiens.</span>}
          {adaTokenMode ? (
            <span className="-mt-2 text-[12px] leading-[1.45] text-mute">ADA envoyés avec le token : exactement le minimum obligatoire de sa sortie (min-ADA), calculé par le coffre et affiché dans la vérification.</span>
          ) : (
          <>
          {/* Amount */}
          <div className="flex flex-col gap-2">
            <div className="flex justify-between">
              <label htmlFor="amount" className="text-[12px] font-medium text-mute">
                Montant
              </label>
              <span className="text-[12px] text-mute">{after !== null && after >= 0n && !hideBalances ? `Solde après envoi : ${fmtCrypto(after, decimals, asset.symbol)}` : ''}</span>
            </div>
            <div className={cn('flex h-[72px] items-center gap-3 rounded-box border bg-raised pr-2.5 pl-[18px] focus-within:border-ice-line', overBalance ? 'border-down/60' : 'border-line-2')}>
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
                className="w-[200px] bg-transparent text-[34px] font-semibold tracking-[-0.02em]"
              />
              <span className="text-[16px] font-semibold text-mute">{fiatMode ? cur : asset.symbol}</span>
              <span className="flex-1 text-[14px] text-faint">
                {fiatMode ? (amountBase !== null ? `≈ ${fmtCrypto(amountBase, decimals, asset.symbol)}` : '') : amountFiat !== null ? `≈ ${fmtFiat(amountFiat, cur)}` : ''}
              </span>
              <button
                type="button"
                aria-label={fiatMode ? `Saisir en ${asset.symbol}` : `Saisir en ${cur}`}
                disabled={price === null}
                onClick={() => {
                  setFiatMode((f) => !f);
                  setAmountStr('');
                  setMax(false);
                }}
                className="flex size-10 items-center justify-center rounded-ctl bg-control-2 text-text2 hover:text-text disabled:opacity-40"
              >
                <IconUpDown size={16} />
              </button>
              <button type="button" onClick={() => setMax(true)} className={cn('h-10 rounded-ctl px-3.5 text-[12px] font-semibold', max ? 'bg-ice/16 text-ice-text' : 'bg-control-2 text-text hover:bg-control')}>
                MAX
              </button>
            </div>
            {overBalance && <span className="text-[12px] text-down">{isXrp ? 'Montant supérieur à ton solde dépensable (la réserve reste bloquée).' : 'Montant supérieur à ton solde.'}</span>}
            {isXrp && <XrpSpendable account={xrpMe.data} hidden={hideBalances} />}
            {isAda && adaMe.data && (
              <span className="text-[12px] leading-[1.45] text-mute">
                Solde : {hideBalances ? '•••••' : fmtCrypto(BigInt(adaMe.data.balance), 6, 'ADA')}
                {BigInt(adaMe.data.lockedWithTokens) > 0n ? ` (dont ${fmtCrypto(BigInt(adaMe.data.lockedWithTokens), 6, 'ADA')} liés à tes tokens par le min-ADA)` : ''}. Kyro garde toujours une sortie de monnaie à ton adresse : au moins ≈ 1 ADA (et tous tes tokens) restent.
              </span>
            )}
            {xrpBelowActivation && <span className="text-[12px] text-down">Ce compte n’existe pas encore : il faut lui envoyer au moins 1 XRP pour activer ce compte.</span>}
            {dogeBelowDust && <span className="text-[12px] text-down">Minimum 0,01 DOGE par destinataire : en dessous, Dogecoin considère la sortie comme de la poussière et Kyro la refuse.</span>}
            {asset.family === 'doge' && (
              <span className="text-[12px] leading-[1.5] text-mute">
                Dogecoin : un destinataire sous 0,01 DOGE est refusé ; une monnaie sous 0,01 DOGE n’est pas créée, elle est ajoutée aux frais (« Pas de monnaie… » dans la fenêtre de confirmation).
              </span>
            )}
            {asset.family === 'ltc' && (
              <span className="text-[12px] leading-[1.5] text-mute">
                Litecoin : un destinataire sous le seuil de poussière ({litecoinDust('p2wpkh').toString()} litoshis pour une adresse ltc1…) est refusé ; une monnaie plus petite est ajoutée aux frais.
              </span>
            )}
          </div>

          </>
          )}
          {/* Fees */}
          {isAda ? (
            <div className="flex flex-col gap-2">
              <span className="text-[12px] font-medium text-mute">Frais réseau</span>
              <div className="rounded-box border border-line-2 bg-raised px-4 py-3 text-[13px] leading-[1.5] text-text2">
                <strong className="font-semibold text-text">Rien à choisir sur Cardano.</strong> Les frais dépendent de la taille de la transaction (44 lovelace par octet + 0,155381 ADA) : d’habitude ≈ 0,17 ADA, un peu plus avec un token ou un message. Le coffre les calcule ; le montant exact est dans la vérification.
              </div>
            </div>
          ) : isXrp ? (
            <div className="flex flex-col gap-2">
              <span className="text-[12px] font-medium text-mute">Frais réseau</span>
              <div className="rounded-box border border-line-2 bg-raised px-4 py-3 text-[13px] leading-[1.5] text-text2">
                <strong className="font-semibold text-text">Rien à choisir sur le XRP Ledger.</strong> Le coffre fixe les frais du registre ouvert (d’habitude 10 à 12 drops, soit 0,000012 XRP) ; ils sont détruits, personne ne les reçoit.
              </div>
            </div>
          ) : isTron ? (
            <div className="flex flex-col gap-2">
              <span className="text-[12px] font-medium text-mute">Frais réseau</span>
              <div className="flex flex-col gap-1 rounded-box border border-line-2 bg-raised px-4 py-3 text-[13px] leading-[1.5] text-text2">
                <span>
                  <strong className="font-semibold text-text">Rien à choisir sur TRON.</strong> Chaque transaction consomme de la bande passante (octets) et, pour un token TRC-20, de l’énergie. Ce que ta bande passante gratuite ou tes TRX gelés ne couvrent pas est payé en TRX brûlés.
                </span>
                <span className="text-[12px] text-mute">Le coffre construit la transaction depuis le dernier bloc et simule l’énergie : le détail s’affiche dans la vérification, avant le mot de passe.</span>
              </div>
            </div>
          ) : (
          <div className="flex flex-col gap-2">
            <div className="flex justify-between">
              <span className="text-[12px] font-medium text-mute">Frais réseau</span>
              <span className="text-[12px] text-faint">{fees.data ? `Réseau actuel : ${fees.data.hint.replace('.', ',')}` : fees.error ? (feesTorBlocked ? 'En attente de Tor…' : serverMissing(fees.error) ? <span className="text-warn">Aucun serveur configuré</span> : serverDown(fees.error) ? <span className="text-warn">Ton serveur ne répond pas</span> : <span className="text-down">Frais indisponibles</span>) : 'Estimation…'}</span>
            </div>
            <div role="radiogroup" aria-label="Frais réseau" className="flex gap-2">
              {LEVELS.map(({ level, label }) => {
                const opt = fees.data?.options[level];
                const c = optionCost(opt?.params);
                const fiat = c !== null && nativeAsset && nativePrice !== null ? fmtFiat(unitsToNumber(c, nativeAsset.decimals) * nativePrice, cur) : c !== null && nativeAsset ? fmtCrypto(c, nativeAsset.decimals, nativeAsset.symbol) : null;
                return (
                  <FeeOption key={level} active={choice === level} onClick={() => setChoice(level)} title={`${label}${fiat ? ` · ${fiat}` : ''}`} sub={opt ? fmtEta(opt.etaSecs) : '…'} disabled={!opt} />
                );
              })}
              <FeeOption active={choice === 'custom'} onClick={() => setChoice('custom')} title="Personnalisé" sub={blockAverage ? 'suggéré' : 'tu choisis'} ice disabled={!fees.data} />
            </div>
            {blockAverage && (
              <span className="flex items-start gap-1.5 text-[12px] leading-[1.45] text-mute">
                <IconWarn size={13} className="mt-0.5 shrink-0 text-warn" />
                <span>
                  Mode filtres compacts : ces tarifs sont la moyenne des frais payés dans les derniers blocs, pas une estimation du mempool. Si c’est urgent ou que le réseau est chargé, choisis « Personnalisé » et fixe ton tarif.
                </span>
              </span>
            )}
            {choice === 'custom' && (
              <div className="flex items-end gap-3 rounded-box border border-ice-line bg-raised px-4 py-3.5">
                {asset.family === 'evm' && (
                  <>
                    <UnitField label="Frais max. par gas" unit="gwei" value={customEvm.maxFeeGwei} onChange={(v) => setCustomEvm((c) => ({ ...c, maxFeeGwei: v }))} />
                    <UnitField label="Pourboire prioritaire" unit="gwei" value={customEvm.priorityGwei} onChange={(v) => setCustomEvm((c) => ({ ...c, priorityGwei: v }))} />
                  </>
                )}
                {utxoLike && <UnitField label="Taux" unit={rateUnit} value={customBtc} onChange={setCustomBtc} decimals={asset.family === 'doge' ? 0 : 2} />}
                {asset.family === 'sol' && <UnitField label="Priority fee" unit="µL/CU" value={customSol} onChange={(v) => setCustomSol(v.replace(/\D/g, ''))} decimals={0} wide />}
                <span className="flex flex-1 flex-col items-end gap-0.5 pb-0.5">
                  <span className="text-[18px] font-semibold">{feeFiat !== null && choice === 'custom' && built ? fmtFiat(feeFiat, cur) : '—'}</span>
                  <span className="text-[12px] text-mute">{maxFee !== null && nativeAsset && built ? `${fmtCrypto(maxFee, nativeAsset.decimals, nativeAsset.symbol)} max.` : 'Coût recalculé en direct'}</span>
                </span>
              </div>
            )}
            {custom && custom.errors.map((e) => <span key={e} className="text-[12px] text-down">{e}</span>)}
            {custom && custom.warnings.map((w) => <span key={w} className="text-[12px] text-warn">{w}</span>)}
          </div>
          )}

          <div className="mt-auto flex items-center gap-3 rounded-box border border-control-2 bg-raised px-4 py-3 text-[13px] text-text2">
            <IconLock size={18} className="shrink-0 text-mute" />
            <span>{settings.clipboardGuard ? 'Le presse-papier est surveillé : si l’adresse change après ton collage, l’envoi est bloqué.' : 'Alerte presse-papier désactivée dans les réglages.'}</span>
          </div>
        </form>

        {/* Verification */}
        <aside aria-label="Vérification" className="flex w-[400px] shrink-0 flex-col gap-4 overflow-y-auto rounded-panel border border-line bg-card px-6 py-[22px] scroll-thin">
          <div className="flex items-center justify-between">
            <span className="text-[15px] font-semibold">Vérification</span>
            <span className="inline-flex h-[26px] items-center gap-1.5 rounded-full border border-control-2 bg-raised px-2.5 text-[11px] font-medium text-text2">
              <IconShield size={12} sw={2.2} className="text-ice" />
              {built?.summary || built?.sol || built?.unsigned.family === 'tron' || built?.unsigned.family === 'xrp' || built?.unsigned.family === 'ada' ? 'Décodé dans le coffre' : utxoLike ? 'PSBT vérifiée localement' : 'Résumé local'}
            </span>
          </div>
          <div className="flex flex-col items-center gap-1 pt-2 pb-1">
            <span className="text-[38px] font-semibold tracking-[-0.03em]">{sendAmount !== null && sendAmount > 0n ? fmtCrypto(sendAmount, decimals, asset.symbol) : `0 ${asset.symbol}`}</span>
            <span className="text-[13px] text-mute">{amountFiat !== null ? fmtFiat(amountFiat, cur) : '—'}</span>
          </div>
          <div className="flex items-center gap-2.5 rounded-box bg-raised px-3.5 py-3">
            <CoinIcon glyph={asset.glyph} color={asset.color} size={30} />
            <span className="flex flex-col text-[12px]">
              <span className="font-semibold">Toi</span>
              <span className="font-mono text-[11px] text-mute">{shortAddress(adapter.getAddress())}</span>
            </span>
            <span aria-hidden="true" className="relative h-0 flex-1 border-t-[1.5px] border-dashed border-ice-line">
              <span className="absolute -top-[7px] -right-0.5 text-[10px] text-ice">▶</span>
            </span>
            <span className="flex flex-col items-end text-[12px]">
              <span className="font-semibold">{addrValid ? (contact?.name ?? 'Destinataire') : '—'}</span>
              <span className="font-mono text-[11px] text-mute">{addrValid ? shortAddress(toTrim) : ''}</span>
            </span>
            <span className="flex size-[30px] items-center justify-center rounded-full bg-ice-deep text-[12px] font-semibold text-ice-text">{(contact?.name ?? '?').slice(0, 1).toUpperCase()}</span>
          </div>
          <dl className="m-0 flex flex-col text-[13px]">
            <Row k="Réseau" v={chain.name} />
            <Row
              k={isTron ? 'Brûlé max.' : 'Frais max.'}
              v={
                maxFee !== null && nativeAsset ? (
                  <>
                    {fmtCrypto(maxFee, nativeAsset.decimals, nativeAsset.symbol)}
                    {feeFiat !== null ? ` · ${fmtFiat(feeFiat, cur)}` : ''} {choice === 'custom' && <span className="text-ice-text2">· perso</span>}
                  </>
                ) : (
                  '—'
                )
              }
            />
            <Row k="Données" v={dataLabel(built, asset.family)} />
            <div className="flex h-[42px] items-center justify-between">
              <dt className="font-semibold">Total</dt>
              <dd className="m-0 text-[17px] font-semibold">{amountFiat !== null ? fmtFiat(amountFiat + (feeFiat ?? 0) + rentFiat, cur) : '—'}</dd>
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
          {built?.unsigned.family === 'ada' && <CardanoSummaryView u={built.unsigned} adaPrice={nativePrice} currency={cur} />}

          {building && (
            <span className="flex items-center gap-2 text-[12px] text-mute">
              <Spinner /> Préparation et décodage…
            </span>
          )}
          {buildError && (serverMissing(buildError) ? <ServerMissingLine coin={asset.name} /> : serverDown(buildError) ? <ServerDownLine /> : <Notice tone="error">{buildError}</Notice>)}
          {built && addrValid && sendAmount !== null && built.unsigned.family === 'tron' && (
            <EnClair tone={tronShort ? 'warn' : 'ice'}>
              Tu envoies <strong>{fmtCrypto(sendAmount, decimals, asset.symbol)}</strong> à <strong>{contact?.name ?? shortAddress(toTrim)}</strong>. TRON ne prend pas de frais fixes : cette transaction brûle environ{' '}
              <strong>{fmtCrypto(BigInt(built.unsigned.estimate.totalBurn), 6, 'TRX', 6)}</strong>, au plus {fmtCrypto(BigInt(built.unsigned.estimate.totalBurnMax), 6, 'TRX', 6)}
              {feeFiat !== null ? ` (${fmtFiat(feeFiat, cur)})` : ''}.
              {!built.unsigned.estimate.recipientExists ? ' Son compte n’existe pas encore : l’activer fait partie de ce brûlé.' : ''}
              {tronShort ? ' Ton solde TRX ne suffit pas : envoi bloqué.' : ''}
            </EnClair>
          )}
          {built && addrValid && sendAmount !== null && built.unsigned.family === 'xrp' && (
            <EnClair tone={built.unsigned.summary.destinationTag === null ? 'warn' : 'ice'}>
              Tu envoies <strong>{fmtCrypto(sendAmount, decimals, asset.symbol)}</strong> à <strong>{contact?.name ?? shortAddress(toTrim)}</strong>
              {built.unsigned.summary.destinationTag !== null ? (
                <>
                  {' '}avec le tag de destination <strong className="font-mono">{built.unsigned.summary.destinationTag}</strong>
                </>
              ) : (
                ', sans tag de destination'
              )}
              . Frais : {fmtCrypto(built.unsigned.maxFee, 6, 'XRP', 6)}.
              {!built.unsigned.context.destination.exists ? ' Ce paiement crée son compte : 1 XRP de réserve y reste bloqué.' : ''}
              {built.unsigned.summary.destinationTag === null ? ' Si c’est une plateforme d’échange, vérifie qu’elle ne t’a pas donné de tag.' : ''}
            </EnClair>
          )}
          {built && addrValid && built.unsigned.family === 'ada' && (
            <EnClair tone={built.unsigned.summary.requiresExtraConfirmation ? 'warn' : 'ice'}>
              Tu envoies{' '}
              <strong>
                {built.unsigned.token && adaToken ? `${built.unsigned.token.quantity} ${cardanoTokenLabel(adaToken)} + ${fmtCrypto(built.unsigned.amount, 6, 'ADA')} (min-ADA)` : fmtCrypto(built.unsigned.amount, 6, 'ADA')}
              </strong>{' '}
              à <strong>{contact?.name ?? shortAddress(toTrim)}</strong>. Frais : {fmtCrypto(built.unsigned.maxFee, 6, 'ADA')} ; au total {fmtCrypto(BigInt(built.unsigned.context.leaving), 6, 'ADA')} quittent ton portefeuille, le reste revient sur ton adresse.
              {built.unsigned.summary.memo ? ' Le message sera public pour toujours.' : ''}
              {built.unsigned.summary.warnings.some((w) => w.kind === 'unknownToken') ? ' Token non vérifié : une 2ᵉ confirmation te sera demandée.' : ''}
            </EnClair>
          )}
          {built && addrValid && sendAmount !== null && built.unsigned.family !== 'tron' && built.unsigned.family !== 'xrp' && built.unsigned.family !== 'ada' && (
            <EnClair>
              Tu envoies <strong>{fmtCrypto(sendAmount, decimals, asset.symbol)}</strong> à <strong>{contact?.name ?? shortAddress(toTrim)}</strong>
              {utxoLike && built.unsigned.family === 'btc' && built.unsigned.summary.outputs.some((o) => o[2]) ? ', la monnaie revient sur ton adresse de change' : ''}. Personne d’autre ne reçoit rien, et tu paies au maximum{' '}
              {feeFiat !== null ? fmtFiat(feeFiat, cur) : maxFee !== null && nativeAsset ? fmtCrypto(maxFee, nativeAsset.decimals, nativeAsset.symbol) : '—'} de frais{choice === 'custom' ? ' (ton réglage)' : ''}.
              {rent > 0n && nativeAsset ? ` Son compte de token n’existe pas encore : tu déposes ${fmtCrypto(rent, nativeAsset.decimals, nativeAsset.symbol)} de loyer pour le créer.` : ''}
              {'dustFolded' in built.unsigned && typeof built.unsigned.dustFolded === 'bigint' && built.unsigned.dustFolded > 0n
                ? ` Pas de monnaie : le reste (${fmtCrypto(built.unsigned.dustFolded, decimals, asset.symbol)}, sous le seuil de poussière) est ajouté aux frais.`
                : ''}
            </EnClair>
          )}
          {!built && !buildError && !building && <p className="m-0 text-[13px] leading-[1.5] text-mute">{!addrValid ? (xAddress ? 'Adresse X : saisis l’adresse classique r… et le tag séparément.' : 'Saisis ou colle l’adresse du destinataire.') : dogeBelowDust ? 'Montant sous 0,01 DOGE : aucune transaction construite.' : xrpTagMissing ? 'Tag de destination obligatoire pour ce destinataire : aucun paiement construit sans lui.' : xrpBelowActivation ? 'Moins de 1 XRP vers un compte inexistant : aucun paiement construit.' : isXrp && !xrpDestInfo ? 'Lecture du compte destinataire…' : 'Indique un montant pour voir le récapitulatif décodé.'}</p>}

          {blindSigning && activeHw && (
            <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
              <strong className="font-semibold">Signature à l’aveugle :</strong> ton {BRAND[activeHw.device]} ne pourra pas afficher le détail de cette transaction (seulement des données brutes ou une empreinte). Seul le résumé de Kyro la décrit ; une 2ᵉ confirmation te sera demandée.
              {activeHw.device === 'ledger' ? ' Sur Ledger, le réglage « Blind signing » de l’app Ethereum doit être activé, sinon l’appareil refusera.' : ''}
            </Notice>
          )}

          <div className="flex-1" />
          {activeHw ? (
            <div className="flex items-center gap-2 rounded-ctl border border-line bg-raised px-3.5 py-2.5 text-[12px] text-mute">
              <DeviceBadge device={activeHw.device} model={activeHw.model} />
              <span>Pas de mot de passe : fenêtre système de Kyro, puis confirmation sur l’écran de l’appareil.</span>
            </div>
          ) : (
            <PasswordField id="send-pw" value={password} onChange={setPassword} onEnter={() => canSign && void sign()} />
          )}
          {signing && activeHw && hwDevice && (
            <HwWaiting
              deviceId={hwDevice}
              idle="Kyro vérifie que c’est le bon appareil…"
              confirm={{ title: 'Confirme sur ton appareil', detail: 'Vérifie le destinataire, le montant et les frais sur l’écran de l’appareil : ils doivent être identiques au récapitulatif. Sinon, refuse sur l’appareil.' }}
            />
          )}
          {hwError !== null && <HwErrorNotice error={hwError} onRetry={() => void sign()} />}
          {signError && (serverDown(signError) ? <ServerDownLine /> : <Notice tone="error">{signError}</Notice>)}
          <Button variant="primary" size="xl" disabled={!canSign} onClick={() => void sign()}>
            {signing && <Spinner />} {activeHw ? 'Signer sur l’appareil et envoyer' : 'Signer et envoyer'}
          </Button>
          <span className="text-center text-[11px] leading-[1.5] text-faint">
            {activeHw ? 'Une fenêtre système te montrera ce récapitulatif, puis ton appareil te demandera de confirmer.' : 'Une fenêtre système te montrera ce récapitulatif une dernière fois.'}
            {recipientName ? '' : ''}
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
  return String(n >= 10 ? Math.ceil(n) : Math.ceil(n * 100) / 100).replace('.', ',');
}

function dataLabel(b: Built | null, family?: string): string {
  if (!b) return '—';
  const u = b.unsigned;
  if (u.family === 'btc') {
    const outs = u.summary.outputs.length;
    // Dogecoin has no SegWit: bytes, not vbytes.
    return `${outs} sortie${outs > 1 ? 's' : ''} · ${u.size.family === 'btc' ? u.size.vsize : '?'} ${family === 'doge' ? 'octets' : 'vB'}`;
  }
  if (u.family === 'ada') return `${u.summary.inputs.length} entrée${u.summary.inputs.length > 1 ? 's' : ''} · ${u.summary.outputs.length} sorties${u.token ? ' · token' : ''}${u.summary.memo ? ' · message' : ''}`;
  if (u.family === 'xrp') return `Payment${u.summary.destinationTag !== null ? ` · tag ${u.summary.destinationTag}` : ' · sans tag'}`;
  if (u.family === 'tron') return u.token ? `transfer() TRC-20 · ${u.size.bandwidth} octets` : `TransferContract · ${u.size.bandwidth} octets`;
  if (u.family === 'sol') return u.mint ? `TransferChecked ${u.tokenProgram === 'token2022' ? 'Token-2022' : 'SPL'}${u.createsAta ? ' + création du compte' : ''}` : 'Aucune · transfert système';
  if (b.summary?.kind === 'NativeTransfer') return 'Aucune · transfert simple';
  if (b.summary?.kind === 'Erc20Transfer') return 'transfer() ERC-20';
  return b.summary?.kind ?? 'Appel de contrat';
}

function Step({ n, done, current, label }: { n: number; done: boolean; current: boolean; label: string }) {
  return (
    <li aria-current={current ? 'step' : undefined} className={cn('flex h-8 items-center gap-2 rounded-full pr-3 pl-1.5', current ? 'bg-ice/14 font-semibold text-ice-text' : 'bg-raised text-text2')}>
      <span className={cn('flex size-5 items-center justify-center rounded-full text-[11px]', done ? 'bg-up/14 text-up' : current ? 'bg-primary font-bold text-white' : 'bg-control-2 text-mute')}>{done ? '✓' : n}</span>
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
      className={cn('flex h-14 flex-1 basis-0 flex-col items-start justify-center gap-0.5 rounded-box px-3.5 text-left disabled:opacity-50', active ? 'border-[1.5px] border-ice bg-ice/8' : 'border border-line-2 bg-raised hover:border-line-3')}
    >
      <span className="truncate text-[13px] font-semibold">{title}</span>
      <span className={cn('text-[11px]', active && ice ? 'text-ice-text2' : 'text-mute')}>{sub}</span>
    </button>
  );
}

function UnitField({ label, unit, value, onChange, decimals = 9, wide }: { label: string; unit: string; value: string; onChange: (v: string) => void; decimals?: number; wide?: boolean }) {
  return (
    <label className="flex flex-col gap-1.5 text-[12px] text-mute">
      {label}
      <span className={cn('flex h-[42px] items-center gap-2 rounded-ctl border border-line-3 bg-bg px-3 focus-within:border-ice-line', wide ? 'w-[210px]' : 'w-[170px]')}>
        <input type="text" inputMode="decimal" value={value} onChange={(e) => onChange(decimals === 0 ? e.target.value : sanitizeDecimalInput(e.target.value, decimals))} className="w-full min-w-0 bg-transparent text-[16px] font-semibold text-text" />
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
  const [name, setName] = useState('');
  const [saved, setSaved] = useState(false);
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="flex w-[520px] flex-col items-center gap-5 rounded-panel border border-line bg-card px-8 py-9 text-center">
        <span className="flex size-14 items-center justify-center rounded-full bg-up/12 text-up">
          <IconCheck size={26} />
        </span>
        <h1 className="m-0 text-[26px] font-semibold tracking-[-0.03em]">Transaction diffusée</h1>
        <p className="m-0 text-[14px] leading-[1.6] text-mute">
          {what ?? fmtCrypto(amount, asset.decimals, asset.symbol)} vers {shortAddress(to)}. Elle apparaîtra comme confirmée dans l’historique dès son inclusion dans un bloc.
        </p>
        <div className="flex w-full items-center justify-between gap-2 rounded-ctl bg-raised py-2 pr-2 pl-3.5">
          <span className="truncate font-mono text-[12px] text-text2">{id}</span>
          <CopyButton text={id} />
        </div>
        {children}
        {!contactKnown && !saved && (
          <div className="flex w-full items-center gap-2">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom pour le carnet d’adresses" className="h-10 min-w-0 flex-1 rounded-ctl border border-line-2 bg-bg px-3 text-[13px]" />
            <Button
              size="md"
              disabled={!name.trim()}
              onClick={() => {
                saveContacts([...getContacts(), { id: crypto.randomUUID(), name: name.trim(), address: to, family: asset.family as ContactFamily, sends: 1 }]);
                setSaved(true);
              }}
            >
              Enregistrer
            </Button>
          </div>
        )}
        <div className="flex gap-2">
          <Button variant="primary" size="lg" onClick={onHistory}>
            Voir l’historique
          </Button>
          <Button size="lg" onClick={onBack}>
            Retour
          </Button>
        </div>
      </div>
    </div>
  );
}
