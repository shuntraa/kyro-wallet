# Kyro fees on swaps

Kyro charges a service fee on every swap, at a **sliding rate** depending on the swap's dollar value: from 5% for a swap of $5 or less down to 0.7% from $10,000. This fee funds the project. Since Kyro is open source, the fees are public: anyone can read the code, change it, set the fee to 0 or remove it in their own build. Public schedule: <https://kyrowallet.com/frais>.

- **Configuration**: a single file, [`packages/swap/src/fees.ts`](../packages/swap/src/fees.ts) (`KYRO_FEE_CURVE`, `UNKNOWN_PRICE_FEE_BPS`, `KYRO_SWAP_FEE`).
- **Display**: the Swap screen shows "You send X" and "You receive ≈ Y", **Y already net** of the service fee, then the guaranteed minimum and the network fees. No line (screen or confirmation) shows the commission amount or rate; under the received amount, the discreet "Service fee included" note opens <https://kyrowallet.com/frais> in the system browser (Rust command `open_fees_page`, URL fixed in Rust; the page opens in your browser, outside Kyro's Tor).
- **Collection**: the fee is taken on the blockchain through each provider's **official "integrator" mechanism**. Kyro never adds an extra transfer.
- **Cap**: 5% (`MAX_FEE_BPS` = 500). A configuration beyond that (or a malformed curve) is rejected; each provider is additionally limited to its own maximum (below).

## Schedule

Swap value = amount sold × price of the token sold (the app's price source, in your currency) ÷ USD rate → your currency (`sellValueUsd`).

| Swap value | Rate |
|---|---|
| ≤ $5 | 500 bps (5%) |
| $10 | 200 bps (2%) |
| $25 | 180 bps (1.8%) |
| $50 | 160 bps (1.6%) |
| $80 | 140 bps (1.4%) |
| $100 | 120 bps (1.2%) |
| $1,000 | 90 bps (0.9%) |
| ≥ $10,000 | 70 bps (0.7%), flat beyond |
| unknown price | 90 bps (0.9%) |

Between two points (u₁, b₁) and (u₂, b₂), **linear interpolation on the logarithm** of the amount, rounded to the **nearest whole** bps (`Math.round`, .5 rounds up):

```
bps(u) = round( b₁ + (b₂ − b₁) × (ln u − ln u₁) / (ln u₂ − ln u₁) )
```

Examples: $7 → 354 bps; $300 → 106 bps; $3,000 → 80 bps.

**A single rate per quote.** The provider computes the rate (`feeForQuote`) once, from the quote's parameters: this is the rate that goes into the request, that Kyro requires back (echo, calldata, transaction), and that is kept in `Quote.kyroFeeBps` for the check done at signing time (Jupiter). Any quote whose fees differ from what was requested (rate, amount down to the token unit, recipient) is rejected.

**Maximum per provider** (`PROVIDER_MAX_FEE_BPS`, read on 2026-11-01):

| Provider | Documented maximum | Kyro rate applied |
|---|---|---|
| 0x | `swapFeeBps`: "default limit of 1000 Bps" | the curve (≤ 500), no clamping |
| LI.FI | `distributionFees`: "greater than 0 and less than 0.5 per entry" | the curve, no clamping |
| Jupiter | `platform_fee_bps` is a `u8` in the route instruction (≤ 255) | **clamped to 255 bps** (swaps under ≈ $9) |
| NEAR Intents 1Click | total of `appFees` ≤ 500 bps, and Kyro requests double its rate (1Click keeps half) | **clamped to 250 bps** (swaps under ≈ $9) |

## Rule: every swap carries the fee

If a provider cannot collect the fee with the current configuration, it is **dropped from the quotes**. The reason is given, and Kyro never quietly uses it without fees. Kyro also never sends fees to an address it cannot validate. The best price is chosen **after fees**: each provider deducts the fees from the amount it advertises, and quotes are compared on that net amount.

## Per provider

The parameters below were checked against the official documentation on 2026-10-31.

| Provider | Parameters sent | Who receives | Taken from | Checked by Kyro |
|---|---|---|---|---|
| **0x** (Swap API v2) | `swapFeeRecipient`, `swapFeeBps=<quote rate>`, `swapFeeToken=<token sold>` | `recipients.evm`, paid within the transaction | the token sold | the quote must return `fees.integratorFee` equal to the requested rate (down to the token unit), otherwise it is rejected |
| **LI.FI** | `distributionFees[0][receiver]`, `distributionFees[0][percentage]=<rate>/10000` (**as a fraction**, e.g. 0.0106) | your address **on the departure chain**: `recipients.evm` (EVM departure) or `recipients.solana` (Solana departure), paid directly (no registration) | the token sent, on the departure chain (`included` → already deducted from `toAmount`) | the quote must return a "Distributions" line at the requested rate to this address, otherwise it is rejected |
| **Jupiter** (Metis `swap/v1`) | `platformFeeBps=<rate, ≤ 255>` on `/quote`, `feeAccount` on `/swap` | the associated token account (ATA) of `recipients.solana` | **USDC** for now (`solanaFeeMints`): the output token if it is USDC, otherwise the input token | the quote must return `platformFee.feeBps` = this rate, otherwise it is rejected |
| **NEAR Intents 1Click** (direct, `POST /v0/quote`) | `appFees: [{ recipient: "0x86cd…8b44", fee: 2 × rate }]` (rate ≤ 250) | the **NEAR Intents account** `0x86cd9af8067ff5e0001c709a550cd62b5e968b44` (= `recipients.evm` in lowercase; an account in the `intents.near` registry controlled by the key of that EVM address) | the **deposited** (sold) token, withheld by 1Click on the deposit and credited to this account | 1Click splits the requested commission **50/50** with itself (real quotes of 2026-11-01: `fee: 140` → 70 for Kyro + 70 for the 1Click account `5880ad…47dd`). Kyro therefore requests double the quote's rate and requires, in the quote response **and** in `/v0/status` of the deposit address: **exactly this rate** to this account, only once, and **at most this rate** for 1Click; otherwise it refuses. If 1Click splits differently (its docs also describe "your commission + 25 bps" without an API key), Kyro re-requests once the amount that yields exactly this rate (≤ 500 in total), then re-verifies |

### Per route (where and in which token)

| Route | Provider | Kyro fees taken | Paid to |
|---|---|---|---|
| Same EVM chain (Ethereum, Arbitrum, Optimism, Base, Polygon, BNB Chain, Avalanche, Sonic, HyperEVM: 0x or LI.FI; Cronos, Mantle, Gnosis, Sei, Flare, Kaia: LI.FI) | 0x or LI.FI | in the **sold** token, on that chain | `recipients.evm` (`0x86cD…8B44`) |
| Same Solana chain | Jupiter | in **USDC** (output token if it is USDC, otherwise input) | USDC account of `recipients.solana` (`CFPW…Qx7C`) |
| EVM → other EVM chain, EVM → Solana, EVM → Bitcoin | LI.FI (NEAR Intents bridge) | in the **sent** token, on the departure EVM chain (FeeForwarder step) | `recipients.evm` |
| Solana → EVM, Solana → Bitcoin | LI.FI (NEAR Intents bridge) | in the **sent** token, on Solana: SOL by a System transfer, an SPL token by a `TransferChecked` to the account for that token of `recipients.solana` | `recipients.solana` (`ptsb…BZcM`) or its token account |
| Bitcoin → EVM / Solana / Litecoin / Dogecoin / TRON / XRP / Cardano | NEAR Intents 1Click (direct) | in **BTC**, withheld by 1Click on the deposit | NEAR Intents account `0x86cd…8b44` |
| Litecoin → any served chain | NEAR Intents 1Click (direct) | in **LTC**, on the deposit | NEAR Intents account `0x86cd…8b44` |
| Dogecoin → any served chain | NEAR Intents 1Click (direct) | in **DOGE**, on the deposit | NEAR Intents account `0x86cd…8b44` |
| TRON → any served chain (TRX ⇄ USDT on TRON included) | NEAR Intents 1Click (direct) | in **TRX** or in **USDT TRC-20**, on the deposit | NEAR Intents account `0x86cd…8b44` |
| XRP → any served chain | NEAR Intents 1Click (direct) | in **XRP**, on the deposit | NEAR Intents account `0x86cd…8b44` |
| Cardano (ADA only) → any served chain | NEAR Intents 1Click (direct) | in **ADA**, on the deposit | NEAR Intents account `0x86cd…8b44` |
| Bitcoin Cash, Dash, Zcash (transparent), Sui, TON, Aptos (native currency only) → any served chain | NEAR Intents 1Click (direct) | in **BCH / DASH / ZEC / SUI / TON (Gram) / APT**, on the deposit | NEAR Intents account `0x86cd…8b44` |
| Gnosis (xDAI, tokens) → non-EVM chain served by 1Click only (Litecoin, Bitcoin Cash…) | NEAR Intents 1Click (direct) | in the **sent** token, on the deposit | NEAR Intents account `0x86cd…8b44` |
| EVM served by 1Click / Solana → Litecoin, Dogecoin, Bitcoin Cash, Dash, Zcash, TRON, XRP, Cardano, Sui, TON, Aptos, Stellar | NEAR Intents 1Click (direct) | in the **sent** token (ETH, USDC, SOL…), on the deposit | NEAR Intents account `0x86cd…8b44` |

"Any served chain": the EVM chains served by 1Click (Ethereum, Arbitrum, Optimism, Base, Polygon, BNB Chain, Avalanche, Gnosis), Solana, Bitcoin, Litecoin, Dogecoin, Bitcoin Cash, Dash, Zcash, TRON, XRP, Cardano, Sui, TON, Aptos and Stellar (destination only); the destination is always **your own** Kyro account on that chain. NEAR Intents fees do **not** go to `recipients.bitcoin`, `recipients.tron`…: 1Click only pays integrator commissions to a NEAR Intents account. The owner withdraws them from that account with the key of `0x86cD…8B44` (for example on near-intents.org, by signing in with that EVM wallet), in the token in which they were taken.

Verified with real 1Click quotes (read-only, no deposit) on 2026-11-01: BTC → ETH, LTC → SOL, DOGE → BTC, TRX → ETH, USDT TRC-20 → USDC Solana, XRP → SOL, ADA → ETH, ETH Arbitrum → LTC; each time `appFees` returns 70 to `0x86cd…8b44` and 70 to 1Click, `SIMPLE` deposit without memo, and `/v0/status` of the deposit address repeats the same conditions. 1Click temporarily imposes a minimum of **$100** when departing from TRON.

Same verification on 2026-11-01 (14:00 UTC) for the new chains (`packages/swap/test/fixtures/cross/1click-direct-more.json`): BCH → ETH, DASH → ETH, ZEC → ETH, TON → ETH, SUI → ETH, APT → ETH, ETH Arbitrum → XLM, xDAI Gnosis → BCH; each time 70 bps to `0x86cd…8b44`, 70 to 1Click (recorded back when the rate was a flat 70 bps; the tests replay these responses with a flat configuration at 70), `SIMPLE` deposit without memo (BCH `bitcoincash:q…`, DASH `X…`, ZEC `t1…`, TON `UQ…`, Sui / Aptos `0x…` of 64 characters), confirmed by `/v0/status`. When departing from **Stellar**, 1Click refuses a `SIMPLE` deposit ("Incorrect depositMode for originAsset from stellar chain"): it needs a memo, which Kyro never sends. Stellar is therefore only a **destination** chain.

Verified with real li.quest quotes (read-only) on 2026-11-01: Arbitrum USDC → SOL, Base ETH → USDC Solana, Arbitrum USDC → BTC (fees in USDC or ETH to `0x86cD…`); SOL → ETH Arbitrum and USDC Solana → USDC Base (fees in SOL / USDC to `ptsb…` or `CFPW…`). li.quest refuses an EVM recipient for a Solana departure ("not a valid Solana address for chain 1151111081099710"): the recipient follows the departure chain.

For a Solana departure with an SPL token other than USDC, the fee wallet must own the account for that token; otherwise LI.FI's transaction creates it (rent ≈ 0.002 SOL paid by the user) or fails. Kyro accepts the creation of an account for the sold token, paid by you, and shows it in the network fees.

Sources:
- 0x: [Monetize your app using Swap](https://docs.0x.org/evm/0x-swap-api/guides/monetize-your-app-using-swap.md)
- LI.FI: [Monetizing the integration](https://docs.li.fi/introduction/integrating-lifi/monetizing-integration)
- Jupiter: [Add fees to swap](https://developers.jup.ag/docs/swap-api/add-fees-to-swap)
- NEAR Intents: [Fee Configuration](https://docs.near-intents.org/integration/distribution-channels/1click-api/fee-config) and [Fees](https://docs.near-intents.org/resources/fees) (`appFees`, `recipient` = "Any NEAR-supported address (… or EVM-like address)", taken from the input token, total ≤ 500 bps)

## What Kyro checks in each quote

The parameters sent are not enough: a provider could return a transaction that does not respect them. Kyro therefore decodes the transaction **before** displaying it, and again right before signing (code: [`packages/swap/src/verify.ts`](../packages/swap/src/verify.ts), [`jupiter-verify.ts`](../packages/swap/src/jupiter-verify.ts)).

| Provider | Kyro fees checked | Other checks |
|---|---|---|
| **0x** | `fees.integratorFee` present, taken in the sold token, **amount ≤ amount sold × 70 / 10,000**; the fee address must appear in the transaction. The detail of the Settler action that pays the fees is not decoded. | `to` and approval = AllowanceHolder `0x0000000000001fF3684f28c67538d4D072C22734`; Settler called = the one in the registry `0x00000000000004533Fe15556B1E086BB1A72cEae` (`ownerOf(2)` or `prev(2)`); recipient = you, minimum ≥ advertised − slippage. |
| **LI.FI** (same chain) | `FeeForwarder` step (`0xCE40449B773a3E6E5e769ADb4e567179d4828cbd`, `0x79C3F5B651Ee5782Ba15d968B088458cd5f1f4EF` on Mantle) decoded: one payment to `recipients.evm`, **= amount sold × rate / 10,000** (to within one unit); total fees of this step ≤ rate + 0.5% (LI.FI's share included). | `to` and approval = Diamond `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE`; `_receiver` = you, `_minAmountOut` ≥ advertised − slippage; first and last steps = the tokens and amount of the pair. |
| **LI.FI cross-chain, EVM departure** | Same `FeeForwarder` step, in the token sent. | **NEAR Intents-only** bridge (`allowBridges=near`); call `swapAndStartBridgeTokensViaNEARIntents` (facet `NEARIntentsFacet`) decoded: destination chain, `BridgeData.receiver` = you (EVM) or `0x11f1…11F1` with `nonEVMReceiver` = your Solana key / the 32 words of your `bc1q` address, no call on arrival, refund to you, `minAmountOut` ≥ advertised − slippage, destination token, consistent departure steps. Then **NEAR Intents confirms the deposit address** (`1click.chaindefuser.com/v0/status`): recipient = your account, refund to you, deposited amount, token and minimum. |
| **LI.FI cross-chain, Solana departure** | Transfer to `recipients.solana` (SOL) or its token account (SPL), **> 0 and ≤ amount sold × 70 / 10,000**. | Transaction decoded by Rust, then only these are accepted: compute budget (priority ≤ 0.01 SOL), one LI.FI tracking instruction (`3i5JeuZuUxeKtVysUnwQNGerJP2bSMX9fTFfS4Nxe3Br`, which moves nothing), transfers **from your account for the sold token** to the Kyro fees, the LI.FI fees (`34FKjAdVcTax2DHqV2XnbXa9J3zmyKcFuFKWbcmgxjgm`, ≤ 0.5%) and **one** deposit address; total = exactly the amount sold. Then the same NEAR Intents confirmation. |
| **NEAR Intents 1Click (direct)** | `appFees` returned by 1Click, in the quote then in `/v0/status` of the deposit address: **exactly** the quote's rate to `0x86cd…8b44`, a single entry, 1Click's share ≤ this rate. | No third-party transaction: 1Click gives a **single-use deposit address** bound (signed quote) to your destination account and your refund address. Kyro requires `EXACT_INPUT`, `SIMPLE` deposit (**no memo, no OP_RETURN, no tag**), recipient = your account (`DESTINATION_CHAIN`), refund = your departure address (`ORIGIN_CHAIN`), amount = your input, requested tokens, minimum ≥ advertised − slippage, deposit address ≠ yours, status `PENDING_DEPOSIT` and at least 2 h before the deadline (the nearer of 1Click's and the 3 h requested by Kyro). Then Kyro builds **itself** an ordinary send of that amount to that address with the chain's adapter, and checks it (`depositTxProblem`): a single payment to the deposit address (BTC/LTC/DOGE: the rest as change, no OP_RETURN output or unknown script; TRON: simple TRX or TRC-20 transfer of the right contract, without memo; XRP: no tag, memo or path, and refusal if the address requires a tag; Cardano: ADA only, no message; EVM / Solana: identical Rust decoding). 1Click is re-read **right before signing**. |
| **Jupiter** | `platform_fee_bps` = the quote's rate and fee account = the expected account of `recipients.solana` (read from the route instruction). | Payer and sole signer = you; authorized programs only (compute budget, ATA, SOL wrapping, one Jupiter v6 route); debited and credited accounts are yours; amount and slippage; priority fees ≤ 0.01 SOL. |

Addresses taken from the official repositories (0x: docs.0x.org and 0x-settler; LI.FI: `lifinance/contracts`, `deployments/<chain>.json`) on 2026-11-01, identical on Ethereum, Arbitrum, Optimism, Base, Polygon, BNB Chain and Avalanche, and present on-chain (`eth_getCode` non-empty) on the newly added chains:

- **0x** also on Sonic ("Cancun" list of docs.0x.org) and HyperEVM ("Cancun" list of the 0x-settler README). **Not Mantle**: docs.0x.org lists it with the "Shanghai" AllowanceHolder (`0x0000000000005E88410CcDFaDe4a5EfaE4b49562`, present on-chain), but 0x designates native MNT there by `0xdeaddeaddeaddeaddeaddeaddeaddeaddead0000` instead of `0xEeee…`, and no real 0x response could be verified (API key): not offered rather than validated without a test. 0x serves neither Cronos, nor Gnosis, nor Sei, nor Flare, nor Kaia, nor Conflux eSpace ("Supported Chains" of docs.0x.org).
- **LI.FI** also on Cronos, Mantle, Sonic, Gnosis and Sei (same Diamond; FeeForwarder specific to Mantle), and on **Flare, HyperEVM and Kaia** with their own Diamond and FeeForwarder (`LIFI_OTHER_DEPLOYMENTS`), taken from `deployments/<chain>.json` **and** identical to the `diamondAddress` of li.quest `/v1/chains`:

  | Chain | Diamond (`to` and approval) | FeeForwarder |
  |---|---|---|
  | Flare (14) | `0x198FC70Dfe05E755C81e54bd67Bff3F729344B9b` | `0xA5971Bd73Dbb879aAaA6fEcB95Dc3fD50c2e3C25` |
  | HyperEVM (999) | `0x0a0758d937d1059c356D4714e57F5df0239bce1A` | `0xba072Bf218314E51d5c3d254800d799840ae6a25` |
  | Kaia (8217) | `0x1255d17c1BC2f764d087536410879F2d0D8772fD` | `0x5161370f81b3054f43361644Ad332625f5E0804F` |

  `eth_getCode` (2026-11-01): each Diamond has the same 5,176-byte code as the other Diamonds, each FeeForwarder **exactly** the code of the default FeeForwarder. Real li.quest responses on Flare (FLR ⇄ USDT0) and HyperEVM (HYPE ⇄ USD₮0) are accepted as-is by the decoder (`packages/swap/test/fixtures/lifi-flare-*.json`, `lifi-hyperevm-*.json`); Kaia had no route to quote that day ("No available quotes"), its addresses are verified but its calldata was not verified live. **Not Conflux eSpace**: it is not a LI.FI chain.

The Swap chain selector only shows the EVM chains where at least one of these contracts is known (`evmSwapSupported`): all of Kyro's EVM chains except Conflux eSpace. On any other network (testnets included), no contract is known: 0x and LI.FI quotes are refused. Cross-chain, an EVM chain is only offered if NEAR Intents serves it (Ethereum, Arbitrum, Optimism, Base, Polygon, BNB Chain, Avalanche, Gnosis).

## What to configure before collecting

As long as these settings are missing, the providers concerned are dropped, and no swap goes out without fees.

1. **`recipients.evm`**: your EVM address. It receives the 0x and LI.FI fees on all EVM chains.
2. **`recipients.solana`**: your Solana address, **the wallet itself, not a token account**. It must own an **initialized token account** for each mint in `solanaFeeMints`, otherwise the Jupiter transaction fails.
   - For now, this is **USDC only**. The USDC account of the configured address was verified on mainnet on 2026-10-31: `CFPWYSxLRh79CobY4gLWzh15zgRgEgo2Cqb4e7gBQx7C`.
   - Jupiter can only take the fees in one of the swap's two tokens. A Solana pair **without USDC** (for example SOL → BONK) therefore cannot carry the fees, and Jupiter does not quote it.
   - To also accept SOL: create the fee wallet's wSOL account (wrap a little SOL), then add the wSOL mint to `solanaFeeMints`.
3. **LI.FI**: nothing to do. Kyro uses `distributionFees`, which pays the fees directly to `recipients.evm`, with no registration on portal.li.fi. Verified with a real quote on 2026-10-31 (Arbitrum, USDC → ETH): LI.FI returns "Distributions 0.7%" to the configured address. Conversely, an unregistered integrator name is refused by LI.FI (`code 1011`). When departing from Solana, the fees go to `recipients.solana` (SOL) or to its account for the sold token (verified on 2026-11-01: SOL → ETH Arbitrum and USDC → USDC Base).
4. **NEAR Intents**: nothing to do to collect. The fees accumulate in the NEAR Intents account `0x86cd9af8067ff5e0001c709a550cd62b5e968b44` (no registration, no API key). To recover them, you must **withdraw** from that account with the key of `recipients.evm` (the account only exists in the `intents.near` registry, each token stays there until withdrawn). Changing `recipients.evm` also changes this account.
5. **THORName** (`thorname`): empty. THORChain is **not** used (owner's decision); it would be a last resort.

## Other chains: what goes through NEAR Intents, what stays closed

`fees.ts` also contains your Bitcoin (`bc1qta8e…aard`), Litecoin (`LWeP…vNyw`), Dogecoin (`DKCS…AU14`), TRON (`TT9j…51pES`), XRP (`rBxj…mSZf`, no tag) and Cardano (`addr1qy9d…dj3`) addresses, each verified at load time (format and checksum; a wrong address drops the route, never a swap without fees). **They receive no fees today**: no official mechanism pays an integrator commission to an address on these chains. Departures from these chains go through **NEAR Intents 1Click**, which pays the commission (in the deposited token) to the NEAR Intents account of `recipients.evm` (see "Per route").

Why not another provider:

- **LI.FI**: `distributionFees` is not supported when departing from Bitcoin ("distributionFees not supported on chain 20000000000001", real quote of 2026-11-01). Litecoin, Dogecoin, XRP and Cardano are not LI.FI chains. When departing from TRON, LI.FI accepts the fees but **requires a recipient in EVM format** ("not a valid EVM address for chain 728126428"): the fees (in USDT) would go to the TRON address of the key of `0x86cD…`, not to `TT9j…`. Not enabled (NEAR Intents covers TRON).
- **THORChain**: ruled out by the owner. Its affiliate fees go to a **THORName**; it would be a last resort if NEAR Intents stopped serving a chain.

Limits of the NEAR Intents routes:

- **Cardano**: ADA only (1Click does not list native Cardano tokens).
- **Bitcoin Cash, Dash, Zcash, Sui, TON, Aptos**: native currency only (Kyro does not handle tokens there). Zcash: transparent addresses (`t1…`), never a TEX or shielded address. TON: the currency is now called **Gram** at 1Click (`GRAM`, asset `nep245:v2_1.omni.hot.tg:1117_`).
- **Stellar**: destination only (1Click requires a memo when departing from Stellar).
- **No route** for NEAR (1Click only knows wNEAR, a NEP-141 token that Kyro does not handle), Hedera, Kaspa, Polkadot, Algorand, Monero, Cosmos Hub, nor for Cronos, Mantle, Sonic, Sei, Flare, Kaia, HyperEVM and Conflux eSpace cross-chain (absent from `/v0/tokens` as of 2026-11-01; "hypercore" is not HyperEVM).
- **XRP**: XRP only (no issued tokens); refused if the deposit address requires a tag.
- 1Click **minimums** (for example $100 when departing from TRON as of 2026-11-01): below that, no quote.
- **Cost to the user**: the Kyro rate **plus** the same for 1Click (its half of the split), i.e. double withheld on the deposit (e.g. 0.9% + 0.9% at $1,000), already deducted from the displayed received amount.

## Chains × providers (2026-11-01)

| Chain | Same chain | Cross-chain (departure and destination) |
|---|---|---|
| Ethereum, Arbitrum, Optimism, Base, Polygon, BNB Chain, Avalanche | 0x, LI.FI | LI.FI (NEAR Intents bridge) to served EVM chains / Solana / Bitcoin; 1Click to the other chains below |
| Sonic, HyperEVM | 0x, LI.FI | — |
| Cronos, Mantle, Sei, Flare, Kaia | LI.FI | — |
| Gnosis | LI.FI | LI.FI (NEAR Intents bridge) to served EVM chains / Solana / Bitcoin; 1Click to the others |
| Conflux eSpace | — | — |
| Solana | Jupiter | LI.FI to served EVM chains / Bitcoin; 1Click to the others |
| Bitcoin | — | 1Click (departure); LI.FI or 1Click (destination) |
| Litecoin, Dogecoin, Bitcoin Cash, Dash, Zcash, XRP, Cardano, Sui, TON, Aptos | — | 1Click |
| TRON | 1Click (TRX ⇄ USDT) | 1Click |
| Stellar | — | 1Click, **destination only** |
| NEAR, Hedera, Kaspa, Polkadot, Algorand, Monero, Cosmos Hub | — | — |

## 1inch: removed

1inch only pays partner fees on a **paid plan**: on the free plan, it receives `fee` and `referrer` but ignores them without error, so the swap would go through with no commission. Since there is no other official mechanism, and Kyro never adds a transfer itself, 1inch was removed (provider, API key, host `api.1inch.dev` from the allowlist). 0x and LI.FI cover EVM.

## What the providers take themselves

These are each provider's own fees, on top of Kyro's and entirely unrelated to them. They are already included in the advertised price or in the network fees shown.

- **0x**: 0.15% on some pairs (Standard plan), returned in `fees.zeroExFee`. Positive slippage gains go to 0x, except on a custom plan.
- **LI.FI**: 0.25% service fee, taken in addition to the Kyro commission.
- **Jupiter (Metis)**: no share of the platform fees advertised.
- **NEAR Intents 1Click**: its half of the `appFees` (as much as the Kyro rate, returned in the quote and already deducted from the received amount), plus the protocol (0.0001%); if the swap is executed at a better price than the quote, the difference is shared with 1Click. In case of a refund, 1Click withholds `refundFee` (network fees of the return).

## Not verified to date

- **No real swap has been sent**: everything is tested against simulated responses, plus real li.quest responses (six on the same chain, four of them on Flare and HyperEVM, five cross-chain with the 1Click status of their deposit), sixteen real direct 1Click quotes with the status of their deposit address, and two real Jupiter transactions (2026-11-01, unsigned) that the decoder accepts as-is. Aggregators and bridges do not work on testnet.
- **NEAR Intents live**: the actual payment of the commission to the account `0x86cd…8b44` has not been observed (it would take a real deposit); Kyro only verifies what 1Click commits to in its signed quote and its status. The 50/50 split without an API key is observed live, whereas the docs describe "commission + 25 bps" without a key: Kyro adapts (a single new request) but never accepts a share different from the requested rate. The ed25519 signature of the 1Click quotes is not verified by Kyro (the response arrives over HTTPS from the allowlisted host and is re-read through `/v0/status`).
- **Cross-chain**: delivery on arrival depends on NEAR Intents' solver network (refund to the departure address if it fails). Kyro verifies what is signed and what the bridge commits to, not the delivery. LI.FI applies slippage at **each** step (departure swap then bridge): Kyro requests half of the chosen slippage per step, then requires the bridge minimum to respect the chosen slippage. The address of the LI.FI fee wallet on Solana (`34FK…xjgm`) is not documented by LI.FI: taken from real transactions; if it changes, Solana departures are refused until updated.
- **0x**: the decoding has not been confronted with a real response (API key required); it follows the published interfaces (`IAllowanceHolder.exec`, `ISettlerTakerSubmitted.execute`). A native-token sale whose `transaction.to` is not AllowanceHolder is refused (behavior not documented by 0x), as is an ETH ⇄ WETH exchange (addressed directly to the WETH contract).
- **0x**: the documentation does not say in so many words whether `buyAmount` is already net of the integrator fees. Kyro takes the fees from the sold token: the advertised amount corresponds to what is actually exchanged.
- **Jupiter**: Metis's docs now declare it "no longer maintained", replaced by Swap V2 (`api.jup.ag/swap/v2`), and `lite-api.jup.ag` is being phased out. Migrating changes the host, so the allowlist, `NETWORK.md` and `IPC.md` will have to be updated at the same time.
