# Paying Lightning invoices

Kyro pays a BOLT11 invoice from a Bitcoin account through a **submarine swap**: an on-chain payment to a script the provider can only claim by paying the invoice. No channels, nothing to receive. Boltz itself is gone (see "Boltz, 2026-11-04" below), but other operators run the same open backend.

## How a payment works

1. You paste an invoice in Send on a Bitcoin account, or tick Lightning. Rust decodes it with `lightning-invoice` (checksum, node signature, amount, expiry, network, payment hash). No amount, expired or another network: refused. Under one hour left: refused.
2. Kyro reads each provider's limits and fees and takes the cheapest that accepts the amount. If it refuses the invoice, the next one is tried.
3. Rust gives a fresh refund key, `m/9735'/0'/0'/i'` from your seed, and the provider answers with its lockup terms.
4. Rust checks those terms (`ln_check_swap`) and rebuilds the address. See below. The terms are then saved encrypted, before anything is signed.
5. The review shows the invoice, the provider's fee, Kyro's fee, the network fees and the total. The deposit is an ordinary Bitcoin send at the Fast fee, and the native window names it as a Lightning payment, with the provider and the refund block.
6. The provider pays the invoice after one confirmation and claims the deposit. History follows `GET /v2/swap/{id}`: waiting, paid, failed, refunded.

### What Rust checks before a deposit

| Check | Refused if |
|---|---|
| Claim leaf | It is not exactly `HASH160 <ripemd160(payment hash)> EQUALVERIFY <claim key> CHECKSIG`, so it cannot be claimed without this invoice's preimage |
| Refund leaf | It is not exactly `<our key> CHECKSIGVERIFY <timeout> CLTV` |
| Key path | The internal key must be the MuSig2 aggregate of the provider's key and ours (the `musig2` crate, claim key first): the provider cannot spend alone. Kyro never signs a MuSig2 session |
| Address | The taproot address rebuilt from all of the above differs from the one the provider gave |
| Timeout | Under 144 or over 1,440 blocks from the tip |
| Amount | Not above the invoice, or a fee over 3% + 3,000 sat. The interface also refuses any fee other than the one announced with the pair |
| Invoice | Under one hour left, or already sent from this wallet |

### Is it atomic?

Yes, unlike an order on an exchange. The provider can only take the bitcoin by revealing the invoice's preimage, which it only learns by paying. It cannot take the coins and not pay. What it can do is fail or refuse to pay. Then your coins stay locked until the timeout, about 7 days, and you take them back alone.

### When a payment fails

Send › Lightning lists your payments. From the timeout block, *Get my bitcoin back* spends the refund leaf to the account's first address. Rust reads the coins, derives the destination and shows the native window. No provider is needed. The refund fee rate is the half-hour estimate, at most 500 sat/vB.

Kyro does not do the cooperative refund, which would return coins early: it needs a MuSig2 signing session. A failed payment therefore always waits for the timeout.

The swap terms live in `<vault>.lnswaps`, XChaCha20-Poly1305 under a key derived from the seed (`m/9735'/0'/1'`). **The recovery phrase alone cannot refund a swap**: without this file Kyro no longer knows the provider's key or the timeout. Do not delete the app folder while a payment is open. It is not part of Settings › Backup.

### Limits

- Mainnet only. The providers have no test network here.
- 25,000 to 5,000,000 sat, depending on the provider (Coinos up to 600,000).
- Amountless invoices are refused: Kyro has no way to pick an amount for you. Lightning addresses and LNURL are not supported.
- An invoice needs at least an hour left. Many wallets and shops issue shorter ones, and these cannot be paid.
- If the deposit does not confirm before the invoice expires, the payment fails and the coins wait for the timeout. Kyro uses the Fast fee for this reason, but a block can take over an hour.
- Hardware accounts are refused: the refund key comes from the seed, which a hardware account does not use. The screen says so.
- Kyro's fee is a second transfer, as on Exolix routes, with at least 546 sat so it can relay. See [SWAP_FEES.md](SWAP_FEES.md).

### Not tested with real funds

No deposit has been made. Swap creation, Rust's checks with a seed-derived key and status reads were run live over Tor (`live_smoke_lightning_tor`). The refund transaction is checked in tests (control block against the lockup output, signature against the script-path sighash), but has never been broadcast. A provider's real payment, failure statuses and time to pay have not been observed. The status names come from Boltz's API as Kyro knew it, and only `invoice.set` was seen live.

## Provider check, 2026-11-04

Every request below went through Kyro's own client (`NetClient::fetch`, embedded Arti, default settings, Tor on), with the hosts allowed for that run. No funds were sent. Orders that were created were left to expire: nothing can happen to them without a deposit.

Test invoices were throwaway BOLT11 strings signed by a random key, with a random payment hash that no one can settle. With no route hint, the providers refuse them ("could not find route to pay invoice"). With one route hint through a public node they pass that check.

| Provider | Keyless | Over Tor | BTC to Lightning | Limits (sat) | Fees |
|---|---|---|---|---|---|
| **Coinos** `swap.coinos.io` (Boltz backend, CLN node `030dfc53…45e8`) | Yes | Yes, through an exit, 0.6 to 15 s a request | **Works.** `POST /v2/swap/submarine` gives 201, status reads back | 25,000 to 600,000 | 0.1% + 302 sat miner fee: 100,402 sat for a 100,000 sat invoice |
| **SATS Routing** `satsrouting.exchange`, onion `w2mqd2fc…auad.onion` (Boltz backend, LND node `02a53f9d…8d1a`) | Yes | Yes, onion and exit, 0.6 to 8 s a request | **Works.** 201 on the onion, status reads back | 50,000 to 5,000,000 | 0.5% + 167 sat miner fee: 100,667 sat for a 100,000 sat invoice |
| **Exolix** `exolix.com` | Yes | Yes | **Does not work.** `/currencies/BTC/networks` lists `LIGHTNING` (`^lnbc…`), but `/rate` and `POST /transactions` answer 422 "Such exchange pair is not available" for BTC, LTC, XMR, ETH and USDT sources, fixed and float, by amount or by withdrawal amount, and with the invoice in the order. BTC to LTC on the same client answered 200 | none | none |
| Middle Way `api.middle-way.space` and its onion | No | Reached | `/v2/swap/submarine` answers 401 "unauthorized" | not read | not read |
| ZEUS Swaps `swaps.zeuslsp.com` | Not established | Reached | `/api/v2/…` answers 502, three runs | not read | not read |
| SideShift `sideshift.ai` | No: its docs require a key or signed requests | Blocked | Cloudflare challenge, 403 | not read | not read |
| exch.cx | Not established | No | Timed out at the exit, three tries. Direct connection refused too | not read | not read |

FixedFloat, ChangeNOW, Changelly, SimpleSwap and StealthEX were not tried: they need a key, by their own documentation or from memory of it, which was not re-checked.

**Decision:** build on Coinos and SATS Routing. Exolix stays out, even though it advertises the network: no pair exists behind it.

### What was measured

- **Minimum invoice life.** Both refuse an invoice valid 15 or 20 minutes ("invoice expiry too short") and accept 30 minutes, 45 minutes, 1, 2, 6 and 24 hours. A real invoice from a public Lightning address, valid 15 minutes, was refused the same way, so many short invoices cannot be paid at all.
- **Refund timeout.** Both set `timeoutBlockHeight` 975576 at height 974568: 1,008 blocks, about 7 days.
- **Confirmation.** `acceptZeroConf` is false on both: the provider pays once the deposit has one confirmation.
- **Lockup address.** Rebuilt locally from two live responses, one per provider, and identical: MuSig2 aggregate of the claim key then the refund key, taproot tree of the two leaves. The other key order gives a different address.
- **Status.** `GET /v2/swap/{id}` gives `{"status":"invoice.set"}` on a fresh swap and 404 on an unknown id.
- **Time to pay.** Not measured: no swap was funded.

### What this does not prove

No deposit was sent, so no provider has been seen paying an invoice or failing to. The two operators are small, and their endpoints came from SwapMarket's public list (`src/configs/mainnet.ts`, updated 2026-11-03). That matters less here than with a custodial service, because Kyro rebuilds the lockup address itself and a false endpoint gains nothing from it. Boltz's swap backend was suspended after attacks whose details are not public, and these operators run that software or a fork. Those attacks were reported against the service, and nothing read says they could take a user's locked coins, but this was not established either way.

## Boltz, 2026-11-04

**Not used.** Boltz is suspended and could not be reached over Tor. No Boltz host is in the allowlist.

### What was checked

All requests went through Kyro's own client (`NetClient::fetch`, embedded Arti, default settings). No funds were involved.

| Target | Result |
|---|---|
| `http://boltzzzbnus4m7mta3cxmflnps4fp7dueu2tgurstbvrbt6xswzcocyd.onion/api` (from `src/configs/mainnet.ts` in `BoltzExchange/boltz-web-app`) | 18 of 18 requests failed: 16 with "Onion Service not found" (the 8 whose full text was logged add "Unable to download hidden service descriptor"), 2 with a circuit timeout. |
| `https://api.boltz.exchange` through a Tor exit | 10 of 10 failed, all `RESOLVEFAILED`. |
| `https://api.testnet.boltz.exchange` through a Tor exit | 9 of 10 failed with `RESOLVEFAILED`, 1 with a circuit timeout. |
| Control: mempool.space's onion, alternating with Boltz's onion on the same client | 8 of 8 answered, in about 1 s once warm. |

The control shows that Tor and onion services were working on this client, and that the failure is specific to Boltz. A descriptor that cannot be downloaded usually means the service is not published at the moment. This test cannot tell whether that is temporary.

Requests tried on each base: `GET /v2/version`, `GET /v2/swap/submarine`, `GET /v2/chain/BTC/height`, and `POST /v2/swap/submarine` with a junk invoice.

### Why it fails

- **The domain is gone from DNS.** `boltz.exchange`, `www.boltz.exchange`, `api.boltz.exchange` and `api.testnet.boltz.exchange` return NXDOMAIN from Cloudflare's DoH resolver, and `api.boltz.exchange` also from the LAN resolver. `api.docs.boltz.exchange` did not resolve either. The `.exchange` registry (RDAP) shows `client hold`, a registrar transfer on 2026-09-01 and a last change on 2026-09-18. A held domain is not published in DNS. The RDAP record does not say who set the hold, or why.
- **Boltz suspended swaps.** The web app sets `swapsSuspended: true` (commit "feat: add swap service suspension notice", #1596, 2026-08-04). Its notice says the API stays available for cooperative refunds and that unilateral refunds do not depend on Boltz. That API could not be reached from here either.
- **Development has slowed.** On the default branches, the last commit on `boltz-backend` is dated 2026-07-27, and the latest `boltz-client` commits are dependency bumps. Neither repository is archived.
- **Secondary sources, not verified against Boltz directly.** Press reports say swaps stopped on 2026-08-03 after automated attacks, with no restart date. A GitHub issue (Ride-The-Lightning/RTL#1724) says the founders stepped down on 2026-08-12 and an unnamed group is taking over, and it records the NXDOMAIN on 2026-09-30. Boltz's own posts on X were not read.

### What could not be determined

Pairs, fees and limits could not be read: no Boltz server answered, so Kyro has no live figures. The swap creation flow, Tor acceptance and API failure behaviour are also unverified. Figures quoted elsewhere are from before the suspension and should not be relied on.

### Before reconsidering Boltz itself

All of these need to be true:

1. Boltz has officially announced that swaps are back, from a source that can be verified.
2. The API answers over Tor from `live_smoke`: pairs, fees and limits, then swap creation.
3. The endpoint is confirmed by Boltz itself. Do not accept a new domain or onion address from a search result, a forum or a third-party client. A relaunch under a new operator may reuse the old name, or use a new one.
4. The new operator, the suspension's cause and the fixes are understood. Boltz said it could not safely reopen, so its security needs a fresh look rather than trust carried over from before.
5. The API and script format are re-read from current documentation. The docs host does not resolve today, and the format may change at relaunch.

The requirements any provider must meet: local verification of the invoice and of the lockup script, a seed-derived refund key, encrypted swap state with resume after restart, and a script-path refund that needs no Boltz server. A script-path refund matters most here, because a service that disappears mid-swap is no longer a theoretical case.

To re-run the check, add a temporary `#[ignore]` test to `apps/desktop/src-tauri/src/live_smoke.rs` that fetches the hosts above, with mempool's onion as the control. The hosts must be added to `ALLOWED_HOSTS` or `ONION_HOSTS` for that run only.
