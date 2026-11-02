// SPDX-License-Identifier: GPL-3.0-or-later
// Integrated title bar (40 px): logo, breadcrumb, Ctrl K search, window controls.

import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { isTauri } from '@kyro/shared';
import { KyroMark } from '../components/kit';
import { IconSearch } from '../components/icons';
import { useT } from '../i18n';

async function win(action: 'minimize' | 'toggleMaximize' | 'close') {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const w = getCurrentWindow();
  await w[action]();
}

// Anything the user can interact with keeps its own clicks; the rest of the bar moves the window.
const NO_DRAG = 'button, input, textarea, select, a, label, [role="button"], [role="menu"], [role="listbox"], [data-no-drag]';

// Tauri 2's data-tauri-drag-region only reacts when the clicked element itself carries the
// attribute, so text spans and untagged columns were dead zones. One handler on the header
// covers every non-interactive descendant: drag on press, maximize/restore on double-click.
function onBarMouseDown(e: MouseEvent<HTMLElement>) {
  if (e.button !== 0 || !isTauri()) return;
  // React bubbles portal events (account menu) up here; only the bar's own DOM counts.
  if (!(e.target instanceof Element) || !e.currentTarget.contains(e.target) || e.target.closest(NO_DRAG)) return;
  e.preventDefault();
  if (e.detail === 2) void win('toggleMaximize');
  else
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().startDragging()).catch(() => {});
}

const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);

export function WindowControls() {
  const { t } = useT();
  const btn = 'flex h-10 w-[46px] items-center justify-center text-mute transition-colors duration-150 hover:bg-raised hover:text-text';
  return (
    <div className="flex h-10">
      <button type="button" aria-label={t('shell.minimize')} className={btn} onClick={() => void win('minimize')}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M1 6h10" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
      <button type="button" aria-label={t('shell.maximize')} className={btn} onClick={() => void win('toggleMaximize')}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
      <button type="button" aria-label={t('common.close')} className={`${btn} hover:!bg-[#c42b1c] hover:!text-white`} onClick={() => void win('close')}>
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

export function TitleBar({ crumbs, center, search, bordered = true, account }: { crumbs?: string[]; center?: ReactNode; search?: (q: string) => SearchResult[]; bordered?: boolean; account?: ReactNode }) {
  return (
    // Three columns: the side ones share what the search leaves, so the breadcrumb gets ~380 px
    // even at the 1100 px minimum (it used to be boxed in 300 px and cut to « Sola… »).
    <header onMouseDown={onBarMouseDown} className={`grid h-10 shrink-0 cursor-default grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center pl-4 select-none ${bordered ? 'border-b border-rail' : ''}`}>
      <div className="flex min-w-0 items-center gap-2 pr-4">
        <KyroMark size={15} className="shrink-0" />
        <span className="shrink-0 text-[13px] font-semibold tracking-[-0.02em]">Kyro</span>
        {account && (
          <span className="flex min-w-0 max-w-[220px] shrink items-center gap-1">
            <Slash />
            {account}
          </span>
        )}
        {crumbs?.map((c, i) => (
          <span key={`${i}:${c}`} className={`fade-in flex items-center gap-2 ${i === crumbs.length - 1 ? 'min-w-0' : 'shrink-0'}`}>
            <Slash />
            <span className={`truncate text-[13px] ${i === crumbs.length - 1 ? 'text-text2' : 'text-mute'}`}>{c}</span>
          </span>
        ))}
      </div>
      <div className="flex min-w-0 justify-center">
        {search ? <SearchBox search={search} /> : center}
      </div>
      <div className="flex min-w-0 justify-end">
        <WindowControls />
      </div>
    </header>
  );
}

function Slash() {
  return (
    <svg width="7" height="14" viewBox="0 0 7 14" aria-hidden="true" className="shrink-0 text-line-3">
      <path d="M6 1 1 13" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function ShortcutHint() {
  const keys = IS_MAC ? ['⌘', 'K'] : ['Ctrl', 'K'];
  return (
    <span aria-hidden="true" className="pointer-events-none flex shrink-0 items-center gap-[3px] transition-opacity duration-150 group-focus-within:opacity-0">
      {keys.map((k) => (
        <kbd key={k} className="flex h-[17px] min-w-[17px] items-center justify-center rounded-[4px] bg-control px-1 font-sans text-[10px] leading-none font-medium text-faint">
          {k}
        </kbd>
      ))}
    </span>
  );
}

function SearchBox({ search }: { search: (q: string) => SearchResult[] }) {
  const { t } = useT();
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
    <div className="relative w-[clamp(260px,28vw,380px)]">
      <label className="group flex h-7 cursor-text items-center gap-2 rounded-ctl border border-line bg-bg-deep px-2.5 text-[12px] text-mute transition-colors hover:border-line-2 focus-within:border-ice-line focus-within:bg-bg">
        <IconSearch size={14} />
        <span className="sr-only">{t('shell.search')}</span>
        <input
          ref={ref}
          type="search"
          value={q}
          placeholder={t('shell.searchPlaceholder')}
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
        {!q && <ShortcutHint />}
      </label>
      {open && q.trim() && (
        <div data-no-drag className="pop-in absolute top-9 right-0 left-0 z-50 overflow-hidden rounded-box border border-line-2 bg-[#121418] p-1 shadow-[0_16px_40px_-16px_rgba(0,0,0,.8)]">
          {results.length === 0 ? (
            <div className="px-3 py-2.5 text-[12px] text-mute">{t('shell.noResults')}</div>
          ) : (
            results.map((r, i) => (
              <button
                key={r.id}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(r)}
                onMouseEnter={() => setSel(i)}
                className={`flex w-full items-center justify-between gap-3 rounded-[5px] px-3 py-2 text-left text-[13px] transition-colors duration-100 ${i === sel ? 'bg-control' : ''}`}
              >
                <span className="truncate font-medium">{r.label}</span>
                <span className="shrink-0 font-mono text-[10.5px] text-faint">{r.hint}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
