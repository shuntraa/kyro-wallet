// SPDX-License-Identifier: GPL-3.0-or-later
import type { ReactNode } from 'react';
import * as D from '@radix-ui/react-dialog';
import { cn } from '../../lib/cn';
import { IconX } from '../icons';

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
  dismissable = true,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  dismissable?: boolean;
}) {
  return (
    <D.Root open={open} onOpenChange={(v) => (dismissable || v ? onOpenChange(v) : undefined)}>
      <D.Portal>
        <D.Overlay className="overlay fixed inset-0 z-50 bg-[#030405]/75 backdrop-blur-[3px]" />
        <D.Content
          className={cn('dialog fixed top-1/2 left-1/2 z-50 flex max-h-[86vh] w-[480px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-panel border border-line-2 bg-[#0e1013] p-6 shadow-[0_24px_60px_-20px_rgba(0,0,0,.8)] scroll-thin', className)}
          onEscapeKeyDown={(e) => !dismissable && e.preventDefault()}
          onPointerDownOutside={(e) => !dismissable && e.preventDefault()}
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <div className="flex items-start justify-between gap-4">
            <D.Title className="m-0 text-[19px] leading-[1.25] font-[560] tracking-[-0.025em]">{title}</D.Title>
            {dismissable && (
              <D.Close aria-label="Fermer" className="press -mt-1 -mr-1 flex size-8 items-center justify-center rounded-ctl text-mute hover:bg-raised hover:text-text">
                <IconX size={16} />
              </D.Close>
            )}
          </div>
          {description && <D.Description className="m-0 -mt-2 text-[13px] leading-[1.55] text-mute">{description}</D.Description>}
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
