// SPDX-License-Identifier: GPL-3.0-or-later
//
// Jupiter (lite-api.jup.ag swap/v1); the swap tx is built on demand (recent blockhash).
// Fee: `platformFeeBps` + `feeAccount` (developers.jup.ag "Add fees to swap"), paid into the fee
// wallet's ATA for a mint in `solanaFeeMints`. The tx is checked by jupiter-verify.ts before signing.

import { fetchJson, netFetch, type NetFetch, l10n } from '@kyro/shared';
import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { feeForQuote, type ProviderFee } from '../fees';
import type { Quote, QuoteParams, SwapProvider } from '../types';
import { providerError, qs, toBig, unavailableReason, type ProviderOptions } from './common';

interface JupQuote {
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct?: string;
  platformFee?: { amount?: string; feeBps?: number } | null;
  routePlan?: Array<{ swapInfo?: { label?: string } }>;
}

const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

const MINT_LABELS: Record<string, string> = {
  So11111111111111111111111111111111111111112: 'SOL',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
};
const mintLabel = (m: string) => MINT_LABELS[m] ?? `${m.slice(0, 4)}…`;

export async function associatedTokenAccount(owner: string, mint: string, tokenProgram: string = TOKEN_PROGRAM): Promise<string> {
  const enc = getAddressEncoder();
  const [ata] = await getProgramDerivedAddress({ programAddress: ATA_PROGRAM, seeds: [enc.encode(address(owner)), enc.encode(address(tokenProgram)), enc.encode(address(mint))] });
  return ata;
}

/** Network fee of a typical Jupiter swap (base fee + priority), lamports. */
const JUP_FEE_LAMPORTS = 25_000;

export class JupiterProvider implements SwapProvider {
  readonly id = 'jupiter' as const;
  readonly name = 'Jupiter';
  readonly host = 'lite-api.jup.ag';
  private readonly fetcher: NetFetch;
  private readonly fee: ProviderFee;
  private readonly feeMints: readonly string[];

  constructor(opts: ProviderOptions & { feeMints?: readonly string[] } = {}) {
    this.fetcher = opts.fetch ?? netFetch;
    this.fee = opts.fee ?? { kind: 'none' };
    this.feeMints = opts.feeMints ?? [];
  }

  available(): boolean {
    return this.unavailableReason() === null;
  }

  unavailableReason(): string | null {
    return unavailableReason(this.fee, true);
  }

  supports(p: QuoteParams): boolean {
    return p.chain === 'solana' && (p.toChain === undefined || p.toChain === 'solana');
  }

  async quote(p: QuoteParams): Promise<Quote> {
    // The rate of THIS quote (curve of its USD value, at most 255: `platform_fee_bps` is a u8).
    const quoteFee = feeForQuote(this.fee, p);
    const fee = quoteFee.kind === 'fee' ? quoteFee : null;
    const feeMint = fee ? [p.buy.address, p.sell.address].find((m) => this.feeMints.includes(m)) : undefined;
    if (fee && !feeMint) throw new Error(l10n(`Jupiter : frais Kyro possibles seulement si ${this.feeMints.map(mintLabel).join(' ou ')} est dans la paire`, `Jupiter: Kyro fees only possible if ${this.feeMints.map(mintLabel).join(' or ')} is in the pair`));
    const url = `https://lite-api.jup.ag/swap/v1/quote?${qs({
      inputMint: p.sell.address,
      outputMint: p.buy.address,
      amount: p.sellAmount.toString(),
      slippageBps: p.slippageBps,
      ...(fee ? { platformFeeBps: fee.bps } : {}),
    })}`;
    let raw: JupQuote & Record<string, unknown>;
    try {
      raw = await fetchJson<JupQuote & Record<string, unknown>>(this.fetcher, url);
    } catch (e) {
      throw providerError(this.name, e);
    }
    if (fee && raw.platformFee?.feeBps !== fee.bps) throw new Error(l10n('Jupiter : frais Kyro non appliqués par le devis', 'Jupiter: Kyro fees not applied by the quote'));
    const feeAccount = fee && feeMint ? await associatedTokenAccount(fee.recipient, feeMint) : null;
    const fetcher = this.fetcher;
    const labels = [...new Set((raw.routePlan ?? []).map((r) => r.swapInfo?.label).filter((x): x is string => !!x))];
    const impact = raw.priceImpactPct !== undefined ? Number(raw.priceImpactPct) : NaN;
    const out: Quote = {
      provider: this.id,
      providerName: this.name,
      buyAmount: toBig(raw.outAmount),
      minBuyAmount: toBig(raw.otherAmountThreshold),
      gasFeeFiat: p.nativePriceFiat !== undefined ? (JUP_FEE_LAMPORTS / 1e9) * p.nativePriceFiat : null,
      providerFeeFiat: 0,
      providerFeeIncluded: true,
      kyroFeeBps: fee ? fee.bps : 0,
      priceImpact: Number.isFinite(impact) ? impact : null,
      allowanceTarget: null,
      solFeeAccount: feeAccount,
      tx: {
        kind: 'solana',
        build: async () => {
          try {
            const r = await fetchJson<{ swapTransaction: string }>(fetcher, 'https://lite-api.jup.ag/swap/v1/swap', {
              method: 'POST',
              body: { quoteResponse: raw, userPublicKey: p.taker, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto', ...(feeAccount ? { feeAccount } : {}) },
            });
            return r.swapTransaction;
          } catch (e) {
            throw providerError('Jupiter', e);
          }
        },
      },
      etaSecs: 5,
    };
    if (labels.length) out.route = labels.join(' + ');
    return out;
  }
}
