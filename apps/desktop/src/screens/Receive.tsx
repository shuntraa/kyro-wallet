// SPDX-License-Identifier: GPL-3.0-or-later
// Receive: real QR (qrcode), BTC SegWit/Taproot, optional requested amount
// (BIP21 / EIP-681 / Solana Pay URI), network warning.

import { useMemo, useState } from 'react';
import { call, toIpcError, type BtcKind } from '@kyro/shared';
import { btcChain, primaryEvmChain, solChain, tryParseUnits } from '@kyro/chains';
import { useApp, useVault } from '../state/app';
import { cn } from '../lib/cn';
import { sanitizeDecimalInput } from '../lib/format';
import { AddressBlocks, CoinIcon, CopyButton } from '../components/kit';
import { QrCode } from '../components/QrCode';
import { Button, IconButton, Notice, Segmented } from '../components/ui/primitives';
import { IconBack, IconRefresh, IconUsbKey, IconWarn } from '../components/icons';

type Family = 'btc' | 'evm' | 'sol';

export function Receive({ family: initial = 'evm' }: { family?: Family }) {
  const { back, network } = useApp();
  const { accounts } = useVault();
  const [family, setFamily] = useState<Family>(initial);
  const [kind, setKind] = useState<BtcKind>('segwit');
  const [index, setIndex] = useState(0);
  const [derived, setDerived] = useState<Record<string, string>>({});
  const [deriveError, setDeriveError] = useState<string | null>(null);
  const [askAmount, setAskAmount] = useState(false);
  const [amount, setAmount] = useState('');

  const btc = btcChain(network);
  const evm = primaryEvmChain(network);
  const sol = solChain(network);

  const address =
    family === 'btc' ? (index === 0 ? accounts.btc[kind].address : derived[`${kind}:${index}`] ?? accounts.btc[kind].address) : family === 'evm' ? accounts.evm.address : accounts.sol.address;
  const path = family === 'btc' ? `${accounts.btc[kind].path}/0/${index}` : family === 'evm' ? "m/44'/60'/0'/0/0" : "m/44'/501'/0'/0'";
  const chainName = family === 'btc' ? btc.name : family === 'evm' ? evm.name : sol.name;
  const decimals = family === 'btc' ? 8 : family === 'evm' ? 18 : 9;
  const symbol = family === 'btc' ? 'BTC' : family === 'evm' ? 'ETH' : 'SOL';
  const amountBase = amount ? tryParseUnits(amount, decimals) : null;

  const uri = useMemo(() => {
    const dec = amount.replace(',', '.');
    if (!askAmount || !amountBase || amountBase <= 0n) return family === 'evm' ? address : family === 'btc' ? `bitcoin:${address}` : address;
    if (family === 'btc') return `bitcoin:${address}?amount=${dec}`;
    if (family === 'evm') return `ethereum:${address}@${evm.chainId}?value=${amountBase.toString()}`;
    return `solana:${address}?amount=${dec}`;
  }, [askAmount, amountBase, amount, family, address, evm.chainId]);

  const newAddress = async () => {
    setDeriveError(null);
    const next = index + 1;
    try {
      const a = await call('btc_address', { kind, change: false, index: next });
      setDerived((d) => ({ ...d, [`${kind}:${next}`]: a }));
      setIndex(next);
    } catch (e) {
      setDeriveError(toIpcError(e).message);
    }
  };

  const desc =
    family === 'btc'
      ? kind === 'segwit'
        ? 'Adresse SegWit native (BIP84) : la plus compatible, frais réduits.'
        : 'Adresse Taproot (BIP86) : plus privée, frais encore plus bas. Certains services ne l’acceptent pas encore.'
      : family === 'evm'
        ? network === 'testnet'
          ? 'Sert aussi pour les tokens ERC-20 (USDC de test).'
          : 'Sert aussi pour les tokens ERC-20 et pour Arbitrum, Base, Optimism, Polygon, BNB Chain et Avalanche.'
        : 'Pour SOL et les tokens SPL.';

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 px-[26px] py-[22px]">
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <IconButton label="Retour au portefeuille" onClick={back} className="size-10 border-control-2">
            <IconBack size={16} />
          </IconButton>
          <h1 className="m-0 text-[28px] font-semibold tracking-[-0.03em]">Recevoir</h1>
        </div>
        <div role="group" aria-label="Réseau" className="flex gap-1 rounded-full border border-line bg-card p-1">
          {(
            [
              ['btc', 'Bitcoin', '₿', '#F7931A'],
              ['evm', 'Ethereum', 'Ξ', '#627EEA'],
              ['sol', 'Solana', 'S', '#35D0BA'],
            ] as const
          ).map(([f, label, glyph, color]) => (
            <button
              key={f}
              type="button"
              aria-pressed={family === f}
              onClick={() => {
                setFamily(f);
                setAmount('');
                setAskAmount(false);
              }}
              className={cn('flex h-10 items-center gap-2 rounded-full pr-4 pl-1.5 text-[13px]', family === f ? 'bg-control-2 font-semibold' : 'text-text2 hover:bg-raised')}
            >
              <CoinIcon glyph={glyph} color={color} size={26} />
              {label}
            </button>
          ))}
        </div>
      </header>

      <section className="relative flex min-h-0 flex-1 items-center justify-center gap-14 overflow-hidden rounded-[22px] border border-line bg-card-hero p-8">
        <div aria-hidden="true" className="absolute top-1/2 left-[34%] size-[760px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#16191E]" />
        <div aria-hidden="true" className="absolute top-1/2 left-[34%] size-[560px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#16191E]" />
        <div className="relative flex flex-col items-center gap-3">
          <QrCode value={uri} size={300} />
          <span className="font-mono text-[11px] tracking-[0.06em] text-faint">{askAmount && amountBase ? 'QR AVEC MONTANT' : 'QR DE L’ADRESSE'}</span>
        </div>

        <div className="relative flex w-[460px] flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] text-mute">Ton adresse {family === 'btc' ? 'Bitcoin' : family === 'evm' ? 'Ethereum' : 'Solana'}</span>
            <span className="text-[15px] leading-[1.45] text-text2">{desc}</span>
          </div>
          {family === 'btc' && (
            <div className="flex items-center gap-2">
              <Segmented
                label="Type d’adresse"
                value={kind}
                onChange={(k) => {
                  setKind(k);
                  setIndex(0);
                }}
                options={[
                  { value: 'segwit', label: 'SegWit' },
                  { value: 'taproot', label: 'Taproot' },
                ]}
              />
              <Button size="sm" variant="ghost" onClick={() => void newAddress()} title="Nouvelle adresse de réception (meilleure confidentialité)">
                <IconRefresh size={14} /> Nouvelle adresse
              </Button>
            </div>
          )}
          <AddressBlocks address={address} size="xl" />
          <div className="flex gap-2.5">
            <CopyButton text={address} variant="primary" size="xl" className="flex-1" />
            <Button size="xl" className="flex-1" disabled title="Hardware wallets : bientôt">
              <IconUsbKey size={16} /> Vérifier sur Ledger
            </Button>
          </div>
          {deriveError && <Notice tone="error">{deriveError}</Notice>}
          <dl className="m-0 flex flex-col overflow-hidden rounded-[14px] border border-line text-[13px]">
            <div className="flex h-11 items-center justify-between border-b border-line px-4">
              <dt className="text-mute">Réseau</dt>
              <dd className="m-0">
                {chainName}
                {network === 'testnet' ? ' (testnet)' : ''}
              </dd>
            </div>
            <div className="flex h-11 items-center justify-between border-b border-line px-4">
              <dt className="text-mute">Chemin de dérivation</dt>
              <dd className="m-0 font-mono text-[12px]">{path}</dd>
            </div>
            <div className="flex min-h-11 items-center justify-between gap-3 px-4 py-1.5">
              <dt className="text-mute">Montant demandé</dt>
              <dd className="m-0">
                {askAmount ? (
                  <span className="flex items-center gap-2">
                    <input autoFocus value={amount} inputMode="decimal" placeholder="0" onChange={(e) => setAmount(sanitizeDecimalInput(e.target.value, decimals))} className="h-8 w-[120px] rounded-[8px] border border-line-2 bg-bg px-2 text-right text-[13px]" />
                    <span className="text-mute">{symbol}</span>
                    <button type="button" onClick={() => { setAskAmount(false); setAmount(''); }} className="text-[12px] text-mute hover:text-text">
                      Retirer
                    </button>
                  </span>
                ) : (
                  <button type="button" onClick={() => setAskAmount(true)} className="font-semibold text-ice hover:underline">
                    Ajouter un montant
                  </button>
                )}
              </dd>
            </div>
          </dl>
          {askAmount && amountBase !== null && amountBase > 0n && (
            <div className="flex items-center justify-between gap-2 rounded-[12px] bg-raised py-1.5 pr-1.5 pl-3">
              <span className="truncate font-mono text-[11px] text-mute">{uri}</span>
              <CopyButton text={uri} label="Copier le lien" />
            </div>
          )}
          <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
            N’envoie ici que des actifs du réseau {chainName}. Un autre réseau = fonds perdus.
            {network === 'testnet' ? ' Les jetons de test n’ont aucune valeur.' : ''}
          </Notice>
        </div>
      </section>
    </div>
  );
}
