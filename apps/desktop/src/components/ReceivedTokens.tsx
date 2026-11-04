// SPDX-License-Identifier: GPL-3.0-or-later
// Tokens an address holds that Kyro can't send yet: read only. Names come from Rust's fixed tables;
// everything else stays folded, because anyone can send a token to an address.

import { call, type ReceivedToken } from '@kyro/shared';
import { useT } from '../i18n';
import { fmtCrypto, shortAddress } from '../lib/format';
import { useAsync } from '../lib/useAsync';

export type ReceivedTokenFamily = 'sui' | 'cosmos' | 'bch';

function load(family: ReceivedTokenFamily, address: string): Promise<ReceivedToken[]> {
  if (family === 'sui') return call('sui_received_tokens', { address });
  if (family === 'cosmos') return call('cosmos_received_tokens', { address });
  return call('bch_received_tokens', { address });
}

/** The amount of a line: in tokens when the decimals are known, else raw units, and any NFTs. */
export function tokenAmount(token: ReceivedToken, raw: string, nft: string): string {
  const parts: string[] = [];
  if (token.nfts === 0 || token.amount !== '0') {
    const amount = BigInt(token.amount);
    parts.push(token.decimals === null ? `${amount.toString()} ${raw}` : fmtCrypto(amount, token.decimals, token.symbol ?? undefined));
  }
  if (token.nfts > 0) parts.push(`${token.nfts} ${nft}`);
  return parts.join(' · ');
}

export function splitTokens(tokens: readonly ReceivedToken[]): { known: ReceivedToken[]; unknown: ReceivedToken[] } {
  return { known: tokens.filter((x) => x.known), unknown: tokens.filter((x) => !x.known) };
}

function Row({ token, hidden }: { token: ReceivedToken; hidden: boolean }) {
  const { t } = useT();
  return (
    <div className="flex h-9 items-center justify-between gap-4 border-t border-line text-[13px]">
      <span className="flex min-w-0 items-baseline gap-2">
        {token.symbol && <span className="font-medium">{token.symbol}</span>}
        {!token.known && <span className="truncate font-mono text-[12px] text-mute">{shortAddress(token.id)}</span>}
      </span>
      <span className="shrink-0 font-mono text-[12.5px] text-text2">{hidden ? '•••••' : tokenAmount(token, t('portfolio.rawUnits'), t('portfolio.nft'))}</span>
    </div>
  );
}

export function ReceivedTokens({ family, address, hidden }: { family: ReceivedTokenFamily; address: string; hidden: boolean }) {
  const { t } = useT();
  const { data } = useAsync(() => load(family, address), [family, address], { intervalMs: 120_000 });
  if (!data || data.length === 0) return null;
  const { known, unknown } = splitTokens(data);
  return (
    <section className="rise flex shrink-0 flex-col rounded-panel border border-line bg-card px-6 py-4">
      <div className="flex items-baseline justify-between gap-4 pb-2.5">
        <span className="text-[15px] font-medium tracking-[-0.01em]">{t('portfolio.otherTokens')}</span>
        <span className="text-[12px] text-mute">{t('portfolio.cantSendYet')}</span>
      </div>
      {known.map((x) => (
        <Row key={x.id} token={x} hidden={hidden} />
      ))}
      {unknown.length > 0 && (
        <details className="border-t border-line text-[13px]">
          <summary className="flex h-9 cursor-pointer items-center text-text2">{t('portfolio.unknownTokens', { n: unknown.length })}</summary>
          <p className="m-0 pb-2 text-[12px] leading-[1.5] text-mute">{t('portfolio.unknownTokensNote')}</p>
          <div className="max-h-[180px] overflow-y-auto scroll-thin">
            {unknown.map((x) => (
              <Row key={x.id} token={x} hidden={hidden} />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
