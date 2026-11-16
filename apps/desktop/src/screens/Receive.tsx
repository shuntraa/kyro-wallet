// SPDX-License-Identifier: GPL-3.0-or-later
// Receive: real QR (qrcode), BTC SegWit/Taproot, Litecoin, Dogecoin, Zcash (transparent), Bitcoin
// Cash (CashAddr), Dash, TRON, XRP, Cardano, Polkadot, Hedera, Sui, Stellar, Algorand, Monero
// (primary address + subaddresses), Cosmos Hub, TON, optional requested amount (BIP21-style /
// EIP-681 / Solana Pay / monero: / ton://transfer URI; none for TRON, XRP, Cardano, Stellar, NEAR,
// Sui, Hedera, Polkadot, Algorand, Cosmos), network warning.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { bitcoinServerFor, call, toIpcError, type BtcKind, type HwImplementedChain } from '@kyro/shared';
import { aptosChain, isHiddenFamily, bchChain, btcChain, dashChain, dogeChain, hwPaths, ltcChain, primaryEvmChain, solChain, tronChain, tryParseUnits, xrpChain, cardanoChain, stellarChain, nearChain, suiChain, hbarChain, kaspaChain, polkadotChain, algorandChain, xmrChain, tonChain, cosmosChain, zecChain } from '@kyro/chains';
import { AlgoTokens } from '../components/AlgoSend';
import { HbarTokens } from '../components/HbarSend';
import { useAsync } from '../lib/useAsync';
import { useApp, useVault } from '../state/app';
import { cn } from '../lib/cn';
import { fmtCrypto, sanitizeDecimalInput } from '../lib/format';
import { useT } from '../i18n';
import { rt } from '../i18n/rich';
import { CoinIcon } from '../components/kit';
import { Menu } from '../components/ui/menu';
import { IconCheck, IconChevronDown, IconCopy, IconRefresh, IconUsbKey } from '../components/icons';
import { BIG, CoinGlow, Frost, GLASS_ROW, GLOW, GlassButton, LABEL, Segmented as KSegmented, THIN, VaultRing } from '../components/kyro';
import { CoinAddress, InfoLine, QrTile, coinColor, useCopy } from '../components/CoinLight';
import { AddressMismatchStop, DeviceBadge, HwErrorNotice, HwWaiting } from '../components/hw';
import { AccountPicker, NewAccountButton } from '../components/AccountPicker';
import { BRAND, isAddressMismatch, pickDevice, withDevice } from '../state/hw';
import { XmrReceivePanel } from '../components/Monero';
import { StellarTrustPanel } from '../components/StellarSend';

type Family = 'btc' | 'evm' | 'sol' | 'ltc' | 'doge' | 'zec' | 'bch' | 'dash' | 'tron' | 'xrp' | 'ada' | 'xlm' | 'near' | 'sui' | 'hbar' | 'kas' | 'dot' | 'algo' | 'xmr' | 'ton' | 'cosmos' | 'apt';
const FAMILIES: Family[] = ['btc', 'evm', 'sol', 'ltc', 'doge', 'bch', 'dash', 'zec', 'tron', 'xrp', 'ada', 'xlm', 'near', 'sui', 'hbar', 'kas', 'dot', 'algo', 'xmr', 'ton', 'cosmos', 'apt'];
const FAMILY_META = [
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
] as const satisfies ReadonlyArray<readonly [Family, string, string, string]>;
const VAULT_ONLY: readonly Family[] = ['near', 'sui', 'hbar', 'kas', 'dot', 'algo', 'xmr', 'ton', 'cosmos', 'apt'];
const UTXO_RECEIVE = ['ltc', 'doge', 'zec', 'bch', 'dash'] as const;
type UtxoReceive = (typeof UTXO_RECEIVE)[number];
const isUtxoReceive = (f: Family): f is UtxoReceive => (UTXO_RECEIVE as readonly Family[]).includes(f);

export function Receive({ family: initial = 'evm' }: { family?: Family }) {
  const { t, lang } = useT();
  const { network, settings, navigate, selectedAccounts, hideBalances } = useApp();
  const cbfMode = bitcoinServerFor(settings.servers, network).kind === 'cbf';
  const { accounts, adapters, activeHw } = useVault();
  const has: Record<Family, boolean> = { btc: !!accounts.btc, evm: !!accounts.evm, sol: !!accounts.sol, ltc: !!accounts.ltc, doge: !!accounts.doge, bch: !!accounts.bch, dash: !!accounts.dash, zec: !!accounts.zec, tron: !!accounts.tron, xrp: !!accounts.xrp, ada: !!accounts.cardano, xlm: !!accounts.stellar, near: !!accounts.near, sui: !!accounts.sui, hbar: !!accounts.hbar, kas: !!accounts.kas, dot: !!accounts.polkadot, algo: !!accounts.algo, xmr: !!accounts.xmr && !activeHw, ton: !!accounts.ton, cosmos: !!accounts.cosmos, apt: !!accounts.aptos };
  const [family, setFamilyRaw] = useState<Family>(has[initial] ? initial : FAMILIES.find((f) => has[f]) ?? initial);
  // Dogecoin / Dash testnets have no public server: say so instead of showing an address as if payments would appear.
  const dogeInfo = useAsync(family === 'doge' ? () => call('doge_backend_info') : family === 'dash' ? () => call('dash_backend_info') : null, [family, JSON.stringify(settings.servers.dogecoin), JSON.stringify(settings.servers.dash)]);
  const zecInfo = useAsync(family === 'zec' ? () => call('zec_backend_info') : null, [family]);
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
  const symbol = { btc: 'BTC', evm: 'ETH', sol: 'SOL', ltc: 'LTC', doge: 'DOGE', zec: 'ZEC', bch: 'BCH', dash: 'DASH', tron: 'TRX', xrp: 'XRP', ada: 'ADA', ton: 'GRAM', xmr: 'XMR', dot: dot.nativeSymbol, hbar: 'HBAR', xlm: 'XLM', near: 'NEAR', sui: 'SUI', kas: 'KAS', algo: 'ALGO', cosmos: 'ATOM', apt: 'APT' }[family];
  // TRON, XRP, Cardano, Stellar, NEAR, Sui, Kaspa, Algorand, Cosmos and Aptos have no payment-link format Kyro relies on: the QR is the bare address.
  const amountLink = family !== 'tron' && family !== 'xrp' && family !== 'ada' && family !== 'dot' && family !== 'hbar' && family !== 'xlm' && family !== 'near' && family !== 'sui' && family !== 'kas' && family !== 'algo' && family !== 'cosmos' && family !== 'apt';
  const xlmAccount = useAsync(family === 'xlm' && adapters.stellar ? () => adapters.stellar!.account() : null, [family, adapters.stellar]);
  const xrpAccount = useAsync(family === 'xrp' && adapters.xrp ? () => adapters.xrp!.account() : null, [family, adapters.xrp]);
  const nearAccount = useAsync(family === 'near' && adapters.near ? () => adapters.near!.account() : null, [family, adapters.near]);
  const nearTokens = useAsync(family === 'near' && adapters.near ? () => adapters.near!.tokenStatus() : null, [family, adapters.near]);
  const dotAccount = useAsync(family === 'dot' && adapters.polkadot ? () => adapters.polkadot!.account() : null, [family, adapters.polkadot]);
  // Algorand: does our account exist yet (≥ 0.1 ALGO received)? Rekeyed?
  const algoAccount = useAsync(family === 'algo' && adapters.algo ? () => adapters.algo!.account() : null, [family, adapters.algo]);
  // ZIP 321 payment URIs (`zcash:t1…?amount=`), same shape as BIP 21.
  const uriScheme = { btc: 'bitcoin', ltc: 'litecoin', doge: 'dogecoin', dash: 'dash', zec: 'zcash' } as const;
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
    if (family === 'ton') return `ton://transfer/${address}?amount=${amountBase.toString()}`;
    return `solana:${address}?amount=${dec}`;
  }, [askAmount, amountBase, amount, family, address, evm.chainId]);

  const newAddress = async () => {
    setDeriveError(null);
    const next = index + 1;
    try {
      const a = isUtxoReceive(family)
        ? activeHw
          ? (adapters[family]?.addressAt(0, next).address ?? '')
          : await call(`${family}_address`, { change: false, index: next, ...(account ? { account } : {}) })
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
    // Ledger single-key chains: the app shows the address (NEAR: the ed25519 key), Rust compares.
    if (activeHw && (family === 'sui' || family === 'apt' || family === 'algo' || family === 'near' || family === 'cosmos' || family === 'ton' || family === 'hbar')) {
      const keyChain = family;
      const shown = address;
      let deviceId = '';
      try {
        const d = await pickDevice(activeHw.device);
        deviceId = d.id;
        setVerify({ state: 'running', deviceId });
        const res = await withDevice(deviceId, () => call('hw_key_verify', { id: deviceId, accountId: activeHw.id, chain: keyChain }));
        if (res.address !== shown) throw new Error(t('receive.verifyMismatch'));
        setVerify({ state: 'ok', address: shown });
      } catch (e) {
        setVerify({ state: 'error', error: e, address: shown });
        if (isAddressMismatch(e)) setMismatch(e);
      }
      return;
    }
    if (!activeHw) return;
    const chain: HwImplementedChain | null = family === 'xlm' ? 'stellar' : family === 'ada' ? 'cardano' : family === 'zec' || family === 'btc' || family === 'evm' || family === 'sol' || family === 'tron' || family === 'xrp' || family === 'ltc' || family === 'doge' || family === 'bch' || family === 'dash' ? family : null;
    if (!chain) return;
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
                      : activeHw
                        ? t('receive.descHbarKey')
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

  const meta = FAMILY_META.find(([f]) => f === family) ?? FAMILY_META[0];
  const color = coinColor({ id: family === 'evm' ? 'ethereum' : family, glyph: meta[2], color: meta[3] });
  const avail = FAMILY_META.filter(([f]) => !isHiddenFamily(f) && has[f]);
  const at = avail.findIndex(([f]) => f === family);
  const prev = avail.length > 1 ? avail[(at - 1 + avail.length) % avail.length] : undefined;
  const next = avail.length > 1 ? avail[(at + 1) % avail.length] : undefined;
  const pick = (f: Family) => {
    setFamily(f);
    setAmount('');
    setAskAmount(false);
  };
  const addrChain = { btc: 'Bitcoin', evm: 'Ethereum', sol: 'Solana', ltc: 'Litecoin', doge: 'Dogecoin', zec: t('receive.chainZec'), bch: 'Bitcoin Cash', dash: 'Dash', tron: 'TRON', xrp: 'XRP', ada: 'Cardano', apt: 'Aptos', cosmos: 'Cosmos Hub', ton: 'TON', xmr: 'Monero', algo: 'Algorand', dot: 'Polkadot', kas: 'Kaspa', hbar: hbarShowId ? t('receive.chainHbarId') : activeHw ? t('receive.chainHbarKey') : t('receive.chainHbarEvm'), sui: 'Sui', xlm: 'Stellar', near: 'NEAR' }[family];
  const netLabel = `${chainName}${network === 'testnet' && !/testnet/i.test(chainName) ? ' (testnet)' : ''}`;
  const warning = `${t('receive.networkWarning', { chain: chainName })}${network === 'testnet' ? t('receive.testTokens') : ''}`;
  const canNew = family === 'btc' || isUtxoReceive(family);
  const S = 360;
  const tile = 146;
  const [copied, copy] = useCopy();
  const [copiedUri, copyUri] = useCopy();
  const single = family === 'btc' || family === 'ltc' || family === 'doge' || family === 'bch' || family === 'dash' || family === 'zec' || family === 'kas' || family === 'xmr';
  const coinName = meta[1];
  const onlyTitle = single ? t(/^[aeiouyh]/i.test(coinName) ? 'receive.onlyCoinVowel' : 'receive.onlyCoin', { coin: coinName }) : t('receive.onlyNetwork', { chain: netLabel });
  const onlyBody = single ? t('receive.onlyCoinBody', { symbol, chain: netLabel }) : warning;
  const rightTitle = askAmount && amountBase ? t('receive.qrWithAmount') : canNew ? t('receive.freshTitle') : t('receive.addressFormat');
  const rightBody = canNew ? t('receive.freshBody') : desc;
  const b = (c: ReactNode) => <strong className="font-semibold text-text">{c}</strong>;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto scroll-thin">
      <CoinGlow color={color} top={-20} />
      <div className="relative flex flex-col items-center pb-10">
        <div className="relative mt-4 w-full" style={{ height: S + 12 }}>
          {prev && (
            <button type="button" onClick={() => pick(prev[0])} className="press absolute left-8 flex items-center gap-2 text-[12.5px] text-faint transition-colors hover:text-text2" style={{ top: S / 2 + 6, transform: 'translateY(-50%)' }}>
              <span aria-hidden="true" className="text-[15px]">‹</span> {prev[1]}
            </button>
          )}
          {next && (
            <button type="button" onClick={() => pick(next[0])} className="press absolute right-8 flex items-center gap-2 text-[12.5px] text-faint transition-colors hover:text-text2" style={{ top: S / 2 + 6, transform: 'translateY(-50%)' }}>
              {next[1]} <span aria-hidden="true" className="text-[15px]">›</span>
            </button>
          )}
          <div key={family} className="pop-in absolute" style={{ left: `calc(50% - ${S / 2}px)`, top: 6 }}>
            <VaultRing size={S} segs={[{ color, part: 1 }]} halo={color}>
              <div key={uri} className={cn('pop-in transition-[opacity,filter] duration-300', blocked && 'pointer-events-none opacity-20 blur-md')} aria-hidden={blocked || undefined}>
                <QrTile value={uri} size={tile} color={color} />
              </div>
            </VaultRing>
          </div>
          <span className="absolute hidden items-center gap-3 xl:flex" style={{ right: `calc(50% + ${S / 2 + 14}px)`, top: S / 2 + 6, transform: 'translateY(-50%)' }}>
            <span className="flex max-w-[220px] flex-col items-end gap-0.5 text-right text-[12.5px] leading-snug text-mute">
              <span className="text-[13px] font-semibold text-text">{onlyTitle}</span>
              {onlyBody}
            </span>
            <span className="h-px w-12 bg-white/[.18]" />
            <span className="size-[6px] bg-[#cfe7ff]" />
          </span>
          <span className="absolute hidden items-center xl:flex" style={{ left: `calc(50% + ${tile / 2 + 8}px)`, top: S / 2 + 6, transform: 'translateY(-50%)' }}>
            <span className="size-[6px] bg-[#cfe7ff]" />
            <span className="h-px bg-white/[.22]" style={{ width: S / 2 - tile / 2 + 56 }} />
            <span className="flex max-w-[230px] flex-col gap-0.5 pl-3 text-[12.5px] leading-snug text-mute">
              <span className="text-[13px] font-semibold text-text">{rightTitle}</span>
              {rightBody}
            </span>
          </span>
        </div>

        <div className="mt-3 flex flex-col items-center">
          <span className={LABEL}>{t('receive.yourAddress', { chain: addrChain })}</span>
          <span className={cn('mt-3.5 max-w-[640px] text-center', blocked && 'pointer-events-none opacity-30 blur-[3px]')} aria-hidden={blocked || undefined}>
            <CoinAddress key={address} address={address} color={color} className="fade-in text-[17px] leading-[1.7]" />
          </span>
          <span className="mt-2 max-w-[560px] text-center text-[12.5px] leading-[1.5] text-mute xl:hidden">
            <span className="font-semibold text-text2">{onlyTitle}</span> · {onlyBody} {rightBody}
          </span>
        <div className="mt-6 flex flex-wrap justify-center gap-2.5">
          {activeHw ? (
            <>
              <Frost className="w-[230px]" disabled={blocked || verify.state === 'running' || !address} onClick={() => void verifyOnDevice()}>
                <IconUsbKey size={16} /> {t('receive.verifyOnDevice')}
              </Frost>
              <GlassButton className={cn('h-12 w-[190px]', blocked && 'pointer-events-none opacity-40')} onClick={() => copy(address)}>
                {copied ? <IconCheck size={16} className="text-up" /> : <IconCopy size={16} sw={2.1} />} {copied === null ? t('receive.copyAddress') : copied ? t('common.copied') : t('shell.copyFailed')}
              </GlassButton>
            </>
          ) : (
            <Frost className="w-[210px]" disabled={!address} onClick={() => copy(address)}>
              {copied ? <IconCheck size={16} className="text-up" /> : <IconCopy size={16} sw={2.1} />} {copied === null ? t('receive.copyAddress') : copied ? t('common.copied') : t('shell.copyFailed')}
            </Frost>
          )}
          {canNew && (
            <GlassButton className="h-12 w-[180px]" title={t('receive.newAddressTitle')} onClick={() => void newAddress()}>
              <IconRefresh size={16} sw={2.1} /> {t('receive.newAddress')}
            </GlassButton>
          )}
          {amountLink && (
            <GlassButton
              className="h-12 w-[180px]"
              aria-pressed={askAmount}
              onClick={() => {
                if (askAmount) setAmount('');
                setAskAmount(!askAmount);
              }}
              style={askAmount ? { color, boxShadow: `inset 0 0 0 1.5px ${color}aa, 0 0 18px ${color}26`, background: `${color}14` } : undefined}
            >
              {t('receive.askAmount')}
            </GlassButton>
          )}
        </div>

        </div>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
            <Menu
              value={family}
              onSelect={(f) => pick(f)}
              label={t('receive.network')}
              className="w-[300px]"
              items={FAMILY_META.filter(([f]) => !isHiddenFamily(f)).map(([f, label, glyph, c]) => ({
                value: f,
                label,
                disabled: !has[f],
                ...(has[f] ? {} : { hint: VAULT_ONLY.includes(f) ? t('receive.vaultOnlyTitle') : t('receive.noKeysTitle') }),
                icon: <CoinIcon glyph={glyph} color={c} id={f === 'evm' ? 'ethereum' : f} size={22} />,
              }))}
              trigger={
                <button type="button" className={cn('press flex h-10 items-center gap-2.5 rounded-[13px] pr-3 pl-1.5 text-[13.5px] font-semibold hover:bg-white/[.08]', GLASS_ROW)}>
                  <CoinIcon glyph={meta[2]} color={meta[3]} id={family === 'evm' ? 'ethereum' : family} size={28} />
                  {meta[1]}
                  <IconChevronDown size={14} className="text-faint" />
                </button>
              }
            />
          <AccountPicker family={family} />
          <NewAccountButton family={family} />
          {(family === 'btc' || (family === 'hbar' && hbarId && hbarEvmOk)) && (
            <div>
              {family === 'btc' ? (
                <KSegmented
                  label={t('receive.addressType')}
                  accent={color}
                  value={kind}
                  onChange={(k) => {
                    setKind(k);
                    setIndex(0);
                    setVerify({ state: 'idle' });
                  }}
                  items={[
                    { id: 'segwit', label: 'SegWit' },
                    { id: 'taproot', label: 'Taproot' },
                  ]}
                />
              ) : (
                <KSegmented label="Format" accent={color} value={hbarView} onChange={setHbarView} items={[{ id: 'id', label: t('receive.hbarFormatId', { id: hbarId ?? '' }) }, { id: 'evm', label: t('receive.hbarFormatEvm') }]} />
              )}
            </div>
          )}
        </div>
        <span className="mt-2 font-mono text-[11px] text-faint">{path}</span>
        {activeHw && <span className="mt-2 max-w-[640px] text-center text-[12px] leading-[1.5] text-faint">{t('receive.hwUnsupported')}</span>}

        <div className="mt-5 flex w-full max-w-[560px] flex-col gap-3">
          {askAmount && amountLink && (
            <div className="pop-in flex flex-col items-center gap-2.5">
              <label className={cn('flex h-14 w-full items-center gap-3 rounded-[16px] px-5 focus-within:ring-white/[.18]', GLASS_ROW)}>
                <span className={LABEL}>{t('receive.requestedAmount')}</span>
                <input autoFocus value={amount} inputMode="decimal" placeholder="0" aria-label={t('receive.requestedAmount')} onChange={(e) => setAmount(sanitizeDecimalInput(e.target.value, decimals))} className="min-w-0 flex-1 bg-transparent text-right text-[24px] leading-none" style={{ ...THIN, ...BIG(color) }} />
                <span className="text-[14px] font-semibold" style={GLOW(color)}>{symbol}</span>
              </label>
              {amountBase !== null && amountBase > 0n && (
                <div className={cn('flex w-full items-center gap-3 rounded-[14px] py-1.5 pr-1.5 pl-4', GLASS_ROW)}>
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-mute">{uri}</span>
                  <button type="button" onClick={() => copyUri(uri)} className="press flex h-8 items-center gap-1.5 rounded-[10px] px-3 text-[12.5px] font-semibold text-text hover:bg-white/[.08]">
                    {copiedUri ? <IconCheck size={14} className="text-up" /> : <IconCopy size={14} />} {copiedUri === null ? t('receive.copyLink') : copiedUri ? t('common.copied') : t('shell.copyFailed')}
                  </button>
                </div>
              )}
            </div>
          )}
          {verify.state === 'running' && activeHw && (
            <HwWaiting deviceId={verify.deviceId} idle={t('receive.connecting', { device: BRAND[activeHw.device] })} confirm={{ title: t('receive.compareTitle'), detail: t('receive.compareDetail') }} />
          )}
          {activeHw && !verifiedHere && !blocked && verify.state !== 'running' && (
            <span className="flex items-center justify-center gap-2 text-center text-[12.5px] text-mute">
              <DeviceBadge device={activeHw.device} model={activeHw.model} />
              {t('receive.hwCheckFirst')}
            </span>
          )}
          {verifiedHere && <InfoLine tone="success">{t('receive.verified')}</InfoLine>}
          {verify.state === 'error' && !isAddressMismatch(verify.error) && verify.address === address && <HwErrorNotice error={verify.error} onRetry={() => void verifyOnDevice()} />}
          {blocked && <InfoLine tone="error">{rt('receive.blocked', { b })}</InfoLine>}
          {deriveError && <InfoLine tone="error">{deriveError}</InfoLine>}
          {(family === 'doge' || family === 'dash') && dogeInfo.data && !dogeInfo.data.available && (
            <InfoLine tone="warn">
              {rt('receive.dogeNoServer', { b }, { coin: family === 'dash' ? 'Dash' : 'Dogecoin' })}
              <button type="button" onClick={() => navigate({ name: 'settings', section: 'networks' })} className="mt-1 block font-semibold text-ice hover:underline">
                {t('receive.dogeConfigure', { coin: family === 'dash' ? 'Dash' : 'Dogecoin' })}
              </button>
            </InfoLine>
          )}
          {family === 'zec' && (
            <InfoLine tone="warn">
              {rt('receive.zecNote', { b, t: (c) => <strong>{c}</strong> })}
              {zecInfo.data && !zecInfo.data.available && <span className="mt-1 block font-semibold">{t('receive.zecTestnetNoServer')}</span>}
            </InfoLine>
          )}
          {family === 'tron' && <InfoLine>{rt('receive.tronNote', { b })}</InfoLine>}
          {family === 'ada' && <InfoLine>{rt('receive.adaNote', { b })}</InfoLine>}
          {family === 'kas' && <InfoLine>{rt('receive.kasNote', { b })}</InfoLine>}
          {family === 'xmr' && adapters.xmr && <XmrReceivePanel adapter={adapters.xmr} hidden={hideBalances} />}
          {family === 'xmr' && <InfoLine>{rt('receive.xmrNote', { b })}</InfoLine>}
          {family === 'ton' && (
            <InfoLine>
              {rt('receive.tonNote', { b })}
              {network === 'testnet' ? t('receive.tonTestnetId') : ''}
              {network === 'mainnet' && <span className="mt-1 block">{rt('receive.tonJettonNote', { b })}</span>}
            </InfoLine>
          )}
          {family === 'xrp' && (
            <InfoLine>
              {rt('receive.xrpNote', { b })}
              {xrpAccount.data && !xrpAccount.data.exists && <span className="mt-1 block font-semibold text-warn">{t('receive.xrpNotActivated')}</span>}
            </InfoLine>
          )}
          {family === 'xlm' && (
            <InfoLine>
              {rt('receive.xlmReserve', { b })}
              {xlmAccount.data && !xlmAccount.data.exists && <span className="mt-1 block font-semibold text-warn">{t('receive.xlmNotCreated')}</span>}
              {xlmAccount.data?.exists && <span className="mt-1 block text-text2">{t('receive.xlmExists', { reserve: fmtCrypto(BigInt(xlmAccount.data.reserve), 7, 'XLM', 7) })}</span>}
            </InfoLine>
          )}
          {family === 'xlm' && adapters.stellar && <StellarTrustPanel adapter={adapters.stellar} hidden={hideBalances} />}
          {family === 'near' && (
            <InfoLine>
              {rt('receive.nearNote', { b })}
              {nearAccount.data && !nearAccount.data.exists && <span className="mt-1 block font-semibold text-warn">{t('receive.nearNotCreated')}</span>}
              {nearTokens.data && nearTokens.data.length > 0 && <span className="mt-1 block">{rt('receive.nearTokenNote', { b }, { status: nearTokens.data.map((x) => `${x.symbol} ${x.registered ? t('receive.nearRegistered') : t('receive.nearNotRegistered')}`).join(' · ') })}</span>}
            </InfoLine>
          )}
          {family === 'sui' && (
            <InfoLine>
              {rt('receive.suiNote', { b })}
              {network === 'mainnet' && <span className="mt-1 block">{rt('receive.suiTokenNote', { b })}</span>}
            </InfoLine>
          )}
          {family === 'hbar' && (
            <InfoLine tone={!activeHw && !(hbarAccount.data && !hbarAccount.data.exists) && !hbarEvmOk ? 'warn' : 'info'}>
              {activeHw && hbarAccount.data && !hbarAccount.data.exists ? (
                <>{rt('receive.hbarHwNotCreated', { b })}</>
              ) : activeHw ? (
                <>{rt('receive.hbarHwNote', { b }, { id: hbarAccount.data?.accountIdChecksum ?? hbarId ?? '…' })}</>
              ) : hbarAccount.data && !hbarAccount.data.exists ? (
                <>{rt('receive.hbarNotCreated', { b })}</>
              ) : !hbarEvmOk ? (
                <span className="font-semibold text-warn">{t('receive.hbarFoundByKey', { id: hbarId ?? '' })}</span>
              ) : (
                <>{rt('receive.hbarNote', { b }, { id: hbarAccount.data?.accountIdChecksum ?? hbarId ?? '…' })}</>
              )}
            </InfoLine>
          )}
          {family === 'hbar' && adapters.hbar && hbarAccount.data && <HbarTokens adapter={adapters.hbar} account={hbarAccount.data} />}
          {family === 'dot' && (
            <InfoLine>
              {rt('receive.dotNote', { b }, {
                amount: `${(dotAccount.data ? String(Number(dotAccount.data.existentialDeposit) / 10 ** dot.nativeDecimals) : '0.01').replace('.', lang === 'fr' ? ',' : '.')} ${dot.nativeSymbol}`,
              })}
              {dotAccount.data && !dotAccount.data.exists && <span className="mt-1 block font-semibold text-warn">{t('receive.dotNotCreated', { symbol: dot.nativeSymbol })}</span>}
              {network === 'mainnet' && <span className="mt-1 block">{rt('receive.dotTokenNote', { b })}</span>}
            </InfoLine>
          )}
          {family === 'algo' && (
            <InfoLine>
              {rt('receive.algoNote', { b })}
              <span className="mt-1 block">{t('receive.algoLedgerPath')}</span>
              {algoAccount.data && !algoAccount.data.exists && <span className="mt-1 block font-semibold text-warn">{t('receive.algoNotCreated')}</span>}
              {algoAccount.data?.authAddr && <span className="mt-1 block font-semibold text-down">{t('receive.algoRekeyed', { addr: algoAccount.data.authAddr })}</span>}
            </InfoLine>
          )}
          {family === 'algo' && adapters.algo && <AlgoTokens adapter={adapters.algo} />}
          {family === 'cosmos' && <InfoLine>{rt('receive.cosmosNote', { b })}</InfoLine>}
          {family === 'apt' && (
            <InfoLine>
              {rt('receive.aptNote', { b })}
              {network === 'mainnet' && <span className="mt-1 block">{rt('receive.aptTokenNote', { b })}</span>}
            </InfoLine>
          )}
          {family === 'btc' && cbfMode && <InfoLine>{rt('receive.cbfNote', { b })}</InfoLine>}
        </div>
      </div>
      {mismatch !== null && <AddressMismatchStop error={mismatch} onClose={() => setMismatch(null)} />}
    </div>
  );
}
