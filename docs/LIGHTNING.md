# Lightning payments through Boltz

**Status: not built.** Kyro cannot pay Lightning invoices. The check that had to pass before any code was written failed on 2026-11-04: Boltz is suspended and cannot be reached over Tor. No Boltz host is in the allowlist, and nothing in Kyro contacts Boltz.

The plan was to pay a BOLT11 invoice from a Bitcoin account with a Boltz submarine swap (on-chain BTC to Lightning), without channels.

## What was checked

All requests went through Kyro's own client (`NetClient::fetch`, embedded Arti, default settings). No funds were involved.

| Target | Result |
|---|---|
| `http://boltzzzbnus4m7mta3cxmflnps4fp7dueu2tgurstbvrbt6xswzcocyd.onion/api` (from `src/configs/mainnet.ts` in `BoltzExchange/boltz-web-app`) | 18 of 18 requests failed: 16 with "Onion Service not found" (the 8 whose full text was logged add "Unable to download hidden service descriptor"), 2 with a circuit timeout. |
| `https://api.boltz.exchange` through a Tor exit | 10 of 10 failed, all `RESOLVEFAILED`. |
| `https://api.testnet.boltz.exchange` through a Tor exit | 9 of 10 failed with `RESOLVEFAILED`, 1 with a circuit timeout. |
| Control: mempool.space's onion, alternating with Boltz's onion on the same client | 8 of 8 answered, in about 1 s once warm. |

The control shows that Tor and onion services were working on this client, and that the failure is specific to Boltz. A descriptor that cannot be downloaded usually means the service is not published at the moment. This test cannot tell whether that is temporary.

Requests tried on each base: `GET /v2/version`, `GET /v2/swap/submarine`, `GET /v2/chain/BTC/height`, and `POST /v2/swap/submarine` with a junk invoice.

## Why it fails

- **The domain is gone from DNS.** `boltz.exchange`, `www.boltz.exchange`, `api.boltz.exchange` and `api.testnet.boltz.exchange` return NXDOMAIN from Cloudflare's DoH resolver, and `api.boltz.exchange` also from the LAN resolver. `api.docs.boltz.exchange` did not resolve either. The `.exchange` registry (RDAP) shows `client hold`, a registrar transfer on 2026-09-01 and a last change on 2026-09-18. A held domain is not published in DNS. The RDAP record does not say who set the hold, or why.
- **Boltz suspended swaps.** The web app sets `swapsSuspended: true` (commit "feat: add swap service suspension notice", #1596, 2026-08-04). Its notice says the API stays available for cooperative refunds and that unilateral refunds do not depend on Boltz. That API could not be reached from here either.
- **Development has slowed.** On the default branches, the last commit on `boltz-backend` is dated 2026-07-27, and the latest `boltz-client` commits are dependency bumps. Neither repository is archived.
- **Secondary sources, not verified against Boltz directly.** Press reports say swaps stopped on 2026-08-03 after automated attacks, with no restart date. A GitHub issue (Ride-The-Lightning/RTL#1724) says the founders stepped down on 2026-08-12 and an unnamed group is taking over, and it records the NXDOMAIN on 2026-09-30. Boltz's own posts on X were not read.

## What could not be determined

Pairs, fees and limits could not be read: no Boltz server answered, so Kyro has no live figures. The swap creation flow, Tor acceptance and API failure behaviour are also unverified. Figures quoted elsewhere are from before the suspension and should not be relied on.

## Before reconsidering

All of these need to be true:

1. Boltz has officially announced that swaps are back, from a source that can be verified.
2. The API answers over Tor from `live_smoke`: pairs, fees and limits, then swap creation.
3. The endpoint is confirmed by Boltz itself. Do not accept a new domain or onion address from a search result, a forum or a third-party client. A relaunch under a new operator may reuse the old name, or use a new one.
4. The new operator, the suspension's cause and the fixes are understood. Boltz said it could not safely reopen, so its security needs a fresh look rather than trust carried over from before.
5. The API and script format are re-read from current documentation. The docs host does not resolve today, and the format may change at relaunch.

The requirements for the feature itself are unchanged: local verification of the invoice and of the lockup script, a seed-derived refund key, encrypted swap state with resume after restart, and a script-path refund that needs no Boltz server. A script-path refund matters most here, because a service that disappears mid-swap is no longer a theoretical case.

To re-run the check, add a temporary `#[ignore]` test to `apps/desktop/src-tauri/src/live_smoke.rs` that fetches the hosts above, with mempool's onion as the control. The hosts must be added to `ALLOWED_HOSTS` or `ONION_HOSTS` for that run only.
