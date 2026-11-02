// SPDX-License-Identifier: GPL-3.0-or-later
import type { update as fr } from '../fr/update';

export const update: Record<keyof typeof fr, string> = {
  'update.auto': 'Automatic updates',
  'update.autoDesc': 'Version {version} · signed and verified',
  'update.title': 'Updates',
  'update.store': 'Version {version}. Updates are handled by the Microsoft Store.',
  'update.updated': 'Kyro updated to {version}.',
  'update.dismiss': 'Dismiss',
};
