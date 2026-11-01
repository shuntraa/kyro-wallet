// SPDX-License-Identifier: GPL-3.0-or-later
// Real QR code (qrcode lib, error correction H so the centre logo is safe).

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { KyroMark } from './kit';
import { t } from '../i18n';

export function QrCode({ value, size = 300 }: { value: string; size?: number }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    QRCode.toString(value, { type: 'svg', errorCorrectionLevel: 'H', margin: 0, color: { dark: '#0A0B0D', light: '#FFFFFF' } })
      .then((s) => {
        if (alive) {
          setSvg(s);
          setError(false);
        }
      })
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [value]);

  return (
    <div className="relative rounded-panel bg-white p-[22px] shadow-[0_0_0_1px_#2f343c,0_0_0_7px_#0d0f12,0_0_0_8px_#20242a]" style={{ width: size + 44, height: size + 44 }}>
      {svg ? (
        <div role="img" aria-label={t('shell.qrAria')} style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} className="[&>svg]:h-full [&>svg]:w-full" />
      ) : (
        <div style={{ width: size, height: size }} className="flex items-center justify-center text-[13px] text-faint">
          {error ? t('shell.qrUnavailable') : '…'}
        </div>
      )}
      {svg && (
        <span className="absolute top-1/2 left-1/2 flex size-[66px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-box bg-[#0A0B0D] ring-[6px] ring-white">
          <KyroMark size={40} />
        </span>
      )}
    </div>
  );
}
