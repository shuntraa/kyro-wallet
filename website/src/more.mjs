// SPDX-License-Identifier: GPL-3.0-or-later
// Product pages of kyrowallet.com. Every claim here comes from the repo: README, SECURITY.md,
// docs/NETWORK.md, docs/SWAP_FEES.md, docs/SWAP_COVERAGE.md, docs/RELEASING.md, CHANGELOG.md.

import { SITE, VERSION, REPO, DL, FILES, esc, html, a, coin, pageHero, dlButton, installBlock, ctaPanel } from './layout.mjs';
import { swapWidget, earnCard, confirmCard, ledgerScene, coinHero, privateCard, moneroCard, torDownCard, torOffDialog, circuits, term, roadList, assetsCard, vaultCard } from './components.mjs';
import { head, sec, row, cards, faqBlock, faqLd, nextLinks, ul, tbl, DONE, NEXT } from './kit.mjs';
import { webPage, listNames, yesNo } from './pages.mjs';
import { guidePages } from './guides.mjs';

function assemble({ path, name, crumb, parent, title, description, hero, body, faqs, scripts = ['/download.js'] }) {
  const trail = [['/', 'Home'], ...(parent ? [parent] : []), [path, crumb]];
  const ld = webPage(path, name, description, trail);
  if (faqs) ld.push(faqLd(SITE + path, faqs));
  return { path, title, description, body: pageHero({ trail, ...hero }) + body, scripts, ld };
}

function tor(chains) {
  const faqs = [
    ['Do I need to install Tor or Tor Browser?', 'No. Kyro embeds its own Tor client, Arti, from The Tor Project. It starts in the background when the app opens.'],
    ['Can I turn Tor off?', 'Yes. It is your choice in Settings, confirmed in a native system window, so a compromised interface cannot switch it off for you. In clear mode, servers see your IP address.'],
    ['Does Tor make my transactions anonymous?', 'No. Tor hides who is asking. It does not hide what is asked: the server you query still sees the addresses and transactions you look up, and public blockchains stay public.'],
    ['Why is Kyro slower over Tor?', 'Requests take three relays instead of a direct path, and some servers refuse some exit relays. Kyro retries on a new circuit, and each blockchain shows as soon as it answers.'],
    ['Do my own servers go through Tor too?', 'Yes. When Tor is on, your custom servers use the isolated circuits of their own blockchain family.']
  ];
  const seen = [
    ['Your internet provider', 'That you use Tor', 'The hosts you reach, your addresses, your amounts'],
    ['First relay', 'Your IP address', 'The destination and the request'],
    ['Middle relay', 'Two other relays', 'You, and the request'],
    ['Exit relay', 'The hostname and the volume', 'You, and the content (TLS runs up to the server)'],
    ['Blockchain server', 'The addresses and transactions requested, from a Tor exit', 'Your IP address'],
    ['Monero node', 'Blocks downloaded and transactions you publish', 'Your IP, your addresses, your view key'],
    ['Price server (CoinGecko)', 'The coins and currency requested', 'Your IP address, your addresses'],
    ['Swap provider', 'Tokens, amounts and the recipient address', 'Your IP address']
  ];
  return assemble({
    path: '/tor/',
    name: 'Tor wallet: how Kyro uses Tor',
    crumb: 'Tor',
    title: 'Tor wallet: built-in Tor for every request | Kyro Wallet',
    description: 'Kyro is a crypto wallet with Tor built in and on by default: separate circuits per blockchain, no fallback to a direct connection, and a plain list of what each party sees.',
    hero: {
      eyebrow: 'Tor wallet',
      h1: 'Tor is built in, <em>and it stays on</em>',
      lead: 'Balances, prices, swaps and broadcasts all leave through an embedded Tor client. You install nothing extra and set nothing up. If Tor is not ready, Kyro stops.',
      extra: `<div class="hero-cta">${dlButton()}</div>`,
      aside: privateCard()
    },
    faqs,
    body: html`
    ${row('t-client', 'The client', 'One app, <em>Tor included</em>', false, html`
          <p>Kyro embeds Arti, the Tor client from The Tor Project. It starts in the background when the app opens, and the wallet shows its state.</p>
          ${ul([
            'The interface cannot reach any server. Only the Rust shell can, and only over the list below.',
            `Kyro contacts only the servers listed in <a href="${REPO}/blob/main/docs/NETWORK.md">docs/NETWORK.md</a>, and refuses every other host.`,
            'Only HTTPS is accepted, with one exception: the onion service for Bitcoin.',
            'Your custom servers go through Tor as well.'
          ])}`, circuits())}

    ${sec('t-circ', html`
        ${head('Circuits', 't-circ', 'A circuit <em>per blockchain</em>', 'A server or an exit relay cannot link your Bitcoin lookup to your Solana lookup through the circuit, because they never share one.')}
        ${cards([
          ['Isolated by family', 'Each blockchain family has its own isolated circuits. Prices and swaps have their own too. All EVM networks count as one family.', 'ic-tor'],
          ['Bitcoin stays inside Tor', 'Bitcoin lookups go to mempool’s onion service. No exit relay is involved, so no relay sees the hostname or the volume.', 'ic-shield'],
          ['Retries stay on Tor', 'A stream refused by a closed circuit is retried on a new one. A refusal on one family no longer moves the others. It never falls back to clear.', 'ic-swap']
        ])}`)}

    ${sec('t-sees', html`
        ${head('Who sees what', 't-sees', 'What each party <em>sees</em>', 'In Tor mode, the default. This table comes from the network document in the repo, which lists every server by name.')}
        ${tbl('What each party sees when Kyro uses Tor', ['Party', 'Sees', 'Does not see'], seen)}
        <p class="tbl-note">With Tor off, every server sees your IP address and your internet provider sees the hosts. <a href="/privacy/">Privacy policy</a></p>`)}

    ${row('t-closed', 'Fails closed', 'No Tor, <em>no request</em>', true, html`
          <p>If Tor is not ready within 60 seconds, the request fails with <code>TOR_UNAVAILABLE</code>. Nothing goes out in the clear, and there is no automatic fallback.</p>
          <p>Leaving Tor is your decision. Kyro asks in a native system window drawn outside the interface, so a compromised page cannot turn Tor off without you.</p>`, `<div class="stack2">${torDownCard()}${torOffDialog()}</div>`)}

    ${sec('t-limits', html`
        ${head('Limits', 't-limits', 'What Tor <em>does not do</em>', 'Tor is one layer. It hides your network location. These things stay true with it on.')}
        ${cards([
          ['Servers still see lookups', 'The server you query sees the addresses and transactions you ask about. To avoid that, use your own node.', 'ic-eye'],
          ['Blockchains stay public', 'Most chains publish every transfer. Tor hides your IP, and your addresses remain linked to each other on chain when you link them.', 'ic-accounts'],
          ['Swap providers see the order', 'Swap APIs see the tokens, amounts and recipient. Exolix sees your source and destination addresses, so it can link those two accounts.', 'ic-swap'],
          ['Two background requests', 'The signed update check and the anonymous weekly count. Both go over Tor and both can be turned off.', 'ic-send']
        ], true)}`)}
    ${faqBlock('t-faq', faqs)}
    ${nextLinks('t-next', [
      ['/guides/why-a-wallet-should-use-tor/', 'Why a wallet should use Tor', 'The problem in plain words: your IP and your addresses in the same log line.'],
      ['/monero/', 'Monero over Tor', 'A desktop Monero wallet that scans blocks on your machine.'],
      ['/security/', 'How Kyro protects your keys', 'Tor covers the network. This covers the vault and the signature.']
    ])}
    ${ctaPanel('A wallet that <em>keeps quiet</em>')}`
  });
}

function monero(chains) {
  const xmr = chains.find((c) => c.slug === 'monero');
  const faqs = [
    ['Is Kyro a full Monero wallet?', 'Yes. Send, receive and swap XMR from the same app as your other coins. Kyro talks to a monerod node and scans blocks itself. No light-wallet server is used.'],
    ['Does the Monero node see my addresses?', 'No. Neither your addresses nor your view key are sent. The node sees the block ranges you download, the decoy outputs requested for a send, and the transactions you publish, from a Tor exit relay.'],
    ['Can I import my 25-word Monero seed?', 'No. Kyro derives Monero from your BIP39 recovery phrase, and a 25-word phrase created elsewhere cannot be imported. The other way works: Kyro shows a 25-word seed that restores your wallet in Monero GUI, Feather or Cake Wallet.'],
    ['Can I use my own Monero node?', 'Yes. Set your own monerod in Settings, or a .onion address. Kyro checks it is on the right network and refuses to fall back to the default node if yours goes down.'],
    ['Does Monero work on a Ledger or Trezor in Kyro?', 'No. Monero on a hardware wallet is not supported.'],
    ['Why do I not see an old XMR payment?', 'Kyro scans from a starting block. If this phrase received XMR earlier, pick an older height in Settings › Security and it scans again from there.']
  ];
  return assemble({
    path: '/monero/',
    name: 'Private Monero desktop wallet',
    crumb: 'Monero',
    title: 'Monero desktop wallet with Tor and local scanning | Kyro',
    description: 'A free, open-source Monero desktop wallet for Windows, macOS and Linux. Blocks are scanned on your machine, your view key stays there, and traffic goes over Tor.',
    hero: {
      eyebrow: 'Monero desktop wallet · XMR',
      h1: 'Private Monero, <em>on your desktop</em>',
      lead: 'Kyro keeps Monero honest: blocks are scanned on your own machine, your view key never leaves it, and every request goes over Tor.',
      extra: `<div class="hero-cta">${dlButton()}<a class="btn btn-ghost btn-xl" href="/chains/monero/">XMR details</a></div>`,
      aside: coinHero(xmr)
    },
    faqs,
    body: html`
    ${row('m-scan', 'Local scanning', 'The node sends blocks. <em>Your machine reads them.</em>', false, html`
          <p>Light-wallet servers need your view key, so they see every incoming payment. Kyro uses none. It downloads blocks from a monerod node and the Rust core analyses them with a view key that stays on your computer.</p>
          ${ul([
            'Default node: Cake Wallet’s public node. You can replace it.',
            'The node never receives your addresses, spend key or view key.',
            'The scan state is stored on disk, encrypted.',
            'A lying node can hide incoming payments or delay your sync. It cannot steal funds.'
          ])}`, moneroCard())}

    ${sec('m-sees', html`
        ${head('Who sees what', 'm-sees', 'What the node <em>learns</em>', 'A Monero wallet has to talk to someone. Here is exactly what that costs you, with Tor on and off.')}
        ${tbl('What a Monero node sees', ['', 'Tor on (default)', 'Tor off'], [
          ['Block ranges you download', 'Yes, so your wallet’s rough age', 'Yes'],
          ['Decoy outputs requested', 'Yes', 'Yes'],
          ['Transactions you publish', 'Yes', 'Yes'],
          ['Your IP address', 'No, a Tor exit relay. None on a .onion node', 'Yes, and it can be linked to what you publish'],
          ['Your addresses, view key, spend key, phrase', 'Never', 'Never']
        ])}`)}

    ${sec('m-keys', html`
        ${head('Keys', 'm-keys', 'One phrase, <em>and an exit</em>', 'Monero comes from the same recovery phrase as your other coins, with its own 25-word seed if you want to leave.')}
        ${cards([
          ['Same recovery phrase', 'Your XMR derives from your BIP39 phrase, using the scheme of Ledger’s Monero app. It is not a native 25-word Monero phrase.', 'ic-lock'],
          ['A way out', 'Kyro shows a 25-word Monero seed in the protected phrase window. It restores the wallet in Monero GUI, Feather or Cake Wallet.', 'ic-send'],
          ['One limit', 'A 25-word phrase made elsewhere cannot be imported. Send those XMR to your Kyro address instead.', 'ic-eye']
        ])}`)}

    ${row('m-swap', 'Swap', 'In and out of <em>XMR</em>', true, html`
          <p>Swap to or from Monero through Exolix: no account, no key, over Tor. BTC, LTC, DOGE, TRX, ETH, SOL, USDT and USDC all reach XMR, and XMR reaches them.</p>
          ${ul([
            'Kyro checks that the order pays your own address and that the deposit address is valid.',
            'It then sends an ordinary transfer. No contract, no third-party transaction.',
            'Kyro’s fee is a second ordinary transfer of the coin you sell. The swap value is reduced by the same rate as other swaps.',
            'Exolix sees your source and destination addresses and can link them.'
          ])}
          <p>${a('/guides/swap-to-monero/', 'Step by step: swap to Monero')}</p>`, swapWidget())}

    ${sec('m-build', html`
        ${head('Under the hood', 'm-build', 'Rust, and <em>no home-grown crypto</em>', 'Monero is easy to get subtly wrong, so Kyro leans on a reviewed library and checks its own output.')}
        ${cards([
          ['monero-oxide', 'Addresses, scanning, key images, CLSAG, Bulletproofs+ and decoy selection come from monero-oxide / monero-wallet 0.2. Cypher Stack audited that library in May 2025. Kyro itself has not been externally audited.', 'ic-shield'],
          ['Checked after signing', 'Rust builds the transfer, then verifies that the signed transaction creates exactly the outputs you approved.', 'ic-eye'],
          ['Honest status', 'This integration is young. There is no Monero on hardware wallets, and it is tested against official vectors. Start small.', 'ic-lock']
        ])}`)}
    ${faqBlock('m-faq', faqs)}
    ${nextLinks('m-next', [
      ['/chains/monero/', 'Monero in Kyro, feature by feature', 'Send, receive, swap and hardware availability at a glance.'],
      ['/guides/swap-to-monero/', 'Swap to Monero', 'From any supported coin to XMR, with what each party sees.'],
      ['/tor/', 'How Kyro uses Tor', 'Circuits, exit relays and what happens when Tor is down.']
    ])}
    ${ctaPanel('Get <em>Monero</em> on your desktop')}`
  });
}

export const ROUTES = [
  ['Ethereum, Arbitrum, Optimism, Base', 'Yes', 'Yes', '0x and LI.FI on the same chain. 1Click and LI.FI across chains. Exolix to XMR, KAS, ALGO and NEAR'],
  ['Polygon', 'Yes', 'Yes', '0x and LI.FI. 1Click. Exolix to XMR, KAS, ALGO and NEAR'],
  ['BNB Chain, Avalanche', 'Yes', 'Yes', '0x and LI.FI. 1Click'],
  ['Gnosis', 'Yes', 'Yes', 'LI.FI. 1Click'],
  ['Cronos, Mantle, Sonic, Flare, Kaia, HyperEVM, Sei', 'Yes', 'Yes', '0x or LI.FI, same chain only'],
  ['Solana and SPL tokens', 'Yes', 'Yes', 'Jupiter on Solana. LI.FI and 1Click across chains. Exolix for SOL, USDT and USDC'],
  ['Bitcoin', 'Yes', 'Yes', '1Click, LI.FI. Exolix to XMR, KAS, ALGO and NEAR'],
  ['Litecoin, Dogecoin, TRON (TRX, USDT)', 'Yes', 'Yes', '1Click. Exolix'],
  ['XRP, Cardano, Bitcoin Cash, Dash, Zcash, Sui, TON, Aptos', 'Yes', 'Yes', '1Click'],
  ['Stellar', 'No', 'Yes', '1Click, arrival only: a Stellar deposit needs a memo'],
  ['Monero, Kaspa, Algorand, NEAR (native coin)', 'Yes', 'Yes', 'Exolix. Kyro’s fee is a second transfer']
];

function swap(chains) {
  const n = chains.filter((c) => c.features.swap).length;
  const faqs = [
    ['Can I really swap any coin to any coin?', `Almost. ${n} of the ${chains.length} blockchains can swap, across chains in most cases. The table on this page lists the limits: Stellar is arrival only, some EVM networks swap on the same chain only, and Polkadot, Cosmos Hub and Conflux have no route yet.`],
    ['What does a swap cost?', 'A Kyro fee from 0.7% to 5% depending on the swap value, already taken out of the amount you see, plus the network fee. <a href="/fees/">Full fee table</a>.'],
    ['Do I need an account with a swap provider?', 'No. Kyro talks to the providers directly over Tor. There is nothing to sign up for.'],
    ['Why does a Monero swap send two transactions?', 'Exolix has no integrator fee, so Kyro’s fee cannot be collected inside the swap. It goes as a second ordinary transfer of the sold coin. The same applies to any Exolix route.'],
    ['What if the rate changes before the swap lands?', 'You set a maximum slippage of 0.1%, 0.5%, 1% or your own value, and Kyro shows the guaranteed minimum before you sign.']
  ];
  return assemble({
    path: '/swap/',
    name: 'Crypto swaps in Kyro',
    crumb: 'Swap',
    title: 'Swap crypto privately, any coin to any coin | Kyro Wallet',
    description: `Swap across ${n} blockchains from your own wallet, with no account. Kyro compares providers, decodes every transaction and includes its fee, from 0.7%, in the rate. Monero included.`,
    hero: {
      eyebrow: 'Swap',
      h1: 'Any coin <em>to any coin</em>',
      lead: `Kyro asks several providers, shows what actually lands in your account and decodes the transaction before you sign. ${n} blockchains, no account, over Tor.`,
      extra: `<div class="hero-cta">${dlButton()}<a class="btn btn-ghost btn-xl" href="/fees/">Swap fees</a></div>`
    },
    scripts: ['/download.js', '/scenes.js'],
    faqs,
    body: html`
    ${sec('s-how', html`
        ${head('How it works', 's-how', 'One screen, <em>several providers</em>', 'Pick what you hold, pick what you want. Kyro compares quotes and shows the amount you receive, with the fee already out.')}
        <div class="swap-grid"><div class="glow-card swap-main spot g-ice" data-reveal>${swapWidget()}</div></div>`)}

    ${sec('s-routes', html`
        ${head('Routes', 's-routes', 'Where each coin <em>can go</em>', 'From the live coverage audit in the repo. Providers can change what they list, so a quote is the final word.')}
        ${tbl('Swap routes by coin', ['Coin or network', 'From', 'To', 'Providers'], ROUTES)}
        <p class="tbl-note"><a href="${REPO}/blob/main/docs/SWAP_COVERAGE.md">Full coverage audit on GitHub</a></p>`)}

    ${row('s-fee', 'Fee', 'Included in the rate, <em>and public</em>', false, html`
          <p>The Kyro fee slides from 5% on a swap of $5 or less down to 0.7% from $10,000, and it is 0.9% when the token price is unknown. It funds the project.</p>
          ${ul([
            'What you see as “You receive” already has the fee out.',
            'It is collected through each provider’s official integrator mechanism.',
            'Exolix routes are the exception: the fee is a second ordinary transfer on the source chain.',
            `The rates live in one open file. <a href="${REPO}/blob/main/packages/swap/src/fees.ts">Read fees.ts</a>.`
          ])}
          <p><a href="/fees/">Fee table and calculator</a></p>`, confirmCard())}

    ${sec('s-check', html`
        ${head('Checks', 's-check', 'Swaps <em>you can check</em>', 'A swap is a transaction written by someone else. Kyro treats it that way.')}
        ${cards([
          ['Decoded first', 'Kyro decodes the provider’s transaction before asking for your password: recipient, minimum amount and fee.', 'ic-eye'],
          ['Official contracts', 'It checks that the transaction targets the provider’s official contract.', 'ic-shield'],
          ['Exact approvals', 'Token approvals are for the exact amount. An unlimited approval needs an explicit action and shows a warning.', 'ic-lock'],
          ['Simulated', 'The transaction is simulated just before you sign it.', 'ic-swap']
        ], true)}`)}

    ${sec('s-limits', html`
        ${head('Limits', 's-limits', 'What does <em>not</em> swap yet', 'Better here than in a failed quote.')}
        <div class="prose" data-reveal>
          ${ul([
            '<b>Stellar as a source.</b> Stellar deposits need a memo, and Kyro only sends plain transfers to deposit addresses. You can swap into XLM.',
            '<b>Polkadot.</b> 1Click does not list it, and delivery to Asset Hub is not confirmed through Exolix.',
            '<b>Cosmos Hub.</b> 1Click does not list it, and Exolix refuses the pair.',
            '<b>Conflux.</b> No provider contract Kyro can check there.',
            '<b>Tokens on NEAR and Algorand.</b> Only the native coin is offered through Exolix. Other tokens on NEAR, Algorand, Polkadot, Stellar, TON, Sui and Aptos swap only if 1Click lists them.',
            '<b>Cronos, Mantle, Sonic, Flare, Kaia, HyperEVM and Sei.</b> Same chain only.'
          ], 'checks minus')}
        </div>`)}
    ${faqBlock('s-faq', faqs)}
    ${nextLinks('s-next', [
      ['/guides/swap-to-monero/', 'Swap to Monero, step by step', 'From BTC, ETH, SOL, USDT and more.'],
      ['/fees/', 'Swap fee table', 'Every step of the curve, with a calculator.'],
      ['/glossary/', 'Glossary', 'Slippage, approvals, gas and the rest, in plain words.']
    ])}
    ${ctaPanel('Swap <em>from your own wallet</em>')}`
  });
}

const EARN_ROWS = [
  ['Ethereum · Lido', 'Liquid staking', 'ETH', 'stETH can be swapped. Unstaking goes through Lido’s queue, often 1 to 5 days', 'Yes'],
  ['Aave · Ethereum', 'Lending', 'USDT, USDC, DAI, WETH', 'None', 'Yes'],
  ['Aave · Arbitrum', 'Lending', 'USDT, USDC', 'None', 'Yes'],
  ['Aave · Polygon', 'Lending', 'USDT, USDC', 'None', 'Yes'],
  ['Aave · Base', 'Lending', 'USDC', 'None', 'Yes'],
  ['Solana', 'Staking', 'SOL', 'About 2 to 3 days', 'No'],
  ['Cardano', 'Staking', 'ADA (2 ADA deposit, returned)', 'None', 'No'],
  ['TRON', 'Staking', 'TRX (minimum 1 TRX)', '14 days', 'No'],
  ['NEAR', 'Staking', 'NEAR', '4 epochs, about 2 to 3 days', 'No']
];

function earn() {
  const faqs = [
    ['Are the rates guaranteed?', 'No. Every rate in Kyro is an estimate and it moves. For Solana, Cardano and TRON it is network-wide, before the validator, pool or Super Representative takes its share.'],
    ['Does Kyro take a fee on Earn?', 'Kyro takes no fee on staking. You pay the network fee, and validators, pools and protocols keep their own share of the rewards.'],
    ['Can I use Earn with a Ledger or Trezor?', 'Yes for Lido and Aave. Staking on Solana, Cardano, TRON and NEAR still needs a recovery-phrase account, and Kyro refuses it from a hardware account.'],
    ['Can a validator take my coins?', 'On Solana, Cardano, TRON and NEAR a validator, pool or Super Representative cannot spend your coins, and there is no slashing for delegators. A poor choice costs rewards.'],
    ['Is lending on Aave the same risk as staking?', 'No. Your tokens go into a smart contract. A contract bug or a stablecoin losing its peg can cost you money. Kyro cannot remove those risks.'],
    ['Is this financial advice?', 'No. Kyro shows options and their terms. Whether any of them suits you is your decision.']
  ];
  return assemble({
    path: '/earn/',
    name: 'Earn: staking and lending in Kyro',
    crumb: 'Earn',
    title: 'Earn: staking and lending from your own wallet | Kyro',
    description: 'Stake SOL, ADA, TRX and NEAR, stake ETH with Lido or lend on Aave from a non-custodial wallet. 14 options, estimated rates and the risks stated plainly.',
    hero: {
      eyebrow: 'Earn',
      h1: 'Earn, <em>with the risks in plain sight</em>',
      lead: '14 options in one list: staking, liquid staking and lending. No sign-up. Rates are estimates, never guaranteed.',
      extra: `<div class="hero-cta">${dlButton()}</div>`
    },
    scripts: ['/download.js', '/scenes.js'],
    faqs,
    body: html`
    ${sec('e-list', html`
        <h2 id="e-list" class="visually-hidden">Earn screen</h2>
        <div class="earn-wrap" data-reveal data-rows>${earnCard()}</div>
        <p class="center small mute">Demo numbers. Real rates are estimates, never guaranteed.</p>`, 'section-tight', 'wrap wrap-mid')}

    ${sec('e-opts', html`
        ${head('Options', 'e-opts', 'All <em>14 options</em>', 'What you can put to work, how long it stays locked, and what works from a hardware wallet.')}
        ${tbl('Earn options in Kyro', ['Option', 'Type', 'Assets', 'Lock', 'Hardware wallet'], EARN_ROWS)}`)}

    ${sec('e-how', html`
        ${head('Three kinds', 'e-how', 'Three ways <em>to earn</em>', 'They look alike in a list. They are different underneath.')}
        ${cards([
          ['Staking', 'SOL, ADA, TRX and NEAR. You delegate from your own account to a validator, pool or Super Representative. They cannot spend your coins. On Cardano your ADA stays spendable.', 'ic-stake'],
          ['Liquid staking', 'ETH with Lido. You receive stETH, and you can swap it or unstake through Lido’s withdrawal queue, then claim in Kyro. You rely on Lido’s contracts.', 'ic-swap'],
          ['Lending', 'Aave v3 on Ethereum, Arbitrum, Polygon and Base. You deposit tokens into a contract and earn the variable rate borrowers pay. You can withdraw when liquidity allows it.', 'ic-accounts']
        ])}`)}

    ${sec('e-risk', html`
        ${head('Risks', 'e-risk', 'What can <em>go wrong</em>', 'Yields are variable and paid by the protocol. You can lose money. Read this before you start.')}
        ${cards([
          ['Contract bugs', 'Lido and Aave are smart contracts Kyro does not control. A bug or an attack there can lose funds.', 'ic-shield'],
          ['Depeg', 'stETH can trade below ETH, and a stablecoin can lose its peg.', 'ic-swap'],
          ['Lower rewards', 'Rates move. A validator’s commission, downtime or a retiring pool can cut your rewards. A delinquent Solana validator pays nothing until it returns.', 'ic-stake'],
          ['Waiting periods', 'TRON unstaking takes 14 days. Solana and NEAR take a few days, and Solana can take longer. You earn nothing in the meantime, and prices keep moving.', 'ic-lock'],
          ['Votes shrink', 'On TRON, unstaking reduces your votes in proportion. Kyro warns you first.', 'ic-eye'],
          ['Price risk', 'Staked coins can lose value like any other. A rate does not protect you from that.', 'ic-dash']
        ])}
        <p class="tbl-note">Kyro is a tool. Nothing on this site is financial advice.</p>`)}

    ${row('e-sign', 'Signing', 'See the contract, <em>then sign</em>', true, html`
          <p>Every step shows the contract, the function and the exact amount. Approvals are for the exact amount only, never unlimited.</p>
          ${ul([
            'Staking operations are a closed list. Everything else is refused, with your key as the only authority.',
            'On Solana, Kyro refuses authority changes and lockups.',
            'On NEAR, only pools from the official factories, with the expected code, are accepted.',
            'Risky choices, such as a commission above 10% on Solana, get a second confirmation.',
            'With a Ledger or Trezor, Kyro names the contract and function, then the device shows the transaction.'
          ])}
          <p>${a('/guides/stake-sol/', 'Step by step: stake SOL')}</p>`, confirmCard())}
    ${faqBlock('e-faq', faqs)}
    ${nextLinks('e-next', [
      ['/guides/stake-sol/', 'How to stake SOL', 'Pick a validator, delegate, and get your SOL back later.'],
      ['/hardware-wallets/', 'Earn on hardware wallets', 'What works from a Ledger or Trezor account.'],
      ['/security/', 'How Kyro signs', 'The native window, and why it reads Rust’s decoding.']
    ])}
    ${ctaPanel('Earn <em>without an account</em>')}`
  });
}

function hardware(chains) {
  const hw = chains.filter((c) => c.features.hardware);
  const none = chains.filter((c) => !c.features.hardware);
  const evm = hw.filter((c) => c.kind === 'evm');
  const others = hw.filter((c) => c.kind !== 'evm');
  const dev = (c, d) => yesNo((c.hwDevices || 'Ledger and Trezor').includes(d));
  const line = (c) => [`<a class="c-${c.slug}" href="/chains/${c.slug}/">${coin(c)}${esc(c.name)}</a>`, dev(c, 'Ledger'), dev(c, 'Trezor'), esc(c.hwNote || '')];
  const faqs = [
    ['Which Ledger and Trezor models work with Kyro?', 'Ledger devices with the current apps, and Trezor including the Trezor Safe 7. Cardano does not work on the Trezor One.'],
    ['Can I use Kyro with a hardware wallet only, without a recovery phrase in the app?', 'Yes. On the welcome screen choose “Use a Ledger / Trezor”. Kyro stores only public keys, and there is no vault or password to set.'],
    ['Can I stake from a Ledger or Trezor?', 'Earn works with Lido and Aave. Staking on Solana, Cardano, TRON and NEAR is refused on hardware accounts for now.'],
    ['Can I send tokens from a hardware wallet?', 'Yes on EVM chains and Solana (SPL), and on TRON (TRC-20) with a Ledger. On other chains, hardware accounts send the native coin for now.'],
    ['Why is my Ledger NEAR or TON address different?', 'The Ledger uses a different derivation path, so the same phrase gives a different account on NEAR, TON and Cardano. Kyro labels hardware accounts as such.'],
    ['Does Kyro check that my device is genuine?', 'No. Run the Genuine check in Ledger’s app or the authenticity check in Trezor Suite. Kyro cannot detect a malicious device that signs what it displays.']
  ];
  return assemble({
    path: '/hardware-wallets/',
    name: 'Ledger and Trezor in Kyro',
    crumb: 'Hardware wallets',
    title: 'Ledger and Trezor wallet app for desktop | Kyro Wallet',
    description: `Use a Ledger or Trezor with Kyro on ${hw.length} blockchains: one-click connect, Rust decoding, a signature check after signing, and an honest list of limits per chain.`,
    hero: {
      eyebrow: 'Hardware wallets',
      h1: 'Ledger <em>and</em> Trezor',
      lead: `Your keys stay in the device. Kyro is the screen, the decoder and the second pair of eyes, on ${hw.length} blockchains.`,
      extra: `<div class="hero-cta">${dlButton()}</div>`
    },
    scripts: ['/download.js', '/scenes.js'],
    faqs,
    body: html`
    <section class="section hw-scene" data-ledger-track aria-labelledby="h-connect">
      <div class="wrap hw-grid">
        <div class="hw-text">
          <p class="eyebrow" data-reveal>One-click connect</p>
          <h2 id="h-connect">Plug in, <em>click Connect</em></h2>
          <ol class="hw-steps" data-reveal>
            <li class="on"><span>1</span>Unlock the device</li>
            <li class="on"><span>2</span>Click Connect</li>
            <li class="on"><span>3</span>Approve on the device</li>
          </ol>
          <p class="small mute" data-reveal>On Ledger, every supported chain is ticked. One Connect opens each app in turn, reads the keys and skips an app that is missing or refused. You get a short result per chain: Added, Not installed or Skipped.</p>
        </div>
        ${ledgerScene()}
      </div>
    </section>

    ${sec('h-chains', html`
        ${head('Per chain', 'h-chains', 'What works <em>on which device</em>', `Generated from the same list as the rest of the site. ${none.length ? `${listNames(none.map((c) => c.name))}: no hardware wallet support.` : ''}`)}
        ${tbl('Hardware wallet support per blockchain', ['Blockchain', 'Ledger', 'Trezor', 'Note'], [
          [`EVM networks (${evm.length})`, yesNo(true), yesNo(true), esc(listNames(evm.map((c) => c.name)))],
          ...others.map(line)
        ])}`)}

    ${row('h-does', 'What Kyro adds', 'Two screens are <em>better than one</em>', true, html`
          <p>The device protects the keys and the final confirmation. Kyro still decodes the transaction in Rust and shows it in a native window before anything reaches the device.</p>
          ${ul([
            'Before signing, Kyro re-reads the device’s keys and compares them with the registered account.',
            'Receive addresses can be shown on the device, and any difference is a blocking error.',
            'After signing, Kyro verifies the signature against the expected key before broadcasting.',
            'Unplugging or a timeout abandons the operation cleanly. Nothing is left half-done.'
          ])}`, confirmCard())}

    ${sec('h-limits', html`
        ${head('Limits', 'h-limits', 'What to <em>know first</em>', 'Hardware support is the youngest part of Kyro. Read this before you move real money.')}
        ${cards([
          ['Testing status', 'SECURITY.md records much of this code as tested on recorded exchanges and simulated devices rather than on real hardware. The Trezor Safe 7 path has not run on a real Safe 7. Start with a small amount.', 'ic-eye'],
          ['Blind signing', 'When the device cannot decode a transaction, its screen shows only raw data and it protects your keys, not your consent. Kyro flags this with a hardened confirmation. Keep blind signing off until you need it.', 'ic-shield'],
          ['Earn', 'Lido and Aave only. Staking on Solana, Cardano, TRON and NEAR is refused from a hardware account.', 'ic-stake'],
          ['Token sends', 'EVM chains, Solana SPL, and TRC-20 on Ledger. Native coins elsewhere.', 'ic-send'],
          ['Different accounts', 'On NEAR, TON and Cardano, a Ledger gives a different account than the software wallet for the same phrase.', 'ic-accounts'],
          ['Public keys on disk', 'Hardware account files hold xpubs unencrypted: a privacy matter, not a funds one. Always verify a receive address on the device.', 'ic-lock']
        ])}`)}

    ${sec('h-trezor', html`
        ${head('Trezor Safe 7', 'h-trezor', 'A paired, <em>encrypted channel</em>', 'The Safe 7 speaks the Trezor Host Protocol. Kyro pairs with it once per installation.')}
        <div class="prose" data-reveal>
          ${ul([
            'The device shows a 6-digit code and you type it into Kyro.',
            'After pairing, another program on the USB cable can neither read nor change the messages.',
            'The device still asks you to confirm the connection on its screen.',
            'A pairing can be forgotten in Kyro. To revoke it on the device, reset its paired hosts.',
            'The pairing file sits next to the vault, unencrypted.'
          ])}
          <p>${a('/guides/connect-a-trezor/', 'Connect a Trezor, step by step')} · ${a('/guides/connect-a-ledger/', 'Connect a Ledger, step by step')}</p>
        </div>`)}
    ${faqBlock('h-faq', faqs)}
    ${nextLinks('h-next', [
      ['/guides/connect-a-ledger/', 'Connect a Ledger', 'Close Ledger Live, plug in, one Connect.'],
      ['/guides/connect-a-trezor/', 'Connect a Trezor', 'Including pairing a Safe 7.'],
      ['/wallets/linux/', 'Hardware wallets on Linux', 'The udev rules you need first.']
    ])}
    ${ctaPanel('Use Kyro <em>with your device</em>')}`
  });
}

const OS = () => ({
  windows: {
    name: 'Windows',
    title2: 'Private crypto wallet for Windows: install and notes | Kyro',
    desc: 'Install Kyro on Windows: one PowerShell command or the 64-bit installer. Free, open source and non-custodial, with built-in Tor. What SmartScreen means, and how updates work.',
    h1: 'Kyro <em>for Windows</em>',
    lead: 'A private crypto wallet for 64-bit Windows. One command, or the installer. It installs for the current user and starts on its own.',
    steps: [
      `Run the one-line command in PowerShell, or download <code>${FILES.exe}</code>.`,
      'If you used the file, verify its SHA-256 first.',
      'SmartScreen may show “Windows protected your PC”. Click <b>More info</b>, then <b>Run anyway</b>.',
      'One Kyro window installs the app, starts it and closes. Kyro appears in the Start menu.'
    ],
    term: ['PowerShell', [`$ Get-FileHash .\\${FILES.exe} -Algorithm SHA256`, 'Compare with the line in SHA256SUMS']],
    notes: [
      ['SmartScreen', 'The installers are not code-signed yet, so a browser download triggers the warning. The one-line command and in-app updates do not. ' + a('/guides/windows-smartscreen/', 'What SmartScreen means for Kyro') + '.', 'ic-shield'],
      ['.exe or .msi', 'Prefer the .exe: it is the only Windows package that updates itself. The .msi does not.', 'ic-send'],
      ['Updates', 'The installed app downloads signed updates over Tor, verifies them and applies them when you close it.', 'ic-swap'],
      ['Phrase window', 'The recovery phrase window is excluded from screenshots and screen sharing on Windows.', 'ic-eye']
    ],
    files: [[FILES.exe, 'Recommended, updates itself'], [FILES.msi, 'For managed installs, no self-update']],
    faqs: [
      ['Is Kyro safe to run if SmartScreen warns me?', 'The warning means the file is unsigned and has little reputation yet. It says nothing about the code either way. Verify the SHA-256 against SHA256SUMS before you click through.'],
      ['Does Kyro need administrator rights?', 'No. The installer works for the current user.'],
      ['Does Kyro run on 32-bit or ARM Windows?', 'Kyro publishes a 64-bit x64 build. That is the only Windows build.']
    ]
  },
  macos: {
    name: 'macOS',
    title2: 'Private crypto wallet for Mac: install and notes | Kyro',
    desc: 'Install Kyro on your Mac with one Terminal command or the universal .dmg, for Apple Silicon and Intel. Free, open source and non-custodial, with built-in Tor.',
    h1: 'Kyro <em>for macOS</em>',
    lead: 'A private crypto wallet for your Mac. One universal app for Apple Silicon and Intel.',
    steps: [
      `Run the one-line command in Terminal, or download <code>${FILES.dmg}</code>.`,
      'If you used the file, verify its SHA-256 first.',
      'Open the .dmg and drag <b>Kyro</b> to <b>Applications</b>.',
      'Gatekeeper blocks the first launch: right-click Kyro in Applications and choose <b>Open</b>, or use <b>System Settings › Privacy &amp; Security › Open Anyway</b>.'
    ],
    term: ['Terminal', [`$ shasum -a 256 ${FILES.dmg}`, 'Compare with the line in SHA256SUMS']],
    notes: [
      ['Gatekeeper', 'The app is not code-signed yet, so macOS blocks the first launch of a downloaded file. The one-line command avoids that.', 'ic-shield'],
      ['Where it installs', 'The one-line command puts Kyro.app in /Applications, or ~/Applications. It needs no sudo.', 'ic-send'],
      ['Updates', 'The installed app updates itself with signed updates, downloaded over Tor.', 'ic-swap'],
      ['Phrase window', 'The phrase window is excluded from most capture on macOS. Check that nobody is watching anyway.', 'ic-eye']
    ],
    files: [[FILES.dmg, 'Universal: Apple Silicon and Intel']],
    faqs: [
      ['Does Kyro run on Apple Silicon?', 'Yes. The .dmg is universal, for Apple Silicon and Intel.'],
      ['macOS says Kyro cannot be opened. Is that normal?', 'Yes, until Kyro is code-signed. Verify the checksum, then right-click Kyro in Applications and choose Open.'],
      ['Is there an iPhone or iPad app?', 'No. Kyro is a desktop app. Anything in an app store using the name is not ours.']
    ]
  },
  linux: {
    name: 'Linux',
    title2: 'Private crypto wallet for Linux: AppImage and .deb | Kyro',
    desc: 'Install Kyro on Linux x86_64: one command, an AppImage that updates itself or a .deb. Free, open source and non-custodial, with built-in Tor. FUSE and udev notes.',
    h1: 'Kyro <em>for Linux</em>',
    lead: 'A private crypto wallet for x86_64 Linux. One command, an AppImage or a .deb. No sudo for the command.',
    steps: [
      'Run the one-line command: it installs <code>~/.local/bin/kyro</code> with a menu entry.',
      `Or download <code>${FILES.appimage}</code>, verify it, make it executable and run it.`,
      `On Debian or Ubuntu you can use the .deb instead: <code>sudo apt install ./${FILES.deb}</code>.`
    ],
    term: ['Terminal', ['$ sha256sum -c SHA256SUMS --ignore-missing', `$ chmod +x ${FILES.appimage}`, `$ ./${FILES.appimage}`]],
    notes: [
      ['FUSE 2', 'AppImages need FUSE 2. Install libfuse2 on Ubuntu 22.04, or libfuse2t64 on Ubuntu 24.04 and later.', 'ic-send'],
      ['AppImage or .deb', 'The AppImage updates itself. The .deb does not: install the new .deb to update.', 'ic-swap'],
      ['udev rules', 'Hardware wallets need the manufacturer’s udev rules so Kyro can open the device. Ledger and Trezor both publish them.', 'ic-hw'],
      ['Phrase window', 'Screen-capture protection does not exist on Linux. Check that nobody can see your screen.', 'ic-eye']
    ],
    files: [[FILES.appimage, 'Recommended, updates itself'], [FILES.deb, 'Debian and Ubuntu, no self-update']],
    faqs: [
      ['Why does my AppImage not start?', 'It most likely needs FUSE 2: sudo apt install libfuse2 on Ubuntu 22.04, or libfuse2t64 on Ubuntu 24.04 and later.'],
      ['Why does Kyro not see my Ledger or Trezor on Linux?', 'Install the manufacturer’s udev rules, unplug the device and plug it back in. Also close Ledger Live or Trezor Suite, which hold the device.'],
      ['Can I build Kyro myself?', `Yes. You need Rust, Node.js 22+, pnpm and the Tauri prerequisites. See ${a('/open-source/', 'how to build Kyro from source')}.`]
    ]
  }
});

function platform(key) {
  const o = OS()[key];
  const path = `/wallets/${key}/`;
  return assemble({
    path,
    name: `Kyro for ${o.name}`,
    crumb: o.name,
    parent: ['/download/', 'Download'],
    title: o.title2,
    description: o.desc,
    hero: { eyebrow: `${o.name} desktop wallet`, h1: o.h1, lead: o.lead, extra: `<div class="hero-cta">${dlButton()}</div>`, aside: vaultCard() },
    scripts: ['/download.js', '/copy.js'],
    faqs: o.faqs,
    body: html`
    ${sec('p-cmd', html`
        ${head('Install', 'p-cmd', 'One <em>command</em>', 'It downloads the latest release from GitHub, checks its SHA-256 against SHA256SUMS and stops if they differ.')}
        <div class="prose" data-reveal>${installBlock('install-' + key)}</div>`, 'section-tight')}

    ${row('p-file', 'Or the file', `Install <em>by hand</em>`, false, html`
          <ol class="os-steps">${o.steps.map((s) => `<li>${s}</li>`)}</ol>
          <div class="doc-links">${o.files.map(([f]) => `<a href="${DL}${f}">${f}</a>`)}<a href="${DL}${FILES.sums}">SHA256SUMS</a></div>
          <p class="small mute">${o.files.map(([f, n]) => `<code>${f}</code>: ${n}.`).join(' ')}</p>`, term(...o.term))}

    ${sec('p-notes', html`
        ${head('Notes', 'p-notes', `Good to know <em>on ${o.name}</em>`)}
        ${cards(o.notes, true)}`)}

    ${row('p-same', 'Same on every system', 'The full wallet, <em>everywhere</em>', true, html`
          <p>The ${o.name} build is the same Kyro: 36 blockchains, swaps, Earn, hardware wallets and Tor from the first launch. The interface is in English and French.</p>
          ${ul(['No account and no analytics.', 'Your recovery phrase stays on your computer, encrypted.', 'Your phrase also restores your wallet on another system.'])}`, assetsCard())}
    ${faqBlock('p-faq', o.faqs)}
    ${nextLinks('p-next', [
      ['/guides/first-steps-with-kyro/', 'First steps with Kyro', 'From the welcome screen to your first receive address.'],
      ['/guides/verify-your-download/', 'Verify your download', 'Check the SHA-256 in two minutes.'],
      ['/guides/back-up-your-recovery-phrase/', 'Back up your recovery phrase', 'Paper, in order, offline.']
    ])}
    ${ctaPanel(`Get Kyro <em>for ${o.name}</em>`)}`
  });
}

function about() {
  return assemble({
    path: '/about/',
    name: 'About Kyro Wallet',
    crumb: 'About',
    title: 'About Kyro: why this private wallet exists | Kyro Wallet',
    description: 'Why Kyro exists: a desktop crypto wallet with no account and no analytics, keys on your machine, Tor by default, code anyone can read and a fee anyone can check.',
    hero: {
      eyebrow: 'About',
      h1: 'Why <em>Kyro</em> exists',
      lead: 'A wallet sees more about you than almost any other app: what you own, what you spend and where you are. Kyro is built to see as little of that as it can.'
    },
    body: html`
    ${sec('a-why', html`
        <div class="prose" data-reveal>
          <h2 id="a-why">The problem</h2>
          <p>Holding your own keys protects your coins. It does nothing for your privacy on its own. Every balance check tells a server which addresses you care about and which IP address asked. Put enough of those requests in one log and your wallet has a name on it.</p>
          <p>Most of that traffic is invisible, so nobody notices. Kyro starts from the other end: a desktop wallet where the private path is the default, and where you have to choose, in a system window, to leave it.</p>
          <h2>What Kyro holds to</h2>
          ${ul([
            '<b>Your keys are yours.</b> The recovery phrase is encrypted on your computer. Nobody else, developers included, can move your funds.',
            '<b>No account.</b> No email, no sign-up, no server holding funds.',
            '<b>No analytics.</b> One anonymous weekly count over Tor, which you can turn off.',
            '<b>You read what you sign.</b> Rust decodes each transaction and a native window shows it.',
            '<b>Limits are published.</b> What Kyro cannot protect you from is written down, chain by chain.'
          ])}
          <h2>How it is paid for</h2>
          <p>Kyro is free. The swap fee, from 0.7%, funds the project, and it is public: the rates sit in one open source file. Sending, receiving and staking carry no Kyro fee. Donations and <a href="https://github.com/sponsors/shuntraa">GitHub Sponsors</a> help too.</p>
          <h2>What Kyro is not</h2>
          ${ul([
            'It is not a bank, an exchange or a custodian. If you lose your phrase and your computer, nobody can recover your funds.',
            'It is not a promise of anonymity. Tor hides your IP address. Public blockchains stay public.',
            'It is not externally audited yet. An internal security review has been done; no independent audit has been published.',
            'It is not on your phone. Kyro is desktop only. A mobile app using the name is not ours.'
          ], 'checks minus')}
        </div>`)}
    ${nextLinks('a-next', [
      ['/open-source/', 'Read the code', 'Licence, build instructions and how to contribute.'],
      ['/roadmap/', 'See what is next', 'What is done and what comes after.'],
      ['/security/', 'See the threat model', 'What Kyro protects, and what no software can.']
    ])}
    ${ctaPanel()}`
  });
}

function roadmap() {
  return assemble({
    path: '/roadmap/',
    name: 'Kyro roadmap',
    crumb: 'Roadmap',
    title: 'Roadmap: what is done and what comes next | Kyro Wallet',
    description: 'What Kyro has shipped and what comes next: staking on Polkadot, Sui and Aptos, token sends on more chains, winget and code signing. No dates we cannot keep.',
    hero: {
      eyebrow: 'Roadmap',
      h1: 'Where Kyro <em>is going</em>',
      lead: `Version ${VERSION} today. This page lists what has shipped and what is planned. There are no dates, because a wallet ships when it is checked.`
    },
    body: html`
    ${sec('r-road', html`
        <h2 id="r-road" class="visually-hidden">Done and next</h2>
        <div class="road-cols">
          <div><h3 class="road-h">Shipped</h3>${roadList(DONE, 'done')}</div>
          <div><h3 class="road-h">Next, in no fixed order</h3>${roadList(NEXT, 'next')}</div>
        </div>`, 'section-tight')}
    ${sec('r-no', html`
        ${head('Not today', 'r-no', 'What Kyro <em>will not rush</em>', 'A few things cannot be done safely yet. They stay out until they can.')}
        ${cards([
          ['Polkadot on Ledger', 'The Ledger app needs a metadata proof with each transaction, which Kyro does not build yet.', 'ic-hw'],
          ['Device authenticity', 'Kyro does not run Trezor’s authenticity check. Do that in Trezor Suite.', 'ic-shield'],
          ['External audit', 'An internal review has been done. No independent audit has been published yet.', 'ic-eye']
        ])}`)}
    ${nextLinks('r-next', [
      ['/changelog/', 'Changelog', 'Every release, in plain words.'],
      ['/open-source/', 'Contribute', 'Issues and pull requests are welcome.'],
      ['/about/', 'About Kyro', 'Why it exists and how it is paid for.']
    ], 'More <em>on the project</em>')}
    ${ctaPanel()}`
  });
}

/** CHANGELOG.md, turned into HTML at build time. */
function changelog(md) {
  const entries = [];
  let cur = null;
  for (const raw of md.split('\n')) {
    const h = raw.match(/^## (.+)/);
    if (h) {
      cur = { v: h[1].trim(), items: [] };
      entries.push(cur);
    } else if (cur && raw.startsWith('- ')) cur.items.push(raw.slice(2).trim());
    else if (cur && /^\s+\S/.test(raw) && cur.items.length) cur.items[cur.items.length - 1] += ' ' + raw.trim();
  }
  return assemble({
    path: '/changelog/',
    name: 'Kyro changelog',
    crumb: 'Changelog',
    title: `Changelog: every Kyro release up to ${entries[0].v} | Kyro Wallet`,
    description: `What changed in each version of Kyro Wallet, from 1.0.0 to ${entries[0].v}. Generated from the CHANGELOG.md file in the repository.`,
    hero: {
      eyebrow: 'Changelog',
      h1: 'What <em>changed</em>',
      lead: `Every release of Kyro, newest first. This page is generated from <a href="${REPO}/blob/main/CHANGELOG.md">CHANGELOG.md</a> at build time.`
    },
    body: html`
    <section class="section section-tight" aria-label="Releases">
      <div class="wrap">
        <div class="prose" data-reveal>
          ${entries.map(
            (e, i) => html`
          <section class="log-entry" id="v${e.v.replace(/\W/g, '-')}" aria-label="Version ${e.v}">
            <h2>${esc(e.v)}${i === 0 ? '<span class="latest">Latest</span>' : ''}</h2>
            <ul>${e.items.map((t) => `<li>${esc(t)}</li>`)}</ul>
          </section>`
          )}
          <p><a href="${REPO}/releases">All releases and files on GitHub</a></p>
        </div>
      </div>
    </section>
    ${ctaPanel()}`
  });
}

function openSource() {
  const faqs = [
    ['What licence is Kyro under?', 'GPL-3.0-or-later. You can read, run, change and share it. If you distribute a changed version, it stays under the same licence, with its source.'],
    ['Are Kyro builds reproducible?', 'Not bit for bit yet. It is a goal, not a guarantee. Today you can verify the SHA-256 of a release and build from the same source yourself.'],
    ['Can I remove the swap fee?', 'Yes, in your own build. The rates live in packages/swap/src/fees.ts, and anyone can change them or set the fee to 0.'],
    ['Has Kyro been audited?', 'An internal security review has been done. No independent external audit has been published yet. Like all GPL software, Kyro comes with no warranty.']
  ];
  return assemble({
    path: '/open-source/',
    name: 'Kyro is open source',
    crumb: 'Open source',
    title: 'Open source crypto wallet: read, build, verify | Kyro',
    description: 'Kyro is an open source wallet under GPL-3.0-or-later. How to read the code, build it, verify a release, contribute and report a vulnerability.',
    hero: {
      eyebrow: 'Open source',
      h1: 'Don’t trust it. <em>Read it.</em>',
      lead: 'The interface, the Rust core and the app shell are all public under GPL-3.0-or-later. Here is how to read, build and verify what you run.',
      extra: `<div class="hero-cta"><a class="btn btn-primary btn-xl" href="${REPO}">Source on GitHub</a></div>`
    },
    faqs,
    body: html`
    ${sec('o-read', html`
        ${head('Read', 'o-read', 'Where <em>to start</em>', 'A small map of the repository. Keys live in one place, and it has no network access.')}
        ${tbl('Repository layout', ['Path', 'What it holds'], [
          ['<code>crates/wallet-core</code>', 'Pure Rust: vault, BIP39 and BIP32, derivation, decoding, signing. No network, no files'],
          ['<code>apps/desktop/src-tauri</code>', 'Tauri 2 shell: commands, session and auto-lock, filtered network access, native windows'],
          ['<code>apps/desktop/src</code>', 'React and strict TypeScript interface. No secrets'],
          ['<code>packages/chains</code>', 'Chain adapters that build unsigned transactions'],
          ['<code>packages/swap</code>', 'Swap providers and fee logic'],
          ['<code>docs/</code>', 'Architecture, IPC contract, network requests, swap fees']
        ])}
        <div class="doc-links" data-reveal>
          <a href="${REPO}/blob/main/SECURITY.md">Threat model</a>
          <a href="${REPO}/blob/main/docs/NETWORK.md">Servers contacted</a>
          <a href="${REPO}/blob/main/docs/ARCHITECTURE.md">Architecture</a>
          <a href="${REPO}/blob/main/docs/SWAP_FEES.md">Swap fees</a>
        </div>`)}

    ${row('o-build', 'Build', 'Build it <em>yourself</em>', false, html`
          <p>You need Rust 1.97.1, which rustup installs from the pinned toolchain file, Node.js 22+, pnpm 11 and the Tauri prerequisites for your system.</p>
          ${ul(['Dependencies are pinned to exact versions, with committed lockfiles.', 'CI runs <code>cargo audit</code>, <code>cargo deny</code> and <code>pnpm audit</code>.', 'Before a PR: <code>pnpm lint</code>, <code>pnpm typecheck</code>, <code>pnpm test</code>.'])}`, term('Terminal', [`$ git clone ${REPO}.git`, '$ cd kyro-wallet', '$ pnpm install --frozen-lockfile', '$ pnpm dev', '$ pnpm build']))}

    ${sec('o-verify', html`
        ${head('Verify', 'o-verify', 'What you can <em>check today</em>', 'Three things you can verify, and one you cannot yet.')}
        ${cards([
          ['Release checksums', `Each release ships <a href="${DL}${FILES.sums}">SHA256SUMS</a>. ${a('/guides/verify-your-download/', 'Compare your file')} before you run it.`, 'ic-shield'],
          ['Signed updates', 'Each update is signed. Kyro verifies it against a public key pinned in the app, and refuses a bad signature.', 'ic-lock'],
          ['Servers contacted', `Every server is listed in <a href="${REPO}/blob/main/docs/NETWORK.md">NETWORK.md</a>, and any new one has to be added there.`, 'ic-tor'],
          ['Not yet', 'Bit-for-bit reproducible builds are a goal, not a guarantee. The installers are not code-signed yet.', 'ic-eye']
        ], true)}`)}

    ${sec('o-contrib', html`
        ${head('Contribute', 'o-contrib', 'Help <em>make it better</em>', 'Issues and pull requests are welcome.')}
        <div class="prose" data-reveal>
          ${ul([
            'Run <code>pnpm lint</code>, <code>pnpm typecheck</code> and <code>pnpm test</code> before opening a pull request.',
            'Any new server Kyro contacts must be listed in <code>docs/NETWORK.md</code>.',
            'Changes to the IPC contract belong in <code>docs/IPC.md</code>.',
            '<b>Never post a recovery phrase, private key or password</b> in an issue, pull request or log.'
          ])}
          <h2 id="o-report">Report a vulnerability</h2>
          <p>Please do not open a public issue. Report privately through <a href="${REPO}/security/advisories/new">GitHub security advisories</a>, with a proof of concept if you can. Reports are acknowledged within 72 hours, with a fix and coordinated disclosure within 90 days at most.</p>
        </div>`)}
    ${faqBlock('o-faq', faqs)}
    ${nextLinks('o-next', [
      ['/security/', 'How Kyro protects your keys', 'The three layers, and what no software can do.'],
      ['/changelog/', 'Changelog', 'What changed in each release.'],
      ['/brand/', 'Brand kit', 'Logos and colours for writing about Kyro.']
    ])}
    ${ctaPanel()}`
  });
}

const LOGOS = [
  ['kyro-logo-dark.svg', 'Logo, for dark backgrounds', ''],
  ['kyro-logo.svg', 'Logo, for light backgrounds', ' light'],
  ['kyro-mark-dark.svg', 'Mark, for dark backgrounds', ''],
  ['kyro-mark.svg', 'Mark, for light backgrounds', ' light'],
  ['kyro-icon.svg', 'App icon', ''],
  ['kyro-icon-blue.svg', 'App icon, blue', '']
];
const COLORS = [['ice', 'Kyro ice', '#7CC4FF'], ['blue', 'Kyro blue', '#2F6BFF'], ['black', 'Page black', '#000000'], ['ink', 'Ink', '#0A0B0D'], ['paper', 'Paper', '#F5F7FA'], ['grey', 'Grey', '#8C929D']];

function brand() {
  return assemble({
    path: '/brand/',
    name: 'Kyro brand kit',
    crumb: 'Brand',
    title: 'Brand and press kit: logos and colours | Kyro Wallet',
    description: 'Download Kyro Wallet logos, marks and app icons, with the colours, typefaces, a short description and simple usage rules for writing about the project.',
    hero: {
      eyebrow: 'Brand',
      h1: 'Brand <em>and press kit</em>',
      lead: 'Writing about Kyro? Everything you need is here, as SVG files from the repository.'
    },
    body: html`
    ${sec('b-logos', html`
        ${head('Logos', 'b-logos', 'Logos <em>and marks</em>')}
        <div class="brand-grid" data-reveal-group>
          ${LOGOS.map(([f, n, c]) => `<div class="brand-tile"><div class="brand-show${c}"><img src="/img/brand/${f}" alt="${esc(n)}" loading="lazy"></div><p>${n}</p><small><a href="/img/brand/${f}" download>${f}</a></small></div>`)}
        </div>`, 'section-tight')}
    ${sec('b-color', html`
        ${head('Colour', 'b-color', 'Colours')}
        <div class="swatches" data-reveal-group>
          ${COLORS.map(([k, n, v]) => `<div class="swatch sw-${k}"><i></i><b>${n}</b><code>${v}</code></div>`)}
        </div>`)}
    ${sec('b-use', html`
        <div class="prose" data-reveal>
          <h2 id="b-use">Name and description</h2>
          <p>Write <b>Kyro</b> or <b>Kyro Wallet</b>. Short description:</p>
          <p class="note">Kyro Wallet is a free, open-source, non-custodial desktop wallet for Windows, macOS and Linux. One recovery phrase for 36 blockchains, keys on your own computer, Tor on by default.</p>
          <h2>Type</h2>
          <p>Headlines use Archivo. Everything else uses Geist. Both are under the SIL Open Font License, with the licence files in <a href="/fonts/OFL-Geist.txt">OFL-Geist</a> and <a href="/fonts/OFL-Archivo.txt">OFL-Archivo</a>.</p>
          <h2>Usage</h2>
          ${ul(['Use the files as they are, with room around them.', 'Use the dark version on dark backgrounds and the light version on light ones.', 'Link to kyrowallet.com, the only official site, and to GitHub Releases for downloads.'])}
          ${ul(['Do not change the colours or shape of the mark.', 'Do not suggest that Kyro endorses your product or service.', 'Do not use the name or logo for an app, a token or a download of your own.'], 'checks minus')}
          <h2>Facts to check</h2>
          <p>Kyro has no mobile app and no external audit published yet. The current version is ${VERSION}. If you are unsure of a claim, the <a href="/llms.txt">site summary</a> and the <a href="${REPO}">repository</a> are the reference.</p>
        </div>`)}
    ${ctaPanel()}`
  });
}

export const LLMS_NAMES = {
  '/tor/': 'Tor wallet',
  '/monero/': 'Monero desktop wallet',
  '/swap/': 'Swaps',
  '/earn/': 'Earn: staking and lending',
  '/hardware-wallets/': 'Ledger and Trezor',
  '/wallets/windows/': 'Kyro for Windows',
  '/wallets/macos/': 'Kyro for macOS',
  '/wallets/linux/': 'Kyro for Linux',
  '/about/': 'About Kyro',
  '/roadmap/': 'Roadmap',
  '/changelog/': 'Changelog',
  '/open-source/': 'Open source',
  '/glossary/': 'Glossary',
  '/guides/': 'Guides',
  '/brand/': 'Brand kit'
};

export const morePages = (chains, changelogMd) => [
  tor(chains),
  monero(chains),
  swap(chains),
  earn(),
  hardware(chains),
  platform('windows'),
  platform('macos'),
  platform('linux'),
  about(),
  roadmap(),
  changelog(changelogMd),
  openSource(),
  brand(),
  ...guidePages(chains)
];
