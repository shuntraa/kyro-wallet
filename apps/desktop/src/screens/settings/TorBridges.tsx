// SPDX-License-Identifier: GPL-3.0-or-later
// Settings › Tor: plain bridge lines. Rust validates them, keeps them in settings.json and gives them to arti.

import { useEffect, useState } from 'react';
import { toIpcError } from '@kyro/shared';
import { useApp } from '../../state/app';
import { useT } from '../../i18n';
import { bridgeProblem, splitBridgeLines } from '../../lib/torBridges';
import { Button, Notice, Spinner } from '../../components/ui/primitives';

export function TorBridges() {
  const { settings, saveSettings } = useApp();
  const { t } = useT();
  const saved = settings.tor.bridges ?? [];
  const savedText = saved.join('\n');
  const [text, setText] = useState(savedText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setText(savedText), [savedText]);

  const lines = splitBridgeLines(text);
  const changed = lines.join('\n') !== savedText;

  const save = async () => {
    setError(null);
    const problem = bridgeProblem(lines);
    if (problem) {
      setError(t(problem.kind === 'transport' ? 'settings.bridgesTransportLine' : 'settings.bridgesBadLine', { n: problem.line }));
      return;
    }
    setBusy(true);
    try {
      await saveSettings({ ...settings, tor: { ...settings.tor, bridges: lines } });
    } catch (e) {
      setError(toIpcError(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-3 rounded-panel border border-line bg-card px-[22px] py-[18px]">
      <div className="flex flex-col gap-0.5">
        <span className="text-[15px] font-medium tracking-[-0.01em]">{t('settings.bridges')}</span>
        <span className="text-[13px] text-mute">{t('settings.bridgesDesc')}</span>
      </div>
      <textarea
        aria-label={t('settings.bridges')}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        spellCheck={false}
        placeholder={t('settings.bridgesPlaceholder')}
        className="w-full resize-y rounded-ctl border border-line-2 bg-bg px-3.5 py-2.5 font-mono text-[12.5px] text-text placeholder:text-faint focus:border-ice-line"
      />
      <p className="m-0 text-[12px] leading-[1.55] text-mute">{t('settings.bridgesPlainOnly')}</p>
      {saved.length > 0 && <p className="m-0 text-[12px] leading-[1.55] text-mute">{t('settings.bridgesOnly')}</p>}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex justify-end">
        <Button variant="primary" disabled={busy || !changed} onClick={() => void save()}>
          {busy && <Spinner />} {t('settings.bridgesSave')}
        </Button>
      </div>
    </section>
  );
}
