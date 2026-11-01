// SPDX-License-Identifier: GPL-3.0-or-later
import type { update as fr } from '../fr/update';

export const update: Record<keyof typeof fr, string> = {
  'update.auto': 'Automatic updates',
  'update.autoDesc': 'Version {version}. Downloaded in the background (over Tor if enabled), signature checked, installed at the next start.',
  'update.updated': 'Kyro updated to {version}.',
  'update.dismiss': 'Dismiss',
};
