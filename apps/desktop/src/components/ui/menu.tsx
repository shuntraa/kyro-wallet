// SPDX-License-Identifier: GPL-3.0-or-later
import type { ReactNode } from 'react';
import * as M from '@radix-ui/react-dropdown-menu';
import { cn } from '../../lib/cn';
import { IconCheck } from '../icons';

export interface MenuItem<T extends string> {
  value: T;
  label: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

/** Dropdown picker (assets, tokens, sort order…). */
export function Menu<T extends string>({
  trigger,
  items,
  value,
  onSelect,
  align = 'start',
  label,
  className,
}: {
  trigger: ReactNode;
  items: MenuItem<T>[];
  value?: T;
  onSelect: (v: T) => void;
  align?: 'start' | 'end';
  label?: string;
  className?: string;
}) {
  return (
    <M.Root modal={false}>
      <M.Trigger asChild>{trigger}</M.Trigger>
      <M.Portal>
        <M.Content align={align} sideOffset={6} className={cn('popover z-50 max-h-[360px] min-w-[220px] overflow-y-auto rounded-box border border-line-2 bg-[#121418] p-1 shadow-[0_16px_40px_-16px_rgba(0,0,0,.8)] scroll-thin', className)}>
          {label && <M.Label className="eyebrow px-2.5 pt-2 pb-1.5">{label}</M.Label>}
          {items.map((it) => (
            <M.Item
              key={it.value}
              disabled={it.disabled}
              onSelect={() => onSelect(it.value)}
              className="flex cursor-pointer items-center gap-2.5 rounded-[5px] px-2.5 py-2 text-[13px] outline-none transition-colors duration-100 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45 data-[highlighted]:bg-control"
            >
              {it.icon}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{it.label}</span>
                {it.hint && <span className="truncate text-[11px] text-mute">{it.hint}</span>}
              </span>
              {value === it.value && <IconCheck size={14} className="text-ice" />}
            </M.Item>
          ))}
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}
