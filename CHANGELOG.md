# Changelog

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
