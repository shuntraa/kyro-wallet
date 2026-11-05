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
- The compact filter backend cannot see lock addresses, so locks are refused there.
- With Bitcoin Core as the server, Kyro imports the script into its watch-only wallet before funding.
  A lock the node does not watch yet (another server was in use, or a backup was restored) is imported
  at the next read, after one `scantxoutset` that finds its coins and the height to rescan from. A
  pruned node that cannot rescan that far watches from now on, and Kyro reads those coins one by one
  with `gettxout`. "Find my locks" is one `scantxoutset` too. It sees unspent coins only, so a
  withdrawn lock does not come back in the list.

### What is stored

`<vault>.btclocks`, written atomically beside the vault, one file per wallet and network, so a
second-password session has its own. **It is plain JSON, readable without the password.** Anyone
who can read this Windows account's files learns from it the dates, the account numbers, the last
amounts seen, and whether each lock was withdrawn.

The address is not in it: Kyro derives it again from the seed each time, so the file cannot redirect
anything, and it does not point at your coins on the chain. The one exception is a Bitcoin Core
server: there the file also holds the txid, index and value of each confirmed coin. A pruned node
that could not rescan a lock can only read it by outpoint, and those outpoints do point at the chain.
It stays in clear because the list is written without the password, on every refresh, and the vault's
encryption needs the password. A key derived from the seed would be a new scheme, for a file much like
the watch list and the history cache, which are in clear too.

The backup is encrypted, and adds the address to each line. On import, a line is kept only if this
seed derives the same address. If the file is lost, the scan rebuilds it. If it is unreadable it is
set aside as `.btclocks.damaged`, then `.damaged.1` and so on, never overwritten. If the disk fails
to read it, Kyro stops with an error: it never starts over from an empty list.

## Withdrawing without Kyro

You need the recovery phrase (and the BIP39 passphrase if you set one), the date, Node, and Bitcoin
Core. These exact commands were run by `btc_lock_regtest`, which reads them from this page, on
Bitcoin Core 32.1 in regtest with `--network` set to `testnet`. Earlier versions were not tested.

**What is online.** Step 1 makes no network connection. You can run it on a computer with no network
and carry the key file over, or run it on the node's computer. Core must be running for step 2, and
online and synced from step 3 on. So the key does reach a computer on the internet. That is why it is the key of this
one lock and not your master key: it can spend this lock and nothing else in your wallet, and once
the lock is empty it guards nothing.

**1. Get the key of this lock.** Core has no BIP39, so this is the one step it cannot do. The script
uses Node's standard library and `scripts/bip39-english.txt`. It asks for the phrase and the
passphrase at a prompt that shows nothing, and refuses a phrase that is not valid BIP39, as Kyro
does: a typo gives an error, not the key of an empty wallet. `T` is the Unix time of 00:00 UTC of the
date, shown in the Details view. Set `--account` to the account number (0 is the first account), and
`--from` to a Unix time shortly before the lock was made, or 0 to rescan the whole chain. A pruned
node cannot rescan what it dropped.

```sh
node scripts/btc-lock-key.mjs --network mainnet --t T --account 0 --from 0 --out import.json
```

It prints the public descriptor and writes the key to `import.json`, never to the screen.

**2. Check the address.** The descriptor it printed holds no secret. The answer must be the address
in the Details view. If it is not, stop: the phrase, passphrase, account or date is wrong.

```sh
bitcoin-cli deriveaddresses "PUBLIC_DESCRIPTOR"
```

**3. Create a wallet and import the key**, through `-stdin` so that it stays off the command line,
then delete the file.

```sh
bitcoin-cli createwallet "alone" false true
bitcoin-cli -stdin -rpcwallet=alone importdescriptors < import.json
rm import.json
bitcoin-cli -rpcwallet=alone listunspent
```

`listunspent` must show the coins with `"solvable": true` and `"spendable": true`.

**4. Wait for the network.** `mediantime` must be above `T`:

```sh
bitcoin-cli getblockchaininfo
```

**5. Send.** `locktime` is required. `fee_rate` is in sat/vB.

```sh
bitcoin-cli -rpcwallet=alone -named sendall recipients='["YOUR_ADDRESS"]' fee_rate=2 options='{"locktime":T}'
```

**6. Delete the wallet.** It holds the key of this lock. Wait for the transaction to confirm, then
unload it and delete its folder, `wallets/alone` in the node's data folder (`WALLETS_FOLDER` here).

```sh
bitcoin-cli unloadwallet "alone"
rm -rf WALLETS_FOLDER/alone
```

**Shell history.** None of these commands holds a secret, so there is nothing to clean. If you ever
typed the phrase or a key on a command line by mistake, remove it: `history -c` and delete
`~/.bash_history` in bash, or delete the file given by `(Get-PSReadlineOption).HistorySavePath` in
PowerShell. In PowerShell, replace `< import.json` with `Get-Content import.json | bitcoin-cli ...`
and `rm -rf` with `Remove-Item -Recurse -Force`. Those two forms were not run.

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
spend goes through after T, that Core alone spends a lock with the commands of this page, read from
this file, and that the scan finds a lock with the list deleted. It also covers a lock the node never
heard of, a funding replaced before it confirmed, a pruned node, and a 5-byte `T` on the node.

## What can still go wrong

- **Losing the phrase** loses the coins, and a lock makes that worse: there is no moving them to a
  new wallet first.
- **A lock on another account** is only found by scanning that account. Kyro scans the current one.
- **Fees at withdrawal.** If fees are higher than the lock is worth that day, Kyro refuses to build
  the withdrawal. The coins stay safe until fees come down. A 50,000 sat lock pays for about 440
  sat/vB at most.
- **A withdrawal stuck at a low fee** cannot be sped up from Kyro. It can be spent onward (CPFP) from
  the wallet, or replaced with Core as above once mempools drop it.
- **A stranger's dust.** Anyone can send tiny coins to a lock address, on purpose or not. A coin worth
  less than its own input at the chosen fee rate is left out of the withdrawal, and so are coins past
  400 per transaction. The screen and the dialog say how many stay behind. They remain at the lock,
  and a later withdrawal at a lower fee takes them. If only such coins remain, Kyro refuses and asks
  for a lower fee.
- **Coins not confirmed yet** stay out of a withdrawal: they could be replaced under it. The list says
  how much, and a later withdrawal takes them.
- **Where a withdrawal lands.** The first unused address among the first five receive addresses,
  because those are the only ones Kyro's normal scan reaches whatever a server says. If all five were
  used, the fifth is used again. That costs some privacy, never the coins.
- **A server that says nothing.** A lock Kyro has seen confirmed stays on the Locked line as "unknown"
  if a server later knows nothing of it. If it was really spent outside Kyro while another server was
  in use, it stays that way until a server that has the history answers.
