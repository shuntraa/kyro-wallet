// SPDX-License-Identifier: GPL-3.0-or-later
// The app's one floating notification: dark card, tone icon, one short line, optional action,
// dismissed automatically. `notify()` works from anywhere; `<Toaster />` (App) shows them.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useT } from '../i18n';
import { IconCheck, IconInfo, IconWarn, IconX } from './icons';

export type ToastTone = 'ok' | 'info' | 'error';

export interface Toast {
  id: number;
  tone: ToastTone;
  text: string;
  action?: { label: string; onClick: () => void };
  ms?: number;
}

let list: Toast[] = [];
let nextId = 1;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function dismissToast(id: number): void {
  list = list.filter((x) => x.id !== id);
  emit();
}

/** Shows one short line; at most 3 at once (the oldest leaves first). */
export function notify(t: Omit<Toast, 'id'>): number {
  const id = nextId++;
  list = [...list.slice(-2), { ...t, id }];
  emit();
  return id;
}

const ICON: Record<ToastTone, ReactNode> = {
  ok: <IconCheck size={15} className="text-up" />,
  info: <IconInfo size={15} className="text-ice" />,
  error: <IconWarn size={15} className="text-down" />,
};

function Item({ x }: { x: Toast }) {
  const { t } = useT();
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const id = window.setTimeout(() => dismissToast(x.id), x.ms ?? 6000);
    return () => window.clearTimeout(id);
  }, [x.id, x.ms, paused]);
  return (
    <div
      role={x.tone === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className="fade-in pointer-events-auto flex max-w-[360px] items-center gap-2.5 rounded-box border border-line bg-card px-3.5 py-2.5 text-[13px] text-text shadow-lg"
    >
      {ICON[x.tone]}
      <span className="min-w-0 truncate">{x.text}</span>
      {x.action && (
        <button
          type="button"
          onClick={() => {
            x.action?.onClick();
            dismissToast(x.id);
          }}
          className="shrink-0 font-medium text-ice hover:underline"
        >
          {x.action.label}
        </button>
      )}
      <button type="button" aria-label={t('update.dismiss')} onClick={() => dismissToast(x.id)} className="shrink-0 text-mute hover:text-text">
        <IconX size={13} />
      </button>
    </div>
  );
}

export function Toaster() {
  const items = useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => void subs.delete(f);
    },
    () => list,
  );
  if (items.length === 0) return null;
  return (
    <div aria-live="polite" className="pointer-events-none fixed right-5 bottom-12 z-50 flex flex-col items-end gap-2">
      {items.map((x) => (
        <Item key={x.id} x={x} />
      ))}
    </div>
  );
}
