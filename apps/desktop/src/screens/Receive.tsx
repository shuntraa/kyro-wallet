// SPDX-License-Identifier: GPL-3.0-or-later
// Receive: real QR (qrcode), BTC SegWit/Taproot, Litecoin, Dogecoin, Zcash (transparent), Bitcoin Cash (CashAddr), Dash,
// TRON, XRP, Cardano, Polkadot, Hedera, Sui, Stellar, Algorand, Monero (primary address + subaddresses), Cosmos Hub, TON, optional requested amount (BIP21-style / EIP-681 / Solana Pay / monero: / ton://transfer URI; none for
// TRON, XRP,
// Cardano, Stellar, NEAR, Sui, Hedera, Polkadot, Algorand, Cosmos), network warning.

import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { bitcoinServerFor, call, toIpcError, type BtcKind, type HwImplementedChain } from '@kyro/shared';
import { aptosChain, bchChain, btcChain, dashChain, dogeChain, hwPaths, ltcChain, primaryEvmChain, solChain, tronChain, tryParseUnits, xrpChain, cardanoChain, stellarChain, nearChain, suiChain, hbarChain, kaspaChain, polkadotChain, algorandChain, xmrChain, tonChain, cosmosChain, zecChain } from '@kyro/chains';
import { useAsync } from '../lib/useAsync';
import { useApp, useVault } from '../state/app';
import { cn } from '../lib/cn';
import { fmtCrypto, sanitizeDecimalInput } from '../lib/format';
import { useT } from '../i18n';
import { rt } from '../i18n/rich';
import { AddressBlocks, CoinIcon, CopyButton } from '../components/kit';
import { QrCode } from '../components/QrCode';
import { Button, IconButton, Notice, Segmented } from '../components/ui/primitives';
import { IconBack, IconCheck, IconInfo, IconRefresh, IconUsbKey, IconWarn } from '../components/icons';
import { AddressMismatchStop, DeviceBadge, HwErrorNotice, HwWaiting } from '../components/hw';
import { AccountPicker, NewAccountButton } from '../components/AccountPicker';
import { BRAND, isAddressMismatch, pickDevice, withDevice } from '../state/hw';
import { XmrReceivePanel } from '../components/Monero';

type Family = 'btc' | 'evm' | 'sol' | 'ltc' | 'doge' | 'zec' | 'bch' | 'dash' | 'tron' | 'xrp' | 'ada' | 'xlm' | 'near' | 'sui' | 'hbar' | 'kas' | 'dot' | 'algo' | 'xmr' | 'ton' | 'cosmos' | 'apt';
const FAMILIES: Family[] = ['btc', 'evm', 'sol', 'ltc', 'doge', 'bch', 'dash', 'zec', 'tron', 'xrp', 'ada', 'xlm', 'near', 'sui', 'hbar', 'kas', 'dot', 'algo', 'xmr', 'ton', 'cosmos', 'apt'];
/** Vault-only chains (hardware wallets: HW_UNSUPPORTED for now). */
const VAULT_ONLY: readonly Family[] = ['ltc', 'doge', 'bch', 'dash', 'zec', 'tron', 'xrp', 'ada', 'xlm', 'near', 'sui', 'hbar', 'kas', 'dot', 'algo', 'xmr', 'ton', 'cosmos', 'apt'];
/** UTXO chains with « Nouvelle adresse » (Rust `{prefix}_address`). */
const UTXO_RECEIVE = ['ltc', 'doge', 'zec', 'bch', 'dash'] as const;
type UtxoReceive = (typeof UTXO_RECEIVE)[number];
const isUtxoReceive = (f: Family): f is UtxoReceive => (UTXO_RECEIVE as readonly Family[]).includes(f);

export function Receive({ family: initial = 'evm' }: { family?: Family }) {
  const { t, lang } = useT();
  const { back, network, settings, navigate, selectedAccounts, hideBalances } = useApp();
  const cbfMode = bitcoinServerFor(settings.servers, network).kind === 'cbf';
  const { accounts, adapters, activeHw } = useVault();
  // Hardware-wallet accounts have no Litecoin / Dogecoin / TRON (HW_UNSUPPORTED for now).
  const has: Record<Family, boolean> = { btc: !!accounts.btc, evm: !!accounts.evm, sol: !!accounts.sol, ltc: !!accounts.ltc, doge: !!accounts.doge, bch: !!accounts.bch, dash: !!accounts.dash, zec: !!accounts.zec, tron: !!accounts.tron, xrp: !!accounts.xrp, ada: !!accounts.cardano, xlm: !!accounts.stellar, near: !!accounts.near, sui: !!accounts.sui, hbar: !!accounts.hbar, kas: !!accounts.kas, dot: !!accounts.polkadot, algo: !!accounts.algo, xmr: !!accounts.xmr && !activeHw, ton: !!accounts.ton, cosmos: !!accounts.cosmos, apt: !!accounts.aptos };
  const [family, setFamilyRaw] = useState<Family>(has[initial] ? initial : FAMILIES.find((f) => has[f]) ?? initial);
  // Dogecoin / Dash testnets have no public server: say so instead of showing an address as if payments would appear.
  const dogeInfo = useAsync(family === 'doge' ? () => call('doge_backend_info') : family === 'dash' ? () => call('dash_backend_info') : null, [family, JSON.stringify(settings.servers.dogecoin), JSON.stringify(settings.servers.dash)]);
  // Zcash testnet has no public server either.
  const zecInfo = useAsync(family === 'zec' ? () => call('zec_backend_info') : null, [family]);
  // Hardware wallet: on-device verification of the shown address (hw_verify_address).
  type Verify = { state: 'idle' } | { state: 'running'; deviceId: string } | { state: 'ok'; address: string } | { state: 'error'; error: unknown; address: string };
  const [verify, setVerify] = useState<Verify>({ state: 'idle' });
  const [mismatch, setMismatch] = useState<unknown>(null);
  const setFamily = (f: Family) => {
    setFamilyRaw(f);
    setVerify({ state: 'idle' });
    setIndex(0);
  };
  const [kind, setKind] = useState<BtcKind>('segwit');
  const [index, setIndex] = useState(0);
  const [derived, setDerived] = useState<Record<string, string>>({});
  const [deriveError, setDeriveError] = useState<string | null>(null);
  const [askAmount, setAskAmount] = useState(false);
  const [amount, setAmount] = useState('');
  // Vault account of this chain (§2.9): another account → back to its first address.
  const account = activeHw ? 0 : selectedAccounts[family];
  useEffect(() => {
    setIndex(0);
    setDerived({});
    setVerify({ state: 'idle' });
  }, [account]);

  const btc = btcChain(network);
  const evm = primaryEvmChain(network);
  const sol = solChain(network);
  const ltc = ltcChain(network);
  const doge = dogeChain(network);
  const bch = bchChain(network);
  const dash = dashChain(network);
  const tron = tronChain(network);
  const xrp = xrpChain(network);
  const ada = cardanoChain(network);
  const xlm = stellarChain(network);
  const nearC = nearChain(network);
  const sui = suiChain(network);
  const hbar = hbarChain(network);
  // Hedera: the account `0.0.x` (created by the first HBAR received on the EVM address).
  const hbarAccount = useAsync(family === 'hbar' && adapters.hbar ? () => adapters.hbar!.account() : null, [family, adapters.hbar], { intervalMs: 30_000 });
  const [hbarView, setHbarView] = useState<'id' | 'evm'>('id');
  const hbarId = hbarAccount.data?.exists ? hbarAccount.data.accountId : null;
  // Found by public key: the EVM address is NOT this account's alias (it would create another account).
  const hbarEvmOk = !hbarAccount.data || hbarAccount.data.foundBy !== 'publicKey';
  const hbarShowId = !!hbarId && (hbarView === 'id' || !hbarEvmOk);
  const kas = kaspaChain(network);
  const dot = polkadotChain(network);
  const algo = algorandChain(network);
  const xmr = xmrChain(network);
  const ton = tonChain(network);
  const atom = cosmosChain(network);
  const apt = aptosChain(network);
  const zec = zecChain(network);

  const btcAcc = accounts.btc?.[kind];
  const utxoAcc = isUtxoReceive(family) ? accounts[family] : undefined;
  const indexKey = family === 'btc' ? `${kind}:${index}` : `${family}:${index}`;
  const address =
    (family === 'btc'
      ? index === 0
        ? btcAcc?.address
        : (derived[indexKey] ?? btcAcc?.address)
      : utxoAcc
        ? index === 0
          ? utxoAcc.address
          : (derived[indexKey] ?? utxoAcc.address)
        : family === 'tron'
          ? accounts.tron?.address
          : family === 'xrp'
            ? accounts.xrp?.address
            : family === 'ada'
              ? accounts.cardano?.address
              : family === 'xlm'
                ? accounts.stellar?.address
              : family === 'near'
                ? accounts.near?.address
              : family === 'sui'
                ? accounts.sui?.address
              : family === 'hbar'
                ? hbarShowId
                  ? (hbarId ?? '')
                  : accounts.hbar?.address
              : family === 'kas'
                ? accounts.kas?.address
              : family === 'dot'
                ? accounts.polkadot?.address
              : family === 'algo'
                ? accounts.algo?.address
                : family === 'xmr'
                ? accounts.xmr?.address
              : family === 'ton'
                ? accounts.ton?.address
              : family === 'cosmos'
                ? accounts.cosmos?.address
              : family === 'apt'
                ? accounts.aptos?.address
                : family === 'evm'
            ? accounts.evm?.address
            : accounts.sol?.address) ?? '';
  const path =
    family === 'btc'
      ? `${btcAcc?.path ?? ''}/0/${index}`
      : utxoAcc
        ? `${utxoAcc.path}/0/${index}`
        : // One address per account (no « Nouvelle adresse »): the path comes from Rust (`accounts_get`)
          // and follows the chosen account, e.g. m/44'/60'/0'/0/1 for « Ethereum 2 ».
          family === 'tron'
          ? (accounts.tron?.path ?? "m/44'/195'/0'/0/0")
          : family === 'xrp'
            ? (accounts.xrp?.path ?? "m/44'/144'/0'/0/0")
            : family === 'ada'
              ? (accounts.cardano?.path ?? "m/1852'/1815'/0'/0/0")
              : family === 'xlm'
                ? (accounts.stellar?.path ?? "m/44'/148'/0'")
              : family === 'near'
                ? (accounts.near?.path ?? "m/44'/397'/0'")
              : family === 'sui'
                ? (accounts.sui?.path ?? "m/44'/784'/0'/0'/0'")
              : family === 'hbar'
                ? (accounts.hbar?.path ?? "m/44'/3030'/0'/0/0")
              : family === 'kas'
                ? (accounts.kas?.path ?? "m/44'/111111'/0'/0/0")
              : family === 'dot'
                ? (accounts.polkadot?.path ?? 'sr25519')
              : family === 'algo'
                ? (accounts.algo?.path ?? "m/44'/283'/0'/0/0")
                : family === 'xmr'
                ? t('receive.xmrPrimaryPath', { path: accounts.xmr?.path ?? "m/44'/128'/0'/0/0" })
              : family === 'ton'
                ? (accounts.ton?.path ?? "m/44'/607'/0'")
              : family === 'cosmos'
                ? (accounts.cosmos?.path ?? "m/44'/118'/0'/0/0")
              : family === 'apt'
                ? (accounts.aptos?.path ?? "m/44'/637'/0'/0'/0'")
                : family === 'evm'
          ? activeHw
            ? hwPaths.evm(activeHw)
            : (accounts.evm?.path ?? "m/44'/60'/0'/0/0")
          : activeHw
            ? (hwPaths.sol(activeHw) ?? '')
            : (accounts.sol?.path ?? "m/44'/501'/0'/0'");
  const verifiedHere = verify.state === 'ok' && verify.address === address;
  const blocked = mismatch !== null || (verify.state === 'error' && isAddressMismatch(verify.error) && verify.address === address);
  const chainName = { btc: btc.name, evm: evm.name, sol: sol.name, ltc: ltc.name, doge: doge.name, zec: zec.name, bch: bch.name, dash: dash.name, tron: tron.name, xrp: xrp.name, ada: ada.name, ton: ton.name, xmr: xmr.name, dot: dot.name, hbar: hbar.name, xlm: xlm.name, near: nearC.name, sui: sui.name, kas: kas.name, algo: algo.name, cosmos: atom.name, apt: apt.name }[family];
  const decimals = { btc: 8, evm: 18, sol: 9, ltc: 8, doge: 8, zec: 8, bch: 8, dash: 8, tron: 6, xrp: 6, ada: 6, ton: 9, xmr: 12, dot: dot.nativeDecimals, hbar: 8, xlm: 7, near: 24, sui: 9, kas: 8, algo: 6, cosmos: 6, apt: 8 }[family];
  const symbol = { btc: 'BTC', evm: 'ETH', sol: 'SOL', ltc: 'LTC', doge: 'DOGE', zec: 'ZEC', bch: 'BCH', dash: 'DASH', tron: 'TRX', xrp: 'XRP', ada: 'ADA', ton: 'TON', xmr: 'XMR', dot: dot.nativeSymbol, hbar: 'HBAR', xlm: 'XLM', near: 'NEAR', sui: 'SUI', kas: 'KAS', algo: 'ALGO', cosmos: 'ATOM', apt: 'APT' }[family];
  // TRON, XRP, Cardano, Stellar, NEAR, Sui, Kaspa, Algorand, Cosmos and Aptos have no payment-link format Kyro relies on: the QR is the bare address.
  const amountLink = family !== 'tron' && family !== 'xrp' && family !== 'ada' && family !== 'dot' && family !== 'hbar' && family !== 'xlm' && family !== 'near' && family !== 'sui' && family !== 'kas' && family !== 'algo' && family !== 'cosmos' && family !== 'apt';
  // XRP: is our account activated yet (≥ 1 XRP base reserve received)?
  // Stellar: is our account created yet (≥ 1 XLM received)? Its reserve, explained.
  const xlmAccount = useAsync(family === 'xlm' && adapters.stellar ? () => adapters.stellar!.account() : null, [family, adapters.stellar]);
  const xrpAccount = useAsync(family === 'xrp' && adapters.xrp ? () => adapters.xrp!.account() : null, [family, adapters.xrp]);
  // NEAR: does our implicit account exist yet (created by the first NEAR received)?
  const nearAccount = useAsync(family === 'near' && adapters.near ? () => adapters.near!.account() : null, [family, adapters.near]);
  // Bitcoin Cash: the CashAddr already starts with its scheme (`bitcoincash:` / `bchtest:`).
  // Polkadot: does our account exist yet (≥ existential deposit received)?
  const dotAccount = useAsync(family === 'dot' && adapters.polkadot ? () => adapters.polkadot!.account() : null, [family, adapters.polkadot]);
  // Algorand: does our account exist yet (≥ 0.1 ALGO received)? Rekeyed?
  const algoAccount = useAsync(family === 'algo' && adapters.algo ? () => adapters.algo!.account() : null, [family, adapters.algo]);
  // ZIP 321 payment URIs (`zcash:t1…?amount=`), same shape as BIP 21.
  const uriScheme = { btc: 'bitcoin', ltc: 'litecoin', doge: 'dogecoin', dash: 'dash', zec: 'zcash' } as const;
  // Monero URI (monero-project/monero docs: `monero:<address>?tx_amount=<XMR>`).
  const amountBase = amount ? tryParseUnits(amount, decimals) : null;

  const uri = useMemo(() => {
    const dec = amount.replace(',', '.');
    const scheme = family === 'btc' || family === 'ltc' || family === 'doge' || family === 'dash' || family === 'zec' ? uriScheme[family] : null;
    if (!askAmount || !amountBase || amountBase <= 0n) return scheme ? `${scheme}:${address}` : address;
    if (scheme) return `${scheme}:${address}?amount=${dec}`;
    if (family === 'bch') return `${address}?amount=${dec}`;
    if (family === 'tron' || family === 'xrp' || family === 'ada' || family === 'xlm' || family === 'near' || family === 'sui' || family === 'hbar' || family === 'kas' || family === 'dot' || family === 'algo' || family === 'cosmos' || family === 'apt') return address;
    if (family === 'xmr') return `monero:${address}?tx_amount=${dec}`;
    if (family === 'evm') return `ethereum:${address}@${evm.chainId}?value=${amountBase.toString()}`;
    // TON deep link (Tonkeeper, MyTonWallet…): amount in nanotons.
    if (family === 'ton') return `ton://transfer/${address}?amount=${amountBase.toString()}`;
    return `solana:${address}?amount=${dec}`;
  }, [askAmount, amountBase, amount, family, address, evm.chainId]);

  const newAddress = async () => {
    setDeriveError(null);
    const next = index + 1;
    try {
      // Vault: Rust derives from the seed. Hardware wallet: public derivation from the stored xpub
      // (then verify it on the device).
      const a = isUtxoReceive(family)
        ? await call(`${family}_address`, { change: false, index: next, ...(account ? { account } : {}) })
        : activeHw
              ? (adapters.btc?.addressAt(kind, 0, next).address ?? '')
              : await call('btc_address', { kind, change: false, index: next, ...(account ? { account } : {}) });
      setDerived((d) => ({ ...d, [family === 'btc' ? `${kind}:${next}` : `${family}:${next}`]: a }));
      setIndex(next);
      setVerify({ state: 'idle' });
    } catch (e) {
      setDeriveError(toIpcError(e).message);
    }
  };

  const verifyOnDevice = async () => {
    if (!activeHw || isUtxoReceive(family) || family === 'tron' || family === 'xrp' || family === 'ada' || family === 'apt' || family === 'cosmos' || family === 'ton' || family === 'xmr' || family === 'algo' || family === 'dot' || family === 'kas' || family === 'hbar' || family === 'sui' || family === 'xlm' || family === 'near') return;
    const chain: HwImplementedChain = family;
    const shown = address;
    let deviceId = '';
    try {
      const d = await pickDevice(activeHw.device);
      deviceId = d.id;
      setVerify({ state: 'running', deviceId });
      const res = await withDevice(deviceId, () => call('hw_verify_address', { id: deviceId, accountId: activeHw.id, chain, path }));
      if (res.address.toLowerCase() !== shown.toLowerCase()) throw new Error(t('receive.verifyMismatch'));
      setVerify({ state: 'ok', address: shown });
    } catch (e) {
      setVerify({ state: 'error', error: e, address: shown });
      if (isAddressMismatch(e)) setMismatch(e);
    }
  };

  const desc =
    family === 'btc'
      ? kind === 'segwit'
        ? t('receive.descBtcSegwit')
        : t('receive.descBtcTaproot')
      : family === 'evm'
        ? network === 'testnet'
          ? t('receive.descEvmTestnet')
          : t('receive.descEvm')
        : family === 'ltc'
          ? t('receive.descLtc')
          : family === 'doge'
            ? t('receive.descDoge')
            : family === 'zec'
              ? t('receive.descZec')
            : family === 'bch'
              ? t('receive.descBch')
              : family === 'dash'
                ? t('receive.descDash')
                : family === 'tron'
              ? network === 'testnet'
                ? t('receive.descTronTestnet')
                : t('receive.descTron')
              : family === 'xrp'
                ? t('receive.descXrp')
                : family === 'ada'
                  ? t('receive.descAda')
                  : family === 'xlm'
                    ? t('receive.descXlm')
                  : family === 'near'
                    ? t('receive.descNear')
                  : family === 'sui'
                    ? t('receive.descSui')
                  : family === 'hbar'
                    ? hbarShowId
                      ? t('receive.descHbarId')
                      : t('receive.descHbarEvm')
                  : family === 'kas'
                    ? t('receive.descKas', { prefix: network === 'testnet' ? 'kaspatest:' : 'kaspa:' })
                  : family === 'dot'
                    ? network === 'testnet'
                      ? t('receive.descDotTestnet')
                      : t('receive.descDot')
                  : family === 'algo'
                    ? t('receive.descAlgo')
                  : family === 'xmr'
                    ? t('receive.descXmr')
                  : family === 'ton'
                    ? network === 'testnet'
                      ? t('receive.descTonTestnet')
                      : t('receive.descTon')
                  : family === 'cosmos'
                    ? t('receive.descCosmos')
                  : family === 'apt'
                    ? t('receive.descApt')
                  : t('receive.descSol');

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 px-7 pt-6 pb-5">
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <IconButton label={t('receive.backToWallet')} onClick={back} className="size-9">
            <IconBack size={16} />
          </IconButton>
          <h1 className="screen-title">{t('receive.title')}</h1>
          <AccountPicker family={family} />
          <NewAccountButton family={family} />
        </div>
        <div role="group" aria-label={t('receive.network')} className="flex min-w-0 gap-0.5 overflow-x-auto rounded-[8px] border border-line bg-bg p-[3px] scroll-thin">
          {(
            [
              ['btc', 'Bitcoin', '₿', '#F7931A'],
              ['evm', 'Ethereum', 'Ξ', '#627EEA'],
              ['sol', 'Solana', 'S', '#35D0BA'],
              ['ltc', 'Litecoin', 'Ł', '#345D9D'],
              ['doge', 'Dogecoin', 'Ð', '#C2A633'],
              ['bch', 'Bitcoin Cash', 'Ƀ', '#0AC18E'],
              ['dash', 'Dash', 'Đ', '#008DE4'],
              ['zec', 'Zcash', 'ⓩ', '#F4B728'],
              ['tron', 'TRON', 'T', '#EB0029'],
              ['xrp', 'XRP', 'X', '#3A3F48'],
              ['ada', 'Cardano', 'A', '#3468D1'],
              ['xlm', 'Stellar', '✦', '#7D00FF'],
              ['near', 'NEAR', 'N', '#00C08B'],
              ['sui', 'Sui', 'S', '#4DA2FF'],
              ['hbar', 'Hedera', 'ħ', '#2D2D2D'],
              ['kas', 'Kaspa', 'K', '#49C3B1'],
              ['dot', 'Polkadot', 'P', '#E6007A'],
              ['algo', 'Algorand', 'A', '#2B2B2F'],
              ['xmr', 'Monero', 'ɱ', '#FF6600'],
              ['ton', 'TON', '◇', '#0098EA'],
              ['cosmos', 'Cosmos', '⚛', '#2E3148'],
              ['apt', 'Aptos', 'A', '#1C1C1C'],
            ] as const
          ).map(([f, label, glyph, color]) => (
            <button
              key={f}
              type="button"
              aria-pressed={family === f}
              disabled={!has[f]}
              title={has[f] ? undefined : VAULT_ONLY.includes(f) ? t('receive.vaultOnlyTitle') : t('receive.noKeysTitle')}
              onClick={() => {
                setFamily(f);
                setAmount('');
                setAskAmount(false);
              }}
              className={cn('relative flex h-8 shrink-0 items-center gap-2 rounded-[5px] pr-3 pl-1.5 text-[12.5px] transition-colors duration-150 disabled:opacity-35', family === f ? 'font-medium text-text' : 'text-mute hover:text-text2')}
            >
              {family === f && <motion.span layoutId="receive-family" aria-hidden="true" className="absolute inset-0 rounded-[5px] border border-line-3 bg-control-2" transition={{ type: 'spring', stiffness: 520, damping: 40 }} />}
              <CoinIcon glyph={glyph} color={color} size={20} className="relative z-10" />
              <span className="relative z-10">{label}</span>
            </button>
          ))}
        </div>
      </header>
      {activeHw && (
        <span className="-mt-2 self-end text-[12px] text-faint">{t('receive.hwUnsupported')}</span>
      )}

      <section className="relative flex min-h-0 flex-1 items-center-safe justify-center gap-14 overflow-y-auto rounded-panel border border-line bg-card p-8 scroll-thin">
        <div className="relative flex flex-col items-center gap-3">
          <div key={uri} className={cn('pop-in transition-[opacity,filter] duration-300', blocked && 'pointer-events-none opacity-20 blur-md')} aria-hidden={blocked || undefined}>
            <QrCode value={uri} size={300} />
          </div>
          <span className="eyebrow">{askAmount && amountBase ? t('receive.qrWithAmount') : t('receive.qrAddress')}</span>
        </div>

        <div key={family} className="rise relative flex w-[460px] flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="eyebrow">{t('receive.yourAddress', { chain: { btc: 'Bitcoin', evm: 'Ethereum', sol: 'Solana', ltc: 'Litecoin', doge: 'Dogecoin', zec: t('receive.chainZec'), bch: 'Bitcoin Cash', dash: 'Dash', tron: 'TRON', xrp: 'XRP', ada: 'Cardano', apt: 'Aptos', cosmos: 'Cosmos Hub', ton: 'TON', xmr: 'Monero', algo: 'Algorand', dot: 'Polkadot', kas: 'Kaspa', hbar: hbarShowId ? t('receive.chainHbarId') : t('receive.chainHbarEvm'), sui: 'Sui', xlm: 'Stellar', near: 'NEAR' }[family] })}</span>
            <span className="text-[15px] leading-[1.45] text-text2">{desc}</span>
          </div>
          {isUtxoReceive(family) && (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => void newAddress()} title={t('receive.newAddressTitle')}>
                <IconRefresh size={14} /> {t('receive.newAddress')}
              </Button>
            </div>
          )}
          {(family === 'doge' || family === 'dash') && dogeInfo.data && !dogeInfo.data.available && (
            <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
              {rt('receive.dogeNoServer', { b: (c) => <strong className="font-semibold">{c}</strong> }, { coin: family === 'dash' ? 'Dash' : 'Dogecoin' })}
              <button type="button" onClick={() => navigate({ name: 'settings', section: 'networks' })} className="mt-1 block font-semibold text-ice hover:underline">
                {t('receive.dogeConfigure', { coin: family === 'dash' ? 'Dash' : 'Dogecoin' })}
              </button>
            </Notice>
          )}
          {family === 'hbar' && hbarId && hbarEvmOk && (
            <Segmented
              label="Format"
              value={hbarView}
              onChange={setHbarView}
              options={[
                { value: 'id', label: t('receive.hbarFormatId', { id: hbarId }) },
                { value: 'evm', label: t('receive.hbarFormatEvm') },
              ]}
            />
          )}
          {family === 'btc' && (
            <div className="flex items-center gap-2">
              <Segmented
                label={t('receive.addressType')}
                value={kind}
                onChange={(k) => {
                  setKind(k);
                  setIndex(0);
                  setVerify({ state: 'idle' });
                }}
                options={[
                  { value: 'segwit', label: 'SegWit' },
                  { value: 'taproot', label: 'Taproot' },
                ]}
              />
              <Button size="sm" variant="ghost" onClick={() => void newAddress()} title={t('receive.newAddressTitle')}>
                <IconRefresh size={14} /> {t('receive.newAddress')}
              </Button>
            </div>
          )}
          <div className={cn(blocked && 'pointer-events-none opacity-30 blur-[3px]')} aria-hidden={blocked || undefined}>
            <AddressBlocks address={address} size="xl" />
          </div>
          {activeHw ? (
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center gap-2 text-[12px] text-mute">
                <DeviceBadge device={activeHw.device} model={activeHw.model} />
                <span>{t('receive.hwCheckFirst')}</span>
              </div>
              <Button variant="primary" size="xl" disabled={blocked || verify.state === 'running' || !address} onClick={() => void verifyOnDevice()}>
                <IconUsbKey size={16} /> {t('receive.verifyOnDevice')}
              </Button>
              {verify.state === 'running' && (
                <HwWaiting
                  deviceId={verify.deviceId}
                  idle={t('receive.connecting', { device: BRAND[activeHw.device] })}
                  confirm={{ title: t('receive.compareTitle'), detail: t('receive.compareDetail') }}
                />
              )}
              {verifiedHere && (
                <Notice tone="success" icon={<IconCheck size={16} className="mt-0.5 shrink-0 text-up" />}>
                  {t('receive.verified')}
                </Notice>
              )}
              {verify.state === 'error' && !isAddressMismatch(verify.error) && verify.address === address && <HwErrorNotice error={verify.error} onRetry={() => void verifyOnDevice()} />}
              {blocked && (
                <Notice tone="error" icon={<IconWarn size={16} className="mt-0.5 shrink-0" />}>
                  {rt('receive.blocked', { b: (c) => <strong className="font-semibold">{c}</strong> })}
                </Notice>
              )}
              <CopyButton text={address} size="xl" className={cn(blocked && 'pointer-events-none opacity-40')} />
            </div>
          ) : (
            <div className="flex gap-2.5">
              <CopyButton text={address} variant="primary" size="xl" className="flex-1" />
            </div>
          )}
          {deriveError && <Notice tone="error">{deriveError}</Notice>}
          <dl className="m-0 flex flex-col overflow-hidden rounded-box border border-line text-[13px]">
            <div className="flex h-11 items-center justify-between border-b border-line px-4">
              <dt className="text-mute">{t('receive.network')}</dt>
              <dd className="m-0">
                {chainName}
                {network === 'testnet' && !/testnet/i.test(chainName) ? ' (testnet)' : ''}
              </dd>
            </div>
            <div className="flex h-11 items-center justify-between border-b border-line px-4">
              <dt className="text-mute">{t('receive.derivationPath')}</dt>
              <dd className="m-0 font-mono text-[12px]">{path}</dd>
            </div>
            <div className="flex min-h-11 items-center justify-between gap-3 px-4 py-1.5">
              <dt className="text-mute">{t('receive.requestedAmount')}</dt>
              <dd className="m-0">
                {!amountLink ? (
                  <span className="text-[12px] text-faint">{t('receive.noPaymentLink', { chain: family === 'xrp' ? 'XRP Ledger' : family === 'ada' ? 'Cardano' : family === 'apt' ? 'Aptos' : family === 'cosmos' ? 'Cosmos Hub' : family === 'algo' ? 'Algorand' : family === 'dot' ? 'Polkadot' : family === 'kas' ? 'Kaspa' : family === 'hbar' ? 'Hedera' : family === 'sui' ? 'Sui' : family === 'xlm' ? 'Stellar' : family === 'near' ? 'NEAR' : 'TRON' })}</span>
                ) : askAmount ? (
                  <span className="flex items-center gap-2">
                    <input autoFocus value={amount} inputMode="decimal" placeholder="0" onChange={(e) => setAmount(sanitizeDecimalInput(e.target.value, decimals))} className="h-8 w-[120px] rounded-ctl border border-line-2 bg-bg px-2 text-right text-[13px] focus:border-ice-line" />
                    <span className="text-mute">{symbol}</span>
                    <button type="button" onClick={() => { setAskAmount(false); setAmount(''); }} className="text-[12px] text-mute hover:text-text">
                      {t('common.remove')}
                    </button>
                  </span>
                ) : (
                  <button type="button" onClick={() => setAskAmount(true)} className="font-semibold text-ice hover:underline">
                    {t('receive.addAmount')}
                  </button>
                )}
              </dd>
            </div>
          </dl>
          {askAmount && amountBase !== null && amountBase > 0n && (
            <div className="flex items-center justify-between gap-2 rounded-ctl bg-raised py-1.5 pr-1.5 pl-3">
              <span className="truncate font-mono text-[11px] text-mute">{uri}</span>
              <CopyButton text={uri} label={t('receive.copyLink')} />
            </div>
          )}
          {family === 'zec' && (
            <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
              {rt('receive.zecNote', { b: (c) => <strong className="font-semibold">{c}</strong>, t: (c) => <strong>{c}</strong> })}
              {zecInfo.data && !zecInfo.data.available && <span className="mt-1 block font-semibold">{t('receive.zecTestnetNoServer')}</span>}
            </Notice>
          )}
          {family === 'tron' && (
            <Notice icon={<IconInfo size={16} className="mt-0.5 shrink-0 text-ice" />}>
              {rt('receive.tronNote', { b: (c) => <strong className="font-semibold text-text">{c}</strong> })}
            </Notice>
          )}
          {family === 'ada' && (
            <Notice icon={<IconInfo size={16} className="mt-0.5 shrink-0 text-ice" />}>
              {rt('receive.adaNote', { b: (c) => <strong className="font-semibold text-text">{c}</strong> })}
            </Notice>
          )}
          {family === 'kas' && (
            <Notice icon={<IconInfo size={16} className="mt-0.5 shrink-0 text-ice" />}>
              {rt('receive.kasNote', { b: (c) => <strong className="font-semibold text-text">{c}</strong> })}
            </Notice>
          )}
          {family === 'xmr' && adapters.xmr && <XmrReceivePanel adapter={adapters.xmr} hidden={hideBalances} />}
          {family === 'xmr' && (
            <Notice icon={<IconInfo size={16} className="mt-0.5 shrink-0 text-ice" />}>
              {rt('receive.xmrNote', { b: (c) => <strong className="font-semibold text-text">{c}</strong> })}
            </Notice>
          )}
          {family === 'ton' && (
            <Notice icon={<IconInfo size={16} className="mt-0.5 shrink-0 text-ice" />}>
              {rt('receive.tonNote', { b: (c) => <strong className="font-semibold text-text">{c}</strong> })}
              {network === 'testnet' ? t('receive.tonTestnetId') : ''}
            </Notice>
          )}
          {family === 'xrp' && (
            <Notice icon={<IconInfo size={16} className="mt-0.5 shrink-0 text-ice" />}>
              {rt('receive.xrpNote', { b: (c) => <strong className="font-semibold text-text">{c}</strong> })}
              {xrpAccount.data && !xrpAccount.data.exists && <span className="mt-1 block font-semibold text-warn">{t('receive.xrpNotActivated')}</span>}
            </Notice>
          )}
          {family === 'xlm' && (
            <Notice icon={<IconInfo size={16} className="mt-0.5 shrink-0 text-ice" />}>
              {rt('receive.xlmReserve', { b: (c) => <strong className="font-semibold text-text">{c}</strong> })}
              {xlmAccount.data && !xlmAccount.data.exists && <span className="mt-1 block font-semibold text-warn">{t('receive.xlmNotCreated')}</span>}
              {xlmAccount.data?.exists && <span className="mt-1 block text-text2">{t('receive.xlmExists', { reserve: fmtCrypto(BigInt(xlmAccount.data.reserve), 7, 'XLM', 7) })}</span>}
            </Notice>
          )}
          {family === 'near' && (
            <Notice icon={<IconInfo size={16} className="mt-0.5 shrink-0 text-ice" />}>
              {rt('receive.nearNote', { b: (c) => <strong className="font-semibold text-text">{c}</strong> })}
              {nearAccount.data && !nearAccount.data.exists && <span className="mt-1 block font-semibold text-warn">{t('receive.nearNotCreated')}</span>}
            </Notice>
          )}
          {family === 'sui' && (
            <Notice icon={<IconInfo size={16} className="mt-0.5 shrink-0 text-ice" />}>
              {rt('receive.suiNote', { b: (c) => <strong className="font-semibold text-text">{c}</strong> })}
            </Notice>
          )}
          {family === 'hbar' && (
            <Notice icon={<IconInfo size={16} className="mt-0.5 shrink-0 text-ice" />}>
              {hbarAccount.data && !hbarAccount.data.exists ? (
                <>
                  {rt('receive.hbarNotCreated', { b: (c) => <strong className="font-semibold text-text">{c}</strong> })}
                </>
              ) : !hbarEvmOk ? (
                <span className="font-semibold text-warn">{t('receive.hbarFoundByKey', { id: hbarId ?? '' })}</span>
              ) : (
                <>
                  {rt('receive.hbarNote', { b: (c) => <strong className="font-semibold text-text">{c}</strong> }, { id: hbarAccount.data?.accountIdChecksum ?? hbarId ?? '…' })}
                </>
              )}
            </Notice>
          )}
          {family === 'dot' && (
            <Notice icon={<IconInfo size={16} className="mt-0.5 shrink-0 text-ice" />}>
              {rt('receive.dotNote', { b: (c) => <strong className="font-semibold text-text">{c}</strong> }, {
                amount: `${(dotAccount.data ? String(Number(dotAccount.data.existentialDeposit) / 10 ** dot.nativeDecimals) : '0.01').replace('.', lang === 'fr' ? ',' : '.')} ${dot.nativeSymbol}`,
              })}
              {dotAccount.data && !dotAccount.data.exists && <span className="mt-1 block font-semibold text-warn">{t('receive.dotNotCreated', { symbol: dot.nativeSymbol })}</span>}
            </Notice>
          )}
          {family === 'algo' && (
            <Notice icon={<IconInfo size={16} className="mt-0.5 shrink-0 text-ice" />}>
              {rt('receive.algoNote', { b: (c) => <strong className="font-semibold text-text">{c}</strong> })}
              <span className="mt-1 block">{t('receive.algoLedgerPath')}</span>
              {algoAccount.data && !algoAccount.data.exists && <span className="mt-1 block font-semibold text-warn">{t('receive.algoNotCreated')}</span>}
              {algoAccount.data?.authAddr && <span className="mt-1 block font-semibold text-down">{t('receive.algoRekeyed', { addr: algoAccount.data.authAddr })}</span>}
            </Notice>
          )}
          {family === 'cosmos' && (
            <Notice icon={<IconInfo size={16} className="mt-0.5 shrink-0 text-ice" />}>
              {rt('receive.cosmosNote', { b: (c) => <strong className="font-semibold text-text">{c}</strong> })}
            </Notice>
          )}
          {family === 'apt' && (
            <Notice icon={<IconInfo size={16} className="mt-0.5 shrink-0 text-ice" />}>
              {rt('receive.aptNote', { b: (c) => <strong className="font-semibold text-text">{c}</strong> })}
            </Notice>
          )}
          {family === 'btc' && cbfMode && (
            <Notice icon={<IconInfo size={16} className="mt-0.5 shrink-0 text-ice" />}>
              {rt('receive.cbfNote', { b: (c) => <strong className="font-semibold text-text">{c}</strong> })}
            </Notice>
          )}
          <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
            {t('receive.networkWarning', { chain: chainName })}
            {network === 'testnet' ? t('receive.testTokens') : ''}
          </Notice>
        </div>
      </section>
      {mismatch !== null && <AddressMismatchStop error={mismatch} onClose={() => setMismatch(null)} />}
    </div>
  );
}
