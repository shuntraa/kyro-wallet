// SPDX-License-Identifier: GPL-3.0-or-later
// Receive: real QR (qrcode), BTC SegWit/Taproot, Litecoin, Dogecoin, TRON, XRP, Cardano, optional
// requested amount (BIP21-style / EIP-681 / Solana Pay URI; none for TRON, XRP, Cardano), network warning.

import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { bitcoinServerFor, call, toIpcError, type BtcKind, type HwImplementedChain } from '@kyro/shared';
import { btcChain, dogeChain, hwPaths, ltcChain, primaryEvmChain, solChain, tronChain, tryParseUnits, xrpChain, cardanoChain } from '@kyro/chains';
import { useAsync } from '../lib/useAsync';
import { useApp, useVault } from '../state/app';
import { cn } from '../lib/cn';
import { sanitizeDecimalInput } from '../lib/format';
import { useT } from '../i18n';
import { rt } from '../i18n/rich';
import { AddressBlocks, CoinIcon, CopyButton } from '../components/kit';
import { QrCode } from '../components/QrCode';
import { Button, IconButton, Notice, Segmented } from '../components/ui/primitives';
import { IconBack, IconCheck, IconInfo, IconRefresh, IconUsbKey, IconWarn } from '../components/icons';
import { AddressMismatchStop, DeviceBadge, HwErrorNotice, HwWaiting } from '../components/hw';
import { AccountPicker, NewAccountButton } from '../components/AccountPicker';
import { BRAND, isAddressMismatch, pickDevice, withDevice } from '../state/hw';

type Family = 'btc' | 'evm' | 'sol' | 'ltc' | 'doge' | 'tron' | 'xrp' | 'ada';
const FAMILIES: Family[] = ['btc', 'evm', 'sol', 'ltc', 'doge', 'tron', 'xrp', 'ada'];
/** Vault-only chains (hardware wallets: HW_UNSUPPORTED for now). */
const VAULT_ONLY: readonly Family[] = ['ltc', 'doge', 'tron', 'xrp', 'ada'];

export function Receive({ family: initial = 'evm' }: { family?: Family }) {
  const { t } = useT();
  const { back, network, settings, navigate, selectedAccounts } = useApp();
  const cbfMode = bitcoinServerFor(settings.servers, network).kind === 'cbf';
  const { accounts, adapters, activeHw } = useVault();
  // Hardware-wallet accounts have no Litecoin / Dogecoin / TRON (HW_UNSUPPORTED for now).
  const has: Record<Family, boolean> = { btc: !!accounts.btc, evm: !!accounts.evm, sol: !!accounts.sol, ltc: !!accounts.ltc, doge: !!accounts.doge, tron: !!accounts.tron, xrp: !!accounts.xrp, ada: !!accounts.cardano };
  const [family, setFamilyRaw] = useState<Family>(has[initial] ? initial : FAMILIES.find((f) => has[f]) ?? initial);
  // Dogecoin has no public server: say so instead of showing an address as if payments would appear.
  const dogeInfo = useAsync(family === 'doge' ? () => call('doge_backend_info') : null, [family, JSON.stringify(settings.servers.dogecoin)]);
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
  const tron = tronChain(network);
  const xrp = xrpChain(network);
  const ada = cardanoChain(network);

  const btcAcc = accounts.btc?.[kind];
  const utxoAcc = family === 'ltc' ? accounts.ltc : family === 'doge' ? accounts.doge : undefined;
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
              : family === 'evm'
          ? activeHw
            ? hwPaths.evm(activeHw)
            : (accounts.evm?.path ?? "m/44'/60'/0'/0/0")
          : activeHw
            ? (hwPaths.sol(activeHw) ?? '')
            : (accounts.sol?.path ?? "m/44'/501'/0'/0'");
  const verifiedHere = verify.state === 'ok' && verify.address === address;
  const blocked = mismatch !== null || (verify.state === 'error' && isAddressMismatch(verify.error) && verify.address === address);
  const chainName = { btc: btc.name, evm: evm.name, sol: sol.name, ltc: ltc.name, doge: doge.name, tron: tron.name, xrp: xrp.name, ada: ada.name }[family];
  const decimals = { btc: 8, evm: 18, sol: 9, ltc: 8, doge: 8, tron: 6, xrp: 6, ada: 6 }[family];
  const symbol = { btc: 'BTC', evm: 'ETH', sol: 'SOL', ltc: 'LTC', doge: 'DOGE', tron: 'TRX', xrp: 'XRP', ada: 'ADA' }[family];
  // TRON, XRP and Cardano have no payment-link format Kyro relies on: the QR is the bare address.
  const amountLink = family !== 'tron' && family !== 'xrp' && family !== 'ada';
  // XRP: is our account activated yet (≥ 1 XRP base reserve received)?
  const xrpAccount = useAsync(family === 'xrp' && adapters.xrp ? () => adapters.xrp!.account() : null, [family, adapters.xrp]);
  const uriScheme = { btc: 'bitcoin', ltc: 'litecoin', doge: 'dogecoin' } as const;
  const amountBase = amount ? tryParseUnits(amount, decimals) : null;

  const uri = useMemo(() => {
    const dec = amount.replace(',', '.');
    const scheme = family === 'btc' || family === 'ltc' || family === 'doge' ? uriScheme[family] : null;
    if (!askAmount || !amountBase || amountBase <= 0n) return scheme ? `${scheme}:${address}` : address;
    if (scheme) return `${scheme}:${address}?amount=${dec}`;
    if (family === 'tron' || family === 'xrp' || family === 'ada') return address;
    if (family === 'evm') return `ethereum:${address}@${evm.chainId}?value=${amountBase.toString()}`;
    return `solana:${address}?amount=${dec}`;
  }, [askAmount, amountBase, amount, family, address, evm.chainId]);

  const newAddress = async () => {
    setDeriveError(null);
    const next = index + 1;
    try {
      // Vault: Rust derives from the seed. Hardware wallet: public derivation from the stored xpub
      // (then verify it on the device).
      const a =
        family === 'ltc'
          ? await call('ltc_address', { change: false, index: next, ...(account ? { account } : {}) })
          : family === 'doge'
            ? await call('doge_address', { change: false, index: next, ...(account ? { account } : {}) })
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
    if (!activeHw || family === 'ltc' || family === 'doge' || family === 'tron' || family === 'xrp' || family === 'ada') return;
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
            : family === 'tron'
              ? network === 'testnet'
                ? t('receive.descTronTestnet')
                : t('receive.descTron')
              : family === 'xrp'
                ? t('receive.descXrp')
                : family === 'ada'
                  ? t('receive.descAda')
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
              ['tron', 'TRON', 'T', '#EB0029'],
              ['xrp', 'XRP', 'X', '#3A3F48'],
              ['ada', 'Cardano', 'A', '#3468D1'],
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
            <span className="eyebrow">{t('receive.yourAddress', { chain: { btc: 'Bitcoin', evm: 'Ethereum', sol: 'Solana', ltc: 'Litecoin', doge: 'Dogecoin', tron: 'TRON', xrp: 'XRP', ada: 'Cardano' }[family] })}</span>
            <span className="text-[15px] leading-[1.45] text-text2">{desc}</span>
          </div>
          {(family === 'ltc' || family === 'doge') && (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => void newAddress()} title={t('receive.newAddressTitle')}>
                <IconRefresh size={14} /> {t('receive.newAddress')}
              </Button>
            </div>
          )}
          {family === 'doge' && dogeInfo.data && !dogeInfo.data.available && (
            <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
              {rt('receive.dogeNoServer', { b: (c) => <strong className="font-semibold">{c}</strong> })}
              <button type="button" onClick={() => navigate({ name: 'settings', section: 'networks' })} className="mt-1 block font-semibold text-ice hover:underline">
                {t('receive.dogeConfigure')}
              </button>
            </Notice>
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
                  <span className="text-[12px] text-faint">{t('receive.noPaymentLink', { chain: family === 'xrp' ? 'XRP Ledger' : family === 'ada' ? 'Cardano' : 'TRON' })}</span>
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
          {family === 'xrp' && (
            <Notice icon={<IconInfo size={16} className="mt-0.5 shrink-0 text-ice" />}>
              {rt('receive.xrpNote', { b: (c) => <strong className="font-semibold text-text">{c}</strong> })}
              {xrpAccount.data && !xrpAccount.data.exists && <span className="mt-1 block font-semibold text-warn">{t('receive.xrpNotActivated')}</span>}
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
