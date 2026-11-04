# Ledger real-device check

Checks every chain Kyro supports on Ledger against the device plugged into this PC. Nothing is
broadcast and nothing goes online. The signed items are a dummy message (EVM, Bitcoin, Litecoin
new app) and transactions the network could not accept, verified locally then dropped:

- Solana: a transfer with a fake blockhash.
- Litecoin (either app): 0.0009 LTC spending a made-up coin, a real transaction signature.
- TON: 1 nanoton to yourself and 0.000001 USDT (the token path), both expired in 2001.
- NEAR: 1 yoctoNEAR and a 1-unit USDC `ft_transfer` to `bob.near`, with a fake block hash.
- XRP: 0.000001 XRP with a `LastLedgerSequence` long past.

1. Close Ledger Live (it holds the USB device). Plug in the Ledger, unlock it, stay on the dashboard.
2. Run, from `E:\wallet` (PowerShell):

   ```powershell
   $env:CARGO_TARGET_DIR='E:\wallet\.claude\cargo-ldg'; $env:CARGO_INCREMENTAL='0'
   cargo test -p kyro-desktop --lib ledger_device_check -- --ignored --nocapture
   ```

3. Approve on the device whenever the output says `-> approve …`: opening each app, then each
   message or transaction above. Compare what the device shows with that line. Each step waits
   up to 10 minutes.

What you see, per chain (`== Chain (app "Name" min+)`):

- `OK   open <app> <version> (SW 9000)`, then `OK read key …`, `OK re-derive … ` (the address
  Kyro computes from the returned key matches the device), and for the signing chains
  `OK sign … (SW 9000)` and `OK signature verifies with the read key`.
- `SKIP not installed (… SW 6807)`: install that app in Ledger Live if you want the chain.
- `SKIP refused on the device (SW 5501)`: you refused opening that app.
- `FAIL <step>: <error> (SW xxxx)`: something is wrong; send the output.

It ends with `== Summary: N OK, M FAIL, skipped: …` and the test passes when M is 0. Refusing a
signature counts as FAIL (SW 6985). Ledger's "Allow secure connection with Ledger Live" prompt
is not part of this check (it is reserved for Ledger Live).
