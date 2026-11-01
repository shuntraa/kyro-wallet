// SPDX-License-Identifier: GPL-3.0-or-later
//
// Réglages › Réseaux et serveurs (B2b): the user's own server per chain.
// Contract: docs/IPC.md §2–2.2; what each server sees: docs/NETWORK.md.
//
// Rules shown and enforced here (Rust stays the judge, see settings_set / server_test):
// - a custom server replaces the chain's default; if it goes down Kyro shows an error and
//   never falls back to the default;
// - every save is checked live by Rust; its typed error is shown inline, in the card;
// - the Core password is never received (`hasPassword`): an empty field = unchanged;
// - removing a custom server goes back to the default, with a note that the default now
//   sees the addresses again;
// - compact block filters (BIP157/158) stay visible but disabled while the build answers
//   FEATURE_DISABLED (cargo feature `cbf`, off until the security review).

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  bitcoinServerFor,
  btcNetworkKey,
  call,
  checkBtcServer,
  checkServerUrl,
  coreIsLocal,
  fingerprintGroups,
  isOnion,
  normalizeFingerprint,
  toIpcError,
  type BtcServer,
  type BtcServerKind,
  type CoreStatus,
  type ElectrumCertInfo,
  type ServerTestResult,
  type ServerTestTarget,
  type Servers,
  type Network,
  type SolanaCluster,
} from '@kyro/shared';
import { evmChains, solChain } from '@kyro/chains';
import { useApp } from '../../state/app';
import { NetworkSwitchDialog, useNetworkInfo } from '../../components/NetworkSwitch';
import { NETWORK_HINT, NETWORK_LABEL } from '../../lib/network';
import { cbfPhaseLabel, cbfStore, useCbf } from '../../state/cbf';
import { usePortfolio } from '../../state/portfolio';
import { cn } from '../../lib/cn';
import { fmtNumber } from '../../lib/format';
import { Dialog } from '../../components/ui/dialog';
import { Badge, Button, Input, Notice, Segmented, Spinner, Switch } from '../../components/ui/primitives';
import { IconCheck, IconInfo, IconWarn } from '../../components/icons';

// ---------------------------------------------------------------- shared bits

interface Failure {
  code: string;
  message: string;
}

const CODE_TITLE: Record<string, string> = {
  SERVER_INVALID: 'Configuration refusée',
  SERVER_WRONG_NETWORK: 'Mauvais réseau',
  SERVER_UNREACHABLE: 'Serveur injoignable',
  DEFAULT_SERVER_DISABLED: 'Serveur par défaut désactivé',
  TOR_UNAVAILABLE: 'Tor indisponible',
  INVALID_INPUT: 'Entrée invalide',
  LOCKED: 'Coffre verrouillé',
};

const toFailure = (e: unknown): Failure => {
  const err = toIpcError(e);
  return { code: err.code, message: err.message };
};

/** Shell message without its « Serveur invalide : » style prefix (the title says it). */
function detail(message: string): string {
  return message.replace(/^(Serveur invalide|Mauvais réseau|Serveur injoignable|Tor indisponible|Entrée invalide|Erreur interne)\s*:\s*/, '');
}

function FailureNotice({ failure }: { failure: Failure }) {
  return (
    <Notice tone="error" icon={<IconWarn size={16} className="mt-0.5 shrink-0" />}>
      <span className="font-semibold">{CODE_TITLE[failure.code] ?? 'Erreur'} :</span> {detail(failure.message)}
      {failure.code === 'SERVER_UNREACHABLE' && <span className="block text-[12px] opacity-80">Rien n’a été enregistré. Kyro ne se rabat jamais sur le serveur par défaut.</span>}
    </Notice>
  );
}

/** `chainLabel`: what `detected.chainId` is for that family (XRP Ledger: `network_id`). */
function TestOk({ result, chainLabel = 'chainId', ledgerLabel = 'bloc' }: { result: ServerTestResult; chainLabel?: string; ledgerLabel?: string }) {
  const d = result.detected;
  const parts = [`${result.latencyMs} ms`];
  if (d.network) parts.push(`réseau ${d.network}`);
  if (d.chainId !== undefined) parts.push(`${chainLabel} ${d.chainId}`);
  if (d.blockHeight !== undefined) parts.push(`${ledgerLabel} ${fmtNumber(d.blockHeight, 0)}`);
  if (d.serverVersion) parts.push(d.serverVersion);
  if (d.genesisHash) parts.push(`genesis ${d.genesisHash.slice(0, 8)}…${d.genesisHash.slice(-6)}`);
  return (
    <div role="status" className="flex items-start gap-2 rounded-ctl border border-up/30 bg-up/[.06] px-3.5 py-2.5 text-[12px] text-[#b8f3d8]">
      <IconCheck size={14} className="mt-0.5 shrink-0 text-up" />
      <span>
        <span className="font-semibold">Connexion réussie</span> · {parts.join(' · ')}
        <span className="block text-mute">Test seulement : rien n’est enregistré tant que tu ne cliques pas sur « Enregistrer ».</span>
      </span>
    </div>
  );
}

function Card({ title, badge, children }: { title: string; badge?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3.5 rounded-panel border border-line bg-card px-[22px] py-[18px]">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[15px] font-medium tracking-[-0.01em]">{title}</span>
        {badge}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="eyebrow">{label}</span>
      {children}
      {hint && <span className="text-[12px] leading-[1.45] text-faint">{hint}</span>}
    </label>
  );
}

/** What a server sees: one honest line (docs/NETWORK.md). */
function Sees({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 flex items-start gap-2 text-[12px] leading-[1.5] text-mute">
      <IconInfo size={14} className="mt-0.5 shrink-0 text-faint" />
      <span>{children}</span>
    </p>
  );
}

/** Outgoing copy of the servers: never sends back `hasPassword`, never invents a password. */
function outgoing(servers: Servers): Servers {
  const out = structuredClone(servers);
  for (const key of ['mainnet', 'testnet4'] as const) {
    const s = out.bitcoin[key];
    if (s?.kind === 'core' && s.auth.kind === 'userpass') {
      const { hasPassword: _h, ...auth } = s.auth;
      s.auth = auth;
    }
  }
  return out;
}

function useSaveServers() {
  const { settings, saveSettings } = useApp();
  return async (mutate: (s: Servers) => void) => {
    const next = outgoing(settings.servers);
    mutate(next);
    await saveSettings({ ...settings, servers: next });
  };
}

function BackToDefaultDialog({ open, host, sees, busy, failure, onConfirm, onCancel, title, body }: { open: boolean; host: string; sees: string; busy: boolean; failure: Failure | null; onConfirm: () => void; onCancel: () => void; title?: string; body?: ReactNode }) {
  return (
    <Dialog open={open} onOpenChange={(v) => (v ? undefined : onCancel())} title={title ?? `Revenir à ${host} ?`} className="w-[520px]">
      <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
        {body ?? (
          <>
            Ton serveur ne sera plus utilisé. <strong className="font-semibold text-text">{host}</strong> verra de nouveau {sees}.
          </>
        )}
      </Notice>
      {failure && <FailureNotice failure={failure} />}
      <div className="flex justify-end gap-2">
        <Button variant="primary" onClick={onCancel} disabled={busy}>
          Garder mon serveur
        </Button>
        <Button variant="dangerOutline" onClick={onConfirm} disabled={busy}>
          {busy && <Spinner />} Revenir au serveur par défaut
        </Button>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- section

export function ServersSection() {
  const { network, settings } = useApp();
  const tor = settings.tor.enabled;
  return (
    <>
      <NetworkChoiceCard />
      <Card title="Réseaux et serveurs" badge={<Badge tone={network === 'testnet' ? 'warn' : 'up'}>{network === 'testnet' ? 'Testnet' : 'Mainnet'}</Badge>}>
        <p className="m-0 text-[13px] leading-[1.55] text-mute">
          {network === 'testnet' ? 'Bitcoin testnet4, Ethereum Sepolia, Solana devnet, Litecoin testnet4, Dogecoin testnet, TRON Nile, XRP Ledger testnet et Cardano preprod. ' : 'Bitcoin, Ethereum + 6 réseaux EVM (même adresse), Solana, Litecoin, Dogecoin, TRON, XRP Ledger, Cardano. '}
          Pour chaque chaîne, tu peux remplacer le serveur par défaut par le tien : Kyro vérifie qu’il est sur le bon réseau avant de l’enregistrer.
        </p>
        <Notice icon={<IconInfo size={16} className="mt-0.5 shrink-0 text-ice" />}>
          Un serveur personnalisé remplace celui par défaut <strong className="font-semibold text-text">sans repli</strong> : s’il ne répond plus, Kyro affiche une erreur et n’interroge jamais le serveur par défaut à sa place.{' '}
          {tor ? 'Tes serveurs sont joints via Tor (sauf un nœud Bitcoin Core local).' : 'Tor est désactivé : tes serveurs voient ton adresse IP.'}
        </Notice>
      </Card>
      <BitcoinCard />
      <UtxoServerCard coin="litecoin" />
      <UtxoServerCard coin="dogecoin" />
      <TronServerCard />
      <XrpServerCard />
      <CardanoServerCard />
      <EvmCard />
      <SolanaCard />
    </>
  );
}

/** Réseau principal / réseau de test (docs/IPC.md §2.10): saved by the shell, applied by a restart. */
function NetworkChoiceCard() {
  const { network, status, demo } = useApp();
  const info = useNetworkInfo();
  const [target, setTarget] = useState<Network | null>(null);
  const current = info.data?.network ?? network;
  const locked = info.data ? !info.data.canSwitch : true;
  return (
    <Card title="Réseau" badge={<Badge tone={current === 'testnet' ? 'warn' : 'up'}>{NETWORK_LABEL[current]}</Badge>}>
      <div role="radiogroup" aria-label="Réseau" className="flex gap-2.5">
        {(['mainnet', 'testnet'] as const).map((n) => {
          const active = current === n;
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={!active && locked}
              onClick={() => !active && setTarget(n)}
              className={cn(
                'press flex min-h-14 flex-1 basis-0 flex-col items-start justify-center gap-0.5 rounded-box border px-3.5 py-2.5 text-left disabled:opacity-50',
                active ? 'border-ice bg-ice/[.07] shadow-[inset_0_0_0_0.5px_var(--color-ice)]' : 'border-line-2 bg-bg hover:border-line-3 hover:bg-raised/50',
              )}
            >
              <span className="text-[13px] font-medium">
                {NETWORK_LABEL[n]} {active && <span className="font-normal text-ice-text2">· utilisé</span>}
              </span>
              <span className="text-[12px] text-mute">{n === 'mainnet' ? 'Fonds réels' : 'Jetons sans valeur'}</span>
            </button>
          );
        })}
      </div>
      <p className="m-0 text-[13px] leading-[1.55] text-mute">
        Chaque réseau a son propre coffre et ses propres comptes : changer de réseau garde l’autre coffre sur cet ordinateur (rien n’est supprimé), verrouille Kyro et le redémarre. Tu es sur le {NETWORK_LABEL[current].toLowerCase()} ({NETWORK_HINT[current]}).
      </p>
      {info.data && !info.data.canSwitch && (
        <Notice icon={<IconInfo size={16} className="mt-0.5 shrink-0 text-ice" />}>{demo ? 'Mode démo : le réseau est imposé par l’adresse de la page (?network=). Retire-la pour choisir ici.' : 'Le réseau est imposé par la variable d’environnement KYRO_NETWORK (développement). Retire-la pour choisir ici.'}</Notice>
      )}
      {info.error && <Notice tone="error">Réseau illisible : {info.error.message}</Notice>}
      {info.data && <NetworkSwitchDialog info={info.data} target={target} hasVault={status?.exists ?? true} onClose={() => setTarget(null)} />}
    </Card>
  );
}

// ---------------------------------------------------------------- Bitcoin

interface BtcDraft {
  kind: BtcServerKind;
  esploraUrl: string;
  host: string;
  port: string;
  tls: boolean;
  tlsMode: 'webpki' | 'pinned';
  cert: string;
  coreUrl: string;
  authKind: 'cookie' | 'userpass';
  cookiePath: string;
  user: string;
  /** Empty = unchanged (the stored one is kept by Rust if URL and user are the same). */
  password: string;
  hasPassword: boolean;
  /** Compact filters: extra peers, one per line ("ip:port" or "onion:port"). */
  cbfPeers: string;
  birthMode: 'genesis' | 'height' | 'date';
  birthHeight: string;
  birthDate: string;
}

function draftOf(s: BtcServer, network: 'mainnet' | 'testnet'): BtcDraft {
  const d: BtcDraft = {
    kind: s.kind,
    esploraUrl: '',
    host: '',
    port: '50002',
    tls: true,
    tlsMode: 'webpki',
    cert: '',
    coreUrl: network === 'testnet' ? 'http://127.0.0.1:48332' : 'http://127.0.0.1:8332',
    authKind: 'cookie',
    cookiePath: '',
    user: '',
    password: '',
    hasPassword: false,
    cbfPeers: '',
    birthMode: 'genesis',
    birthHeight: '',
    birthDate: '',
  };
  if (s.kind === 'esplora') d.esploraUrl = s.url;
  if (s.kind === 'cbf') {
    d.cbfPeers = (s.peers ?? []).join('\n');
    if (s.birthHeight !== undefined) {
      d.birthMode = 'height';
      d.birthHeight = String(s.birthHeight);
    }
  }
  if (s.kind === 'electrum') {
    d.host = s.host;
    d.port = String(s.port);
    d.tls = s.tls !== 'none';
    d.tlsMode = s.tls === 'pinned' ? 'pinned' : 'webpki';
    d.cert = s.certSha256 ?? '';
  }
  if (s.kind === 'core') {
    d.coreUrl = s.url;
    d.authKind = s.auth.kind;
    if (s.auth.kind === 'cookie') d.cookiePath = s.auth.cookiePath;
    else {
      d.user = s.auth.user;
      d.hasPassword = !!s.auth.hasPassword;
    }
  }
  return d;
}

/**
 * Approximate block height at a date, minus a one-week safety margin (1008 blocks). Reference
 * points: mainnet block 840 000 (halving, 2024-04-20), testnet4 genesis (2024-05-03); about
 * one block per 10 minutes. Starting earlier only costs time, starting later would miss funds.
 */
export function estimateBirthHeight(dateIso: string, network: 'mainnet' | 'testnet'): number | null {
  const t = Date.parse(`${dateIso}T00:00:00Z`) / 1000;
  if (!Number.isFinite(t)) return null;
  const [refHeight, refTime] = network === 'mainnet' ? [840_000, 1_713_571_767] : [0, 1_714_777_860];
  return Math.max(0, Math.floor(refHeight + (t - refTime) / 600) - 1008);
}

function birthOf(d: BtcDraft, network: 'mainnet' | 'testnet'): number | undefined {
  if (d.birthMode === 'height' && /^\d+$/.test(d.birthHeight.trim())) return Number(d.birthHeight.trim());
  if (d.birthMode === 'date') return estimateBirthHeight(d.birthDate, network) ?? undefined;
  return undefined;
}

function serverOf(d: BtcDraft, network: 'mainnet' | 'testnet' = 'testnet'): BtcServer {
  switch (d.kind) {
    case 'default':
      return { kind: 'default' };
    case 'cbf': {
      const peers = d.cbfPeers.split(/[\s,]+/).map((p) => p.trim()).filter(Boolean);
      const birthHeight = birthOf(d, network);
      return { kind: 'cbf', ...(peers.length ? { peers } : {}), ...(birthHeight !== undefined ? { birthHeight } : {}) };
    }
    case 'esplora':
      return { kind: 'esplora', url: d.esploraUrl.trim() };
    case 'electrum': {
      const tls = !d.tls ? 'none' : d.tlsMode;
      const cert = normalizeFingerprint(d.cert);
      return { kind: 'electrum', host: d.host.trim(), port: Number(d.port), tls, ...(tls === 'pinned' && cert ? { certSha256: cert } : {}) };
    }
    case 'core':
      return {
        kind: 'core',
        url: d.coreUrl.trim(),
        // Password omitted when the field is empty: Rust keeps the stored one (never round-tripped).
        auth: d.authKind === 'cookie' ? { kind: 'cookie', cookiePath: d.cookiePath.trim() } : { kind: 'userpass', user: d.user.trim(), ...(d.password ? { password: d.password } : {}) },
      };
  }
}

/** Comparable form of a saved server (no `hasPassword`). */
function comparable(s: BtcServer): string {
  if (s.kind === 'core' && s.auth.kind === 'userpass') return JSON.stringify({ ...s, auth: { kind: 'userpass', user: s.auth.user } });
  return JSON.stringify(s);
}

const BTC_KINDS: Array<{ value: BtcServerKind; label: string }> = [
  { value: 'default', label: 'Par défaut' },
  { value: 'esplora', label: 'Esplora perso' },
  { value: 'electrum', label: 'Electrum' },
  { value: 'core', label: 'Bitcoin Core' },
  { value: 'cbf', label: 'Filtres compacts (BIP157/158)' },
];

function btcSees(d: BtcDraft, tor: boolean): string {
  switch (d.kind) {
    case 'default':
      return tor
        ? 'mempool.space voit tes adresses Bitcoin et tes transactions, via son service .onion : ni ton IP, ni celle d’un relais.'
        : 'mempool.space voit tes adresses Bitcoin, tes transactions et ton adresse IP (Tor est désactivé).';
    case 'esplora':
      return `Ton serveur Esplora voit tes adresses et tes transactions ; ${tor ? 'l’IP d’un relais de sortie Tor (aucune si .onion)' : 'et ton adresse IP'}.`;
    case 'electrum':
      return `Le serveur Electrum voit tes script hashes (l’équivalent de tes adresses) et tes transactions ; ${tor ? 'l’IP d’un relais de sortie Tor (aucune si .onion)' : 'et ton adresse IP'}.`;
    case 'cbf':
      return `Aucun serveur n’apprend tes adresses : Kyro télécharge les filtres de blocs et vérifie sur ta machine lesquels te concernent. Les pairs voient quels blocs tu télécharges en entier${tor ? ' ; avec Tor, ton IP leur est cachée' : ', et ton adresse IP (Tor désactivé)'}.`;
    case 'core':
      return coreIsLocal(d.coreUrl)
        ? 'Ton propre nœud voit tes descripteurs publics (xpub) et tes transactions. Rien ne sort de ta machine ou de ton réseau local. Jamais ta phrase ni tes clés privées.'
        : 'Ce nœud connaît ton xpub : tout l’historique de ton compte, présent et futur. N’utilise un nœud distant que s’il t’appartient.';
  }
}

function BitcoinCard() {
  const { settings, network } = useApp();
  const tor = settings.tor.enabled;
  const netKey = btcNetworkKey(network);
  const saved = bitcoinServerFor(settings.servers, network);
  const savedKey = comparable(saved);
  const [d, setD] = useState<BtcDraft>(() => draftOf(saved, network));
  useEffect(() => setD(draftOf(saved, network)), [savedKey, network]);
  const set = (patch: Partial<BtcDraft>) => setD((x) => ({ ...x, ...patch }));
  const saveServers = useSaveServers();

  const [busy, setBusy] = useState<'test' | 'save' | 'cert' | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [result, setResult] = useState<ServerTestResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cert, setCert] = useState<{ info: ElectrumCertInfo; host: string; port: number; changed: boolean } | null>(null);
  const [confirmDefault, setConfirmDefault] = useState(false);

  const cbf = useCbf();
  useEffect(() => {
    void cbfStore.refresh();
  }, []);
  const cbfOff = cbf.availability === 'disabled';
  const server = serverOf(d, network);
  const dirty = comparable(server) !== savedKey || (d.kind === 'core' && d.authKind === 'userpass' && d.password !== '');
  // URL or user changed: Rust does not keep the stored password (merge rule) → must be re-entered.
  const passwordLost = saved.kind === 'core' && saved.auth.kind === 'userpass' && d.kind === 'core' && d.authKind === 'userpass' && d.password === '' && (saved.url !== d.coreUrl.trim() || saved.auth.user !== d.user.trim());
  const needsPassword = d.kind === 'core' && d.authKind === 'userpass' && d.password === '' && (!d.hasPassword || passwordLost);
  const hint = d.kind === 'default' ? null : (checkBtcServer(server, tor) ?? (needsPassword ? 'mot de passe RPC requis' : null));
  const onionHost = d.kind === 'electrum' && isOnion(d.host.trim());

  const reset = () => {
    setFailure(null);
    setResult(null);
    setNotice(null);
  };

  const runTest = async (s: BtcServer) => {
    setBusy('test');
    try {
      setResult(await call('server_test', { target: { family: 'bitcoin', network: netKey, server: s } }));
    } catch (e) {
      setFailure(toFailure(e));
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    reset();
    if (d.kind === 'electrum' && d.tls) {
      // TLS: fetch the certificate first (trust on first use), then test with the chosen validation.
      setBusy('cert');
      try {
        const host = d.host.trim();
        const port = Number(d.port);
        const info = await call('electrum_fetch_cert', { host, port });
        const pinned = normalizeFingerprint(d.cert);
        if (d.tlsMode === 'pinned' && pinned === info.sha256) {
          setBusy(null);
          await runTest(server);
          return;
        }
        setCert({ info, host, port, changed: d.tlsMode === 'pinned' && pinned !== null });
      } catch (e) {
        setFailure(toFailure(e));
      } finally {
        setBusy((b) => (b === 'cert' ? null : b));
      }
      return;
    }
    await runTest(server);
  };

  const chooseCert = async (mode: 'pinned' | 'webpki') => {
    if (!cert) return;
    const next = mode === 'pinned' ? { tlsMode: 'pinned' as const, cert: cert.info.sha256 } : { tlsMode: 'webpki' as const, cert: '' };
    setCert(null);
    const nd = { ...d, ...next };
    setD(nd);
    await runTest(serverOf(nd, network));
  };

  const save = async () => {
    reset();
    if (d.kind === 'default') {
      if (saved.kind !== 'default') setConfirmDefault(true);
      return;
    }
    setBusy('save');
    try {
      await saveServers((s) => {
        s.bitcoin[netKey] = server;
      });
      setNotice(d.kind === 'cbf' ? 'Mode filtres compacts enregistré : première synchronisation lancée.' : 'Serveur Bitcoin enregistré. Kyro n’utilise plus que lui pour Bitcoin.');
      if (d.kind === 'core') set({ password: '' });
      if (d.kind === 'cbf') void cbfStore.sync();
    } catch (e) {
      setFailure(toFailure(e));
    } finally {
      setBusy(null);
    }
  };

  const backToDefault = async () => {
    setBusy('save');
    setFailure(null);
    try {
      await saveServers((s) => {
        delete s.bitcoin[netKey];
      });
      setConfirmDefault(false);
      setNotice('Serveur par défaut rétabli : mempool.space voit maintenant tes adresses Bitcoin et tes transactions.');
    } catch (e) {
      setFailure(toFailure(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title={network === 'testnet' ? 'Bitcoin testnet4' : 'Bitcoin'}
      badge={saved.kind === 'default' ? <Badge>Par défaut</Badge> : <Badge tone="ice">Serveur perso · {BTC_KINDS.find((k) => k.value === saved.kind)?.label}</Badge>}
    >
      <Segmented
        label="Type de serveur Bitcoin"
        value={d.kind}
        onChange={(kind) => {
          reset();
          set({ kind });
        }}
        options={BTC_KINDS.map((k) => (k.value === 'cbf' && cbfOff && saved.kind !== 'cbf' ? { ...k, disabled: true } : k))}
        className="max-w-full flex-wrap gap-y-[3px] self-start"
      />
      {cbfOff && (
        <span className="flex items-center gap-1.5 text-[12px] text-faint">
          <IconInfo size={13} /> Filtres compacts (BIP157/158) : disponible après revue de sécurité (à partir du 11/11/2026).
        </span>
      )}
      <Sees>{btcSees(d, tor)}</Sees>

      {d.kind === 'esplora' && (
        <Field label="URL de l’API Esplora" hint="https://, ou http:// pour une adresse .onion (Tor). Jamais d’identifiants dans l’URL.">
          <Input value={d.esploraUrl} onChange={(e) => set({ esploraUrl: e.target.value })} placeholder={network === 'testnet' ? 'https://mon-noeud.example/testnet4/api' : 'https://mon-noeud.example/api'} className="font-mono text-[13px]" />
        </Field>
      )}

      {d.kind === 'electrum' && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-2.5">
            <Field label="Hôte">
              <Input
                value={d.host}
                onChange={(e) => {
                  const host = e.target.value;
                  // TLS off is only allowed for a .onion over Tor: switch it back on otherwise.
                  set({ host, ...(!(isOnion(host.trim()) && tor) ? { tls: true } : {}) });
                }}
                placeholder="electrum.mon-noeud.example"
                className="font-mono text-[13px]"
              />
            </Field>
            <Field label="Port">
              <Input value={d.port} inputMode="numeric" onChange={(e) => set({ port: e.target.value.replace(/\D/g, '').slice(0, 5) })} placeholder="50002" className="font-mono text-[13px]" />
            </Field>
          </div>
          <div className="flex items-center justify-between gap-4 rounded-box border border-line bg-raised px-4 py-3">
            <span className="flex flex-col gap-0.5">
              <span className="text-[13px] font-semibold">TLS (chiffrement)</span>
              <span className="text-[12px] text-mute">{onionHost && tor ? 'Sans TLS possible : l’adresse .onion authentifie et chiffre déjà la connexion.' : 'Obligatoire sauf pour une adresse .onion via Tor.'}</span>
            </span>
            <Switch label="TLS" checked={d.tls} disabled={!(onionHost && tor)} onCheckedChange={(tls) => set({ tls })} />
          </div>
          {d.tls && (
            <div className="flex flex-col gap-2">
              <Segmented
                label="Validation du certificat"
                value={d.tlsMode}
                onChange={(tlsMode) => set({ tlsMode })}
                options={[
                  { value: 'webpki', label: 'Validation normale' },
                  { value: 'pinned', label: 'Certificat épinglé' },
                ]}
                className="self-start"
              />
              <span className="text-[12px] leading-[1.45] text-faint">
                {d.tlsMode === 'webpki'
                  ? 'Certificat vérifié par les autorités de certification, comme un site web.'
                  : 'Pour un serveur auto-signé : Kyro n’accepte que ce certificat précis. « Tester » récupère l’empreinte et te demande de la confirmer.'}
              </span>
              {d.tlsMode === 'pinned' &&
                (normalizeFingerprint(d.cert) ? (
                  <Fingerprint hex={d.cert} compact />
                ) : (
                  <span className="text-[12px] text-warn">Aucune empreinte épinglée : clique sur « Tester la connexion ».</span>
                ))}
            </div>
          )}
        </div>
      )}

      {d.kind === 'cbf' && <CbfForm d={d} set={set} network={network} tor={tor} />}

      {d.kind === 'core' && (
        <CoreForm d={d} set={set} savedIsCore={saved.kind === 'core'} passwordLost={passwordLost} tor={tor} />
      )}

      {hint && d.kind !== 'default' && (
        <span className="flex items-center gap-1.5 text-[12px] text-warn">
          <IconWarn size={13} /> {hint}
        </span>
      )}
      {failure && <FailureNotice failure={failure} />}
      {result && !failure && <TestOk result={result} />}
      {notice && !failure && <Notice tone={notice.startsWith('Serveur par défaut') ? 'warn' : 'success'}>{notice}</Notice>}

      <div className="flex flex-wrap gap-2">
        {d.kind !== 'default' && (
          <Button onClick={() => void test()} disabled={busy !== null}>
            {(busy === 'test' || busy === 'cert') && <Spinner />} Tester la connexion
          </Button>
        )}
        <Button variant="primary" onClick={() => void save()} disabled={busy !== null || !dirty}>
          {busy === 'save' && <Spinner />} {d.kind === 'default' && saved.kind !== 'default' ? 'Revenir au serveur par défaut' : 'Enregistrer'}
        </Button>
        {dirty && (
          <Button variant="ghost" onClick={() => (reset(), setD(draftOf(saved, network)))} disabled={busy !== null}>
            Annuler les modifications
          </Button>
        )}
      </div>

      {saved.kind === 'core' && d.kind === 'core' && <CoreWallet />}
      {saved.kind === 'cbf' && d.kind === 'cbf' && <CbfPanel />}

      <BackToDefaultDialog
        open={confirmDefault}
        host="mempool.space"
        sees="tes adresses Bitcoin et tes transactions (via son service .onion avec Tor, sinon avec ton adresse IP)"
        busy={busy === 'save'}
        failure={confirmDefault ? failure : null}
        onConfirm={() => void backToDefault()}
        onCancel={() => setConfirmDefault(false)}
      />
      <CertDialog cert={cert} onCancel={() => setCert(null)} onChoose={(m) => void chooseCert(m)} />
    </Card>
  );
}

function Fingerprint({ hex, compact }: { hex: string; compact?: boolean }) {
  const groups = fingerprintGroups(hex);
  return (
    <div aria-label={`Empreinte SHA-256 ${groups.join(' ')}`} className={cn('grid grid-cols-8 gap-x-2 gap-y-1 rounded-ctl border border-ice-line bg-ice/[.06] font-mono text-ice-text', compact ? 'px-3 py-2 text-[11px]' : 'px-4 py-3 text-[13px]')}>
      {groups.map((g, i) => (
        <span key={i}>{g}</span>
      ))}
    </div>
  );
}

function CertDialog({ cert, onCancel, onChoose }: { cert: { info: ElectrumCertInfo; host: string; port: number; changed: boolean } | null; onCancel: () => void; onChoose: (mode: 'pinned' | 'webpki') => void }) {
  return (
    <Dialog open={cert !== null} onOpenChange={(v) => (v ? undefined : onCancel())} title="Faire confiance à ce certificat ?" className="w-[600px]">
      {cert && (
        <>
          <p className="m-0 text-[13px] leading-[1.55] text-text2">
            Certificat présenté par <span className="font-mono text-text">{cert.host}:{cert.port}</span>. Rien n’a été envoyé au serveur : la connexion a été coupée dès réception du certificat.
          </p>
          {cert.changed && (
            <Notice tone="error" icon={<IconWarn size={16} className="mt-0.5 shrink-0" />}>
              <strong className="font-semibold">L’empreinte a changé</strong> depuis celle que tu avais épinglée. Si tu n’as pas renouvelé le certificat de ton serveur, n’accepte pas : quelqu’un pourrait se faire passer pour lui.
            </Notice>
          )}
          <div className="flex flex-col gap-1.5">
            <span className="flex items-center justify-between text-[12px] font-medium text-mute">
              Empreinte SHA-256
              {cert.info.webpkiValid ? <Badge tone="up">Reconnu par les autorités</Badge> : <Badge tone="warn">Auto-signé ou non reconnu</Badge>}
            </span>
            <Fingerprint hex={cert.info.sha256} />
          </div>
          <p className="m-0 text-[12px] leading-[1.55] text-mute">
            Compare-la avec celle de ton serveur (par exemple <span className="font-mono">openssl x509 -noout -fingerprint -sha256 -in cert.pem</span>). En l’épinglant, Kyro refusera tout autre certificat pour ce serveur.
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={onCancel}>Annuler</Button>
            <Button variant="outline" disabled={!cert.info.webpkiValid} title={cert.info.webpkiValid ? undefined : 'Ce certificat n’est pas reconnu par les autorités : seule l’épinglage est possible.'} onClick={() => onChoose('webpki')}>
              Utiliser la validation normale
            </Button>
            <Button variant="primary" onClick={() => onChoose('pinned')}>
              Faire confiance à ce certificat
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}

function CbfForm({ d, set, network, tor }: { d: BtcDraft; set: (p: Partial<BtcDraft>) => void; network: 'mainnet' | 'testnet'; tor: boolean }) {
  const estimate = d.birthMode === 'date' ? estimateBirthHeight(d.birthDate, network) : null;
  return (
    <div className="flex flex-col gap-3">
      <Field
        label="Pairs supplémentaires (facultatif)"
        hint={`Un par ligne : « ip:port » ou « adresse.onion:port » (v3), jamais un nom d’hôte (aucune requête DNS). Kyro a déjà sa liste de pairs servant les filtres${tor ? ', .onion d’abord' : ''}.`}
      >
        <textarea
          value={d.cbfPeers}
          onChange={(e) => set({ cbfPeers: e.target.value })}
          rows={3}
          spellCheck={false}
          placeholder={network === 'testnet' ? 'exemple.onion:48333\n203.0.113.5:48333' : 'exemple.onion:8333\n203.0.113.5:8333'}
          className="w-full resize-y rounded-ctl border border-line-2 bg-bg px-3.5 py-2.5 font-mono text-[13px] text-text placeholder:text-faint focus:border-ice-line"
        />
      </Field>
      <div className="flex flex-col gap-2">
        <span className="eyebrow">Point de départ (date de naissance du coffre)</span>
        <Segmented
          label="Point de départ des filtres"
          value={d.birthMode}
          onChange={(birthMode) => set({ birthMode })}
          options={[
            { value: 'genesis', label: 'Depuis le début' },
            { value: 'date', label: 'Depuis une date' },
            { value: 'height', label: 'Depuis un bloc' },
          ]}
          className="self-start"
        />
        {d.birthMode === 'date' && (
          <div className="flex items-center gap-3">
            <Input type="date" value={d.birthDate} onChange={(e) => set({ birthDate: e.target.value })} max={new Date().toISOString().slice(0, 10)} className="w-[200px]" />
            {estimate !== null && <span className="text-[12px] text-mute">≈ bloc {fmtNumber(estimate, 0)} (marge d’une semaine incluse)</span>}
          </div>
        )}
        {d.birthMode === 'height' && <Input value={d.birthHeight} inputMode="numeric" onChange={(e) => set({ birthHeight: e.target.value.replace(/\D/g, '') })} placeholder="ex. 90000" className="w-[200px] font-mono text-[13px]" />}
        <span className="text-[12px] leading-[1.45] text-faint">
          Accélère la première synchronisation : les filtres des blocs plus anciens ne sont pas lus. Choisis une date antérieure à ta première transaction, sinon elle n’apparaîtra pas.
        </span>
      </div>
      <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
        <span className="block">
          <strong className="font-semibold">Pas de mempool :</strong> un paiement reçu n’apparaît qu’une fois inclus dans un bloc ; tes propres envois s’affichent « en attente ».
        </span>
        <span className="block">
          <strong className="font-semibold">Frais :</strong> moyenne des frais payés dans les derniers blocs, pas une estimation du mempool. Le tarif personnalisé reste disponible.
        </span>
      </Notice>
    </div>
  );
}

const CBF_STEPS: Array<{ key: 'headers' | 'filters' | 'blocks'; label: string }> = [
  { key: 'headers', label: 'En-têtes' },
  { key: 'filters', label: 'Filtres' },
  { key: 'blocks', label: 'Blocs' },
];

/** Compact-filter sync: phases, progress, peers. Driven by the `cbf-status` event. */
function CbfPanel() {
  const { status, error } = useCbf();
  const [busy, setBusy] = useState(false);
  const st = status;
  const running = st !== null && (st.state === 'connecting' || st.state === 'headers' || st.state === 'filters');
  const phaseIndex = !st ? -1 : st.state === 'headers' || st.state === 'connecting' ? 0 : st.state === 'filters' ? 1 : st.state === 'synced' ? 3 : -1;
  const pct = st?.state === 'filters' ? Math.round(st.progress * 100) : st?.state === 'synced' ? 100 : null;
  const sync = async () => {
    setBusy(true);
    await cbfStore.sync();
    setBusy(false);
  };
  return (
    <div className="flex flex-col gap-3 rounded-box border border-line bg-raised px-4 py-3.5">
      <div className="flex items-center justify-between gap-3">
        <span className="flex flex-col gap-0.5">
          <span className="text-[13px] font-semibold">Synchronisation par filtres compacts</span>
          <span className="text-[12px] text-mute">
            {st ? `${cbfPhaseLabel(st)} · ${st.peers.length} pair${st.peers.length > 1 ? 's' : ''}${st.tor ? ' via Tor' : ' en direct'}` : 'État inconnu'}
          </span>
        </span>
        {st && <Badge tone={st.state === 'synced' ? 'up' : st.state === 'error' ? 'down' : running ? 'ice' : 'mute'}>{st.state === 'synced' ? 'À jour' : st.state === 'error' ? 'Erreur' : running ? 'En cours' : 'En attente'}</Badge>}
      </div>
      <ol className="m-0 grid list-none grid-cols-3 gap-2 p-0" aria-label="Étapes de la synchronisation">
        {CBF_STEPS.map((step, i) => {
          // Blocks matching our scripts are downloaded during the filter scan.
          const done = phaseIndex > i || (step.key === 'blocks' && phaseIndex >= 3);
          const active = phaseIndex === i || (step.key === 'blocks' && phaseIndex === 1 && (st?.matchedBlocks ?? 0) > 0);
          const detail =
            step.key === 'headers'
              ? st?.tipHeight != null
                ? `bloc ${fmtNumber(st.tipHeight, 0)}`
                : '—'
              : step.key === 'filters'
                ? st?.scannedHeight != null
                  ? `jusqu’au bloc ${fmtNumber(st.scannedHeight, 0)}`
                  : `depuis le bloc ${fmtNumber(st?.birthHeight ?? 0, 0)}`
                : `${st?.matchedBlocks ?? 0} téléchargé${(st?.matchedBlocks ?? 0) > 1 ? 's' : ''}`;
          return (
            <li key={step.key} aria-current={active ? 'step' : undefined} className={cn('flex flex-col gap-0.5 rounded-ctl border px-3 py-2', done ? 'border-up/30 bg-up/[.05]' : active ? 'border-ice-line bg-ice/[.06]' : 'border-line bg-card')}>
              <span className="flex items-center gap-1.5 text-[12px] font-semibold">
                {done ? <IconCheck size={12} className="text-up" /> : active ? <Spinner className="size-3 border-[1.5px] text-ice" /> : <span className="size-1.5 rounded-full bg-faint" />}
                {step.label}
              </span>
              <span className="font-mono text-[11px] text-mute">{detail}</span>
            </li>
          );
        })}
      </ol>
      {pct !== null && (
        <div role="status" className="flex flex-col gap-1.5">
          <div className="h-1.5 overflow-hidden rounded-full bg-control-2">
            <div className="h-full rounded-full bg-ice transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-[12px] text-mute">
            {st?.state === 'synced' ? `À jour${st.lastSyncUnix ? ` · dernière synchronisation à ${new Date(st.lastSyncUnix * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}` : ''}` : `Filtres : ${pct}\u202f%`} · {st?.watchedScripts ?? 0} scripts surveillés
          </span>
        </div>
      )}
      {st && st.peers.length > 0 && (
        <details className="text-[12px] text-mute">
          <summary className="cursor-pointer select-none">Pairs connectés ({st.peers.length})</summary>
          <ul className="m-0 mt-1.5 flex list-none flex-col gap-0.5 p-0 font-mono text-[11px]">
            {st.peers.map((p) => (
              <li key={p} className="truncate">
                {p}
              </li>
            ))}
          </ul>
        </details>
      )}
      {st?.state === 'error' && st.message && <Notice tone="error">{st.message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <div>
        <Button variant="outline" size="sm" onClick={() => void sync()} disabled={busy || running}>
          {(busy || running) && <Spinner />} {running ? 'Synchronisation en cours' : 'Synchroniser maintenant'}
        </Button>
      </div>
    </div>
  );
}

function CoreForm({ d, set, savedIsCore, passwordLost, tor }: { d: BtcDraft; set: (p: Partial<BtcDraft>) => void; savedIsCore: boolean; passwordLost: boolean; tor: boolean }) {
  const local = coreIsLocal(d.coreUrl);
  return (
    <div className="flex flex-col gap-3">
      <Field label="URL RPC du nœud" hint="http:// seulement pour une adresse locale ou du réseau local ; sinon https:// ou .onion (Tor).">
        <Input value={d.coreUrl} onChange={(e) => set({ coreUrl: e.target.value })} placeholder="http://127.0.0.1:48332" className="font-mono text-[13px]" />
      </Field>
      {d.coreUrl.trim() &&
        (local ? (
          <Notice icon={<IconInfo size={16} className="mt-0.5 shrink-0 text-ice" />}>
            <strong className="font-semibold text-text">Nœud local : connexion directe, sans Tor.</strong> Tor ne peut pas joindre ton réseau local, et ce n’est pas utile : la requête ne quitte pas ta machine ou ton réseau.
          </Notice>
        ) : (
          <span className="text-[12px] text-mute">Nœud distant : {tor ? 'joint via Tor.' : 'joint directement (Tor désactivé) : il voit ton adresse IP.'}</span>
        ))}
      <div className="flex flex-col gap-2">
        <span className="eyebrow">Authentification</span>
        <Segmented
          label="Authentification Bitcoin Core"
          value={d.authKind}
          onChange={(authKind) => set({ authKind })}
          options={[
            { value: 'cookie', label: 'Fichier .cookie (recommandé)' },
            { value: 'userpass', label: 'Utilisateur et mot de passe' },
          ]}
          className="self-start"
        />
      </div>
      {d.authKind === 'cookie' ? (
        <CookiePicker d={d} set={set} local={local} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Utilisateur (rpcuser)">
              <Input value={d.user} onChange={(e) => set({ user: e.target.value })} placeholder="kyro" className="font-mono text-[13px]" />
            </Field>
            <Field label="Mot de passe (rpcpassword)" hint={d.hasPassword && !passwordLost ? 'Enregistré. Laisse vide pour le garder.' : undefined}>
              <Input type="password" autoComplete="off" value={d.password} onChange={(e) => set({ password: e.target.value })} placeholder={d.hasPassword && !passwordLost ? '•••••••• (inchangé)' : ''} className="font-mono text-[13px]" />
            </Field>
          </div>
          {passwordLost && savedIsCore && <span className="text-[12px] text-warn">URL ou utilisateur modifié : ressaisis le mot de passe (l’ancien n’est réutilisé que pour le même nœud et le même utilisateur).</span>}
          <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
            Le mot de passe est stocké <strong className="font-semibold">en clair</strong> dans le dossier de l’app (jamais renvoyé à l’interface). Préfère le fichier .cookie.
          </Notice>
        </>
      )}
    </div>
  );
}

/**
 * `.cookie` chosen in the system file picker opened by Rust (`btc_core_pick_cookie`): the
 * interface cannot type a path, so it cannot point Kyro at another file (settings, vault…).
 */
function CookiePicker({ d, set, local }: { d: BtcDraft; set: (p: Partial<BtcDraft>) => void; local: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await call('btc_core_pick_cookie');
      if (res.path) set({ cookiePath: res.path });
    } catch (e) {
      setError(toIpcError(e).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Field label="Fichier .cookie" hint="Recommandé : Bitcoin Core le régénère à chaque démarrage et Kyro le relit à chaque requête, aucun mot de passe n’est stocké. Il se trouve dans le dossier de données du nœud (sous macOS et Linux, affiche les fichiers cachés pour le voir).">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2.5">
          <Button variant="outline" size="md" disabled={busy || !local} onClick={() => void pick()}>
            {busy && <Spinner />} Choisir le fichier .cookie
          </Button>
          <span className={cn('min-w-0 truncate font-mono text-[12.5px]', d.cookiePath ? 'text-text2' : 'text-faint')} title={d.cookiePath || undefined}>
            {d.cookiePath || 'aucun fichier choisi'}
          </span>
        </div>
        {!local && d.coreUrl.trim() && <span className="text-[12px] text-warn">Le fichier .cookie n’est envoyé qu’à un nœud local ou de ton réseau local. Pour un nœud distant, utilise l’utilisateur et le mot de passe RPC.</span>}
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Field>
  );
}

/** Bitcoin Core watch-only wallet: setup + rescan progress (polls a local command). */
function CoreWallet() {
  const pf = usePortfolio();
  const [status, setStatus] = useState<CoreStatus | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'now' | 'date'>('now');
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const wasImporting = useRef(false);

  const refresh = async () => {
    try {
      const s = await call('btc_core_status');
      setStatus(s);
      setFailure(null);
      return s;
    } catch (e) {
      setFailure(toFailure(e));
      return null;
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  // Poll while the import / rescan runs.
  const importing = status?.state === 'importing';
  useEffect(() => {
    if (!importing) return;
    wasImporting.current = true;
    const id = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(id);
  }, [importing]);
  useEffect(() => {
    if (status?.state === 'ready' && wasImporting.current) {
      wasImporting.current = false;
      pf.refresh();
    }
  }, [status?.state]);

  const rescanFrom = useMemo(() => {
    if (mode === 'now') return 'now' as const;
    const t = Date.parse(`${date}T00:00:00Z`);
    return Number.isFinite(t) ? Math.floor(t / 1000) : null;
  }, [mode, date]);

  const setup = async () => {
    if (rescanFrom === null) return;
    setBusy(true);
    setFailure(null);
    try {
      setStatus(await call('btc_core_setup', { rescanFrom }));
      setOpen(false);
      wasImporting.current = true;
    } catch (e) {
      setFailure(toFailure(e));
    } finally {
      setBusy(false);
    }
  };

  const pct = status?.scanProgress !== undefined ? Math.round(status.scanProgress * 100) : null;

  return (
    <div className="flex flex-col gap-3 rounded-box border border-line bg-raised px-4 py-3.5">
      <div className="flex items-center justify-between gap-3">
        <span className="flex flex-col gap-0.5">
          <span className="text-[13px] font-semibold">Portefeuille de surveillance</span>
          <span className="font-mono text-[12px] text-mute">{status?.wallet ?? 'kyro-watch-…'}</span>
        </span>
        {status && (
          <Badge tone={status.state === 'ready' ? 'up' : status.state === 'error' ? 'down' : status.state === 'importing' ? 'ice' : 'warn'}>
            {status.state === 'ready' ? 'Prêt' : status.state === 'importing' ? 'Import en cours' : status.state === 'error' ? 'Erreur' : status.state === 'not-configured' ? 'Nœud non enregistré' : 'À configurer'}
          </Badge>
        )}
      </div>
      <p className="m-0 text-[12px] leading-[1.5] text-mute">
        Kyro crée sur ton nœud un portefeuille <strong className="font-semibold text-text2">sans clé privée</strong> et y importe tes 4 descripteurs publics (SegWit et Taproot, réception et monnaie). Ton nœud ne peut rien signer.
      </p>
      {importing && (
        <div role="status" className="flex flex-col gap-1.5">
          <div className="h-1.5 overflow-hidden rounded-full bg-control-2">
            <div className={cn('h-full rounded-full bg-ice transition-[width]', pct === null && 'animate-pulse')} style={{ width: `${pct ?? 15}%` }} />
          </div>
          <span className="text-[12px] text-mute">
            {pct === null ? 'Import des descripteurs…' : `Rescan de la blockchain : ${pct} %${status?.scanDurationSecs !== undefined ? ` · ${status.scanDurationSecs} s` : ''}.`} Tu peux quitter cet écran, le nœud continue.
          </span>
        </div>
      )}
      {status?.error && <Notice tone="error">{status.error}</Notice>}
      {failure && <FailureNotice failure={failure} />}
      {status?.state !== 'importing' && (
        <div>
          <Button variant={status?.state === 'ready' ? 'outline' : 'primary'} onClick={() => setOpen(true)}>
            {status?.state === 'ready' ? 'Reconfigurer le portefeuille de surveillance' : 'Configurer le portefeuille de surveillance'}
          </Button>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen} title="Configurer le portefeuille de surveillance" className="w-[560px]">
        <p className="m-0 text-[13px] leading-[1.55] text-text2">Pour retrouver tes transactions passées, ton nœud doit relire la blockchain (rescan) depuis leur date.</p>
        <div role="radiogroup" aria-label="Point de départ du rescan" className="flex flex-col gap-2">
          {(
            [
              ['now', 'Maintenant (recommandé)', 'Pour un coffre neuf : aucune transaction passée à chercher, prêt en quelques secondes.'],
              ['date', 'Depuis une date', 'Retrouve les transactions depuis cette date. Le rescan peut prendre de longues minutes, voire des heures sur mainnet ; le nœud reste utilisable.'],
            ] as const
          ).map(([value, label, desc]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              onClick={() => setMode(value)}
              className={cn('flex flex-col gap-0.5 rounded-box px-4 py-3 text-left', mode === value ? 'border-[1.5px] border-ice bg-ice/8' : 'border border-line bg-raised hover:border-line-3')}
            >
              <span className="text-[14px] font-semibold">{label}</span>
              <span className="text-[12px] leading-[1.5] text-mute">{desc}</span>
            </button>
          ))}
        </div>
        {mode === 'date' && (
          <Field label="Date de ta première transaction (ou avant)">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} max={new Date().toISOString().slice(0, 10)} className="w-[200px]" />
          </Field>
        )}
        {failure && <FailureNotice failure={failure} />}
        <div className="flex justify-end gap-2">
          <Button onClick={() => setOpen(false)} disabled={busy}>
            Annuler
          </Button>
          <Button variant="primary" onClick={() => void setup()} disabled={busy || rescanFrom === null}>
            {busy && <Spinner />} Lancer la configuration
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------- EVM / Solana

function RpcRow({
  title,
  subtitle,
  defaultUrl,
  saved,
  target,
  onSave,
  defaultSees,
  last,
}: {
  title: string;
  subtitle: string;
  defaultUrl: string;
  saved: string | undefined;
  target: (url: string) => ServerTestTarget;
  onSave: (url: string | null) => Promise<void>;
  /** What the default sees again once restored. */
  defaultSees: string;
  last?: boolean;
}) {
  const { settings } = useApp();
  const [url, setUrl] = useState(saved ?? '');
  useEffect(() => setUrl(saved ?? ''), [saved]);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [result, setResult] = useState<ServerTestResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDefault, setConfirmDefault] = useState(false);
  const clean = url.trim();
  const dirty = clean !== (saved ?? '');
  const hint = clean ? checkServerUrl(clean, settings.tor.enabled) : null;
  const defaultHost = new URL(defaultUrl).host;

  const reset = () => {
    setFailure(null);
    setResult(null);
    setNotice(null);
  };
  const test = async () => {
    reset();
    setBusy('test');
    try {
      setResult(await call('server_test', { target: target(clean) }));
    } catch (e) {
      setFailure(toFailure(e));
    } finally {
      setBusy(null);
    }
  };
  const save = async (value: string | null) => {
    reset();
    setBusy('save');
    try {
      await onSave(value);
      setConfirmDefault(false);
      setNotice(value ? 'Enregistré : Kyro n’utilise plus que ce serveur pour cette chaîne.' : `Serveur par défaut rétabli : ${defaultHost} voit maintenant ${defaultSees}.`);
    } catch (e) {
      setFailure(toFailure(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={cn('flex flex-col gap-2.5 py-3.5', !last && 'border-b border-line')}>
      <div className="flex items-center justify-between gap-3">
        <span className="flex flex-col">
          <span className="text-[14px] font-semibold">{title}</span>
          <span className="text-[12px] text-mute">{subtitle}</span>
        </span>
        {saved ? <Badge tone="ice">Serveur perso</Badge> : <Badge>Par défaut</Badge>}
      </div>
      <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={`${defaultUrl} (par défaut)`} aria-label={`RPC ${title}`} className="font-mono text-[13px]" />
      {hint && (
        <span className="flex items-center gap-1.5 text-[12px] text-warn">
          <IconWarn size={13} /> {hint}
        </span>
      )}
      {failure && <FailureNotice failure={failure} />}
      {result && !failure && <TestOk result={result} />}
      {notice && !failure && <Notice tone={notice.startsWith('Serveur par défaut') ? 'warn' : 'success'}>{notice}</Notice>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void test()} disabled={!clean || busy !== null}>
          {busy === 'test' && <Spinner />} Tester la connexion
        </Button>
        <Button size="sm" variant="primary" onClick={() => (clean ? void save(clean) : setConfirmDefault(true))} disabled={!dirty || busy !== null}>
          {busy === 'save' && <Spinner />} {clean || !saved ? 'Enregistrer' : 'Revenir au serveur par défaut'}
        </Button>
        {saved && !dirty && (
          <Button size="sm" variant="ghost" onClick={() => setConfirmDefault(true)} disabled={busy !== null}>
            Revenir au serveur par défaut
          </Button>
        )}
      </div>
      <BackToDefaultDialog
        open={confirmDefault}
        host={defaultHost}
        sees={defaultSees}
        busy={busy === 'save'}
        failure={confirmDefault ? failure : null}
        onConfirm={() => void save(null)}
        onCancel={() => {
          setConfirmDefault(false);
          setUrl(saved ?? '');
        }}
      />
    </div>
  );
}

/**
 * Litecoin / Dogecoin: Rust accepts the default or an Esplora server (docs/IPC.md §2.4).
 * Dogecoin mainnet defaults to Komodo's public ElectrumX servers; Dogecoin testnet has NO public
 * default: an unconfigured Dogecoin testnet says so, it never pretends to load.
 */
function UtxoServerCard({ coin }: { coin: 'litecoin' | 'dogecoin' }) {
  const { settings, network } = useApp();
  const tor = settings.tor.enabled;
  const nk = network === 'mainnet' ? 'mainnet' : 'testnet';
  const saved = settings.servers[coin]?.[nk];
  const savedUrl = saved?.kind === 'esplora' ? saved.url : '';
  const doge = coin === 'dogecoin';
  const name = doge ? 'Dogecoin' : 'Litecoin';
  /** Dogecoin testnet only: no public server found, the user must set one. */
  const noDefault = doge && nk === 'testnet';
  /** Host(s) of the default, as the user sees them (Rust: `servers::utxo_default_*`). */
  const defaultHosts = doge ? 'doge.electrum1.cipig.net (et doge.electrum2.cipig.net en secours)' : 'litecoinspace.org';
  const [kind, setKind] = useState<'default' | 'esplora'>(savedUrl ? 'esplora' : 'default');
  const [url, setUrl] = useState(savedUrl);
  useEffect(() => {
    setKind(savedUrl ? 'esplora' : 'default');
    setUrl(savedUrl);
  }, [savedUrl]);
  const saveServers = useSaveServers();
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [result, setResult] = useState<ServerTestResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDefault, setConfirmDefault] = useState(false);
  const clean = url.trim();
  const hint = kind === 'esplora' && clean ? checkServerUrl(clean, tor) : null;
  const dirty = kind === 'esplora' ? clean !== savedUrl : !!savedUrl;
  const reset = () => {
    setFailure(null);
    setResult(null);
    setNotice(null);
  };
  const test = async () => {
    reset();
    setBusy('test');
    try {
      setResult(await call('server_test', { target: { family: coin, network: nk, server: kind === 'esplora' ? { kind: 'esplora', url: clean } : { kind: 'default' } } }));
    } catch (e) {
      setFailure(toFailure(e));
    } finally {
      setBusy(null);
    }
  };
  const save = async (toDefault: boolean) => {
    reset();
    setBusy('save');
    try {
      await saveServers((s) => {
        s[coin] = { ...(s[coin] ?? {}) };
        if (toDefault) delete s[coin][nk];
        else s[coin][nk] = { kind: 'esplora', url: clean };
      });
      setConfirmDefault(false);
      setNotice(
        toDefault
          ? noDefault
            ? 'Serveur retiré : Dogecoin testnet n’a plus de serveur, soldes et envois indisponibles jusqu’à ce que tu en configures un.'
            : `Serveur par défaut rétabli : ${defaultHosts} voit maintenant tes adresses ${name} et tes transactions.`
          : `Serveur ${name} enregistré. Kyro n’utilise plus que lui pour ${name}.`,
      );
    } catch (e) {
      setFailure(toFailure(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title={network === 'testnet' ? `${name} ${doge ? 'testnet' : 'testnet4'}` : name}
      badge={savedUrl ? <Badge tone="ice">Serveur perso · Esplora</Badge> : noDefault ? <Badge tone="warn">Aucun serveur</Badge> : <Badge>Par défaut</Badge>}
    >
      <Segmented
        label={`Serveur ${name}`}
        value={kind}
        onChange={(k) => {
          reset();
          setKind(k);
        }}
        options={[
          { value: 'default', label: noDefault ? 'Aucun (pas de serveur public)' : 'Par défaut' },
          { value: 'esplora', label: 'Esplora perso' },
        ]}
        className="self-start"
      />
      {kind === 'default' && noDefault ? (
        <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
          <strong className="font-semibold">Aucun serveur public gratuit : configure ton serveur.</strong> Aucun serveur public gratuit n’a été trouvé pour Dogecoin testnet (le mainnet, lui, a un serveur par défaut). Tant que tu n’as pas indiqué ton serveur Esplora (electrs-dogecoin), Kyro n’affiche ni solde ni historique Dogecoin et ne peut pas envoyer.
        </Notice>
      ) : (
        <Sees>
          {kind === 'default'
            ? doge
              ? `Les serveurs ElectrumX publics de Komodo (${defaultHosts}) voient tes adresses Dogecoin et tes transactions ; ${tor ? 'l’IP d’un relais de sortie Tor' : 'et ton adresse IP'}. Ils ne peuvent pas te faire signer un faux montant : avant chaque signature, Kyro vérifie chaque pièce dans sa transaction d’origine.`
              : `litecoinspace.org voit tes adresses Litecoin et tes transactions ; ${tor ? 'l’IP d’un relais de sortie Tor' : 'et ton adresse IP'}.`
            : `Ton serveur Esplora voit tes adresses ${name} et tes transactions ; ${tor ? 'l’IP d’un relais de sortie Tor (aucune si .onion)' : 'et ton adresse IP'}.`}
        </Sees>
      )}
      {kind === 'esplora' && (
        <Field label={`URL de l’API Esplora ${name}`} hint={doge ? 'Par exemple un electrs-dogecoin (API Esplora). https://, ou http:// pour une adresse .onion (Tor).' : 'https://, ou http:// pour une adresse .onion (Tor). Jamais d’identifiants dans l’URL.'}>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={doge ? 'https://mon-electrs-dogecoin.example/api' : 'https://mon-noeud-litecoin.example/api'} aria-label={`URL Esplora ${name}`} className="font-mono text-[13px]" />
        </Field>
      )}
      {hint && (
        <span className="flex items-center gap-1.5 text-[12px] text-warn">
          <IconWarn size={13} /> {hint}
        </span>
      )}
      {failure && <FailureNotice failure={failure} />}
      {result && !failure && <TestOk result={result} />}
      {notice && !failure && <Notice tone={notice.startsWith('Serveur par défaut') || notice.startsWith('Serveur retiré') ? 'warn' : 'success'}>{notice}</Notice>}
      <div className="flex flex-wrap gap-2">
        {(kind === 'esplora' || !noDefault) && (
          <Button onClick={() => void test()} disabled={busy !== null || (kind === 'esplora' && !clean)}>
            {busy === 'test' && <Spinner />} Tester la connexion
          </Button>
        )}
        <Button variant="primary" onClick={() => (kind === 'esplora' ? void save(false) : setConfirmDefault(true))} disabled={busy !== null || !dirty || (kind === 'esplora' && !clean)}>
          {busy === 'save' && <Spinner />} {kind === 'default' && savedUrl ? (noDefault ? 'Retirer le serveur' : 'Revenir au serveur par défaut') : 'Enregistrer'}
        </Button>
      </div>
      <BackToDefaultDialog
        open={confirmDefault}
        host={noDefault ? 'Dogecoin' : doge ? 'doge.electrum1.cipig.net' : 'litecoinspace.org'}
        {...(noDefault ? { title: 'Retirer ton serveur Dogecoin ?', body: 'Dogecoin testnet n’a pas de serveur public : sans le tien, Kyro n’affiche plus ni solde ni historique Dogecoin et ne peut plus envoyer.' } : {})}
        sees={noDefault ? 'rien : Dogecoin testnet n’aura plus de serveur (soldes et envois indisponibles)' : `tes adresses ${name} et tes transactions`}
        busy={busy === 'save'}
        failure={confirmDefault ? failure : null}
        onConfirm={() => void save(true)}
        onCancel={() => {
          setConfirmDefault(false);
          setKind('esplora');
        }}
      />
    </Card>
  );
}

// ---------------------------------------------------------------- TRON

/**
 * TRON: TronGrid by default (api.trongrid.io / nile.trongrid.io) or the user's java-tron HTTP API
 * (FullNode). Balances, resources, building and broadcast work with any java-tron node; the
 * history needs TronGrid's `/v1` API, which a plain node does not have (tron_txs then fails).
 */
function TronServerCard() {
  const { settings, network, config } = useApp();
  const tor = settings.tor.enabled;
  const nk = network === 'mainnet' ? 'mainnet' : 'testnet';
  const defaultHost = network === 'mainnet' ? 'api.trongrid.io' : 'nile.trongrid.io';
  const saved = settings.servers.tron?.[nk];
  const savedUrl = saved?.kind === 'http' ? saved.url : '';
  const [kind, setKind] = useState<'default' | 'http'>(savedUrl ? 'http' : 'default');
  const [url, setUrl] = useState(savedUrl);
  useEffect(() => {
    setKind(savedUrl ? 'http' : 'default');
    setUrl(savedUrl);
  }, [savedUrl]);
  const saveServers = useSaveServers();
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [result, setResult] = useState<ServerTestResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDefault, setConfirmDefault] = useState(false);
  const clean = url.trim();
  const hint = kind === 'http' && clean ? checkServerUrl(clean, tor) : null;
  const dirty = kind === 'http' ? clean !== savedUrl : !!savedUrl;
  const reset = () => {
    setFailure(null);
    setResult(null);
    setNotice(null);
  };
  const test = async () => {
    reset();
    setBusy('test');
    try {
      setResult(await call('server_test', { target: { family: 'tron', network: nk, server: kind === 'http' ? { kind: 'http', url: clean } : { kind: 'default' } } }));
    } catch (e) {
      setFailure(toFailure(e));
    } finally {
      setBusy(null);
    }
  };
  const save = async (toDefault: boolean) => {
    reset();
    setBusy('save');
    try {
      await saveServers((s) => {
        s.tron = { ...(s.tron ?? {}) };
        if (toDefault) delete s.tron[nk];
        else s.tron[nk] = { kind: 'http', url: clean };
      });
      setConfirmDefault(false);
      setNotice(toDefault ? `Serveur par défaut rétabli : ${defaultHost} voit maintenant ton adresse TRON et tes transactions.` : 'Serveur TRON enregistré. Kyro n’utilise plus que lui pour TRON.');
    } catch (e) {
      setFailure(toFailure(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title={network === 'testnet' ? 'TRON Nile (testnet)' : 'TRON'}
      badge={savedUrl ? <Badge tone="ice">Nœud perso · java-tron</Badge> : <Badge>Par défaut · TronGrid</Badge>}
    >
      <Segmented
        label="Serveur TRON"
        value={kind}
        onChange={(k) => {
          reset();
          setKind(k);
        }}
        options={[
          { value: 'default', label: 'TronGrid' },
          { value: 'http', label: 'Nœud java-tron perso' },
        ]}
        className="self-start"
      />
      <Sees>
        {kind === 'default'
          ? `${defaultHost} voit ton adresse TRON et tes transactions ; ${tor ? 'l’IP d’un relais de sortie Tor' : 'et ton adresse IP'}.`
          : `Ton nœud voit ton adresse TRON et tes transactions ; ${tor ? 'l’IP d’un relais de sortie Tor (aucune si .onion)' : 'et ton adresse IP'}.`}
      </Sees>
      <Notice icon={<IconInfo size={16} className="mt-0.5 shrink-0 text-ice" />}>
        <strong className="font-semibold text-text">Historique : API /v1 de TronGrid requise.</strong> Soldes, ressources, construction et diffusion marchent avec n’importe quel nœud java-tron (API HTTP <span className="font-mono">/wallet</span>). L’historique, lui, vient de l’API <span className="font-mono">/v1</span> de TronGrid : un nœud java-tron seul ne la fournit pas, l’historique TRON restera alors indisponible.
      </Notice>
      {kind === 'http' && (
        <Field label="URL de l’API HTTP java-tron (FullNode)" hint="https://, ou http:// pour une adresse .onion (Tor). Jamais d’identifiants dans l’URL.">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mon-noeud-tron.example" aria-label="URL du nœud TRON" className="font-mono text-[13px]" />
        </Field>
      )}
      {config?.hasTrongridKey && kind === 'default' && <span className="text-[12px] text-mute">Clé API TronGrid configurée (Réglages › Clés API ou environnement) : limites de débit plus hautes.</span>}
      {hint && (
        <span className="flex items-center gap-1.5 text-[12px] text-warn">
          <IconWarn size={13} /> {hint}
        </span>
      )}
      {failure && <FailureNotice failure={failure} />}
      {result && !failure && <TestOk result={result} />}
      {notice && !failure && <Notice tone={notice.startsWith('Serveur par défaut') ? 'warn' : 'success'}>{notice}</Notice>}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void test()} disabled={busy !== null || (kind === 'http' && !clean)}>
          {busy === 'test' && <Spinner />} Tester la connexion
        </Button>
        <Button variant="primary" onClick={() => (kind === 'http' ? void save(false) : setConfirmDefault(true))} disabled={busy !== null || !dirty || (kind === 'http' && !clean)}>
          {busy === 'save' && <Spinner />} {kind === 'default' && savedUrl ? 'Revenir à TronGrid' : 'Enregistrer'}
        </Button>
      </div>
      <BackToDefaultDialog
        open={confirmDefault}
        host={defaultHost}
        sees="ton adresse TRON et tes transactions"
        busy={busy === 'save'}
        failure={confirmDefault ? failure : null}
        onConfirm={() => void save(true)}
        onCancel={() => {
          setConfirmDefault(false);
          setKind('http');
        }}
      />
    </Card>
  );
}

// ---------------------------------------------------------------- XRP Ledger

/**
 * XRP Ledger: Ripple's public rippled by default (s.altnet.rippletest.net on testnet,
 * xrplcluster.com on mainnet) or the user's rippled JSON-RPC. Kyro checks `network_id` before
 * saving (0 mainnet, 1 testnet). Everything (reserve, tags, history) comes from that server.
 */
function XrpServerCard() {
  const { settings, network } = useApp();
  const tor = settings.tor.enabled;
  const nk = network === 'mainnet' ? 'mainnet' : 'testnet';
  const defaultHost = network === 'mainnet' ? 'xrplcluster.com' : 's.altnet.rippletest.net';
  const saved = settings.servers.xrp?.[nk];
  const savedUrl = saved?.kind === 'jsonRpc' ? saved.url : '';
  const [kind, setKind] = useState<'default' | 'jsonRpc'>(savedUrl ? 'jsonRpc' : 'default');
  const [url, setUrl] = useState(savedUrl);
  useEffect(() => {
    setKind(savedUrl ? 'jsonRpc' : 'default');
    setUrl(savedUrl);
  }, [savedUrl]);
  const saveServers = useSaveServers();
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [result, setResult] = useState<ServerTestResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDefault, setConfirmDefault] = useState(false);
  const clean = url.trim();
  const hint = kind === 'jsonRpc' && clean ? checkServerUrl(clean, tor) : null;
  const dirty = kind === 'jsonRpc' ? clean !== savedUrl : !!savedUrl;
  const reset = () => {
    setFailure(null);
    setResult(null);
    setNotice(null);
  };
  const test = async () => {
    reset();
    setBusy('test');
    try {
      setResult(await call('server_test', { target: { family: 'xrp', network: nk, server: kind === 'jsonRpc' ? { kind: 'jsonRpc', url: clean } : { kind: 'default' } } }));
    } catch (e) {
      setFailure(toFailure(e));
    } finally {
      setBusy(null);
    }
  };
  const save = async (toDefault: boolean) => {
    reset();
    setBusy('save');
    try {
      await saveServers((s) => {
        s.xrp = { ...(s.xrp ?? {}) };
        if (toDefault) delete s.xrp[nk];
        else s.xrp[nk] = { kind: 'jsonRpc', url: clean };
      });
      setConfirmDefault(false);
      setNotice(toDefault ? `Serveur par défaut rétabli : ${defaultHost} voit maintenant ton adresse XRP et tes paiements.` : 'Serveur XRP Ledger enregistré. Kyro n’utilise plus que lui pour XRP.');
    } catch (e) {
      setFailure(toFailure(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title={network === 'testnet' ? 'XRP Ledger testnet' : 'XRP Ledger'} badge={savedUrl ? <Badge tone="ice">Serveur perso · rippled</Badge> : <Badge>Par défaut</Badge>}>
      <Segmented
        label="Serveur XRP Ledger"
        value={kind}
        onChange={(k) => {
          reset();
          setKind(k);
        }}
        options={[
          { value: 'default', label: 'Par défaut' },
          { value: 'jsonRpc', label: 'Mon serveur rippled' },
        ]}
        className="self-start"
      />
      <Sees>
        {kind === 'default'
          ? `${defaultHost} voit ton adresse XRP et tes paiements ; ${tor ? 'l’IP d’un relais de sortie Tor' : 'et ton adresse IP'}.`
          : `Ton serveur rippled voit ton adresse XRP et tes paiements ; ${tor ? 'l’IP d’un relais de sortie Tor (aucune si .onion)' : 'et ton adresse IP'}.`}
      </Sees>
      {kind === 'jsonRpc' && (
        <Field label="URL JSON-RPC de ton rippled" hint={`Kyro vérifie le réseau (network_id ${network === 'mainnet' ? '0, mainnet' : '1, testnet'}) avant d’enregistrer. https://, ou http:// pour une adresse .onion (Tor).`}>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mon-rippled.example:51234/" aria-label="URL du serveur XRP" className="font-mono text-[13px]" />
        </Field>
      )}
      {hint && (
        <span className="flex items-center gap-1.5 text-[12px] text-warn">
          <IconWarn size={13} /> {hint}
        </span>
      )}
      {failure && <FailureNotice failure={failure} />}
      {result && !failure && <TestOk result={result} chainLabel="network_id" ledgerLabel="registre validé" />}
      {notice && !failure && <Notice tone={notice.startsWith('Serveur par défaut') ? 'warn' : 'success'}>{notice}</Notice>}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void test()} disabled={busy !== null || (kind === 'jsonRpc' && !clean)}>
          {busy === 'test' && <Spinner />} Tester la connexion
        </Button>
        <Button variant="primary" onClick={() => (kind === 'jsonRpc' ? void save(false) : setConfirmDefault(true))} disabled={busy !== null || !dirty || (kind === 'jsonRpc' && !clean)}>
          {busy === 'save' && <Spinner />} {kind === 'default' && savedUrl ? 'Revenir au serveur par défaut' : 'Enregistrer'}
        </Button>
      </div>
      <BackToDefaultDialog
        open={confirmDefault}
        host={defaultHost}
        sees="ton adresse XRP et tes paiements"
        busy={busy === 'save'}
        failure={confirmDefault ? failure : null}
        onConfirm={() => void save(true)}
        onCancel={() => {
          setConfirmDefault(false);
          setKind('jsonRpc');
        }}
      />
    </Card>
  );
}

// ---------------------------------------------------------------- Cardano

/**
 * Cardano: Koios by default (preprod.koios.rest / api.koios.rest, free keyless tier) or the user's
 * Koios-compatible REST API (`…/api/v1`). Kyro checks the genesis network magic before saving
 * (preprod 1, mainnet 764824073; preview refused). UTxOs, parameters, history and submission.
 */
function CardanoServerCard() {
  const { settings, network } = useApp();
  const tor = settings.tor.enabled;
  const nk = network === 'mainnet' ? 'mainnet' : 'testnet';
  const defaultHost = network === 'mainnet' ? 'api.koios.rest' : 'preprod.koios.rest';
  const saved = settings.servers.cardano?.[nk];
  const savedUrl = saved?.kind === 'koios' ? saved.url : '';
  const [kind, setKind] = useState<'default' | 'koios'>(savedUrl ? 'koios' : 'default');
  const [url, setUrl] = useState(savedUrl);
  useEffect(() => {
    setKind(savedUrl ? 'koios' : 'default');
    setUrl(savedUrl);
  }, [savedUrl]);
  const saveServers = useSaveServers();
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [result, setResult] = useState<ServerTestResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDefault, setConfirmDefault] = useState(false);
  const clean = url.trim();
  const hint = kind === 'koios' && clean ? checkServerUrl(clean, tor) : null;
  const dirty = kind === 'koios' ? clean !== savedUrl : !!savedUrl;
  const reset = () => {
    setFailure(null);
    setResult(null);
    setNotice(null);
  };
  const test = async () => {
    reset();
    setBusy('test');
    try {
      setResult(await call('server_test', { target: { family: 'cardano', network: nk, server: kind === 'koios' ? { kind: 'koios', url: clean } : { kind: 'default' } } }));
    } catch (e) {
      setFailure(toFailure(e));
    } finally {
      setBusy(null);
    }
  };
  const save = async (toDefault: boolean) => {
    reset();
    setBusy('save');
    try {
      await saveServers((s) => {
        s.cardano = { ...(s.cardano ?? {}) };
        if (toDefault) delete s.cardano[nk];
        else s.cardano[nk] = { kind: 'koios', url: clean };
      });
      setConfirmDefault(false);
      setNotice(toDefault ? `Serveur par défaut rétabli : ${defaultHost} voit maintenant ton adresse Cardano et tes transactions.` : 'Serveur Cardano enregistré. Kyro n’utilise plus que lui pour Cardano.');
    } catch (e) {
      setFailure(toFailure(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title={network === 'testnet' ? 'Cardano preprod' : 'Cardano'} badge={savedUrl ? <Badge tone="ice">Serveur perso · Koios</Badge> : <Badge>Par défaut · Koios</Badge>}>
      <Segmented
        label="Serveur Cardano"
        value={kind}
        onChange={(k) => {
          reset();
          setKind(k);
        }}
        options={[
          { value: 'default', label: 'Par défaut' },
          { value: 'koios', label: 'Mon serveur Koios' },
        ]}
        className="self-start"
      />
      <Sees>
        {kind === 'default'
          ? `${defaultHost} voit ton adresse Cardano (et donc tout ton historique : une seule adresse) ; ${tor ? 'l’IP d’un relais de sortie Tor' : 'et ton adresse IP'}.`
          : `Ton serveur Koios voit ton adresse Cardano (et donc tout ton historique : une seule adresse) ; ${tor ? 'l’IP d’un relais de sortie Tor (aucune si .onion)' : 'et ton adresse IP'}.`}
      </Sees>
      {kind === 'koios' && (
        <Field label="URL de l’API Koios (…/api/v1)" hint={`Kyro vérifie le réseau (magic ${network === 'mainnet' ? '764824073, mainnet' : '1, preprod'}) avant d’enregistrer. https://, ou http:// pour une adresse .onion (Tor). Blockfrost n’est pas pris en charge.`}>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mon-koios.example/api/v1" aria-label="URL du serveur Cardano" className="font-mono text-[13px]" />
        </Field>
      )}
      {hint && (
        <span className="flex items-center gap-1.5 text-[12px] text-warn">
          <IconWarn size={13} /> {hint}
        </span>
      )}
      {failure && <FailureNotice failure={failure} />}
      {result && !failure && <TestOk result={result} chainLabel="magic" />}
      {notice && !failure && <Notice tone={notice.startsWith('Serveur par défaut') ? 'warn' : 'success'}>{notice}</Notice>}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void test()} disabled={busy !== null || (kind === 'koios' && !clean)}>
          {busy === 'test' && <Spinner />} Tester la connexion
        </Button>
        <Button variant="primary" onClick={() => (kind === 'koios' ? void save(false) : setConfirmDefault(true))} disabled={busy !== null || !dirty || (kind === 'koios' && !clean)}>
          {busy === 'save' && <Spinner />} {kind === 'default' && savedUrl ? 'Revenir au serveur par défaut' : 'Enregistrer'}
        </Button>
      </div>
      <BackToDefaultDialog
        open={confirmDefault}
        host={defaultHost}
        sees="ton adresse Cardano et tes transactions"
        busy={busy === 'save'}
        failure={confirmDefault ? failure : null}
        onConfirm={() => void save(true)}
        onCancel={() => {
          setConfirmDefault(false);
          setKind('koios');
        }}
      />
    </Card>
  );
}

function EvmCard() {
  const { network, settings } = useApp();
  const saveServers = useSaveServers();
  const chains = evmChains(network);
  const tor = settings.tor.enabled;
  return (
    <Card title="Réseaux EVM" badge={<Badge>{chains.length === 1 ? '1 chaîne' : `${chains.length} chaînes`}</Badge>}>
      <Sees>Ton RPC voit ton adresse EVM et tes transactions signées ; {tor ? 'l’IP d’un relais de sortie Tor' : 'et ton adresse IP'}. Laisse vide pour le nœud public par défaut (publicnode.com, qui voit la même chose).</Sees>
      <div className="flex flex-col">
        {chains.map((c, i) => (
          <RpcRow
            key={c.key}
            title={c.name}
            subtitle={`chainId ${c.chainId}`}
            defaultUrl={c.rpcUrl}
            saved={settings.servers.evm[String(c.chainId)]?.url}
            target={(url) => ({ family: 'evm', chainId: c.chainId, server: { url } })}
            onSave={(url) =>
              saveServers((s) => {
                if (url) s.evm[String(c.chainId)] = { url };
                else delete s.evm[String(c.chainId)];
              })
            }
            defaultSees="ton adresse EVM et tes transactions"
            last={i === chains.length - 1}
          />
        ))}
      </div>
    </Card>
  );
}

function SolanaCard() {
  const { network, settings } = useApp();
  const saveServers = useSaveServers();
  const tor = settings.tor.enabled;
  const active = solChain(network).cluster;
  const clusters: Array<{ cluster: SolanaCluster; url: string }> = [
    { cluster: active, url: solChain(network).rpcUrl },
    { cluster: active === 'devnet' ? 'mainnet-beta' : 'devnet', url: solChain(network === 'testnet' ? 'mainnet' : 'testnet').rpcUrl },
  ];
  return (
    <Card title="Solana" badge={<Badge>un RPC par cluster</Badge>}>
      <Sees>Ton RPC voit ton adresse Solana, tes transactions signées et les tables d’adresses lues avant une signature ; {tor ? 'l’IP d’un relais de sortie Tor' : 'et ton adresse IP'}.</Sees>
      <div className="flex flex-col">
        {clusters.map(({ cluster, url }, i) => (
          <RpcRow
            key={cluster}
            title={`Solana ${cluster}`}
            subtitle={cluster === active ? 'utilisé sur ce réseau' : 'inactif tant que l’app tourne sur l’autre réseau'}
            defaultUrl={url}
            saved={settings.servers.solana[cluster]?.url}
            target={(u) => ({ family: 'solana', cluster, server: { url: u } })}
            onSave={(u) =>
              saveServers((s) => {
                if (u) s.solana[cluster] = { url: u };
                else delete s.solana[cluster];
              })
            }
            defaultSees="ton adresse Solana et tes transactions"
            last={i === clusters.length - 1}
          />
        ))}
      </div>
    </Card>
  );
}
