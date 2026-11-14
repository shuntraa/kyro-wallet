// SPDX-License-Identifier: GPL-3.0-or-later
import { clearCookie } from "../../_lib/auth.js";
import { guard, json } from "../../_lib/http.js";

export const onRequestPost = guard(async () => json({ ok: true }, 200, { "Set-Cookie": clearCookie() }), { auth: false });
