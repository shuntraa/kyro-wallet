# Changelog

## 1.0.7

- Lightning: pay an invoice from a Bitcoin account. Paste it in Send or tick Lightning. Kyro checks the swap on your device and shows every fee first. The provider can only take your bitcoin by paying the invoice. If it fails, your coins stay locked about 7 days, then you take them back yourself. Not for hardware accounts, and an invoice needs at least an hour left.
- Tor bridges: if your country blocks Tor, paste plain bridge lines in Settings › Privacy. Kyro
  then connects only through them and stays offline if none answers. obfs4 and other disguised
  bridges don't work yet.
- Tokens you received on Sui, Cosmos Hub and Bitcoin Cash now show on the SUI, ATOM and BCH pages,
  read only: they can't be sent from Kyro yet. Tokens Kyro can't name stay folded, since many are
  spam.
- Lock before sleep: on Windows, Kyro now locks as the computer goes to sleep, not only when it
  wakes up. On by default, in Settings › Security. macOS and Linux still lock on wake.
- Send: type a name.eth as the recipient on EVM chains. Kyro shows the address under the field,
  and the review and the signing window show that real address. Names stored off-chain aren't
  read.
- Backup: Settings › Backup exports your contacts, labels, watch list, favorites, alerts and
  settings to one encrypted file, with a password you choose. Import shows what would change
  first and replaces nothing unless you ask. Never your phrase, keys, API keys or servers.
- Windows tray icon: Open, Lock and Quit. Settings › Security can keep Kyro in the tray when you
  close the window, and start it with Windows, minimized. Both are off by default. Going to the
  tray locks the wallet unless you change it, and quitting from the tray still applies a staged
  update.
- Gains and losses: average cost and unrealized gain per coin and in total, on the Portfolio and
  on each asset page, computed on your device. Where a price or an origin is unknown Kyro shows
  « — » or says the figure is partial.
- Alerts: price alerts per coin (above or below a level) and "funds received", as system
  notifications. Set them in Settings › Alerts. They work while Kyro is open and unlocked, from
  data it already loads; nothing leaves your device.
- Send: the fee speeds show their cost before you fill in the amount, and a custom fee moved
  under Advanced, with its allowed range. Values outside that range are refused.
- History: speed up or cancel a pending Bitcoin, Litecoin or EVM send, with hardware wallets too.
  You see the extra cost first. Bitcoin and Litecoin sends are now marked replaceable, so this
  works for sends made from this version on.
- Asset pages: Swap is open for every coin Swap supports, not only EVM and Solana.
- Search: also finds your contacts, your history and the settings sections.
- Price charts: "All" really goes back years (Bitcoin: 2013), opens at once, with
  the % from the first point and the year in the date.
- Swap: the Best price panel now shows the provider, route, minimum received, Kyro fee,
  provider fee and estimated time, with other quotes listed below.
- Staking from hardware wallets: Solana on Ledger and Trezor (create, delegate, deactivate,
  withdraw), decoded on the device.
- Staking from hardware wallets: Cardano delegation on Ledger and Trezor. Rewards can be
  withdrawn on a Trezor (firmware 2.8.5 or later), not on a Ledger: its app does not show them.
- Staking from hardware wallets: NEAR pools on Ledger, from the Ledger's own NEAR account.
- Hardware wallets: TON USD₮ can be sent from Ledger accounts (TON app 2.2.0 or later); the
  device shows the token, the amount and the recipient. No comment on these transfers: the
  app cannot show it.
- Hardware wallets: Stellar USDC can be sent from Ledger and Trezor accounts, and its trustline
  enabled or removed there (Receive), each shown in full on the device.
- Hardware wallets: Sui USDC can be sent from Ledger accounts, the device reading the token and
  the amount from the coins themselves (8 coins per transfer at most).
- Hardware wallets: Aptos USDC and USDt can be sent from Ledger accounts (Aptos app 0.10.1 or
  later), shown by name and amount on the device.
- Hardware wallets: Algorand USDC and USDt can be enabled and sent from Ledger accounts.
- Hardware wallets: NEAR USDC and USDt can be sent from Ledger accounts; the device shows the
  contract and the recipient, and the amount in raw units (Kyro's window names the token).
- Ledger device check: real signatures, never broadcast, on TON, NEAR, XRP and Litecoin.
- Earn: stake SUI with a validator (validators, measured yield, rewards, withdraw at any time).
- Change password: Settings › Security, for the wallet in use. The new vault is checked before
  it replaces the old one, then Kyro locks and asks for the new password.
- Earn: stake APT in a delegation pool (add, unlock, withdraw after the pool's lockup).
- Simulation before signing: on swaps and Earn calls, the review now says what you send and
  receive, which approvals you grant, and warns about a call that would fail, an unlimited
  approval, or an unknown or brand-new contract. It runs on your own RPC node and only warns:
  the review stays the reference.
- Several wallets: keep more than one recovery phrase on this device, each with its own
  password, accounts and history. Switch from the title bar; add, rename and remove in
  Settings › Accounts. Your existing wallet and its file do not change.
- Watch addresses: follow any public address or xpub with no key (balance, tokens, history).
  The network is detected from what you paste. Send, Swap and Earn are off for them, and a Watch
  tag shows it. Add one in Settings › Accounts, from the title bar, or on the welcome screen.

## 1.0.6

- Switching between Portfolio and Assets no longer slides the tab underline across the screen.
- Ledger Litecoin: the app's protocol is detected by asking it (Litecoin 2.4.x is still the
  legacy app), and the account is read without the master key the app refuses, instead of
  being reported as outdated.
- Address book: the network is detected from the pasted address (a short choice only when
  several match), Enter saves and the name is optional. Send offers "Save" for a new recipient.
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
- Hardware wallets: TRON tokens (TRC-20, e.g. USDT) can be sent from Ledger accounts; when the
  Tron app needs a setting, Kyro names it ("Allow data" or "Custom contracts").
- Ledger: connect in one step, like Ledger Live. Every chain the Ledger supports is ticked;
  one "Connect" opens each app in turn, reads the keys, and skips an app that is not installed
  or refused. A short result per chain follows (Added / Not installed / Skipped).

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
