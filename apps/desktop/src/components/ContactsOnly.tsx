// SPDX-License-Identifier: GPL-3.0-or-later
// « Envoyer seulement à mes contacts »: while it is on, a new contact needs the vault password
// (Rust counts the attempt, `vault_password_check`), and turning it off too (`contacts_only_off`).
// The address book lives in this interface's storage: the rule is enforced here, by Send.

import { useState, type ReactNode } from 'react';
import { call, toIpcError } from '@kyro/shared';
import { useApp } from '../state/app';
import { PasswordField } from './kit';
import { Dialog } from './ui/dialog';
import { Button, Notice, Spinner } from './ui/primitives';
import { useT } from '../i18n';

/** Asks the vault password, runs `verify` with it, then `onDone`. */
export function PasswordGate({ title, body, action, verify, onDone, onCancel }: { title: string; body: ReactNode; action: string; verify: (password: string) => Promise<void>; onDone: () => void; onCancel: () => void }) {
  const { t } = useT();
  const [password, setPassword] = useState('');
  const [wrong, setWrong] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await verify(password);
      setPassword('');
      onDone();
    } catch (e) {
      const err = toIpcError(e);
      if (err.code === 'WRONG_PASSWORD') setWrong((n) => n + 1);
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && !busy && onCancel()} title={title}>
      <p className="m-0 text-[13px] leading-[1.55] text-text2">{body}</p>
      <PasswordField id="gate-pw" value={password} onChange={setPassword} wrong={wrong} autoFocus onEnter={() => void submit()} />
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel} disabled={busy}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" disabled={!password || busy} onClick={() => void submit()}>
          {busy && <Spinner />} {action}
        </Button>
      </div>
    </Dialog>
  );
}

/**
 * `guard(save)`: saves a new contact at once, or after the vault password while « send only to
 * my contacts » is on. Render `dialog` somewhere in the component.
 */
export function useContactGuard(): { guard: (save: () => void) => void; dialog: ReactNode } {
  const { settings } = useApp();
  const { t } = useT();
  const [pending, setPending] = useState<(() => void) | null>(null);
  const guard = (save: () => void) => (settings.contactsOnly ? setPending(() => save) : save());
  const dialog = pending ? (
    <PasswordGate
      title={t('settings.contactsOnlyAddTitle')}
      body={t('settings.contactsOnlyAddBody')}
      action={t('settings.addToBook')}
      verify={(password) => call('vault_password_check', { password })}
      onDone={() => {
        pending();
        setPending(null);
      }}
      onCancel={() => setPending(null)}
    />
  ) : null;
  return { guard, dialog };
}
