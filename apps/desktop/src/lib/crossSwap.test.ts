import { describe, expect, it } from 'vitest';
import { call, setBackend } from '@kyro/shared';
import { createMockBackend } from '@kyro/shared/mock';
import { allChains, assetsFor, createAdapters, findChain, type AnyUnsigned } from '@kyro/chains';
import { buildDepositTx, buyGroups, canSwapFrom, canSwapTo, crossStatusLabel, depositTxProblem, ownAddressOn, swapChainOf, swapTokenAddress } from './crossSwap';
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

  it('« Tu reçois » groups: the sell chain first, then the others, without the sold asset', () => {
    const sell = assets.find((a) => a.id === 'eth:1');
    const groups = buyGroups('mainnet', chains, assets, sell);
    expect(groups[0]?.chain.key).toBe('ethereum');
    expect(groups.map((g) => g.chain.key)).toEqual(expect.arrayContaining(['solana', 'bitcoin', 'arbitrum']));
    expect(['tron', 'xrp', 'ada', 'ltc', 'doge'].every((f) => groups.some((g) => g.chain.family === f))).toBe(true);
    // Cardano: ADA only (native tokens are not offered by 1Click).
    expect(groups.find((g) => g.chain.family === 'ada')?.assets.every((a) => a.kind === 'native')).toBe(true);
    expect(groups.flatMap((g) => g.assets).some((a) => a.id === 'eth:1')).toBe(false);
    // Testnet: same chain only.
    const sepEth = assetsFor('testnet').find((a) => a.chainKey === 'sepolia' && a.kind === 'native');
    expect(buyGroups('testnet', allChains('testnet'), assetsFor('testnet'), sepEth).map((g) => g.chain.key)).toEqual(['sepolia']);
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
};
const AMOUNT: Record<string, bigint> = { btc: 100_000n, ltc: 50_000_000n, doge: 100_000_000_000n, trx: 10_000_000n, 'trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t': 5_000_000n, xrp: 20_000_000n, ada: 5_000_000n, 'eth:42161': 10n ** 15n };
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

  it('BTC, LTC, DOGE, TRX, USDT TRC-20, XRP, ADA and ETH (Arbitrum): exactly the confirmed amount to the real 1Click deposit address, nothing else', async () => {
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
    // A deposit address of another chain is refused before anything is built.
    await expect(buildDepositTx(asset('ltc'), ad, { ...plan('ltc'), depositAddress: DEPOSIT.doge ?? '' })).rejects.toThrow(/adresse de dépôt invalide/);
  }, 60_000);
});
