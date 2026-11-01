// SPDX-License-Identifier: GPL-3.0-or-later
//
// DEMO ONLY — staking (docs/IPC.md §2.8): Solana (native Stake program), Cardano (pool + vote
// delegation) and TRON (Stake 2.0 + SR votes), mirroring the Rust rules, refusals and
// reinforced-dialog triggers. Messages, CBOR and raw_data are demo encodings (hex / base64 JSON,
// NOT the real wire formats); signatures are fake. Balances are taken from the demo chains.
//
// Reinforced confirmation (2nd native dialog):
// - Solana: validator commission > 10 % or delinquent;
// - Cardano: pool retiring, margin > 10 %, saturation > 100 %, or an inactive DRep;
// - TRON: an SR outside the first 127 (no reward), an SR keeping 100 %, or an unfreeze that cuts votes.

import { sha256 } from '@noble/hashes/sha2';
import { base58, base64 } from '@scure/base';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
  IpcError,
  type AdaPool,
  type AdaStakeAccount,
  type AdaStakeContext,
  type AdaStakeRequest,
  type AdaStakeWarning,
  type CardanoAccount,
  type CardanoCertView,
  type CardanoDrepView,
  type CardanoStakeSummary,
  type Commands,
  type Network,
  type SolEpoch,
  type SolInstruction,
  type SolStakePosition,
  type SolStakePreview,
  type SolStakeRequest,
  type SolStakeWarning,
  type SolTxSummary,
  type SolValidator,
  type TronEstimate,
  type TronResource,
  type TronStakeAccount,
  type TronStakeContext,
  type TronStakeRequest,
  type TronStakeSummary,
  type TronStakeWarning,
  type TronWitness,
} from './ipc';
import { l10n } from './i18n';

const invalid = (m: string) => new IpcError('INVALID_INPUT', l10n(`Entrée invalide : ${m}`, `Invalid input: ${m}`));
const units = (v: bigint | string, dec: number) => {
  const b = BigInt(v);
  const p = 10n ** BigInt(dec);
  const neg = b < 0n;
  const a = neg ? -b : b;
  const frac = (a % p).toString().padStart(dec, '0').replace(/0+$/, '');
  return `${neg ? '−' : ''}${a / p}${frac ? `,${frac}` : ''}`;
};
const h = (label: string) => bytesToHex(sha256(new TextEncoder().encode(label)));
const b58 = (label: string) => base58.encode(sha256(new TextEncoder().encode(label)));
const encode = (o: unknown) => bytesToHex(new TextEncoder().encode(JSON.stringify(o)));
const decode = <T>(hexStr: unknown): T => {
  try {
    return JSON.parse(new TextDecoder().decode(hexToBytes(String(hexStr ?? '').trim()))) as T;
  } catch {
    throw invalid(l10n('transaction de staking illisible', 'unreadable staking transaction'));
  }
};

export interface DemoStakeDeps {
  network: Network;
  now: () => number;
  requireUnlocked: () => void;
  checkPassword: (password: unknown) => void;
  confirm: (text: string) => boolean;
  sol: { address: string; lamports: () => bigint; setLamports: (v: bigint) => void };
  ada: { address: string; account: () => CardanoAccount; spend: (lovelace: bigint) => void };
  tron: { address: string; trx: () => bigint; setTrx: (v: bigint) => void };
}

export function createDemoStake(d: DemoStakeDeps) {
  const t0 = d.now();
  const testnet = d.network === 'testnet';
  const confirmTwice = (first: string, reinforced: boolean, extra: string) => {
    if (!d.confirm(first)) throw new IpcError('USER_REJECTED', l10n('Signature refusée.', 'Signature refused.'));
    if (reinforced && !d.confirm(l10n(`Attention : opération à vérifier\n${extra}\nNe signe que si tu sais exactement pourquoi. Signer quand même ?`, `Warning: operation to check\n${extra}\nOnly sign if you know exactly why. Sign anyway?`))) throw new IpcError('USER_REJECTED', l10n('Signature refusée.', 'Signature refused.'));
  };

  // ============================================================== Solana
  const SLOTS = 432_000;
  const SOL_RENT = 2_282_880n;
  const SOL_MIN = testnet ? 1_000_000_000n : 1n;
  const SOL_FEE = 5_000n;
  const solBase = { epoch: testnet ? 812 : 702, slot: 241_000 };
  /** Tests can move the clock by whole epochs. */
  let solEpochShift = 0;
  const solEpoch = (): SolEpoch => {
    const elapsed = Math.floor((d.now() - t0) / 400);
    const abs = solBase.slot + elapsed;
    const epoch = solBase.epoch + solEpochShift + Math.floor(abs / SLOTS);
    const slotIndex = abs % SLOTS;
    return { epoch, slotIndex, slotsInEpoch: SLOTS, absoluteSlot: epoch * SLOTS + slotIndex, secondsLeft: Math.round(((SLOTS - slotIndex) * 400) / 1000) };
  };
  const V = (label: string, name: string | null, commission: number, stake: bigint, delinquent = false): SolValidator => ({
    voteAccount: b58(`vote:${label}`),
    identity: b58(`id:${label}`),
    name,
    commission,
    activatedStake: stake.toString(),
    delinquent,
    lastVote: 0,
    epochVoteAccount: !delinquent,
  });
  const validators: SolValidator[] = [
    V('a', 'Atelier Devnet', 5, 18_400_000_000_000_000n),
    V('b', 'Grand Stake', 7, 12_900_000_000_000_000n),
    V('c', 'Validateur Zéro', 0, 6_300_000_000_000_000n),
    V('d', 'Nœud Communautaire', 10, 4_100_000_000_000_000n),
    V('e', 'Gros Appétit', 25, 2_600_000_000_000_000n),
    V('f', null, 8, 1_200_000_000_000_000n),
    V('g', 'Validateur Endormi', 6, 900_000_000_000_000n, true),
  ];
  interface SolAcc {
    address: string;
    seed: string;
    lamports: bigint;
    vote: string | null;
    delegated: bigint;
    activationEpoch: number | null;
    deactivationEpoch: number | null;
  }
  const solAccounts: SolAcc[] = [
    { address: b58(`stake:${d.sol.address}:kyro-stake-0`), seed: 'kyro-stake-0', lamports: 2_500_000_000n + SOL_RENT + 37_412_552n, vote: validators[0]!.voteAccount, delegated: 2_500_000_000n, activationEpoch: solBase.epoch - 9, deactivationEpoch: null },
  ];
  let solSeed = 1;
  const solState = (a: SolAcc): SolStakePosition => {
    const e = solEpoch().epoch;
    let state: SolStakePosition['state'] = 'initialized';
    if (a.vote !== null && a.activationEpoch !== null) {
      if (a.deactivationEpoch !== null) state = a.deactivationEpoch === a.activationEpoch || e > a.deactivationEpoch ? 'inactive' : 'deactivating';
      else state = e > a.activationEpoch ? 'active' : 'activating';
    }
    const del = a.delegated;
    const effective = state === 'active' || state === 'deactivating' ? del : 0n;
    const locked = state === 'active' || state === 'activating' || state === 'deactivating';
    const free = a.lamports - SOL_RENT - (locked ? del : 0n);
    return {
      address: a.address,
      lamports: a.lamports.toString(),
      state,
      rentExemptReserve: SOL_RENT.toString(),
      staker: d.sol.address,
      withdrawer: d.sol.address,
      ours: true,
      lockupInForce: false,
      voteAccount: a.vote,
      delegated: a.vote ? del.toString() : null,
      activationEpoch: a.activationEpoch,
      deactivationEpoch: a.deactivationEpoch,
      effective: effective.toString(),
      activating: state === 'activating' ? del.toString() : '0',
      deactivating: state === 'deactivating' ? del.toString() : '0',
      withdrawable: (free > 0n ? free : 0n).toString(),
      canClose: !locked,
    };
  };
  const solWarnings = (v: SolValidator | null): SolStakeWarning[] => {
    const w: SolStakeWarning[] = [];
    if (v?.delinquent) w.push({ kind: 'delinquent' });
    if (v && v.commission > 10) w.push({ kind: 'highCommission', commission: v.commission });
    return w;
  };
  const solBuild = (action: SolStakeRequest) => {
    const me = d.sol.address;
    const balance = d.sol.lamports();
    const ep = solEpoch();
    const findV = (vote: string) => {
      const v = validators.find((x) => x.voteAccount === vote);
      if (!v) throw invalid(l10n('compte de vote inconnu de getVoteAccounts', 'vote account unknown to getVoteAccounts'));
      return v;
    };
    const findA = (addr: string) => {
      const a = solAccounts.find((x) => x.address === addr);
      if (!a) throw invalid(l10n('compte de staking introuvable (ou pas entièrement à toi)', 'stake account not found (or not entirely yours)'));
      return a;
    };
    const ixs: SolInstruction[] = [];
    let preview: SolStakePreview;
    const base = { rentExemptReserve: SOL_RENT.toString(), balance: balance.toString(), fee: SOL_FEE.toString(), epoch: ep };
    if (action.kind === 'createAndDelegate') {
      const lamports = BigInt(action.lamports || '0');
      if (lamports < SOL_MIN) throw invalid(l10n(`montant sous le minimum de délégation (${units(SOL_MIN, 9)} SOL)`, `amount below the delegation minimum (${units(SOL_MIN, 9)} SOL)`));
      if (balance < lamports + SOL_RENT + SOL_FEE) throw invalid(l10n(`solde insuffisant : il faut ${units(lamports + SOL_RENT + SOL_FEE, 9)} SOL (montant + réserve de rent + frais)`, `insufficient balance: ${units(lamports + SOL_RENT + SOL_FEE, 9)} SOL needed (amount + rent reserve + fees)`));
      const v = findV(action.voteAccount);
      const seed = `kyro-stake-${solSeed}`;
      const addr = b58(`stake:${me}:${seed}`);
      ixs.push({ type: 'systemCreateAccountWithSeed', from: me, newAccount: addr, base: me, seed, lamports: (lamports + SOL_RENT).toString(), space: '200', owner: 'Stake11111111111111111111111111111111111111' });
      ixs.push({ type: 'stakeInitialize', stakeAccount: addr, staker: me, withdrawer: me });
      ixs.push({ type: 'stakeDelegate', stakeAccount: addr, voteAccount: v.voteAccount, authority: me });
      const w = solWarnings(v);
      preview = { ...base, kind: 'createAndDelegate', stakeAccount: addr, seed, lamports: (lamports + SOL_RENT).toString(), delegated: lamports.toString(), validator: v, account: null, closesAccount: false, warnings: w, requiresExtraConfirmation: w.length > 0 };
    } else if (action.kind === 'delegate') {
      const a = findA(action.stakeAccount);
      const st = solState(a);
      if (st.state !== 'initialized' && st.state !== 'inactive') throw invalid(l10n('ce compte de staking n’est pas inactif : désactive-le d’abord', 'this stake account is not inactive: deactivate it first'));
      if (balance < SOL_FEE) throw invalid(l10n('solde insuffisant pour les frais', 'insufficient balance for the fees'));
      const v = findV(action.voteAccount);
      ixs.push({ type: 'stakeDelegate', stakeAccount: a.address, voteAccount: v.voteAccount, authority: me });
      const w = solWarnings(v);
      preview = { ...base, kind: 'delegate', stakeAccount: a.address, seed: a.seed, lamports: null, delegated: (a.lamports - SOL_RENT).toString(), validator: v, account: st, closesAccount: false, warnings: w, requiresExtraConfirmation: w.length > 0 };
    } else if (action.kind === 'deactivate') {
      const a = findA(action.stakeAccount);
      const st = solState(a);
      if (st.state !== 'active' && st.state !== 'activating') throw invalid(l10n('ce compte n’est pas délégué', 'this account is not delegated'));
      ixs.push({ type: 'stakeDeactivate', stakeAccount: a.address, authority: me });
      const v = validators.find((x) => x.voteAccount === a.vote) ?? null;
      preview = { ...base, kind: 'deactivate', stakeAccount: a.address, seed: a.seed, lamports: null, delegated: a.delegated.toString(), validator: v, account: st, closesAccount: false, warnings: [], requiresExtraConfirmation: false };
    } else {
      const a = findA(action.stakeAccount);
      const st = solState(a);
      const max = st.canClose ? a.lamports : BigInt(st.withdrawable);
      const want = action.lamports !== undefined ? BigInt(action.lamports) : max;
      if (want <= 0n) throw invalid(l10n('rien à retirer', 'nothing to withdraw'));
      if (want > max) throw invalid(st.canClose ? l10n('retrait au-delà du solde du compte', 'withdrawal beyond the account balance') : l10n(`retrait au-delà du montant retirable (${units(max, 9)} SOL) : désactive d’abord le stake`, `withdrawal beyond the withdrawable amount (${units(max, 9)} SOL): deactivate the stake first`));
      if (!st.canClose && want === a.lamports) throw invalid(l10n('tout retirer alors que du stake reste actif : désactive-le d’abord', 'withdrawing everything while stake is still active: deactivate it first'));
      ixs.push({ type: 'stakeWithdraw', stakeAccount: a.address, to: me, lamports: want.toString(), authority: me });
      preview = { ...base, kind: 'withdraw', stakeAccount: a.address, seed: a.seed, lamports: want.toString(), delegated: null, validator: null, account: st, closesAccount: want === a.lamports, warnings: [], requiresExtraConfirmation: false };
    }
    const summary: SolTxSummary = { version: 'legacy', feePayer: me, signers: [me], ourSignerIndex: 0, recentBlockhash: b58(`bh:${ep.absoluteSlot}`), instructions: ixs, lookupTables: [], baseFeeLamports: SOL_FEE.toString(), computeUnitLimit: null, computeUnitPriceMicroLamports: null, priorityFeeLamports: null, warnings: [], requiresExtraConfirmation: false };
    const message = base64.encode(new TextEncoder().encode(JSON.stringify({ action, seed: preview.seed, stake: preview.stakeAccount, slot: ep.absoluteSlot })));
    return { message, summary, stake: preview };
  };
  const solFromMessage = (m: unknown): SolStakeRequest => {
    try {
      const o = JSON.parse(new TextDecoder().decode(base64.decode(String(m ?? '')))) as { action: SolStakeRequest };
      if (!o.action || !['createAndDelegate', 'delegate', 'deactivate', 'withdraw'].includes(o.action.kind)) throw new Error('kind');
      return o.action;
    } catch {
      throw invalid(l10n('ce message n’est pas une opération de staking Kyro', 'this message is not a Kyro staking operation'));
    }
  };
  const solDescribe = (p: SolStakePreview) => {
    const op = { createAndDelegate: l10n('Créer un compte de staking et déléguer', 'Create a stake account and delegate'), delegate: l10n('Déléguer', 'Delegate'), deactivate: l10n('Désactiver (début du refroidissement)', 'Deactivate (start of the cooldown)'), withdraw: l10n('Retirer', 'Withdraw') }[p.kind];
    let out = l10n(`Staking Solana${testnet ? ' (devnet)' : ''} : ${op}\nCompte de staking : ${p.stakeAccount}\n`, `Solana staking${testnet ? ' (devnet)' : ''}: ${op}\nStake account: ${p.stakeAccount}\n`);
    if (p.delegated) out += l10n(`Délégué : ${units(p.delegated, 9)} SOL${p.kind === 'createAndDelegate' ? ` + réserve de rent ${units(p.rentExemptReserve, 9)} SOL` : ''}\n`, `Delegated: ${units(p.delegated, 9)} SOL${p.kind === 'createAndDelegate' ? ` + rent reserve ${units(p.rentExemptReserve, 9)} SOL` : ''}\n`);
    if (p.kind === 'withdraw' && p.lamports) out += l10n(`Retiré vers ton adresse : ${units(p.lamports, 9)} SOL${p.closesAccount ? ' (ferme le compte)' : ''}\n`, `Withdrawn to your address: ${units(p.lamports, 9)} SOL${p.closesAccount ? ' (closes the account)' : ''}\n`);
    if (p.validator) out += l10n(`Validateur : ${p.validator.name ?? '(sans nom)'} (nom déclaré, non vérifié) · commission ${p.validator.commission} %${p.validator.delinquent ? ' · EN RETARD' : ''}\n  vote ${p.validator.voteAccount}\n`, `Validator: ${p.validator.name ?? '(no name)'} (declared name, not verified) · commission ${p.validator.commission}%${p.validator.delinquent ? ' · DELINQUENT' : ''}\n  vote ${p.validator.voteAccount}\n`);
    out += l10n(`Époque ${p.epoch.epoch}, ≈ ${Math.round(p.epoch.secondsLeft / 3600)} h restantes. ${p.kind === 'deactivate' ? 'Refroidissement jusqu’à la fin de l’époque (pas de récompense pendant ce temps).' : p.kind === 'withdraw' ? '' : 'Activation au début de l’époque suivante.'}\nFrais : ${units(p.fee, 9)} SOL · pas de slashing sur Solana`, `Epoch ${p.epoch.epoch}, ≈ ${Math.round(p.epoch.secondsLeft / 3600)} h left. ${p.kind === 'deactivate' ? 'Cooldown until the end of the epoch (no rewards meanwhile).' : p.kind === 'withdraw' ? '' : 'Activation at the start of the next epoch.'}\nFees: ${units(p.fee, 9)} SOL · no slashing on Solana`);
    return out;
  };
  const solHandlers: Record<Extract<keyof Commands, `sol_stake_${string}`>, (a: Record<string, unknown>) => unknown> = {
    sol_stake_overview: () => ({ address: d.sol.address, balance: d.sol.lamports().toString(), epoch: solEpoch(), minimumDelegation: SOL_MIN.toString(), rentExemptReserve: SOL_RENT.toString(), accounts: solAccounts.map(solState) }),
    sol_stake_validators: (a) => ({ validators: validators.map((v) => (a.withNames === false ? { ...v, name: null } : v)), namesAvailable: a.withNames !== false }),
    sol_stake_build: (a) => {
      d.requireUnlocked();
      return solBuild(a.action as SolStakeRequest);
    },
    sol_stake_sign: (a) => {
      d.requireUnlocked();
      const built = solBuild(solFromMessage(a.message));
      d.checkPassword(a.password);
      const w = built.stake.warnings.map((x) => (x.kind === 'delinquent' ? l10n('• validateur EN RETARD : il ne vote plus, pas de récompense', '• DELINQUENT validator: it no longer votes, no rewards') : l10n(`• commission élevée : ${x.commission} % des récompenses gardées par le validateur`, `• high commission: ${x.commission}% of the rewards kept by the validator`))).join('\n');
      confirmTwice(l10n(`Confirmer le staking Solana\n${solDescribe(built.stake)}`, `Confirm the Solana staking\n${solDescribe(built.stake)}`), built.stake.requiresExtraConfirmation, w);
      const sig = new Uint8Array([...sha256(new TextEncoder().encode(`sig-r:${String(a.message)}`)), ...sha256(new TextEncoder().encode(`sig-s:${String(a.message)}`))]);
      return { signature: base64.encode(sig), summary: built.summary, stake: built.stake };
    },
    sol_stake_broadcast: (a) => {
      const action = solFromMessage(a.message);
      let sig: Uint8Array;
      try {
        sig = base64.decode(String(a.signature ?? ''));
      } catch {
        throw invalid(l10n('signature : base64 attendu', 'signature: base64 expected'));
      }
      if (sig.length !== 64) throw invalid(l10n('signature : 64 octets attendus', 'signature: 64 bytes expected'));
      const built = solBuild(action);
      const ep = solEpoch().epoch;
      const p = built.stake;
      if (action.kind === 'createAndDelegate') {
        d.sol.setLamports(d.sol.lamports() - BigInt(p.lamports ?? '0') - SOL_FEE);
        solAccounts.push({ address: p.stakeAccount, seed: p.seed ?? '', lamports: BigInt(p.lamports ?? '0'), vote: action.voteAccount, delegated: BigInt(p.delegated ?? '0'), activationEpoch: ep, deactivationEpoch: null });
        solSeed += 1;
      } else {
        d.sol.setLamports(d.sol.lamports() - SOL_FEE);
        const acc = solAccounts.find((x) => x.address === p.stakeAccount)!;
        if (action.kind === 'delegate') Object.assign(acc, { vote: action.voteAccount, delegated: acc.lamports - SOL_RENT, activationEpoch: ep, deactivationEpoch: null });
        else if (action.kind === 'deactivate') acc.deactivationEpoch = ep;
        else {
          const out = BigInt(p.lamports ?? '0');
          d.sol.setLamports(d.sol.lamports() + out);
          acc.lamports -= out;
          if (acc.lamports === 0n) solAccounts.splice(solAccounts.indexOf(acc), 1);
        }
      }
      // The id of a Solana transaction is its (first) signature.
      return base58.encode(sig);
    },
  };

  // ============================================================== Cardano
  const KEY_DEPOSIT = 2_000_000n;
  const ADA_FEE = 183_721n;
  const ADA_EPOCH_LEN = 432_000;
  const adaEpoch = () => {
    const slot = (testnet ? 72_000_000 : 140_000_000) + Math.floor((d.now() - t0) / 1000);
    const slotInEpoch = slot % ADA_EPOCH_LEN;
    return { epoch: (testnet ? 230 : 590) + Math.floor(slot / ADA_EPOCH_LEN) - Math.floor((testnet ? 72_000_000 : 140_000_000) / ADA_EPOCH_LEN), slotInEpoch, epochLength: ADA_EPOCH_LEN, secondsLeft: ADA_EPOCH_LEN - slotInEpoch, slot };
  };
  const P = (label: string, ticker: string, name: string, margin: number, saturation: number, delegators: number, status: AdaPool['status'] = 'registered', retiringEpoch: number | null = null): AdaPool => ({
    poolId: `pool1${base58.encode(sha256(new TextEncoder().encode(`pool:${label}`))).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 51).padEnd(51, 'q')}`,
    poolHash: h(`pool:${label}`).slice(0, 56),
    ticker,
    name,
    homepage: `https://${ticker.toLowerCase()}.example`,
    margin,
    fixedCost: '170000000',
    pledge: '250000000000',
    activeStake: String(Math.round(saturation * 720_000) * 1_000_000),
    liveStake: String(Math.round(saturation * 720_000) * 1_000_000),
    liveSaturation: saturation,
    liveDelegators: delegators,
    status,
    retiringEpoch,
  });
  const pools: AdaPool[] = [
    P('kyro1', 'KYRO', 'Pool Démo Kyro', 0.01, 62.4, 1_204),
    P('fair', 'FAIR', 'Pool Équitable', 0.02, 48.1, 880),
    P('big', 'GROS', 'Pool Saturé', 0.015, 104.7, 9_102),
    P('greedy', 'MRG', 'Marge Gourmande', 0.15, 31.0, 210),
    P('bye', 'BYE', 'Pool en Retraite', 0.01, 22.5, 95, 'retiring', (testnet ? 230 : 590) + 2),
    P('small', 'PETIT', 'Petit Pool', 0.005, 3.2, 41),
  ];
  const DREPS = { active: 'drep1ytdemoactive0q8v9z5kq3f0xw6wf0r4k7m2c8n5p6s7t8u9v0w', inactive: 'drep1ytdemoinactive8v9z5kq3f0xw6wf0r4k7m2c8n5p6s7t8u9' };
  const ada = { registered: true, pool: pools[1]!.poolId as string | null, drep: null as string | null, rewards: 12_345_678n };
  const adaStakeAddress = `stake${testnet ? '_test' : ''}1u${h(`stake:${d.ada.address}`).slice(0, 52)}`;
  const adaAccount = (): AdaStakeAccount => ({ stakeAddress: adaStakeAddress, registered: ada.registered, delegatedPool: ada.registered ? ada.pool : null, delegatedDrep: ada.registered ? ada.drep : null, rewardsAvailable: ada.registered ? ada.rewards.toString() : '0', deposit: ada.registered ? KEY_DEPOSIT.toString() : '0', totalBalance: (BigInt(d.ada.account().balance) + (ada.registered ? ada.rewards : 0n)).toString() });
  const findPool = (id: string) => pools.find((p) => p.poolId === id || p.poolHash === id) ?? null;
  const drepView = (choice: string): { drep: CardanoDrepView; registered: boolean; active: boolean } => {
    if (choice === 'alwaysAbstain') return { drep: { kind: 'alwaysAbstain' }, registered: true, active: true };
    if (choice === 'alwaysNoConfidence') return { drep: { kind: 'alwaysNoConfidence' }, registered: true, active: true };
    if (choice === DREPS.active || choice === DREPS.inactive) return { drep: { kind: 'key', id: choice, hash: h(choice).slice(0, 56) }, registered: true, active: choice === DREPS.active };
    if (/^drep(_script)?1[0-9a-z]{20,}$/.test(choice)) throw invalid(l10n('DRep non enregistré', 'DRep not registered'));
    throw invalid(l10n('DRep invalide : « alwaysAbstain », « alwaysNoConfidence » ou un identifiant drep1…', 'Invalid DRep: “alwaysAbstain”, “alwaysNoConfidence” or a drep1… identifier'));
  };
  const adaBuild = (action: AdaStakeRequest) => {
    const before = adaAccount();
    const certs: CardanoCertView[] = [];
    const withdrawals: { rewardAddress: string; lovelace: string }[] = [];
    let deposit = 0n;
    let refund = 0n;
    let withdrawn = 0n;
    let pool: AdaPool | null = null;
    let drep: { drep: CardanoDrepView; registered: boolean; active: boolean } | null = null;
    const register = () => {
      if (!ada.registered) {
        certs.push({ type: 'stakeRegistration', deposit: KEY_DEPOSIT.toString() });
        deposit = KEY_DEPOSIT;
      }
    };
    if (action.kind === 'delegate') {
      pool = findPool(action.poolId);
      if (!pool) throw invalid(l10n('pool inconnu', 'unknown pool'));
      if (pool.status === 'retired') throw invalid(l10n('pool retiré', 'retired pool'));
      register();
      certs.push({ type: 'stakeDelegation', poolId: pool.poolId, poolHash: pool.poolHash });
      if (action.drep) {
        drep = drepView(action.drep);
        certs.push({ type: 'voteDelegation', drep: drep.drep });
      }
    } else if (action.kind === 'voteDelegate') {
      drep = drepView(action.drep);
      register();
      certs.push({ type: 'voteDelegation', drep: drep.drep });
    } else if (action.kind === 'withdraw') {
      if (!ada.registered) throw invalid(l10n('opération sur une clé de staking non enregistrée', 'operation on an unregistered stake key'));
      if (ada.rewards === 0n) throw invalid(l10n('aucune récompense à retirer', 'no rewards to withdraw'));
      if (!ada.drep) throw invalid(l10n('retrait sans délégation de vote : le réseau l’interdit depuis Plomin — délègue d’abord ton vote (par exemple « toujours s’abstenir »)', 'withdrawal without vote delegation: the network forbids it since Plomin — delegate your vote first (for example “always abstain”)'));
      withdrawn = ada.rewards;
      withdrawals.push({ rewardAddress: adaStakeAddress, lovelace: withdrawn.toString() });
    } else {
      if (!ada.registered) throw invalid(l10n('opération sur une clé de staking non enregistrée', 'operation on an unregistered stake key'));
      if (ada.rewards > 0n) {
        if (!ada.drep) throw invalid(l10n('désinscription : les récompenses doivent être retirées, ce qui exige une délégation de vote — délègue d’abord ton vote', 'deregistration: the rewards must be withdrawn, which requires a vote delegation — delegate your vote first'));
        withdrawn = ada.rewards;
        withdrawals.push({ rewardAddress: adaStakeAddress, lovelace: withdrawn.toString() });
      }
      certs.push({ type: 'stakeDeregistration', refund: KEY_DEPOSIT.toString() });
      refund = KEY_DEPOSIT;
    }
    const acc = d.ada.account();
    const netCost = ADA_FEE + deposit - refund - withdrawn;
    if (BigInt(acc.balance) - BigInt(acc.lockedWithTokens) < ADA_FEE + deposit + 1_000_000n) throw invalid(l10n('solde insuffisant pour les frais et le dépôt', 'insufficient balance for the fees and the deposit'));
    const warnings: AdaStakeWarning[] = [];
    if (pool?.status === 'retiring' && pool.retiringEpoch !== null) warnings.push({ kind: 'poolRetiring', epoch: pool.retiringEpoch });
    if (pool && pool.margin > 0.1) warnings.push({ kind: 'highMargin', margin: Math.round(pool.margin * 1000) / 10 });
    if (pool && (pool.liveSaturation ?? 0) > 100) warnings.push({ kind: 'poolSaturated', saturation: pool.liveSaturation ?? 0 });
    if (drep && !drep.active) warnings.push({ kind: 'drepInactive' });
    const ep = adaEpoch();
    const change = (BigInt(acc.balance) - ADA_FEE - deposit + refund + withdrawn).toString();
    const summary: CardanoStakeSummary = {
      tx: { txId: h(`ada-stake:${JSON.stringify(action)}:${ep.slot}`), inputs: [`${h('ada-u1')}#0`], outputs: [{ address: d.ada.address, kind: 'base', isChange: true, lovelace: change, tokens: [], minLovelace: '969750' }], fee: ADA_FEE.toString(), ttl: ep.slot + 3600, validFrom: null, memo: null, warnings: [], requiresExtraConfirmation: false },
      stakeAddress: adaStakeAddress,
      certificates: certs,
      withdrawals,
      deposit: deposit.toString(),
      refund: refund.toString(),
      withdrawn: withdrawn.toString(),
    };
    const context: AdaStakeContext = { account: acc, stake: before, pool, drep, params: { minFeeA: 44, minFeeB: 155_381, coinsPerByte: 4_310, maxTxSize: 16_384 }, keyDeposit: KEY_DEPOSIT.toString(), epoch: ep, netCost: netCost.toString(), warnings, requiresExtraConfirmation: warnings.length > 0 };
    return { tx: encode({ action, slot: ep.slot }), summary, context };
  };
  const adaDescribe = (s: CardanoStakeSummary, c: AdaStakeContext) => {
    let out = `Staking Cardano${testnet ? ' (preprod)' : ''}\n`;
    for (const cert of s.certificates) {
      if (cert.type === 'stakeRegistration') out += l10n(`• Enregistrement de la clé de staking : dépôt ${units(cert.deposit, 6)} ADA (remboursé à la désinscription)\n`, `• Stake key registration: deposit ${units(cert.deposit, 6)} ADA (refunded on deregistration)\n`);
      if (cert.type === 'stakeDeregistration') out += l10n(`• Désinscription : remboursement du dépôt ${units(cert.refund, 6)} ADA\n`, `• Deregistration: deposit refund ${units(cert.refund, 6)} ADA\n`);
      if (cert.type === 'stakeDelegation') out += l10n(`• Délégation au pool ${c.pool?.ticker ?? '?'} (« ${c.pool?.name ?? ''} », déclaré) · marge ${((c.pool?.margin ?? 0) * 100).toFixed(1)} % · coût fixe ${units(c.pool?.fixedCost ?? '0', 6)} ADA · saturation ${c.pool?.liveSaturation ?? '?'} %\n`, `• Delegation to pool ${c.pool?.ticker ?? '?'} (“${c.pool?.name ?? ''}”, declared) · margin ${((c.pool?.margin ?? 0) * 100).toFixed(1)}% · fixed cost ${units(c.pool?.fixedCost ?? '0', 6)} ADA · saturation ${c.pool?.liveSaturation ?? '?'}%\n`);
      if (cert.type === 'voteDelegation') out += l10n(`• Délégation de vote : ${cert.drep.kind === 'alwaysAbstain' ? 'toujours s’abstenir' : cert.drep.kind === 'alwaysNoConfidence' ? 'toujours défiance' : cert.drep.id}\n`, `• Vote delegation: ${cert.drep.kind === 'alwaysAbstain' ? 'always abstain' : cert.drep.kind === 'alwaysNoConfidence' ? 'always no confidence' : cert.drep.id}\n`);
    }
    for (const w of s.withdrawals) out += l10n(`• Retrait des récompenses : ${units(w.lovelace, 6)} ADA\n`, `• Rewards withdrawal: ${units(w.lovelace, 6)} ADA\n`);
    out += l10n(`Frais : ${units(s.tx.fee, 6)} ADA · coût net : ${units(c.netCost, 6)} ADA\nÉpoque ${c.epoch.epoch} : la délégation compte à l’époque ${c.epoch.epoch + 2}, premières récompenses au début de l’époque ${c.epoch.epoch + 4}.\nPas de blocage, pas de slashing : tes ADA restent sur ton adresse.`, `Fees: ${units(s.tx.fee, 6)} ADA · net cost: ${units(c.netCost, 6)} ADA\nEpoch ${c.epoch.epoch}: the delegation counts from epoch ${c.epoch.epoch + 2}, first rewards at the start of epoch ${c.epoch.epoch + 4}.\nNo lock-up, no slashing: your ADA stay on your address.`);
    return out;
  };
  const adaHandlers: Record<Extract<keyof Commands, `ada_stake_${string}`>, (a: Record<string, unknown>) => unknown> = {
    ada_stake_overview: () => {
      const stake = adaAccount();
      return { address: d.ada.address, stake, pool: stake.delegatedPool ? findPool(stake.delegatedPool) : null, keyDeposit: KEY_DEPOSIT.toString(), epoch: adaEpoch(), canWithdraw: ada.registered && ada.rewards > 0n && !!ada.drep };
    },
    ada_stake_pools: (a) => pools.slice(0, Math.min(200, Number(a.limit ?? 50))),
    ada_stake_pool: (a) => {
      const p = findPool(String(a.poolId ?? '').trim());
      if (!p) throw invalid(l10n('pool inconnu', 'unknown pool'));
      return p;
    },
    ada_stake_build: (a) => {
      d.requireUnlocked();
      return adaBuild(a.action as AdaStakeRequest);
    },
    ada_stake_sign: (a) => {
      d.requireUnlocked();
      const { action } = decode<{ action: AdaStakeRequest }>(a.tx);
      const built = adaBuild(action);
      d.checkPassword(a.password);
      const w = built.context.warnings
        .map((x) => (x.kind === 'poolRetiring' ? l10n(`• le pool part à la retraite à l’époque ${x.epoch}`, `• the pool retires at epoch ${x.epoch}`) : x.kind === 'highMargin' ? l10n(`• marge élevée : ${x.margin} %`, `• high margin: ${x.margin}%`) : x.kind === 'poolSaturated' ? l10n(`• pool saturé (${x.saturation} %) : récompenses réduites`, `• saturated pool (${x.saturation}%): reduced rewards`) : l10n('• DRep inactif : ton vote ne compte pas', '• inactive DRep: your vote does not count')))
        .join('\n');
      confirmTwice(l10n(`Confirmer le staking Cardano\n${adaDescribe(built.summary, built.context)}`, `Confirm the Cardano staking\n${adaDescribe(built.summary, built.context)}`), built.context.requiresExtraConfirmation, w);
      return { tx: encode({ action, signed: true, slot: adaEpoch().slot }), txId: built.summary.tx.txId, summary: built.summary, context: built.context };
    },
    ada_stake_broadcast: (a) => {
      const o = decode<{ action: AdaStakeRequest; signed?: boolean }>(a.tx);
      if (!o.signed) throw invalid(l10n('transaction Cardano non signée (témoins manquants)', 'unsigned Cardano transaction (missing witnesses)'));
      const built = adaBuild(o.action);
      d.ada.spend(BigInt(built.context.netCost));
      const act = o.action;
      if (act.kind === 'delegate') {
        ada.registered = true;
        ada.pool = findPool(act.poolId)?.poolId ?? act.poolId;
        if (act.drep) ada.drep = act.drep;
      } else if (act.kind === 'voteDelegate') {
        ada.registered = true;
        ada.drep = act.drep;
      } else if (act.kind === 'withdraw') ada.rewards = 0n;
      else Object.assign(ada, { registered: false, pool: null, drep: null, rewards: 0n });
      return built.summary.tx.txId;
    },
  };

  // ============================================================== TRON
  const DELAY_DAYS = testnet ? 1 : 14;
  const SUN = 1_000_000n;
  const W = (i: number): TronWitness => ({
    address: base58.encode(new Uint8Array([0x41, ...sha256(new TextEncoder().encode(`sr:${i}`)).slice(0, 24)])).slice(0, 34).replace(/^./, 'T'),
    url: i === 3 ? 'https://sr-gourmand.example' : `https://sr-${i}.example`,
    voteCount: Math.round(3_000_000_000 / i),
    rank: i,
    isSr: i <= 27,
    isPaid: i <= 127,
    producing: i <= 27,
    brokerage: null,
  });
  const witnesses: TronWitness[] = [...Array.from({ length: 30 }, (_, k) => W(k + 1)), W(131)];
  /** % kept by each SR (getBrokerage): most 20 %, SR #3 keeps everything. */
  const brokerageOf = (addr: string) => (witnesses.find((w) => w.address === addr)?.rank === 3 ? 100 : 20);
  const tr = {
    staked: { BANDWIDTH: 0n, ENERGY: 20n * SUN } as Record<TronResource, bigint>,
    unfreezing: [] as Array<{ resource: TronResource; amount: bigint; expireTime: number }>,
    votes: [{ address: witnesses[1]!.address, count: '20' }] as Array<{ address: string; count: string }>,
    reward: 1_250_000n,
    lastClaim: t0 - 3 * 86_400_000,
  };
  const tronAccount = (): TronStakeAccount => {
    const now = d.now();
    const power = Number((tr.staked.BANDWIDTH + tr.staked.ENERGY) / SUN);
    const used = tr.votes.reduce((s, v) => s + Number(v.count), 0);
    const next = tr.lastClaim + 86_400_000;
    return {
      address: d.tron.address,
      balance: d.tron.trx().toString(),
      stakedBandwidth: tr.staked.BANDWIDTH.toString(),
      stakedEnergy: tr.staked.ENERGY.toString(),
      unfreezing: tr.unfreezing.map((u) => ({ resource: u.resource, amount: u.amount.toString(), expireTime: u.expireTime })),
      withdrawableNow: tr.unfreezing.filter((u) => u.expireTime <= now).reduce((s, u) => s + u.amount, 0n).toString(),
      tronPowerLimit: power,
      tronPowerUsed: used,
      votes: tr.votes.map((v) => ({ ...v })),
      reward: tr.reward.toString(),
      nextClaimTime: next <= now ? 0 : next,
      unfreezeDelayDays: DELAY_DAYS,
      nextMaintenanceTime: now + 6 * 3_600_000 - ((now - t0) % (6 * 3_600_000)),
      energyLimit: Number(tr.staked.ENERGY / SUN) * 12,
      energyUsed: 0,
      bandwidthLimit: Number(tr.staked.BANDWIDTH / SUN),
      bandwidthUsed: 0,
    };
  };
  const tronEstimate = (acc: TronStakeAccount): TronEstimate => ({ bandwidthNeeded: 280, freeBandwidth: 600, stakedBandwidth: 0, bandwidthBurn: '0', activationFee: '0', recipientExists: true, energyNeeded: 0, energyAvailable: 0, energyFee: 100, energyBurn: '0', feeLimit: '0', totalBurn: '0', totalBurnMax: '0', balance: acc.balance });
  const tronBuild = (action: TronStakeRequest) => {
    const acc = tronAccount();
    const now = d.now();
    const warnings: TronStakeWarning[] = [];
    let summaryAction: TronStakeSummary['action'];
    const ctxWitnesses: TronWitness[] = [];
    if (action.kind === 'freeze') {
      const amt = BigInt(action.amount || '0');
      if (amt < SUN) throw invalid(l10n('stake minimum : 1 TRX', 'minimum stake: 1 TRX'));
      if (amt > BigInt(acc.balance)) throw invalid(l10n('stake supérieur au solde', 'stake above the balance'));
      summaryAction = { type: 'freeze', resource: action.resource, amount: amt.toString() };
    } else if (action.kind === 'unfreeze') {
      const amt = BigInt(action.amount || '0');
      if (amt <= 0n || amt > tr.staked[action.resource]) throw invalid(l10n(`dégel supérieur au stake ${action.resource === 'ENERGY' ? 'énergie' : 'bande passante'}`, `unfreeze above the ${action.resource === 'ENERGY' ? 'energy' : 'bandwidth'} stake`));
      if (tr.unfreezing.length >= 32) throw invalid(l10n('32 dégels déjà en attente', '32 unfreezes already pending'));
      const powerAfter = acc.tronPowerLimit - Number(amt / SUN);
      if (powerAfter < acc.tronPowerUsed) warnings.push({ kind: 'votesReduced' });
      summaryAction = { type: 'unfreeze', resource: action.resource, amount: amt.toString() };
    } else if (action.kind === 'withdrawUnfrozen') {
      if (BigInt(acc.withdrawableNow) === 0n) throw invalid(l10n('rien à retirer : aucun dégel arrivé à son terme', 'nothing to withdraw: no unfreeze has completed'));
      summaryAction = { type: 'withdrawUnfrozen' };
    } else if (action.kind === 'cancelAllUnfreeze') {
      if (tr.unfreezing.length === 0) throw invalid(l10n('aucun dégel à annuler', 'no unfreeze to cancel'));
      summaryAction = { type: 'cancelAllUnfreeze' };
    } else if (action.kind === 'claimRewards') {
      if (tr.reward === 0n) throw invalid(l10n('récompense nulle', 'zero reward'));
      if (now - tr.lastClaim < 86_400_000) throw invalid(l10n('récompense déjà réclamée il y a moins de 24 h', 'reward already claimed less than 24 h ago'));
      summaryAction = { type: 'claimRewards' };
    } else {
      const votes = action.votes ?? [];
      if (votes.length === 0 || votes.length > 30) throw invalid(l10n('il faut voter pour 1 à 30 SR', 'you must vote for 1 to 30 SRs'));
      let total = 0;
      for (const v of votes) {
        const w = witnesses.find((x) => x.address === v.address);
        if (!w) throw invalid(l10n(`adresse qui n’est pas un candidat SR : ${v.address}`, `address that is not an SR candidate: ${v.address}`));
        const c = Number(v.count);
        if (!Number.isInteger(c) || c <= 0) throw invalid(l10n('nombre de votes invalide', 'invalid number of votes'));
        total += c;
        const b = brokerageOf(w.address);
        ctxWitnesses.push({ ...w, brokerage: b });
        if (!w.isPaid) warnings.push({ kind: 'srNotPaid', address: w.address, rank: w.rank });
        if (b >= 100) warnings.push({ kind: 'brokerageAll', address: w.address });
      }
      if (total > acc.tronPowerLimit) throw invalid(l10n(`votes (${total}) supérieurs à ton TRON Power (${acc.tronPowerLimit})`, `votes (${total}) above your TRON Power (${acc.tronPowerLimit})`));
      summaryAction = { type: 'vote', votes: votes.map((v) => ({ ...v })), total: String(total) };
    }
    const raw = encode({ stake: true, owner: d.tron.address, action, timestamp: now, expiration: now + 600_000 });
    const txid = bytesToHex(sha256(hexToBytes(raw)));
    const summary: TronStakeSummary = { txid, owner: d.tron.address, action: summaryAction, expiration: now + 600_000, timestamp: now, refBlockBytes: '254f', refBlockHash: h(`blk:${now}`).slice(0, 16), rawSize: 120 };
    const context: TronStakeContext = { account: acc, estimate: tronEstimate(acc), witnesses: ctxWitnesses, warnings, requiresExtraConfirmation: warnings.length > 0 };
    return { raw, txid, summary, context };
  };
  const tronDescribe = (s: TronStakeSummary, c: TronStakeContext) => {
    const a = s.action;
    const res = (r: TronResource) => l10n((r === 'ENERGY' ? 'énergie' : 'bande passante'), (r === 'ENERGY' ? l10n('énergie', 'energy') : l10n('bande passante', 'bandwidth')));
    let out = `Staking TRON${testnet ? ' (Nile)' : ''}\n`;
    if (a.type === 'freeze') out += l10n(`Staker ${units(a.amount, 6)} TRX pour ${res(a.resource)} (+${Number(BigInt(a.amount) / SUN)} TRON Power)\n`, `Stake ${units(a.amount, 6)} TRX for ${res(a.resource)} (+${Number(BigInt(a.amount) / SUN)} TRON Power)\n`);
    if (a.type === 'unfreeze') out += l10n(`Dégeler ${units(a.amount, 6)} TRX (${res(a.resource)}) : disponibles dans ${c.account.unfreezeDelayDays} jour(s)\n`, `Unfreeze ${units(a.amount, 6)} TRX (${res(a.resource)}): available in ${c.account.unfreezeDelayDays} day(s)\n`);
    if (a.type === 'withdrawUnfrozen') out += l10n(`Retirer les dégels arrivés à terme : ${units(c.account.withdrawableNow, 6)} TRX\n`, `Withdraw completed unfreezes: ${units(c.account.withdrawableNow, 6)} TRX\n`);
    if (a.type === 'cancelAllUnfreeze') out += l10n('Annuler tous les dégels en cours (les TRX sont re-stakés)\n', 'Cancel all pending unfreezes (the TRX are re-staked)\n');
    if (a.type === 'claimRewards') out += l10n(`Réclamer les récompenses de vote : ${units(c.account.reward, 6)} TRX\n`, `Claim the vote rewards: ${units(c.account.reward, 6)} TRX\n`);
    if (a.type === 'vote') {
      out += l10n(`Votes (REMPLACENT tous tes votes actuels), ${a.total} / ${c.account.tronPowerLimit} TRON Power :\n`, `Votes (REPLACE all your current votes), ${a.total} / ${c.account.tronPowerLimit} TRON Power:\n`);
      for (const v of a.votes) {
        const w = c.witnesses.find((x) => x.address === v.address);
        out += l10n(`  ${v.count} → ${w?.url ?? v.address} (rang ${w?.rank ?? '?'}, garde ${w?.brokerage ?? '?'} %)\n`, `  ${v.count} → ${w?.url ?? v.address} (rank ${w?.rank ?? '?'}, keeps ${w?.brokerage ?? '?'}%)\n`);
      }
    }
    out += l10n(`Bande passante : ${c.estimate.bandwidthNeeded} octets · ${units(c.estimate.bandwidthBurn, 6)} TRX brûlés · pas de slashing sur TRON\nExpire dans 10 min · ID : ${s.txid}`, `Bandwidth: ${c.estimate.bandwidthNeeded} bytes · ${units(c.estimate.bandwidthBurn, 6)} TRX burned · no slashing on TRON\nExpires in 10 min · ID: ${s.txid}`);
    return out;
  };
  /** Signed staking raw_data, broadcast through the existing `tron_broadcast` (null: not a staking tx). */
  const tronStakeBroadcast = (rawHex: string, signature: string): string | null => {
    let o: { stake?: boolean; action?: TronStakeRequest };
    try {
      o = JSON.parse(new TextDecoder().decode(hexToBytes(rawHex.trim()))) as typeof o;
    } catch {
      return null;
    }
    if (!o.stake || !o.action) return null;
    if (!/^[0-9a-f]{130}$/i.test(signature.trim())) throw invalid(l10n('signature : 65 octets hex', 'signature: 65 hex bytes'));
    const built = tronBuild(o.action);
    const act = o.action;
    const now = d.now();
    if (act.kind === 'freeze') {
      d.tron.setTrx(d.tron.trx() - BigInt(act.amount));
      tr.staked[act.resource] += BigInt(act.amount);
    } else if (act.kind === 'unfreeze') {
      tr.staked[act.resource] -= BigInt(act.amount);
      tr.unfreezing.push({ resource: act.resource, amount: BigInt(act.amount), expireTime: now + DELAY_DAYS * 86_400_000 });
      // Not enough TRON Power left: the network takes the votes back, proportionally.
      const power = Number((tr.staked.BANDWIDTH + tr.staked.ENERGY) / SUN);
      const used = tr.votes.reduce((s, v) => s + Number(v.count), 0);
      if (used > power) tr.votes = tr.votes.map((v) => ({ ...v, count: String(Math.floor((Number(v.count) * power) / used)) })).filter((v) => v.count !== '0');
    } else if (act.kind === 'withdrawUnfrozen') {
      const done = tr.unfreezing.filter((u) => u.expireTime <= now);
      d.tron.setTrx(d.tron.trx() + done.reduce((s, u) => s + u.amount, 0n));
      tr.unfreezing = tr.unfreezing.filter((u) => u.expireTime > now);
    } else if (act.kind === 'cancelAllUnfreeze') {
      for (const u of tr.unfreezing) {
        if (u.expireTime <= now) d.tron.setTrx(d.tron.trx() + u.amount);
        else tr.staked[u.resource] += u.amount;
      }
      tr.unfreezing = [];
    } else if (act.kind === 'claimRewards') {
      d.tron.setTrx(d.tron.trx() + tr.reward);
      tr.reward = 0n;
      tr.lastClaim = now;
    } else tr.votes = act.votes.map((v) => ({ ...v }));
    return built.txid;
  };
  const tronHandlers: Record<Extract<keyof Commands, `tron_stake_${string}`>, (a: Record<string, unknown>) => unknown> = {
    tron_stake_overview: () => tronAccount(),
    tron_stake_witnesses: () => witnesses.map((w) => ({ ...w })),
    tron_stake_build: (a) => {
      d.requireUnlocked();
      return tronBuild(a.action as TronStakeRequest);
    },
    tron_stake_sign: (a) => {
      d.requireUnlocked();
      const o = decode<{ stake?: boolean; action?: TronStakeRequest; expiration?: number }>(a.raw);
      if (!o.stake || !o.action) throw invalid(l10n('ce raw_data n’est pas une opération de staking Kyro', 'this raw_data is not a Kyro staking operation'));
      if ((o.expiration ?? 0) <= d.now()) throw invalid(l10n('transaction TRON expirée : reconstruis-la', 'TRON transaction expired: rebuild it'));
      const built = tronBuild(o.action);
      d.checkPassword(a.password);
      const w = built.context.warnings.map((x) => (x.kind === 'srNotPaid' ? l10n(`• SR hors des 127 premiers (rang ${x.rank}) : aucune récompense`, `• SR outside the top 127 (rank ${x.rank}): no rewards`) : x.kind === 'brokerageAll' ? l10n('• ce SR garde 100 % des récompenses : rien pour toi', '• this SR keeps 100% of the rewards: nothing for you') : l10n('• ce dégel va réduire tes votes (le réseau les retire en proportion)', '• this unfreeze will reduce your votes (the network removes them proportionally)'))).join('\n');
      confirmTwice(l10n(`Confirmer le staking TRON\n${tronDescribe(built.summary, built.context)}`, `Confirm the TRON staking\n${tronDescribe(built.summary, built.context)}`), built.context.requiresExtraConfirmation, w);
      const txid = bytesToHex(sha256(hexToBytes(String(a.raw).trim())));
      return { signature: h(`r:${txid}`) + h(`s:${txid}`) + '1b', txid, summary: { ...built.summary, txid }, context: built.context };
    },
  };

  return {
    handlers: { ...solHandlers, ...adaHandlers, ...tronHandlers },
    tronStakeBroadcast,
    /** Tests: move Solana by whole epochs (activation, cool-down). */
    advanceSolEpochs(n: number) {
      solEpochShift += n;
    },
    /** Tests: the 24 h claim limit. */
    state: { ada, tron: tr, solAccounts, validators, pools, witnesses, DREPS },
  };
}
