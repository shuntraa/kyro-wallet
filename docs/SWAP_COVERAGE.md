# Swap coverage

What Kyro can swap, per coin of the registry (`packages/chains/src/registry.ts`), with the
providers Kyro already uses. Audit of 2 November 2026: 1Click `/v0/tokens` and Exolix
`/api/v2/currencies/{coin}/networks` and `/rate` were checked live. Mainnet only. On testnet,
only same-chain EVM swaps are listed, and their quotes are refused.

Kyro's fee works the same way on every route (`docs/SWAP_FEES.md`). 0x, LI.FI and Jupiter use
their integrator fee, and 1Click uses `appFees`. Exolix has no affiliate program, so Kyro sends a
second ordinary transfer of the sold coin to its own fee address on the source chain. Exolix routes
therefore need a Kyro fee address on the source chain.

## Swappable

| Coin / network | From | To | Provider |
| --- | --- | --- | --- |
| ETH, ERC-20s (Ethereum, Arbitrum, Optimism, Base) | yes | yes | 0x, LI.FI (same chain); 1Click / LI.FI (cross-chain); Exolix (to XMR / KAS / ALGO / NEAR) |
| POL (Polygon) | yes | yes | 0x, LI.FI; 1Click; Exolix (to XMR / KAS / ALGO / NEAR) |
| BNB (BNB Chain), AVAX (Avalanche) | yes | yes | 0x, LI.FI; 1Click (Exolix refuses BNB / AVAX → XMR) |
| xDAI (Gnosis) | yes | yes | LI.FI; 1Click |
| CRO, MNT, S, FLR, KAIA, HYPE, SEI (Cronos, Mantle, Sonic, Flare, Kaia, HyperEVM, Sei) | yes | yes | 0x / LI.FI on the same chain only (1Click does not list them) |
| SOL, SPL tokens | yes | yes | Jupiter (same chain); LI.FI / 1Click (cross-chain); Exolix for SOL, USDT and USDC (to XMR / KAS / ALGO / NEAR) |
| BTC | yes | yes | 1Click, LI.FI (to BTC); Exolix (to XMR / KAS / ALGO / NEAR) |
| LTC | yes | yes | 1Click; Exolix |
| DOGE | yes | yes | 1Click; Exolix (**new**: to XMR / KAS / ALGO / NEAR) |
| TRX, USDT (TRC-20) | yes | yes | 1Click; Exolix (**new**: to XMR / KAS / ALGO / NEAR) |
| XRP, ADA, BCH, DASH, ZEC (transparent), SUI, GRAM (TON), APT | yes | yes | 1Click |
| XLM | no | yes | 1Click (arrival only: a Stellar deposit needs a memo) |
| XMR | **yes (1.0.6)** | yes | Exolix (Kyro fee: a second transfer to `recipients.monero`) |
| KAS (Kaspa) | **yes (1.0.6)** | yes | Exolix (fee to `recipients.kaspa`) |
| ALGO (Algorand) | **yes (1.0.6)** | yes | Exolix (fee to `recipients.algorand`) |
| NEAR (native) | **yes (1.0.6)** | yes | Exolix (fee to `recipients.near`, an implicit account) |

Exolix destinations can be reached from ETH (Ethereum, Arbitrum, Base, Optimism), POL, SOL, USDT and USDC
(Ethereum, Solana), BTC, LTC, DOGE, TRX and USDT-TRC20. Since 1.0.6 Monero, Kaspa, Algorand and NEAR are also
sources (Exolix, to any of those destinations and back). Only their native coin is offered, both ways. ASAs and NEP-141 tokens are not mapped.

## Not swappable

| Coin | Reason |
| --- | --- |
| XMR as a source | Kyro has no Monero fee address yet. Exolix routes are never fee-free. |
| KAS, ALGO, NEAR as sources | Kyro has no fee address on these chains, and Exolix's fee is a second transfer on the source chain. 1Click lists only wNEAR (NEP-141), not native NEAR. |
| XLM as a source | 1Click and Exolix both ask for a memo on Stellar deposits. Kyro only sends plain transfers to deposit addresses. |
| HBAR, HTS tokens | 1Click does not list Hedera. Exolix pays only to `0.0.N` account ids and wants a memo on deposits, while Kyro's Hedera account is an EVM alias address. |
| DOT, Asset Hub assets | 1Click does not list Polkadot. Kyro's DOT lives on Asset Hub, and Exolix's `DOT` network checks relay-chain addresses, so delivery to Asset Hub is not confirmed. |
| ATOM | 1Click does not list Cosmos. Exolix refuses the pair (`BTC → ATOM`: "Such exchange pair is not available", 02/11/2026) and wants a memo on ATOM deposits. |
| CFX (Conflux eSpace) | 0x and LI.FI have no contract Kyro checks there. Exolix lists four ambiguous CFX networks (`CFX`, `Conflux`, `CFXEVM`, `CFXESPACE`). |
| Tokens on NEAR, Algorand, Hedera, Polkadot, Stellar, TON, Sui and Aptos that 1Click does not list | No provider route: they can be picked, but no quote comes back. |
