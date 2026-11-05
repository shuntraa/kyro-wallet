# Bitcoin time lock

A lock sends bitcoins to an address the Bitcoin network itself refuses to spend before a date. It
does not depend on Kyro, on a server or on this computer. Nobody can cancel it once it is
confirmed, not even with the recovery phrase. It is there to stop a sale made on impulse.

Before the first confirmation the funding is an ordinary pending transaction. Like every Kyro send
it signals RBF, so History can still speed it up or cancel it during that window.

## How it works

| What | Value |
|---|---|
| Date `T` | Unix time at 00:00 UTC of the chosen day. A time, never a block height. |
| Key | `m/84'/coin'/account'/2/<day>`, `day = T / 86400`, unhardened. `coin` is 0 on mainnet, 1 on testnet. |
| Script | `<K> OP_CHECKSIGVERIFY <T> OP_CHECKLOCKTIMEVERIFY` |
| Miniscript | `and_v(v:pk(K),after(T))` |
| Descriptor | `wsh(and_v(v:pk(KEY),after(T)))` |
| Address | P2WSH of that script |
| Spending | `nLockTime = T`, input sequence `0xFFFFFFFD`, witness `<signature> <script>` |

The network accepts the spend once the **median time past** of the tip is strictly above `T`. That
median lags the clock, so a lock opens about 1 to 2 hours after 00:00 UTC of its date.

One date on one account is one key and one address. Two locks on the same date share the address
and are withdrawn together. The phrase alone finds every lock: "Find my locks" walks the days from
2026-11-05 (`BTC_LOCK_FIRST_DAY`) to 10 years ahead on the current BIP84 account and asks the server
about each address.

**None of this may ever change.** A different path or script would leave existing locks unfindable.
`frozen_vectors_never_change` in `crates/wallet-core/src/btc_lock.rs` pins them.

### Limits

- From tomorrow (UTC) to 10 years ahead, checked in Rust on both the local clock and the chain tip's
  time, which must not disagree by more than 2 hours.
- **Not after 2038-01-19.** Miniscript's `after(n)` stops at `n < 2^31`. A later date still works on
  the network, but it has no standard descriptor, and Bitcoin Core refuses it: "A function is needed
  within P2WSH". Kyro will not make a lock that standard tools cannot spend, so from January 2028
  the longest lock gets shorter than 10 years.
- At least 50,000 sats. The withdrawal fee comes out of the locked amount.
- Software wallets only. Hardware and watch-only accounts are refused: Kyro has no key for them.
- The compact filter backend cannot see lock addresses, so locks are refused there. With Bitcoin
  Core as the server, Kyro imports the script into its watch-only wallet before funding, and "Find
  my locks" runs one `scantxoutset`. That sees unspent coins only, so a withdrawn lock does not come
  back in the list.

### What is stored

`<vault>.btclocks`, written atomically beside the vault, one file per wallet and network, so a
second-password session has its own. It holds account, date and last amount seen. Addresses are
always derived again from the seed. The backup includes the list; on import, a line is kept only if
this seed derives the same address. If the file is lost, the scan rebuilds it. If it is unreadable
it is set aside as `.btclocks.damaged`, never overwritten.

## Withdrawing without Kyro

You need the recovery phrase (and the BIP39 passphrase if you set one), the date, and a synced
Bitcoin Core node. These steps were run against Bitcoin Core 32.1 on regtest, with `tprv` and coin
type 1, by `btc_lock_regtest`. Earlier versions were not tested. The commands below are that run,
written for mainnet. Testnet uses `testnet` and `1h`.

**1. Get the master key from the phrase.** Core has no BIP39, so this is the one step it cannot do.
The script uses Node's standard library only. Do this offline: the output spends your coins.

```sh
node scripts/btc-phrase-to-xprv.mjs mainnet
```

Type the phrase, then Ctrl+D (Ctrl+Z, Enter on Windows). With a passphrase, set
`KYRO_BIP39_PASSPHRASE` first.

**2. Write the descriptor.** The Details view of a lock gives `T`, the path and `DAY`. Without
it: `T` is the Unix time of 00:00 UTC of the date, and `DAY = T / 86400`. `ACCOUNT` is 0 for the
first account.

```
wsh(and_v(v:pk(XPRV/84h/0h/ACCOUNTh/2/DAY),after(T)))
```

**3. Add its checksum, and check the address** is the one in the Details view.

```sh
bitcoin-cli getdescriptorinfo "DESCRIPTOR"
bitcoin-cli deriveaddresses "DESCRIPTOR#CHECKSUM"
```

**4. Import it** into a new wallet. `timestamp` 0 rescans the whole chain; a Unix time shortly before
the lock was made is much faster. A pruned node cannot rescan what it dropped.

```sh
bitcoin-cli createwallet "alone" false true
bitcoin-cli -rpcwallet=alone importdescriptors '[{"desc":"DESCRIPTOR#CHECKSUM","timestamp":0}]'
bitcoin-cli -rpcwallet=alone listunspent
```

`listunspent` must show the coins with `"solvable": true` and `"spendable": true`.

**5. Wait for the network.** `mediantime` must be above `T`:

```sh
bitcoin-cli getblockchaininfo
```

**6. Send.** `locktime` is required. `fee_rate` is in sat/vB.

```sh
bitcoin-cli -rpcwallet=alone -named sendall recipients='["YOUR_ADDRESS"]' fee_rate=2 options='{"locktime":T}'
```

**7. Clean up.** The node's wallet now holds a private key of your seed. Unload it and delete its
folder.

### Sparrow

Not tested, so do not count on it. Check first, with a small amount on testnet, that Sparrow accepts
this descriptor. Bitcoin Core is the route that was proven.

## The proof

`apps/desktop/src-tauri/src/btc_lock_regtest.rs` runs all of this against a real `bitcoind`, with
the app's TypeScript and Rust funding the locks:

```sh
KYRO_BITCOIN_BIN=<folder with bitcoind and bitcoin-cli> \
  cargo test -p kyro-desktop btc_lock_regtest -- --ignored --nocapture --test-threads=1
```

It checks Core's own addresses against Kyro's on mainnet, testnet4 and regtest. It checks that a
correctly signed spend is refused as `non-final` up to and including MTP = T, both in the mempool
and in a block, that a low `nLockTime`, a final sequence or another key fail the script, that Kyro's
spend goes through after T, that Core alone spends a lock from the phrase, and that the scan finds a
lock with the list deleted. It also spends a lock with a 5-byte `T` on the node.

## What can still go wrong

- **Losing the phrase** loses the coins, and a lock makes that worse: there is no moving them to a
  new wallet first.
- **A lock on another account** is only found by scanning that account. Kyro scans the current one.
- **Fees at withdrawal.** If fees are higher than the lock is worth that day, Kyro refuses to build
  the withdrawal. The coins stay safe until fees come down. A 50,000 sat lock pays for about 440
  sat/vB at most.
- **A withdrawal stuck at a low fee** cannot be sped up from Kyro. It can be spent onward (CPFP) from
  the wallet, or replaced with Core as above once mempools drop it.
- **A stranger's dust** on a lock address is withdrawn with it, largest coins first, at most 400 per
  transaction.
