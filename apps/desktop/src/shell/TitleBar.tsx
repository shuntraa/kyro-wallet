// SPDX-License-Identifier: GPL-3.0-or-later
// Integrated title bar (40 px): logo, breadcrumb, Ctrl K search, window controls.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { isTauri } from '@kyro/shared';
import { KyroMark } from '../components/kit';
import { IconSearch } from '../components/icons';

async function win(action: 'minimize' | 'toggleMaximize' | 'close') {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const w = getCurrentWindow();
  await w[action]();
}

export function WindowControls() {
  const btn = 'flex h-10 w-[46px] items-center justify-center text-mute hover:bg-raised hover:text-text';
  return (
    <div className="flex h-10">
      <button type="button" aria-label="Réduire" className={btn} onClick={() => void win('minimize')}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M1 6h10" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
      <button type="button" aria-label="Agrandir" className={btn} onClick={() => void win('toggleMaximize')}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
      <button type="button" aria-label="Fermer" className={`${btn} hover:!bg-[#c42b1c] hover:!text-white`} onClick={() => void win('close')}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M1.5 1.5l9 9M10.5 1.5l-9 9" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
    </div>
  );
}

export interface SearchResult {
  id: string;
  label: string;
  hint: string;
  onSelect: () => void;
}

export function TitleBar({ crumbs, center, search, bordered = true }: { crumbs?: string[]; center?: ReactNode; search?: (q: string) => SearchResult[]; bordered?: boolean }) {
  return (
    <header data-tauri-drag-region className={`flex h-10 shrink-0 items-center justify-between pl-4 ${bordered ? 'border-b border-rail' : ''}`}>
      <div data-tauri-drag-region className="flex w-[300px] min-w-0 items-center gap-2">
        <KyroMark size={16} />
        <span className="text-[13px] font-semibold tracking-[-0.01em]">Kyro</span>
        {crumbs?.map((c, i) => (
          <span key={i} className="flex min-w-0 items-center gap-2">
            <span className="text-[13px] text-faint">/</span>
            <span className="truncate text-[13px] text-mute">{c}</span>
          </span>
        ))}
      </div>
      <div data-tauri-drag-region className="flex min-w-0 flex-1 justify-center">
        {search ? <SearchBox search={search} /> : center}
      </div>
      <div className="flex w-[300px] justify-end">
        <WindowControls />
      </div>
    </header>
  );
}

function SearchBox({ search }: { search: (q: string) => SearchResult[] }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  const results = useMemo(() => (q.trim() ? search(q.trim()).slice(0, 8) : []), [q, search]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ref.current?.focus();
        ref.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pick = (r: SearchResult | undefined) => {
    if (!r) return;
    r.onSelect();
    setQ('');
    setOpen(false);
    ref.current?.blur();
  };

  return (
    <div className="relative w-[380px]">
      <label className="flex h-7 items-center gap-2 rounded-[8px] border border-line bg-[#141417] px-2.5 text-[12px] text-mute focus-within:border-ice-line">
        <IconSearch size={14} />
        <span className="sr-only">Rechercher</span>
        <input
          ref={ref}
          type="search"
          value={q}
          placeholder="Rechercher un actif, une adresse…"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((s) => Math.min(results.length - 1, s + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((s) => Math.max(0, s - 1));
            } else if (e.key === 'Enter') pick(results[sel]);
            else if (e.key === 'Escape') {
              setQ('');
              ref.current?.blur();
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-[12px] text-text"
        />
        <span className="rounded-[4px] border border-line-3 px-[5px] py-px font-mono text-[10px] text-mute">Ctrl K</span>
      </label>
      {open && q.trim() && (
        <div className="absolute top-9 right-0 left-0 z-50 overflow-hidden rounded-[12px] border border-line-2 bg-[#15171b] p-1.5">
          {results.length === 0 ? (
            <div className="px-3 py-2.5 text-[12px] text-mute">Aucun résultat.</div>
          ) : (
            results.map((r, i) => (
              <button
                key={r.id}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(r)}
                className={`flex w-full items-center justify-between gap-3 rounded-[8px] px-3 py-2 text-left text-[13px] ${i === sel ? 'bg-control' : ''}`}
              >
                <span className="truncate font-medium">{r.label}</span>
                <span className="shrink-0 text-[11px] text-mute">{r.hint}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
