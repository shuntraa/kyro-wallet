import { describe, expect, it } from 'vitest';
import { call, setBackend } from '@kyro/shared';
import { createMockBackend } from '@kyro/shared/mock';
import { allChains, assetsFor, createAdapters, findChain, type AnyUnsigned } from '@kyro/chains';
import { buildDepositTx, buyGroups, canSwapFrom, canSwapTo, crossStatusLabel, depositTxProblem, ownAddressOn, pickSend, sendChoices, swapChainOf, swapRate, swapTokenAddress } from './crossSwap';
import { isLocalTx } from './storage';

const accounts = {
  evm: { address: '0x4F2A9c83b1E07D6a55C0E91B3D7f28aE6c19d7b2', path: '' },
  sol: { address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', path: '' },
  btc: { segwit: { address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', xpub: '', fingerprint: '', path: '' }, taproot: { address: 'bc1p…', xpub: '', fingerprint: '', path: '' } },
};

describe('cross-chain swap helpers', () => {
  const chains = allChains('mainnet');
  const assets = assetsFor('mainnet');
  const eth = findChain('mainnet', 'ethereum');
  const sol = findChain('mainnet', 'solana');
  const btc = findChain('mainnet', 'bitcoin');

  it('maps chains to swap ids and own addresses (never typed: always one of your accounts)', () => {
    expect(swapChainOf(eth)).toBe(1);
    expect(swapChainOf(sol)).toBe('solana');
    expect(swapChainOf(btc)).toBe('bitcoin');
    expect(['tron', 'xrp', 'ada', 'ltc', 'doge'].map((k) => swapChainOf(chains.find((c) => c.family === k)))).toEqual(['tron', 'xrp', 'cardano', 'litecoin', 'dogecoin']);
    expect(ownAddressOn(accounts, sol)).toBe(accounts.sol.address);
    expect(ownAddressOn(accounts, btc)).toBe(accounts.btc.segwit.address); // native SegWit, not Taproot
    const xrp = chains.find((c) => c.family === 'xrp');
    expect(ownAddressOn(accounts, xrp)).toBeNull(); // no XRP account here
    expect(ownAddressOn({ ...accounts, xrp: { address: 'rBxjMcoZ3X6Q89MjBxvuJBrZq6CctimSZf' } }, xrp)).toBe('rBxjMcoZ3X6Q89MjBxvuJBrZq6CctimSZf');
  });

  it('starts on EVM / Solana everywhere, on Bitcoin / LTC / DOGE / TRON / XRP / Cardano on mainnet (NEAR Intents); other chains on mainnet only', () => {
    expect(canSwapFrom(btc)).toBe(true);
    expect(canSwapFrom(sol)).toBe(true);
    const tron = chains.find((c) => c.family === 'tron');
    expect(canSwapTo('mainnet', eth, sol)).toBe(true);
    expect(canSwapTo('mainnet', sol, btc)).toBe(true);
    expect(canSwapTo('mainnet', btc, eth)).toBe(true);
    expect(canSwapTo('mainnet', eth, tron)).toBe(true);
    expect(canSwapTo('mainnet', tron, tron)).toBe(true); // TRX <-> USDT
    const tbtc = allChains('testnet').find((c) => c.family === 'btc');
    expect(canSwapFrom(tbtc, 'testnet')).toBe(false);
    const sep = findChain('testnet', 'sepolia');
    expect(canSwapTo('testnet', sep, findChain('testnet', 'solana'))).toBe(false);
    expect(canSwapTo('testnet', sep, sep)).toBe(true);
  });

  it('NEAR Intents chains added on 01/11/2026: BCH, Dash, Zcash, Sui, TON, Aptos both ways, Stellar on arrival only, Gnosis', () => {
    const by = (f: string) => chains.find((c) => c.family === f);
    expect(['bch', 'dash', 'zec', 'sui', 'ton', 'apt', 'xlm'].map((f) => swapChainOf(by(f)))).toEqual(['bitcoincash', 'dash', 'zcash', 'sui', 'ton', 'aptos', 'stellar']);
    for (const f of ['bch', 'dash', 'zec', 'sui', 'ton', 'apt']) {
      expect(canSwapFrom(by(f)), f).toBe(true);
      expect(canSwapTo('mainnet', by(f), eth), f).toBe(true);
      expect(canSwapTo('mainnet', sol, by(f)), f).toBe(true);
      expect(canSwapFrom(allChains('testnet').find((c) => c.family === f), 'testnet'), f).toBe(false);
    }
    // Stellar: 1Click wants a memo on a Stellar deposit (Kyro never sends one) → arrival only.
    expect(canSwapFrom(by('xlm'))).toBe(false);
    expect(canSwapTo('mainnet', eth, by('xlm'))).toBe(true);
    expect(canSwapTo('mainnet', by('bch'), by('xlm'))).toBe(true);
    // Monero (Exolix): both ways since Kyro has a Monero fee address (1.0.6).
    expect(canSwapFrom(by('xmr'))).toBe(true);
    expect(canSwapTo('mainnet', by('xmr'), by('btc'))).toBe(true);
    for (const f of ['btc', 'ltc', 'sol']) expect(canSwapTo('mainnet', by(f), by('xmr')), f).toBe(true);
    expect(canSwapTo('mainnet', eth, by('xmr'))).toBe(true);
    expect(canSwapTo('mainnet', by('doge'), by('xmr'))).toBe(true);
    expect(canSwapTo('mainnet', findChain('mainnet', 'bsc'), by('xmr'))).toBe(false);
    expect(ownAddressOn({ ...accounts, xmr: { address: '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A' } }, by('xmr'))).toMatch(/^44AF/);
    for (const f of ['hbar', 'dot', 'cosmos']) expect(canSwapFrom(by(f)), f).toBe(false);
    for (const f of ['near', 'kas', 'algo']) expect(canSwapFrom(by(f)), f).toBe(true);
    // Exolix: Kaspa, Algorand, NEAR both ways (1.0.6); Hedera, Polkadot, Cosmos not at all.
    for (const f of ['near', 'kas', 'algo']) expect(canSwapTo('mainnet', eth, by(f)), f).toBe(true);
    for (const f of ['hbar', 'dot', 'cosmos']) expect(canSwapTo('mainnet', eth, by(f)), f).toBe(false);
    // EVM: same-chain where 0x / LI.FI has a checked contract (Flare, Kaia, HyperEVM now too), not Conflux.
    for (const k of ['flare', 'kaia', 'hyperevm', 'cronos', 'gnosis']) expect(canSwapTo('mainnet', findChain('mainnet', k), findChain('mainnet', k)), k).toBe(true);
    expect(canSwapFrom(findChain('mainnet', 'conflux'))).toBe(false);
    expect(canSwapTo('mainnet', findChain('mainnet', 'gnosis'), by('bch'))).toBe(true);
    expect(canSwapTo('mainnet', eth, findChain('mainnet', 'gnosis'))).toBe(true);
    expect(canSwapTo('mainnet', eth, findChain('mainnet', 'cronos'))).toBe(false);
    expect(canSwapTo('mainnet', findChain('mainnet', 'flare'), sol)).toBe(false);
    const own = { ...accounts, bch: { address: 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a' }, stellar: { address: 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6' }, ton: { address: 'UQCKhieGGl3ZbJ2zzggHsSLaXtRzk0znVopbSxw2HLsorhqg' } };
    expect(ownAddressOn(own, by('bch'))).toBe(own.bch.address);
    expect(ownAddressOn(own, by('xlm'))).toBe(own.stellar.address);
    expect(ownAddressOn(own, by('ton'))).toBe(own.ton.address);
    expect(ownAddressOn(own, by('sui'))).toBeNull();
    expect(swapTokenAddress(assets.find((a) => a.id === 'zec') ?? assets[0]!)).toBe('zcash');
    expect(swapTokenAddress(assets.find((a) => a.id === 'apt') ?? assets[0]!)).toBe('aptos');
  });

  it('« Tu reçois » groups: the sell chain first, then the others, without the sold asset', () => {
    const sell = assets.find((a) => a.id === 'eth:1');
    const groups = buyGroups('mainnet', chains, assets, sell);
    expect(groups[0]?.chain.key).toBe('ethereum');
    expect(groups.map((g) => g.chain.key)).toEqual(expect.arrayContaining(['solana', 'bitcoin', 'arbitrum']));
    expect(['tron', 'xrp', 'ada', 'ltc', 'doge'].every((f) => groups.some((g) => g.chain.family === f))).toBe(true);
    expect(groups.find((g) => g.chain.family === 'ada')?.assets.every((a) => a.kind === 'native')).toBe(true);
    expect(groups.flatMap((g) => g.assets).some((a) => a.id === 'eth:1')).toBe(false);
    const sepEth = assetsFor('testnet').find((a) => a.chainKey === 'sepolia' && a.kind === 'native');
    expect(buyGroups('testnet', allChains('testnet'), assetsFor('testnet'), sepEth).map((g) => g.chain.key)).toEqual(['sepolia']);
  });

  it('Monero is a « Tu reçois » choice on mainnet from ETH, USDT, USDC, BTC, SOL and LTC (testnet: none)', () => {
    const native = (family: string) => assets.find((a) => a.family === family && a.kind === 'native' && chains.find((c) => c.key === a.chainKey)?.family === family);
    const onEth = (symbol: string) => assets.find((a) => a.chainKey === 'ethereum' && a.symbol === symbol);
    const sells = [onEth('ETH'), onEth('USDT'), onEth('USDC'), native('btc'), native('sol'), native('ltc')];
    for (const sell of sells) {
      expect(sell).toBeDefined();
      const xmr = buyGroups('mainnet', chains, assets, sell).find((g) => g.chain.family === 'xmr');
      expect(xmr?.assets.some((a) => a.kind === 'native' && a.symbol === 'XMR'), sell?.id).toBe(true);
    }
    const sepEth = assetsFor('testnet').find((a) => a.chainKey === 'sepolia' && a.kind === 'native');
    expect(buyGroups('testnet', allChains('testnet'), assetsFor('testnet'), sepEth).some((g) => g.chain.family === 'xmr')).toBe(false);
  });

  it('token ids as the providers name them', () => {
    const find = (id: string) => assets.find((a) => a.id === id);
    expect(swapTokenAddress(find('sol') ?? assets[0]!)).toBe('So11111111111111111111111111111111111111112');
    expect(swapTokenAddress(find('btc') ?? assets[0]!)).toBe('bitcoin');
    expect(swapTokenAddress(find('eth:1') ?? assets[0]!)).toBe('0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE');
  });

  it('labels the bridge status and stores it safely', () => {
    expect(crossStatusLabel(undefined, 'Solana')).toBe('en route vers Solana');
    expect(crossStatusLabel('DONE', 'Solana')).toBe('arrivé sur Solana');
    expect(crossStatusLabel('FAILED', 'Solana')).toMatch(/remboursement/);
    expect(crossStatusLabel('SUCCESS', 'Ethereum')).toBe('arrivé sur Ethereum');
    expect(crossStatusLabel('REFUNDED', 'Ethereum')).toMatch(/remboursé/);
    const tx = { id: '0xabc', network: 'mainnet', chainKey: 'arbitrum', assetId: 'eth:42161', kind: 'swap', direction: 'out', amount: '1', time: 1, status: 'pending' };
    expect(isLocalTx({ ...tx, cross: { fromChain: '42161', toChain: 'solana', toChainKey: 'solana', bridge: 'near' } }, 'mainnet')).toBe(true);
    expect(isLocalTx({ ...tx, cross: { fromChain: '42161', toChain: 'ethereum', toChainKey: 'solana', bridge: 'near' } }, 'mainnet')).toBe(false);
    expect(isLocalTx({ ...tx, cross: { fromChain: 'bitcoin', toChain: '1', toChainKey: 'ethereum', bridge: '1click', depositAddress: 'bc1qfm26lzq7yaqap99dp689wfn4pkfpd6r2m7n55d' } }, 'mainnet')).toBe(true);
    expect(isLocalTx({ ...tx, cross: { fromChain: 'bitcoin', toChain: '1', toChainKey: 'ethereum', bridge: '1click', depositAddress: 'bc1q/../x' } }, 'mainnet')).toBe(false);
    expect(isLocalTx({ ...tx, cross: { fromChain: 'bitcoincash', toChain: '1', toChainKey: 'ethereum', bridge: '1click', depositAddress: 'bitcoincash:qz7xm6aahynmu0ud5y255jlxe22cdjgxpv9ra4uqyf' } }, 'mainnet')).toBe(true);
    expect(isLocalTx({ ...tx, cross: { fromChain: 'ton', toChain: 'stellar', toChainKey: 'stellar', bridge: '1click', depositAddress: 'UQD-x0XHFHtf6KcZGG7ZWrqF1oZ5NGE-guyHR4yjKL1Ivz_P' } }, 'mainnet')).toBe(true);
    expect(isLocalTx({ ...tx, cross: { fromChain: 'near', toChain: '1', toChainKey: 'ethereum', bridge: '1click' } }, 'mainnet')).toBe(false);
    expect(isLocalTx({ ...tx, cross: { fromChain: '1', toChain: 'kaspa', toChainKey: 'kaspa', bridge: 'exolix', orderId: 'abcd1234' } }, 'mainnet')).toBe(true);
    expect(isLocalTx({ ...tx, cross: { fromChain: '42161', toChain: 'solana', toChainKey: 'solana', bridge: 'near', status: '<script>' } }, 'mainnet')).toBe(false);
  });
});

// Real deposit addresses 1Click handed out on 01/11/2026 (packages/swap/test/fixtures/cross/1click-direct.json).
const DEPOSIT: Record<string, string> = {
  btc: 'bc1qfm26lzq7yaqap99dp689wfn4pkfpd6r2m7n55d',
  ltc: 'LYi5nf6eMQxg2SYKkc6bSZmmbvockxzKQj',
  doge: 'DAkCxcdvPjHfrG9ERYd2rYgj9svVEu86Kz',
  trx: 'TLem3Uzs6JPcPfs3onBa8Bz3ShddzzVEYi',
  'trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t': 'TWcAt1DJEavVJieCoeNNPWWsJHSh6qx4CK',
  xrp: 'rN7zSHBPiuaGmTe79Gb7Dv6JkJyQNkKHS6',
  ada: 'addr1vxvpl2gfjp3y78dac4dpkf9pmn7v38lnj6qmz2hwe3en5gcqcawcf',
  'eth:42161': '0x22259b2F4e5fe827d3bB8d528f8d3C771A219523',
  bch: 'bitcoincash:qz7xm6aahynmu0ud5y255jlxe22cdjgxpv9ra4uqyf',
  dash: 'Xwe1utk12ydvkRAw9TVfNdijg6xLrDaabW',
  zec: 't1djDRoNmb8ea5eNFeP5QmuNm2pGCpyxbf2',
  ton: 'UQD-x0XHFHtf6KcZGG7ZWrqF1oZ5NGE-guyHR4yjKL1Ivz_P',
  sui: '0x9b485b25b3800b2d9685a19661572247c3b2583dd14db14cc9ab7e1625fada2a',
  apt: '0x27fad4cd8ce74d1c39faab4f2d36a4513b38dcdf049899b53a09357bb2170b2f',
  'eth:100': '0xd474520085f54B0F7DD7743BB36Fa112b2AE7b0a',
};
const AMOUNT: Record<string, bigint> = {
  btc: 100_000n,
  ltc: 50_000_000n,
  doge: 100_000_000_000n,
  trx: 10_000_000n,
  'trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t': 5_000_000n,
  xrp: 20_000_000n,
  ada: 5_000_000n,
  'eth:42161': 10n ** 15n,
  bch: 1_000_000n,
  dash: 10_000_000n,
  zec: 1_000_000n,
  ton: 1_000_000_000n,
  sui: 1_000_000_000n,
  apt: 10_000_000n,
  'eth:100': 10n ** 16n,
};
const plan = (id: string) => ({ depositAddress: DEPOSIT[id] ?? '', amountIn: AMOUNT[id] ?? 0n, amountOut: 1n, minAmountOut: 1n, deadline: Date.now() + 3 * 3_600_000, kyroFeeBps: 70, oneClickFeeBps: 70, timeEstimateSecs: 60 });
type Of<F extends AnyUnsigned['family']> = Extract<AnyUnsigned, { family: F }>;

describe('NEAR Intents deposit: the ordinary transfer Kyro builds (demo adapters, mainnet)', () => {
  async function setup() {
    const mock = createMockBackend({ network: 'mainnet', torEnabled: false, preset: { password: 'correct horse', unlocked: true } });
    setBackend(mock.invoke);
    return createAdapters(await call('accounts_get'));
  }
  const asset = (id: string) => {
    const a = assetsFor('mainnet').find((x) => x.id === id);
    if (!a) throw new Error(id);
    return a;
  };

  it('BTC, LTC, DOGE, BCH, DASH, ZEC, TRX, USDT TRC-20, XRP, ADA, SUI, TON, APT, ETH (Arbitrum) and xDAI: exactly the confirmed amount to the real 1Click deposit address, nothing else', async () => {
    const ad = await setup();
    for (const id of Object.keys(DEPOSIT)) {
      const sell = asset(id);
      const p = plan(id);
      const d = await buildDepositTx(sell, ad, p);
      expect(d.unsigned.recipient.toLowerCase(), id).toBe(p.depositAddress.toLowerCase());
      expect(d.unsigned.amount, id).toBe(p.amountIn);
      if (sell.family === 'evm') expect(d.decoded.evm?.kind).toBe('NativeTransfer');
    }
  }, 60_000);

  it('refuses another address, another amount, an OP_RETURN, a tag, a memo, or a deposit address of another chain', async () => {
    const ad = await setup();
    const build = async (id: string) => (await buildDepositTx(asset(id), ad, plan(id))).unsigned;
    const btcTx = (await build('btc')) as Of<'btc'>;
    expect(depositTxProblem(btcTx, asset('btc'), { ...plan('btc'), amountIn: 100_001n })).toMatch(/montant/);
    expect(depositTxProblem(btcTx, asset('btc'), { ...plan('btc'), depositAddress: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' })).toMatch(/destinataire/);
    const withOpReturn: Of<'btc'> = { ...btcTx, summary: { ...btcTx.summary, outputs: [...btcTx.summary.outputs, ['op_return:6b79726f', 0, false]] } };
    expect(depositTxProblem(withOpReturn, asset('btc'), plan('btc'))).toMatch(/OP_RETURN/);
    const xrpTx = (await build('xrp')) as Of<'xrp'>;
    expect(depositTxProblem({ ...xrpTx, summary: { ...xrpTx.summary, destinationTag: 12345 } }, asset('xrp'), plan('xrp'))).toMatch(/tag/);
    const trxTx = (await build('trx')) as Of<'tron'>;
    expect(depositTxProblem({ ...trxTx, summary: { ...trxTx.summary, memo: 'x' } }, asset('trx'), plan('trx'))).toMatch(/mémo/);
    const adaTx = (await build('ada')) as Of<'ada'>;
    expect(depositTxProblem({ ...adaTx, memo: 'x' }, asset('ada'), plan('ada'))).toMatch(/message/);
    const zecTx = (await build('zec')) as Of<'zec'>;
    expect(depositTxProblem(zecTx, asset('zec'), { ...plan('zec'), amountIn: 1_000_001n })).toMatch(/montant/);
    expect(depositTxProblem({ ...zecTx, summary: { ...zecTx.summary, toKind: 'tex' } }, asset('zec'), plan('zec'))).toBeTruthy();
    const suiTx = (await build('sui')) as Of<'sui'>;
    expect(depositTxProblem({ ...suiTx, all: true }, asset('sui'), plan('sui'))).toBeTruthy();
    expect(depositTxProblem({ ...suiTx, summary: { ...suiTx.summary, recipient: '0x' + '1'.repeat(64) } }, asset('sui'), plan('sui'))).toBeTruthy();
    const aptTx = (await build('apt')) as Of<'apt'>;
    expect(depositTxProblem({ ...aptTx, summary: { ...aptTx.summary, function: '0x1::coin::transfer' } }, asset('apt'), plan('apt'))).toBeTruthy();
    const tonTx = (await build('ton')) as Of<'ton'>;
    expect(depositTxProblem({ ...tonTx, summary: { ...tonTx.summary, comment: 'x' } }, asset('ton'), plan('ton'))).toMatch(/mémo/);
    expect(depositTxProblem({ ...tonTx, sendAll: true }, asset('ton'), plan('ton'))).toBeTruthy();
    const bchTx = (await build('bch')) as Of<'btc'>;
    expect(depositTxProblem({ ...bchTx, summary: { ...bchTx.summary, outputs: [...bchTx.summary.outputs, ['op_return:6b79726f', 0, false]] } }, asset('bch'), plan('bch'))).toMatch(/OP_RETURN/);
    await expect(buildDepositTx(asset('xlm'), ad, { ...plan('btc'), depositAddress: 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6' })).rejects.toThrow();
    await expect(buildDepositTx(asset('ltc'), ad, { ...plan('ltc'), depositAddress: DEPOSIT.doge ?? '' })).rejects.toThrow(/adresse de dépôt invalide/);
  }, 60_000);
});

describe('unified « You send » picker (no network dropdown)', () => {
  const chains = allChains('mainnet');
  const assets = assetsFor('mainnet');
  const eth = assets.find((a) => a.chainKey === 'ethereum' && a.kind === 'native')!;
  const btc = assets.find((a) => a.chainKey === 'bitcoin' && a.kind === 'native')!;
  const sol = assets.find((a) => a.chainKey === 'solana' && a.kind === 'native')!;
  const held = new Map([[btc.id, 50_000_000n], [sol.id, 2_000_000_000n]]);
  const list = sendChoices('mainnet', chains, assets, (id) => held.get(id) ?? 0n);

  it('lists assets across every network with balances, held first', () => {
    expect(new Set(list.map((c) => c.chain.key)).size).toBeGreaterThan(3);
    expect(list.slice(0, 2).map((c) => c.asset.id).sort()).toEqual([btc.id, sol.id].sort());
    expect(list.find((c) => c.asset.id === btc.id)?.balance).toBe(50_000_000n);
    expect(list.find((c) => c.asset.id === eth.id)?.balance).toBe(0n);
    const firstSoon = list.findIndex((c) => c.comingSoon);
    if (firstSoon >= 0) expect(list.slice(firstSoon).every((c) => c.comingSoon)).toBe(true);
  });

  it('a pick sets chain and asset implicitly, and routes « You receive » from that chain', () => {
    const pick = pickSend(list, btc.id)!;
    expect(pick.chain.key).toBe('bitcoin');
    expect(pick.asset.id).toBe(btc.id);
    const groups = buyGroups('mainnet', chains, assets, pick.asset);
    expect(groups[0]?.chain.key).not.toBe('bitcoin'); // BTC has no same-chain swap: first group is another chain
    expect(groups.some((g) => g.chain.key === 'ethereum' && g.assets.some((a) => a.id === eth.id))).toBe(true);
    expect(groups.flatMap((g) => g.assets).some((a) => a.id === btc.id)).toBe(false);
    const fromEth = buyGroups('mainnet', chains, assets, pickSend(list, eth.id)!.asset);
    expect(fromEth[0]?.chain.key).toBe('ethereum'); // same-chain first
    expect(pickSend(list, 'nope')).toBeNull();
    const soon = list.find((c) => c.comingSoon);
    if (soon) expect(pickSend(list, soon.asset.id)).toBeNull();
  });

  it('testnet: picks stay same-chain only', () => {
    const tChains = allChains('testnet');
    const tAssets = assetsFor('testnet');
    const tList = sendChoices('testnet', tChains, tAssets, () => 0n);
    const pick = pickSend(tList, tList[0]!.asset.id)!;
    expect(buyGroups('testnet', tChains, tAssets, pick.asset).every((g) => g.chain.key === pick.chain.key)).toBe(true);
  });

  it('computes the rate shown under the amounts', () => {
    expect(swapRate(100_000_000n, 8, 31_200_000_000_000_000_000n, 18)).toBeCloseTo(31.2);
    expect(swapRate(0n, 8, 1n, 18)).toBeNull();
  });
});
