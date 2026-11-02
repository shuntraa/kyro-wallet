# Changelog

## 1.0.2

- Tor: fixed history failing on EVM networks ("Protocol error while launching a data
  stream") and the slowness behind it. A server refusing one Tor exit no longer moves every
  network of the same family onto new circuits; requests per family are bounded; a stream
  refused by a just-closed circuit is retried on a new one. Tor still never falls back to clear.
- History: no more raw error text. A short message with Retry is shown instead; the
  technical detail is in Settings > Network diagnostics.

## 1.0.1

- Windows: new one-click installer. No wizard any more: a single branded Kyro window
  installs the app for the current user, then starts Kyro and closes. Silent, passive and
  in-app update installs behave as before.
- Windows: the uninstaller now shows the Kyro icon instead of the default NSIS one.

## 1.0.0

- First stable release.
