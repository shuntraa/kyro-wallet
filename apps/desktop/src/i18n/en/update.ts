// SPDX-License-Identifier: GPL-3.0-or-later
import type { update as fr } from '../fr/update';

export const update: Record<keyof typeof fr, string> = {
  'update.auto': 'Automatic updates',
  'update.autoDesc': 'Version {version}',
  'update.title': 'Updates',
  'update.store': 'Version {version}. Updates come from the Microsoft Store.',
  'update.updated': 'Kyro is now on version {version}.',
  'update.dismiss': 'Dismiss',
};
