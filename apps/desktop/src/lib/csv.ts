// SPDX-License-Identifier: GPL-3.0-or-later

/** RFC 4180 CSV with `;` separator (French Excel default) and CRLF. */
export function toCsv(rows: Array<Array<string | number>>, sep = ';'): string {
  const esc = (v: string | number) => {
    const s = String(v);
    return /["\n\r;,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(esc).join(sep)).join('\r\n') + '\r\n';
}

/** Trigger a download of a text file (Blob URL, no network). */
export function downloadText(filename: string, text: string, mime = 'text/csv;charset=utf-8'): void {
  const blob = new Blob(['﻿' + text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
