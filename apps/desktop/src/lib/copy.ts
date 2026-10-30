// SPDX-License-Identifier: GPL-3.0-or-later
//
// Copy only through explicit "Copier" buttons. Public data only (addresses,
// tx hashes): the recovery phrase is never copyable.

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
