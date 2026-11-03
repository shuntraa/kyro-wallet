# Changelog

## 1.0.6

- History is fetched in the background after unlock and kept per wallet, so the History page
  opens on a ready list; while it refreshes, what is there shows with a small "Updating…".
  Unreachable networks are named in a calm line and retried on their own.
- Price charts: "All" now goes back years (Kraken public weekly prices, no account), and is
  hidden for coins without a long history instead of repeating 1Y.
- Arbitrum history works over Tor again: a second public node (arb1.arbitrum.io) is tried when
  publicnode refuses.
- Search: one result per coin, with its icon and your balance or its rank.
- Receive: a quieter network note.
- Swap: Monero, Kaspa, Algorand and NEAR can now be swapped FROM (Exolix), not only to.
- Ledger: Litecoin works with the current Litecoin app (keys, address on screen, signing over the
  new protocol); an app that does not understand Kyro now says to update it in Ledger Live.
- Hardware wallets: Solana tokens (SPL, e.g. USDC/USDT) can be sent from Ledger and Trezor
  accounts, creating the recipient's token account when needed; a Trezor shows the recipient
  wallet, a Ledger that needs it says "Enable Blind signing in the Solana app settings".

## 1.0.5

- Earn (was Staking): a new page with 14 options and live estimated rates. New: ETH liquid
  staking with Lido (stake, unstake through the withdrawal queue, claim), and lending on
  Aave v3: USDT, USDC, DAI and WETH on Ethereum, USDT and USDC on Arbitrum and Polygon, USDC
  on Base. Every step shows the contract, the function and the exact amount; approvals are
  for the exact amount only.
- Activity: an asset page only waits for its own blockchain. Empty history is remembered, so
  "No activity" shows at once; a spinner never stays more than a few seconds.
- Charts fit the window in width and height.
- Earn opens from its last state, without grey placeholders.
- Notifications: one short style everywhere, starting with the update notice.
- Asset page: "Loading activity…" until the first answer, never "No activity" before it. The
  header wraps on narrow windows (the period selector stays whole).
- Earn: a rate that cannot be read shows "—" after a few seconds; the page scrolls normally.
- Token picker: Escape closes it.
- Swap: pick any coin you hold, on any network, without a network menu; the account choice
  only shows when you have several. The rate ("1 BTC ≈ 31.2 ETH") and what you receive show
  under the amounts.
- Earn: live estimated rates for Solana, Cardano and TRON (network-wide, before the
  validator, pool or SR commission), read from the servers Kyro already uses.
- Earn with a Ledger or Trezor: Lido and Aave work from hardware wallet accounts. Kyro names the
  contract and function first, then the device shows the transaction; a Ledger with blind
  signing off gets a short hint. Staking on Solana, Cardano, TRON and NEAR still needs a
  recovery-phrase account.
## 1.0.4

- Staking: NEAR. Stake, unstake and withdraw with NEAR staking pools. Kyro only accepts pools
  from the official factories and checks the pool's code before each transaction.
- Swap: search by name or ticker in the coin picker. Monero shows in the list and can be bought
  from more coins (ETH on Arbitrum, Base, Optimism, POL, DOGE, TRX, USDT on TRON). Kaspa,
  Algorand and NEAR can now be received from a swap.
- Faster: charts are kept on your computer and only the recent part is refreshed. Each
  blockchain shows as soon as it answers. Staking opens from its last state.
- My assets: one row per crypto, with every account under it.
- Tokens from the top 250 (Quant and others) open as supported assets instead of "price only".
- Charts stay continuous at any window size. No more endless "Loading" on asset pages.
- Updates install when you close the window.
- Simpler texts in Settings, recovery phrase checks and update notices. Cleaner outgoing
  connections and API key screens.
## 1.0.3

- Swap: Monero. Swap BTC, LTC, ETH, SOL, USDT or USDC to XMR through Exolix (no account,
  no key, over Tor). Kyro creates the order, checks that it pays your own Monero address and
  that the deposit address is valid, then sends a normal transfer. Kyro's service fee is a
  second small transfer of the same coin. XMR to other coins comes later. Tested with live
  quotes only.
- Ledger: Kyro now opens the right app for you. Plug in and unlock the Ledger, click Connect,
  and approve "Open Bitcoin" (or Ethereum, Solana…) on the device when asked. If another app
  is open, Kyro closes it first. A missing app shows "Install the app with Ledger Live".
  Same when signing from a Ledger account. Not yet tested on a real Ledger.

## 1.0.2

- Tor: fixed history failing on EVM networks ("Protocol error while launching a data
  stream") and the slowness behind it. A server refusing one Tor exit no longer moves every
  network of the same family onto new circuits; requests per family are bounded; a stream
  refused by a just-closed circuit is retried on a new one. Tor still never falls back to clear.
- History: no more raw error text. A short message with Retry is shown instead; the
  technical detail is in Settings > Network diagnostics.
- History: activity shows at once from a local cache (amounts and transaction details only),
  then refreshes in the background; each blockchain appears as soon as it answers, without
  waiting for the slowest. No more long grey placeholder rows.
- Privacy: new anonymous weekly count (on by default, Settings > Privacy). Once a week, over
  Tor only, Kyro downloads a tiny file from its GitHub release so the download counter can
  estimate active wallets. No identifier and no personal data are sent.

## 1.0.1

- Windows: new one-click installer. No wizard any more: a single branded Kyro window
  installs the app for the current user, then starts Kyro and closes. Silent, passive and
  in-app update installs behave as before.
- Windows: the uninstaller now shows the Kyro icon instead of the default NSIS one.

## 1.0.0

- First stable release.
