# Changelog

## 1.0.3

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
