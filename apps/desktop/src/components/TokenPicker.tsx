// SPDX-License-Identifier: GPL-3.0-or-later
// Swap token picker: a dialog with a search field (focused on open) filtering by ticker, name or
// network, a network badge per row, ↑ ↓ / Enter / Esc, recent and popular coins first.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Dialog } from './ui/dialog';
import { IconCheck } from './icons';
import { cn } from '../lib/cn';
import { getRecentTokens, pushRecentToken, searchTokens, type PickerEntry } from '../lib/tokenSearch';
import { useT } from '../i18n';

export interface TokenPickerItem extends PickerEntry {
  hint: string;
  icon: ReactNode;
  /** Shown instead of the hint when greyed (« Bientôt »). */
  note?: string;
}

export function TokenPicker({ title, value, items, onSelect, trigger }: { title: string; value: string; items: TokenPickerItem[]; onSelect: (id: string) => void; trigger: (open: () => void) => ReactNode }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => searchTokens(items, query, recent), [items, query, recent]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setRecent(getRecentTokens());
    setActive(0);
  }, [open]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const pick = (it: TokenPickerItem | undefined) => {
    if (!it || it.disabled) return;
    setRecent(pushRecentToken(it.id));
    onSelect(it.id);
    setOpen(false);
  };
  const move = (from: number, step: 1 | -1) => {
    for (let i = from + step; i >= 0 && i < shown.length; i += step) if (!shown[i]?.disabled) return i;
    return from;
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') setActive((a) => move(a, 1));
    else if (e.key === 'ArrowUp') setActive((a) => move(a, -1));
    else if (e.key === 'Home') setActive(move(-1, 1));
    else if (e.key === 'End') setActive(move(shown.length, -1));
    else if (e.key === 'Enter') pick(shown[active]);
    // Escape closes from the search box too (not only from the dialog's own handler).
    else if (e.key === 'Escape') setOpen(false);
    else return;
    e.preventDefault();
  };

  return (
    <>
      {trigger(() => setOpen(true))}
      <Dialog open={open} onOpenChange={setOpen} title={title} className="w-[440px] gap-3">
        <input
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls="token-picker-list"
          aria-activedescendant={shown[active] ? `token-opt-${active}` : undefined}
          aria-label={t('swap.searchToken')}
          placeholder={t('swap.searchTokenPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          spellCheck={false}
          autoComplete="off"
          className="h-10 w-full rounded-ctl border border-line-2 bg-bg px-3 text-[14px] outline-none focus:border-ice-line"
        />
        <div id="token-picker-list" ref={listRef} role="listbox" className="-mx-2 flex max-h-[52vh] flex-col overflow-y-auto scroll-thin">
          {shown.length === 0 && <p className="px-3 py-6 text-center text-[13px] text-mute">{t('swap.searchNoResult', { query: query.trim() })}</p>}
          {shown.map((it, i) => (
            <div
              key={it.id}
              id={`token-opt-${i}`}
              data-index={i}
              role="option"
              aria-selected={i === active}
              aria-disabled={it.disabled || undefined}
              onMouseMove={() => !it.disabled && setActive(i)}
              onClick={() => pick(it)}
              className={cn('flex items-center gap-2.5 rounded-[6px] px-2.5 py-2 text-[13px]', it.disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer', i === active && !it.disabled && 'bg-control')}
            >
              {it.icon}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-2">
                  <span className="truncate font-medium">{it.symbol}</span>
                  <span className="shrink-0 rounded-[4px] border border-line-2 px-1.5 py-px text-[10.5px] leading-[1.4] text-mute">{it.network}</span>
                </span>
                <span className="truncate text-[12px] text-mute">{it.disabled && it.note ? it.note : it.hint}</span>
              </span>
              {value === it.id && <IconCheck size={14} className="text-ice" />}
            </div>
          ))}
        </div>
      </Dialog>
    </>
  );
}
