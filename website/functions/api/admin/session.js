// SPDX-License-Identifier: GPL-3.0-or-later
import { SENDERS } from "../../_lib/config.js";
import { guard, json } from "../../_lib/http.js";

// 200 with the sender list when logged in, 401 otherwise: this is how the page knows which view to show.
export const onRequestGet = guard(async ({ session }) =>
  json({
    ok: true,
    user: session.user,
    senders: Object.entries(SENDERS).map(([id, s]) => ({ id, address: s.address, team: s.team })),
  }),
);
