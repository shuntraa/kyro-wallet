// SPDX-License-Identifier: GPL-3.0-or-later
// Guides and glossary of kyrowallet.com. Same rule as the rest of the site: only what the repo backs.

import { SITE, REPO, DL, FILES, html, a, pageHero, ctaPanel, installBlock } from './layout.mjs';
import { confirmCard, moneroCard, phraseCard, privateCard, seesCards, term, vaultCard } from './components.mjs';
import { head, sec, ul, nextLinks, strip } from './kit.mjs';
import { webPage, APP_ID } from './pages.mjs';

const PUBLISHED = '2026-11-04';
const steps = (items) => `<ol class="os-steps">${items.map((i) => `<li>${i}</li>`).join('')}</ol>`;
const warn = (t) => `<p class="note note-warn">${t}</p>`;

const GROUPS = [
  ['start', 'Getting started'],
  ['safe', 'Privacy and safety'],
  ['money', 'Swap and earn'],
  ['hw', 'Hardware wallets']
];

const GUIDES = () => [
  {
    slug: 'first-steps-with-kyro',
    group: 'start',
    short: 'First steps with Kyro',
    blurb: 'From the welcome screen to your first receive address.',
    title: 'First steps with Kyro: set up your wallet | Kyro Wallet',
    h1: 'First steps <em>with Kyro</em>',
    desc: 'Set up Kyro Wallet from scratch: choose a start, set a password, write down your recovery phrase, receive your first coins and send a small test.',
    lead: 'Ten calm minutes: install, choose how to start, save your phrase, then try a small amount before you move anything serious.',
    related: ['back-up-your-recovery-phrase', 'verify-your-download', 'move-from-another-wallet'],
    body: () => html`
      <h2>1. Install Kyro</h2>
      <p>The quickest way is the one-line command. It downloads the latest release from GitHub and checks its SHA-256 before installing.</p>
      ${installBlock('guide-install')}
      <p>If you prefer the file, ${a('/download/', 'download it')} and ${a('/guides/verify-your-download/', 'verify it')} first.</p>
      <h2>2. Choose how to start</h2>
      <p>The welcome screen offers three ways in. There is no account in any of them.</p>
      ${ul([
        '<b>Use a Ledger or Trezor.</b> Your keys stay in the device, and Kyro stores only public keys.',
        '<b>Create a new vault.</b> Kyro makes a new recovery phrase, 24 words by default.',
        '<b>Import a recovery phrase.</b> 12 or 24 BIP39 words from another wallet.'
      ])}
      <h2>3. Pick a password</h2>
      <p>At least 10 characters, and a phrase of four words or more is better. It encrypts the vault on this computer, and you will type it to unlock Kyro and to sign. It cannot be recovered.</p>
      <h2>4. Write down your phrase</h2>
      <p>Kyro shows the words in a separate window, blurred until you choose to show them. Write them on paper, in order, then type the three words Kyro asks for. ${a('/guides/back-up-your-recovery-phrase/', 'How to keep that paper safe')}.</p>
      ${phraseCard()}
      <h2>5. Look around</h2>
      <p>Portfolio shows your total and your assets. Swap, Earn and History sit in the side rail. Ctrl K searches assets and addresses. The vault panel shows Tor, auto-lock and whether any unlimited approval is active.</p>
      ${vaultCard()}
      <p>Tor needs a moment to connect at launch. If it is not ready within 60 seconds, a request fails and nothing is sent in the clear.</p>
      <h2>6. Receive, then send a little</h2>
      ${steps([
        'Open an asset and choose <b>Receive</b>. Copy the address, or use the QR code.',
        'Send a small amount from wherever your coins are now.',
        'Back in Kyro, check that it arrives.',
        'Send a small amount out. Kyro asks for your password, then shows the decoded transaction in a system window. Read it, then confirm.'
      ])}
      <h2>Worth a look in Settings</h2>
      ${ul([
        '<b>Privacy.</b> The anonymous weekly count is on by default, over Tor only. You can turn it off here.',
        '<b>Security.</b> Check your phrase again, and for Monero, set the scan height.',
        '<b>Networks.</b> Point a blockchain at your own node.'
      ])}`
  },
  {
    slug: 'verify-your-download',
    group: 'start',
    short: 'Verify your download',
    blurb: 'Check a release with SHA-256 in two minutes.',
    title: 'How to verify your Kyro download with SHA-256 | Kyro Wallet',
    h1: 'Verify <em>your download</em>',
    desc: 'Check that your Kyro installer is the file published on GitHub Releases: compare its SHA-256 with SHA256SUMS on Windows, macOS or Linux, before you run it.',
    lead: 'A wallet is a bad thing to install from a fake link. This takes two minutes and proves your file matches the published release.',
    related: ['windows-smartscreen', 'first-steps-with-kyro', 'how-to-spot-address-poisoning'],
    body: () => html`
      <h2>Where Kyro comes from</h2>
      <p>Kyro is published only on <a href="${REPO}/releases/latest">GitHub Releases</a>. The links on ${a('/download/', 'our download page')} point there. There is no mobile app, so anything in an app store using the name is not ours.</p>
      <h2>The easy way</h2>
      <p>The one-line install does this check for you. It compares the SHA-256 of the file with <code>SHA256SUMS</code>, and stops if they differ. Read the scripts first if you like: <a href="/install.ps1">install.ps1</a> and <a href="/install.sh">install.sh</a>.</p>
      <h2>By hand</h2>
      ${steps([
        `Download your installer and <a href="${DL}${FILES.sums}">SHA256SUMS</a> into the same folder.`,
        'Run the command for your system.',
        'Compare the result with the line for your file in SHA256SUMS. Every character must match.'
      ])}
      ${term('Windows, PowerShell', [`$ Get-FileHash .\\${FILES.exe} -Algorithm SHA256`])}
      ${term('macOS, Terminal', [`$ shasum -a 256 ${FILES.dmg}`])}
      ${term('Linux, Terminal', ['$ sha256sum -c SHA256SUMS --ignore-missing'])}
      <h2>If the hashes differ</h2>
      <p>Delete the file and download it again from GitHub Releases. Do not run it.</p>
      <h2>What this proves, and what it does not</h2>
      <p>A match proves your file is the one listed in that release, with no corruption and no swap along the way. It does not prove the code is free of bugs, and it depends on the release itself being genuine.</p>
      <p>Two more honest limits. The installers are not code-signed yet, so your system warns on first launch: check the hash before you click through. Bit-for-bit reproducible builds are a goal, not a guarantee yet. If you want more certainty, ${a('/open-source/', 'build Kyro from source')}.</p>
      <h2>After the first install</h2>
      <p>Updates verify themselves. Each one is signed, and Kyro checks the signature against a public key built into the app before installing. A bad signature is rejected.</p>`
  },
  {
    slug: 'back-up-your-recovery-phrase',
    group: 'start',
    short: 'Back up your recovery phrase',
    blurb: 'Paper, in order, offline. What to do and what to avoid.',
    title: 'How to back up your recovery phrase safely | Kyro Wallet',
    h1: 'Back up your <em>recovery phrase</em>',
    desc: 'Your recovery phrase is the only way back into a non-custodial wallet. How to write it down, store it, check it, and what to do if someone sees it.',
    lead: 'Your recovery phrase is your wallet. Kyro keeps no copy and cannot reset it, so this page matters more than any other on the site.',
    related: ['first-steps-with-kyro', 'move-from-another-wallet', 'how-to-spot-address-poisoning'],
    body: () => html`
      <h2>What the phrase is</h2>
      <p>The 12 or 24 words generate every key in your wallet, on all 36 blockchains. Anyone who has them can spend your coins from anywhere. If you lose them and also lose your computer or your password, your funds are gone. There is no support desk that can help.</p>
      <p>Your phrase and your password do different jobs. The password protects the vault on this computer. The phrase rebuilds the wallet on any computer. You need to protect both, and the phrase is the one that matters most.</p>
      ${phraseCard()}
      <h2>How Kyro shows it</h2>
      <p>The phrase only appears in a separate native window, never in the app’s interface. The words stay blurred until you choose to show them, and they cannot be copied. On Windows the window is excluded from screenshots and screen sharing, and from most capture on macOS. That protection does not exist on Linux, and it never stops a camera, so check who and what can see your screen.</p>
      <h2>Write it down</h2>
      ${steps([
        'Use paper and a pen. Write the words in order, with their numbers.',
        'Check each word against the screen, one at a time.',
        'Type the three words Kyro asks for. That confirms the sheet is right.',
        'If you skipped this, do it later in <b>Settings › Security</b>.'
      ])}
      <h2>Keep it safe</h2>
      ${ul([
        'Keep it somewhere safe from water, fire and curious visitors.',
        'A second copy in another place protects you against losing the first.',
        'Tell someone you trust how to find it if something happens to you, without giving them the words.'
      ])}
      ${ul([
        'No photos, no screenshots, no notes app.',
        'No cloud storage, email or chat, even to yourself.',
        'No password manager synced online, unless you have thought hard about what that means.',
        'Never type it on a website.'
      ], 'checks minus')}
      ${warn('Nobody legitimate will ever ask for your phrase: not Kyro, not support, not an airdrop. Anyone who asks is trying to steal from you.')}
      <h2>If someone may have seen it</h2>
      <p>Act as if they have. Create a new vault with a new phrase, then send everything to the new addresses. Do this before anything else.</p>
      <h2>Monero’s 25 words</h2>
      <p>Kyro can also show a 25-word Monero seed for the same wallet, to restore it in Monero GUI, Feather or Cake Wallet. Treat it the same way. It only covers your XMR, so it does not replace your recovery phrase.</p>
      <h2>Hardware wallets</h2>
      <p>With a Ledger or Trezor, the phrase belongs to the device. Back it up the way the manufacturer tells you, and initialize the device with a phrase it generated itself.</p>`
  },
  {
    slug: 'move-from-another-wallet',
    group: 'start',
    short: 'Move from another wallet',
    blurb: 'Import your phrase, or send your coins across.',
    title: 'Move to Kyro from another wallet with your phrase | Kyro',
    h1: 'Move from <em>another wallet</em>',
    desc: 'Import a 12 or 24-word BIP39 recovery phrase into Kyro, or send your coins to a new phrase instead. What carries over, and what can look different.',
    lead: 'If your wallet uses a standard BIP39 phrase, you can import it in a minute. Sometimes a fresh phrase is the better move.',
    related: ['back-up-your-recovery-phrase', 'first-steps-with-kyro', 'why-a-wallet-should-use-tor'],
    body: () => html`
      <h2>Two ways to move</h2>
      <p><b>Import your phrase.</b> Quick, and your old wallet keeps working, because both now hold the same keys.</p>
      <p><b>Create a new phrase and send your coins.</b> Slower and it costs network fees, but your funds end up on keys that have never been in another app. Choose this if you are unsure how your old phrase was handled.</p>
      <h2>Import a phrase</h2>
      ${steps([
        'On the welcome screen, choose <b>Import a recovery phrase</b>.',
        'Enter your BIP39 words in English, in order. You can paste the whole phrase into the first box. Screenshots are blocked while you type.',
        'Choose a password to encrypt the phrase on this device.',
        'Kyro shows your accounts. Wait for each blockchain to answer over Tor.'
      ])}
      <h2>If a balance looks wrong</h2>
      ${ul([
        '<b>Different derivation.</b> The same phrase can give different addresses in different wallets. Compare a receive address from both. If they differ, your coins are safe, but they sit on keys Kyro is not showing. Send them across from the old wallet.',
        '<b>Another account.</b> Kyro supports several accounts per blockchain. Coins may sit on a later account.',
        '<b>Ledger accounts.</b> On NEAR, TON and Cardano, a Ledger gives different accounts than the same phrase in software.',
        '<b>Monero.</b> Kyro scans from a starting block. If this phrase received XMR earlier, pick an older height in Settings › Security.'
      ])}
      <h2>What does not import</h2>
      ${ul([
        'A 25-word Monero phrase made elsewhere. Send those XMR to your Kyro address.',
        'Phrases that are not BIP39 English words. Send those coins across instead.',
        'Your history of labels and contacts. Add addresses to Kyro’s address book as you go.'
      ], 'checks minus')}
      <h2>Send across, safely</h2>
      ${steps([
        'Create your new vault and ' + a('/guides/back-up-your-recovery-phrase/', 'back up the phrase') + ' first.',
        'Copy your Kyro receive address. Paste it and compare it in full, with care.',
        'Send a small test, and wait for it to arrive.',
        'Send the rest, chain by chain.'
      ])}
      <p>Token approvals you gave from the old keys stay in place if you keep using them, so moving to fresh keys also leaves those behind.</p>`
  },
  {
    slug: 'windows-smartscreen',
    group: 'start',
    short: 'What Windows SmartScreen means for Kyro',
    blurb: 'Why the warning shows, and how to handle it.',
    title: 'Windows SmartScreen warning for Kyro, explained | Kyro Wallet',
    h1: 'What SmartScreen <em>means for Kyro</em>',
    desc: 'Why Windows shows “Windows protected your PC” for Kyro, what it does and does not tell you, how to verify the installer, and how to avoid the warning.',
    lead: '“Windows protected your PC” is about reputation and signatures. Here is what that means for Kyro today, plainly.',
    related: ['verify-your-download', 'first-steps-with-kyro', 'back-up-your-recovery-phrase'],
    body: () => html`
      <h2>Why you see it</h2>
      <p>Kyro’s Windows installers are not code-signed yet. A file downloaded by a browser carries a “downloaded from the internet” mark, so SmartScreen shows the warning until that file has built up reputation.</p>
      <p>Reputation is tied to the file’s hash. Every release is a new file, so every release starts from zero.</p>
      <h2>What the warning tells you</h2>
      <p>It says Windows does not recognise this file yet. It does not say the file is harmful, and clearing it would not prove the file is safe. Your own check is the one that counts.</p>
      <h2>What to do</h2>
      ${steps([
        'Make sure the file came from GitHub Releases or ' + a('/download/', 'our download page') + '.',
        a('/guides/verify-your-download/', 'Verify its SHA-256') + ' against SHA256SUMS.',
        'Run it. On the blue window, click <b>More info</b>, then <b>Run anyway</b>.'
      ])}
      ${warn('If the hash does not match, delete the file. Do not click through.')}
      <h2>How to avoid it</h2>
      <p>Install with the one-line command. PowerShell does not add the “downloaded from the internet” mark, and the script checks the SHA-256 for you.</p>
      ${term('PowerShell', ['$ irm https://kyrowallet.com/install.ps1 | iex'])}
      <p>Updates applied by Kyro itself never trigger the warning either, and they are signed and verified.</p>
      <h2>What we do about it</h2>
      <p>Each release’s Windows installers are submitted to Microsoft for review. Microsoft does not guarantee this clears the warning for home users, since reputation mostly builds with downloads. Code signing is on the ${a('/roadmap/', 'roadmap')}, and the ${a('/code-signing-policy/', 'code signing policy')} sets out the rules.</p>
      <h2>And macOS?</h2>
      <p>Same cause, different screen. Gatekeeper blocks the first launch of a downloaded file. See ${a('/wallets/macos/', 'Kyro for macOS')}.</p>`
  },
  {
    slug: 'why-a-wallet-should-use-tor',
    group: 'safe',
    short: 'Why a wallet should use Tor',
    blurb: 'Your IP and your addresses in the same log line.',
    title: 'Why a crypto wallet should use Tor | Kyro Wallet',
    h1: 'Why a wallet <em>should use Tor</em>',
    desc: 'Every balance check tells a server your addresses and your IP address. What that leaks, what Tor changes, and what it leaves exposed, in plain words.',
    lead: 'Self-custody protects your coins. It does little for your privacy. The leak happens before you ever send anything.',
    related: ['how-to-spot-address-poisoning', 'swap-to-monero', 'move-from-another-wallet'],
    body: () => html`
      <h2>What a wallet does all day</h2>
      <p>A wallet does not hold coins. It asks servers about addresses: what is the balance, what happened, what does this fee cost. Each of those questions travels with your IP address.</p>
      <p>Your IP points to your internet connection, and often to a city. Your addresses point to everything you have ever received and spent on a public blockchain. A server that sees both in one log line can connect them.</p>
      ${seesCards()}
      <h2>The linking problem</h2>
      <p>The worse part is what happens across addresses. Ask about your Bitcoin, Ethereum and Solana addresses from one IP, and you have told that server they belong together. Keeping separate accounts achieves little if a single connection asks about all of them.</p>
      <p>Why does it matter? Holders of crypto are targets. A record that ties a home connection to a balance is worth protecting, whatever the size of the balance.</p>
      <h2>What Tor changes</h2>
      <p>Tor sends your traffic through three relays. The first sees your IP but not the destination. The last sees the destination but not you. The server sees a Tor exit relay.</p>
      <p>${a('/tor/', 'Kyro builds this in')}. It adds three things that matter for a wallet:</p>
      ${ul([
        '<b>On by default.</b> A privacy setting you forget to enable protects nobody.',
        '<b>Separate circuits.</b> Each blockchain family has its own, so the circuit does not link your lookups.',
        '<b>Fails closed.</b> If Tor is down, requests fail. A silent fallback to a direct connection would expose you at the worst moment.'
      ])}
      <h2>What Tor does not change</h2>
      ${ul([
        'The server you query still sees the addresses you ask about. Tor hides who is asking, not what is asked.',
        'Blockchains stay public. Tor protects your connection, not the transaction record.',
        'Swap providers see the order they process.',
        'Your own habits still count: reusing addresses or sending between your accounts links them on chain.'
      ], 'checks minus')}
      <p>For the strongest setup, combine Tor with your own node, so no third party sees your addresses at all. For a coin built around private transfers, see ${a('/monero/', 'Monero in Kyro')}.</p>`
  },
  {
    slug: 'how-to-spot-address-poisoning',
    group: 'safe',
    short: 'How to spot address poisoning',
    blurb: 'The lookalike address in your own history.',
    title: 'Address poisoning: how to spot it and stay safe | Kyro',
    h1: 'How to spot <em>address poisoning</em>',
    desc: 'Address poisoning hides a lookalike address in your transaction history so you copy it by mistake. How the scam works, how Kyro flags it, and the habits that stop it.',
    lead: 'No hack and no malware: a scammer only needs you to copy the wrong line from your own history.',
    related: ['why-a-wallet-should-use-tor', 'back-up-your-recovery-phrase', 'verify-your-download'],
    body: () => html`
      <h2>How the scam works</h2>
      ${steps([
        'A scammer watches who you send to.',
        'They generate an address that starts and ends like that one.',
        'They slip it into your history with a dust transaction, a zero-value transfer, or a fake transfer displayed as “sent”.',
        'Next time, you copy the “recent” address from your history. The middle is different, and your money goes to them.'
      ])}
      <p>It works because most people check only the first and last few characters, and because a long address is hard to read.</p>
      <h2>What Kyro does</h2>
      ${ul([
        'A blocking red alert appears if a recipient shares the first 4 and last 4 characters with a known address without being identical.',
        'Known addresses are your address book, your accounts and sends signed by this Kyro. The server’s history is never trusted.',
        'Addresses are displayed in blocks, and anything outside the address book is marked “Unknown address”.',
        'After you paste, Kyro watches the field for clipboard tampering.',
        'The native confirmation window shows the recipient Rust decoded.'
      ])}
      ${confirmCard()}
      <h2>What it cannot catch</h2>
      <p>A lookalike that already differs within those 8 characters is not detected. A clipboard swap that happens before you paste cannot be seen either. Only comparing against your source will find those, so these habits still matter.</p>
      <h2>Habits that stop it</h2>
      ${ul([
        'Never copy a recipient from your transaction history.',
        'Save the addresses you use in the address book. Send offers “Save” for a new recipient.',
        'Compare the whole address with your source, block by block.',
        'For large amounts, send a small test and have the recipient confirm it.',
        'Ignore unexpected tiny deposits. You do not need to do anything about them.'
      ])}
      <h2>If it already happened</h2>
      <p>Transfers on a blockchain cannot be reversed, and neither Kyro nor anyone else can pull funds back. Your keys were not stolen, so your wallet itself remains safe to use. Be wary of anyone offering to “recover” the money for a fee.</p>`
  },
  {
    slug: 'swap-to-monero',
    group: 'money',
    short: 'Swap to Monero',
    blurb: 'From BTC, ETH, SOL, USDT and more to XMR.',
    title: 'How to swap to Monero (XMR) in your wallet | Kyro Wallet',
    h1: 'Swap <em>to Monero</em>',
    desc: 'Swap BTC, ETH, SOL, USDT and other coins to XMR inside Kyro, with no account. The steps, what the fee looks like, and what the swap provider can see.',
    lead: 'From a coin you hold to XMR in your own wallet: no account, over Tor, in one screen.',
    related: ['why-a-wallet-should-use-tor', 'back-up-your-recovery-phrase', 'stake-sol'],
    body: () => html`
      <h2>Before you start</h2>
      <p>Your Monero account comes from your recovery phrase, so it is already there. Give the first scan time to finish: Kyro scans blocks on your machine, and your XMR shows up once it reaches them.</p>
      ${moneroCard()}
      <p>These reach XMR through Exolix: BTC, LTC, DOGE, TRX, USDT on TRON, ETH on Ethereum, Arbitrum, Base and Optimism, POL, SOL, and USDT and USDC on Ethereum and Solana. BNB and AVAX do not.</p>
      <h2>The swap</h2>
      ${steps([
        'Open <b>Swap</b> and pick the coin you want to sell. Kyro shows any coin you hold, on any network.',
        'Pick <b>XMR</b> as what you want. Search by name or ticker.',
        'Enter the amount. “You receive” already has Kyro’s fee and the provider’s costs out.',
        'Choose <b>Review the swap</b>. Kyro creates the order, checks that it pays your own Monero address, and checks the deposit address.',
        'Confirm in the system window. Kyro sends an ordinary transfer, with no contract involved.',
        'Right after the deposit, Kyro sends a second transfer: its fee, in the coin you sold.',
        'Follow the status in <b>History</b>. The XMR appears when the provider has paid out and your scan reaches it.'
      ])}
      <h2>Why two transfers</h2>
      <p>Exolix has no integrator fee, so Kyro’s fee cannot be taken inside the swap. The swapped amount is reduced by the normal rate, and the fee goes as a second ordinary transfer on the source chain. You pay the network fee on both. ${a('/fees/', 'Fee table')}.</p>
      <h2>Who sees what</h2>
      <p>Exolix sees the coins, the amount, your Monero address and your source address, so it can link those two accounts. Tor keeps your IP address away from it. The source chain shows your transfer publicly, like any other.</p>
      ${warn('Start small. This path is younger than the rest of Kyro, and it depends on a third-party provider completing the order.')}
      <h2>Going back</h2>
      <p>Since version 1.0.6 you can swap from XMR too, to the same coins. The steps are the same. Kyro’s fee is then a second XMR transfer.</p>`
  },
  {
    slug: 'stake-sol',
    group: 'money',
    short: 'Stake SOL',
    blurb: 'Pick a validator, delegate, and get your SOL back.',
    title: 'How to stake SOL from a desktop wallet | Kyro Wallet',
    h1: 'How to <em>stake SOL</em>',
    desc: 'Stake Solana from your own account in Kyro: choose a validator, delegate, wait for activation, then deactivate and withdraw. Risks and timing, without the hype.',
    lead: 'Your SOL goes into a stake account in your name. A validator can earn you rewards, and it cannot take your coins.',
    related: ['swap-to-monero', 'back-up-your-recovery-phrase', 'first-steps-with-kyro'],
    body: () => html`
      <h2>Before you start</h2>
      ${ul([
        'You need a recovery-phrase account. Staking SOL from a Ledger or Trezor is refused for now.',
        'Keep some SOL unstaked for network fees.',
        'Rates are estimates. The rate shown is network-wide, before the validator’s commission.'
      ])}
      <h2>Stake</h2>
      ${steps([
        'Open <b>Earn</b> and choose <b>Solana</b>.',
        'Choose <b>Stake SOL</b>. Kyro creates a stake account in your name, and only you can manage or withdraw it.',
        'Pick a validator. Names are declared by the validators themselves and not verified, so look at commission and status too.',
        'Enter the amount and review.',
        'Confirm with your password in the system window.'
      ])}
      ${confirmCard()}
      <p>A commission above 10%, or a delinquent validator that has stopped voting, gets a second, reinforced confirmation.</p>
      <h2>Wait for activation</h2>
      <p>A delegation activates at the start of the next epoch. An epoch lasts about two days.</p>
      <h2>Get your SOL back</h2>
      ${steps([
        'Choose <b>Deactivate</b> on the stake account.',
        'Wait out the cooldown: at least one epoch, about 2 to 3 days, and longer if a lot of stake is moving at once. There are no rewards during it.',
        'Choose <b>Withdraw</b>. It goes to your own address.'
      ])}
      <h2>Risks, plainly</h2>
      ${ul([
        'There is no slashing on Solana today, so your stake is not confiscated.',
        'A bad validator costs you rewards: high commission or downtime.',
        'SOL can lose value while staked, and you wait days to move it.',
        'The server can misreport validators. Kyro’s Rust core still decodes what you sign, and refuses authority changes and lockups.'
      ])}
      <p>Kyro takes no fee on staking. This guide explains how the feature works. It is not financial advice. For other options, see ${a('/earn/', 'Earn')}.</p>`
  },
  {
    slug: 'connect-a-ledger',
    group: 'hw',
    short: 'Connect a Ledger',
    blurb: 'Close Ledger Live, plug in, one Connect.',
    title: 'How to connect a Ledger to Kyro Wallet',
    h1: 'Connect <em>a Ledger</em>',
    desc: 'Connect a Ledger to Kyro: close Ledger Live, unlock the device, click Connect once and approve each app. Results per chain, blind signing and the limits.',
    lead: 'One click reads every chain your Ledger supports. You approve each app on the device, and the keys never leave it.',
    related: ['connect-a-trezor', 'back-up-your-recovery-phrase', 'first-steps-with-kyro'],
    body: () => html`
      <h2>Before you start</h2>
      ${ul([
        'Close Ledger Live: it holds the USB device.',
        'Use a data cable, and unlock the Ledger.',
        'Install the apps you want with Ledger Live, and keep them up to date.',
        'On Linux, install ' + `<a href="https://github.com/LedgerHQ/udev-rules">Ledger’s udev rules</a>` + ' first.'
      ])}
      <h2>Connect</h2>
      ${steps([
        'On the welcome screen choose <b>Use a Ledger / Trezor</b>, or go to <b>Settings › Devices › Add a device</b>.',
        'Every chain the Ledger supports is ticked. Untick what you do not want.',
        'Click <b>Connect</b>.',
        'Approve “Open Bitcoin”, “Open Ethereum” and the others on the device as Kyro asks. If another app is open, Kyro closes it first.',
        'Read the result per chain: <b>Added</b>, <b>Not installed</b>, or <b>Skipped</b>.'
      ])}
      <p>“Not installed” means you can add that app in Ledger Live and connect again. If an app is too old, Kyro says to update it.</p>
      <h2>Check a receive address</h2>
      <p>Before you share an address, show it on the device and compare. Kyro compares it with the one it derives itself, and any difference is a blocking error. Treat the device screen as the truth.</p>
      <h2>Sign</h2>
      ${steps([
        'Start a send as usual.',
        'Read the decoded transaction in Kyro’s system window.',
        'Read it again on the Ledger and approve there.',
        'Kyro verifies the signature before it broadcasts.'
      ])}
      ${confirmCard()}
      <h2>Blind signing</h2>
      <p>Some transactions cannot be decoded by the device, which then shows raw data. A Ledger with blind signing off will refuse them, and Kyro names the setting to change. Solana tokens may need “Enable Blind signing in the Solana app settings”. TRON tokens may need “Allow data” or “Custom contracts”.</p>
      ${warn('With blind signing, the device protects your keys but cannot show you what you approve. Keep it off until you need it.')}
      <h2>Limits</h2>
      ${ul([
        'On NEAR, TON and Cardano the Ledger account differs from the software account for the same phrase.',
        'Token sends work on EVM chains, Solana and TRON. Elsewhere, native coins only.',
        'Earn covers Lido and Aave. Staking is refused from a hardware account.',
        'Not available on Ledger: Monero, Polkadot, Kaspa and Zcash.'
      ], 'checks minus')}
      <p>Full table: ${a('/hardware-wallets/', 'Ledger and Trezor in Kyro')}. Hardware support is young, so start with a small amount.</p>`
  },
  {
    slug: 'connect-a-trezor',
    group: 'hw',
    short: 'Connect a Trezor',
    blurb: 'Including pairing a Trezor Safe 7.',
    title: 'How to connect a Trezor to Kyro Wallet',
    h1: 'Connect <em>a Trezor</em>',
    desc: 'Connect a Trezor to Kyro on desktop: close Trezor Suite, add the device, pair a Safe 7 with its code, and sign with the device. What works, and what does not.',
    lead: 'Keys stay in the Trezor and the PIN stays on it. A Safe 7 pairs once with a 6-digit code.',
    related: ['connect-a-ledger', 'back-up-your-recovery-phrase', 'first-steps-with-kyro'],
    body: () => html`
      <h2>Before you start</h2>
      ${ul([
        'Close Trezor Suite: it holds the device.',
        'Use a data cable, and update the firmware in Trezor Suite.',
        'Run the authenticity check in Trezor Suite. Kyro does not run it.',
        'On Linux, install ' + `<a href="https://trezor.io/learn/a/udev-rules">Trezor’s udev rules</a>` + ' first.'
      ])}
      <h2>Connect</h2>
      ${steps([
        'On the welcome screen choose <b>Use a Ledger / Trezor</b>, or go to <b>Settings › Devices › Add a device</b>.',
        'Unlock with your PIN on the device.',
        'Choose <b>Connect</b> and pick your chains.',
        'Kyro reads the public keys and adds the accounts. Hardware accounts are labelled as such.'
      ])}
      <h2>Pair a Trezor Safe 7</h2>
      <p>The Safe 7 uses an encrypted, authenticated channel. Pairing happens once per Kyro installation.</p>
      ${steps([
        'Accept the pairing with “Kyro Wallet” on the device.',
        'The device shows a 6-digit code. Type it into Kyro.',
        'On later connections, the Trezor asks you to confirm on its screen.'
      ])}
      <p>A wrong code saves nothing: try again with the new code. To revoke access on the device side, for instance after losing a computer, reset its paired hosts.</p>
      <h2>Trezor One</h2>
      <p>The Trezor One has no PIN entry on the device. It shows a shuffled grid and you click the matching positions in Kyro. Kyro receives only positions. A passphrase typed on the computer is refused. Cardano is not available on this model.</p>
      <h2>Sign</h2>
      <p>Read the decoded transaction in Kyro’s system window, then check it on the Trezor’s screen and approve there. Kyro verifies the signature before it broadcasts. For a Solana token send, a Trezor shows the recipient wallet.</p>
      <h2>What works on Trezor</h2>
      ${ul([
        'Bitcoin, all EVM networks, Solana, Litecoin, Dogecoin, Bitcoin Cash, Dash, Stellar and Cardano.',
        'Zcash transparent addresses, on Trezor only.',
        'Token sends on EVM chains and Solana.',
        'Earn with Lido and Aave.'
      ])}
      ${ul([
        'XRP, TRON, Sui, Aptos, Algorand, Cosmos Hub, TON and NEAR: Ledger only.',
        'Monero, Polkadot and Kaspa: no hardware wallet support.',
        'Staking on Solana, Cardano, TRON and NEAR is refused from a hardware account.'
      ], 'checks minus')}
      ${warn('Safe 7 support has been tested against Trezor’s device-side code, not yet on a real Safe 7. Other hardware paths are young too. Start with a small amount.')}
      <p>Full table: ${a('/hardware-wallets/', 'Ledger and Trezor in Kyro')}.</p>`
  }
];

function guidePage(g, all) {
  const path = `/guides/${g.slug}/`;
  const trail = [['/', 'Home'], ['/guides/', 'Guides'], [path, g.short]];
  const inner = g.body();
  const minutes = Math.max(2, Math.round(strip(inner).split(/\s+/).length / 200));
  const name = strip(g.h1);
  const related = g.related.map((s) => all.find((x) => x.slug === s)).map((r) => [`/guides/${r.slug}/`, r.short, r.blurb]);
  const body = html`
    ${pageHero({ trail, eyebrow: 'Guide', h1: g.h1, lead: g.lead, extra: `<p class="article-meta">${minutes} min read</p>` })}
    <section class="section section-tight" aria-label="Article">
      <div class="wrap">
        <article class="prose" data-reveal>${inner}</article>
      </div>
    </section>
    ${nextLinks('g-next', related)}
    ${ctaPanel()}`;
  const ld = webPage(path, name, g.desc, trail);
  ld.push({
    '@type': 'Article',
    '@id': `${SITE}${path}#article`,
    headline: name,
    description: g.desc,
    url: SITE + path,
    mainEntityOfPage: `${SITE}${path}#page`,
    datePublished: PUBLISHED,
    dateModified: PUBLISHED,
    inLanguage: 'en',
    image: `${SITE}/img/og.jpg`,
    author: { '@id': `${SITE}/#org` },
    publisher: { '@id': `${SITE}/#org` },
    about: { '@id': APP_ID }
  });
  return { path, title: g.title, description: g.desc, body, scripts: ['/download.js', '/copy.js'], ld, ogType: 'article' };
}

function guidesIndex(all) {
  const path = '/guides/';
  const trail = [['/', 'Home'], [path, 'Guides']];
  const description = 'Plain guides for Kyro Wallet: back up your phrase, verify a download, move from another wallet, swap to Monero, stake SOL and connect a Ledger or Trezor.';
  const body = html`
    ${pageHero({ trail, eyebrow: 'Guides', h1: 'Learn it <em>once</em>', lead: 'Short, practical articles on using a private crypto wallet well. No hype, and the limits stated.' })}
    <section class="section section-tight" aria-label="All guides">
      <div class="wrap guide-groups">
        ${GROUPS.map(
          ([k, title]) => html`
        <div>
          <h2>${title}</h2>
          <ul class="link-cards" data-reveal-group>
            ${all.filter((g) => g.group === k).map((g) => `<li class="glow-card spot"><h3><a href="/guides/${g.slug}/">${g.short}</a></h3><p>${g.blurb}</p></li>`)}
          </ul>
        </div>`
        )}
        <p>${a('/glossary/', '<span class="more">New to the words? Read the glossary</span>')}</p>
      </div>
    </section>
    ${ctaPanel()}`;
  const ld = webPage(path, 'Kyro Wallet guides', description, trail);
  ld.push({ '@type': 'ItemList', itemListElement: all.map((g, i) => ({ '@type': 'ListItem', position: i + 1, url: `${SITE}/guides/${g.slug}/`, name: g.short })) });
  return { path, title: 'Guides: use a private crypto wallet well | Kyro Wallet', description, body, scripts: ['/download.js'], ld };
}

const TERMS = () => [
  ['Address', 'The public string you share to receive coins. Safe to give out, though it can link your activity on a public blockchain.'],
  ['Address poisoning', `A scam that plants a lookalike address in your history so you copy it by mistake. ${a('/guides/how-to-spot-address-poisoning/', 'How to spot it')}.`],
  ['Approval', 'Permission you give a contract to move a token from your account. Kyro approves the exact amount by default. An unlimited approval needs an explicit action and shows a warning.'],
  ['APY', 'Annual percentage yield: a yearly rate of return, with compounding. In Kyro every APY is an estimate, never a promise.'],
  ['BIP39', 'The standard that turns a random number into 12 or 24 English words. It is why a phrase can move between wallets.'],
  ['Blind signing', 'Approving a transaction your hardware wallet cannot decode. The device shows raw data, so it protects your keys but not your consent.'],
  ['Blockchain', 'A shared public record of transactions, kept by many computers.'],
  ['Clear mode', 'Kyro with Tor turned off. Servers see your IP address. You can only reach it by confirming in a system window.'],
  ['Custodial wallet', 'A wallet where a company holds the keys for you. You trust it to give your coins back. Kyro is not one.'],
  ['Decoy', 'In Monero, other outputs mixed with your real one when you send, so an observer cannot tell which was spent.'],
  ['Depeg', 'When a token meant to track another asset, such as a stablecoin or stETH, drifts from its target price.'],
  ['Derivation path', 'The recipe that turns a phrase into a specific key. Two wallets using different paths show different addresses for the same phrase.'],
  ['Epoch', 'A fixed period on a proof-of-stake network. Staking changes often take effect at an epoch boundary.'],
  ['Exit relay', 'The last Tor relay, which connects to the server. The server sees its IP address instead of yours.'],
  ['Fail closed', 'Stopping when a protection is missing, rather than carrying on without it. If Tor is down, Kyro sends nothing.'],
  ['Gas', 'The fee for running a transaction on Ethereum and similar networks. It goes to the network, not to Kyro.'],
  ['Hardware wallet', `A small device that keeps your keys and signs on its own screen. ${a('/hardware-wallets/', 'Ledger and Trezor in Kyro')}.`],
  ['Lending', 'Depositing tokens in a protocol such as Aave so borrowers can use them, for a variable rate. Contract risk applies.'],
  ['Liquid staking', 'Staking through a protocol such as Lido that gives you a token, stETH, standing for your stake.'],
  ['Network fee', 'What you pay the blockchain to process a transaction. It is separate from any Kyro fee.'],
  ['Node', 'A computer that keeps a copy of a blockchain and answers questions about it. Running your own means no third party sees your lookups.'],
  ['Non-custodial wallet', 'A wallet where you alone hold the keys. Nobody can freeze your funds or recover them for you.'],
  ['Onion service', 'A server reachable only inside Tor, so no exit relay is involved. Kyro uses one for Bitcoin lookups.'],
  ['Private key', 'The secret that signs transactions. Kyro derives it for each signature in the Rust core, then wipes it from memory.'],
  ['Recovery phrase', `12 or 24 words that restore your whole wallet. Also called a seed phrase. ${a('/guides/back-up-your-recovery-phrase/', 'How to back it up')}.`],
  ['RPC server', 'A server a wallet talks to in order to read a blockchain and broadcast transactions.'],
  ['Seed', 'The secret value your keys come from. In everyday use, the same thing as your recovery phrase.'],
  ['Slashing', 'A penalty that destroys part of a stake. Delegators on Solana, Cardano, TRON and NEAR are not slashed today.'],
  ['Slippage', 'The gap between the quoted swap rate and the rate you get. Your maximum slippage is the most you accept.'],
  ['Stablecoin', 'A token designed to track a currency, such as USDC or USDT.'],
  ['Staking', 'Supporting a proof-of-stake network with your coins in exchange for rewards. In Kyro, you delegate from your own account.'],
  ['Stake pool', 'A group stake run by an operator, as on Cardano and NEAR.'],
  ['Swap', 'Exchanging one coin for another from your wallet, through a provider. Kyro’s fee and the provider’s costs are included in the rate.'],
  ['Token', 'An asset that lives on a blockchain, such as an ERC-20 or SPL token, as opposed to the chain’s native coin.'],
  ['Tor', `A network that hides your IP address by routing traffic through volunteer relays. ${a('/tor/', 'How Kyro uses it')}.`],
  ['Tor circuit', 'The path of three relays a connection takes through Tor. Kyro keeps a separate one for each blockchain family.'],
  ['Validator', 'A computer that helps run a proof-of-stake network and earns rewards. It cannot spend what you delegate.'],
  ['View key', 'A Monero key that reads incoming payments but cannot spend. In Kyro it stays on your machine.'],
  ['xpub', 'An extended public key. It can show all addresses of an account, but cannot spend. Kyro stores xpubs for hardware accounts.']
];

const idOf = (t) => 'g-' + t.toLowerCase().replace(/[^a-z0-9]+/g, '-');

function glossary() {
  const path = '/glossary/';
  const trail = [['/', 'Home'], [path, 'Glossary']];
  const terms = TERMS();
  const description = `${terms.length} crypto wallet terms in plain language: recovery phrase, non-custodial, Tor circuit, seed, gas, slippage, staking, blind signing and more.`;
  const letters = [...new Set(terms.map(([t]) => t[0].toUpperCase()))];
  const first = new Map();
  terms.forEach(([t]) => first.has(t[0].toUpperCase()) || first.set(t[0].toUpperCase(), idOf(t)));
  const body = html`
    ${pageHero({ trail, eyebrow: 'Glossary', h1: 'Words, <em>in plain language</em>', lead: 'What a recovery phrase is, why gas costs money, what a Tor circuit does. The terms you meet in a crypto wallet, kept short.' })}
    ${sec('gl', html`
        <h2 id="gl" class="visually-hidden">All terms</h2>
        <nav class="gloss-az" aria-label="Jump to a letter">${letters.map((l) => `<a href="#${first.get(l)}">${l}</a>`)}</nav>
        <div class="prose" data-reveal>
          <dl class="gloss">
            ${terms.map(([t, d]) => `<dt id="${idOf(t)}">${t}</dt><dd>${d}</dd>`)}
          </dl>
        </div>`, 'section-tight')}
    ${nextLinks('gl-next', [
      ['/guides/', 'Guides', 'Step-by-step articles for the things you will actually do.'],
      ['/faq/', 'FAQ', 'Short answers about Kyro.'],
      ['/security/', 'Security', 'How Kyro protects your keys.']
    ])}
    ${ctaPanel()}`;
  const ld = webPage(path, 'Crypto wallet glossary', description, trail);
  ld.push({
    '@type': 'DefinedTermSet',
    '@id': `${SITE}${path}#terms`,
    name: 'Crypto wallet glossary',
    hasDefinedTerm: terms.map(([t, d]) => ({ '@type': 'DefinedTerm', name: t, description: strip(d), url: `${SITE}${path}#${idOf(t)}` }))
  });
  return { path, title: 'Crypto wallet glossary in plain language | Kyro Wallet', description, body, scripts: ['/download.js'], ld };
}

export function guidePages() {
  const all = GUIDES();
  return [guidesIndex(all), ...all.map((g) => guidePage(g, all)), glossary()];
}
