// SPDX-License-Identifier: GPL-3.0-or-later
// Réglages → Affichage: the fiat currency (dropdown of FIAT_CURRENCIES, named in the current
// language through Intl: « Franc suisse », « Japanese Yen »).

import { FIAT_CURRENCIES, intlLocale, type Currency } from '@kyro/shared';
import { fiatSymbol } from '../lib/format';
import { Menu } from './ui/menu';
import { IconChevronDown } from './icons';

function currencyName(c: Currency): string {
  try {
    const name = new Intl.DisplayNames([intlLocale()], { type: 'currency' }).of(c);
    return name ? name.charAt(0).toUpperCase() + name.slice(1) : c;
  } catch {
    return c;
  }
}

export function CurrencySelect({ value, onChange, label }: { value: Currency; onChange: (c: Currency) => void; label: string }) {
  const sym = (c: Currency) => {
    const s = fiatSymbol(c);
    return s === c ? '' : s;
  };
  return (
    <Menu
      value={value}
      onSelect={onChange}
      align="end"
      className="w-[300px]"
      items={FIAT_CURRENCIES.map((c) => ({ value: c, label: `${c} · ${currencyName(c)}`, hint: sym(c) }))}
      trigger={
        <button type="button" aria-label={`${label} : ${value}`} className="press flex h-9 min-w-[180px] items-center gap-2 rounded-ctl border border-line-2 bg-raised px-3 text-left text-[13px] hover:border-line-3">
          <span className="flex-1 truncate">
            <span className="font-mono font-medium">{value}</span> <span className="text-mute">{currencyName(value)}</span>
          </span>
          <IconChevronDown size={14} className="text-mute" />
        </button>
      }
    />
  );
}
