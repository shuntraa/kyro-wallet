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
//   sees the addresses again.

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
  type SolanaCluster,
} from '@kyro/shared';
import { evmChains, solChain } from '@kyro/chains';
import { useApp } from '../../state/app';
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

function TestOk({ result }: { result: ServerTestResult }) {
  const d = result.detected;
  const parts = [`${result.latencyMs} ms`];
  if (d.network) parts.push(`réseau ${d.network}`);
  if (d.chainId !== undefined) parts.push(`chainId ${d.chainId}`);
  if (d.blockHeight !== undefined) parts.push(`bloc ${fmtNumber(d.blockHeight, 0)}`);
  if (d.serverVersion) parts.push(d.serverVersion);
  if (d.genesisHash) parts.push(`genesis ${d.genesisHash.slice(0, 8)}…${d.genesisHash.slice(-6)}`);
  return (
    <div role="status" className="flex items-start gap-2 rounded-[12px] border border-up/30 bg-up/[.06] px-3.5 py-2.5 text-[12px] text-[#b8f3d8]">
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
    <section className="flex flex-col gap-3.5 rounded-[22px] border border-line bg-card px-[22px] py-[18px]">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[15px] font-semibold">{title}</span>
        {badge}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[12px] font-medium text-mute">{label}</span>
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

function BackToDefaultDialog({ open, host, sees, busy, failure, onConfirm, onCancel }: { open: boolean; host: string; sees: string; busy: boolean; failure: Failure | null; onConfirm: () => void; onCancel: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(v) => (v ? undefined : onCancel())} title={`Revenir à ${host} ?`} className="w-[520px]">
      <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
        Ton serveur ne sera plus utilisé. <strong className="font-semibold text-text">{host}</strong> verra de nouveau {sees}.
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
      <Card title="Réseaux et serveurs" badge={<Badge tone={network === 'testnet' ? 'warn' : 'up'}>{network === 'testnet' ? 'Testnet' : 'Mainnet'}</Badge>}>
        <p className="m-0 text-[13px] leading-[1.55] text-mute">
          {network === 'testnet' ? 'Bitcoin testnet4, Ethereum Sepolia et Solana devnet. ' : 'Bitcoin, Ethereum + 6 réseaux EVM (même adresse), Solana. '}
          Le réseau est fixé au lancement. Pour chaque chaîne, tu peux remplacer le serveur par défaut par le tien : Kyro vérifie qu’il est sur le bon réseau avant de l’enregistrer.
        </p>
        <Notice icon={<IconInfo size={16} className="mt-0.5 shrink-0 text-ice" />}>
          Un serveur personnalisé remplace celui par défaut <strong className="font-semibold text-text">sans repli</strong> : s’il ne répond plus, Kyro affiche une erreur et n’interroge jamais le serveur par défaut à sa place.{' '}
          {tor ? 'Tes serveurs sont joints via Tor (sauf un nœud Bitcoin Core local).' : 'Tor est désactivé : tes serveurs voient ton adresse IP.'}
        </Notice>
      </Card>
      <BitcoinCard />
      <EvmCard />
      <SolanaCard />
    </>
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
  };
  if (s.kind === 'esplora') d.esploraUrl = s.url;
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

function serverOf(d: BtcDraft): BtcServer {
  switch (d.kind) {
    case 'default':
      return { kind: 'default' };
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

  const server = serverOf(d);
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
    await runTest(serverOf(nd));
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
      setNotice('Serveur Bitcoin enregistré. Kyro n’utilise plus que lui pour Bitcoin.');
      if (d.kind === 'core') set({ password: '' });
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
        options={BTC_KINDS}
        className="self-start"
      />
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
          <div className="flex items-center justify-between gap-4 rounded-[14px] border border-line bg-raised px-4 py-3">
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
    <div aria-label={`Empreinte SHA-256 ${groups.join(' ')}`} className={cn('grid grid-cols-8 gap-x-2 gap-y-1 rounded-[12px] border border-ice-line bg-ice/[.06] font-mono text-ice-text', compact ? 'px-3 py-2 text-[11px]' : 'px-4 py-3 text-[13px]')}>
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
        <span className="text-[12px] font-medium text-mute">Authentification</span>
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
        <Field label="Chemin du fichier .cookie" hint="Recommandé : Bitcoin Core le régénère à chaque démarrage et Kyro le relit à chaque requête, aucun mot de passe n’est stocké.">
          <Input value={d.cookiePath} onChange={(e) => set({ cookiePath: e.target.value })} placeholder="C:\Users\toi\AppData\Roaming\Bitcoin\testnet4\.cookie" className="font-mono text-[13px]" />
        </Field>
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
    <div className="flex flex-col gap-3 rounded-[16px] border border-line bg-raised px-4 py-3.5">
      <div className="flex items-center justify-between gap-3">
        <span className="flex flex-col gap-0.5">
          <span className="text-[13px] font-semibold">Portefeuille de surveillance</span>
          <span className="font-mono text-[12px] text-mute">{status?.wallet ?? 'kyro-watch-…'}</span>
        </span>
        {status && (
          <Badge tone={status.state === 'ready' ? 'up' : status.state === 'error' ? 'down' : status.state === 'importing' ? 'ice' : 'warn'}>
            {status.state === 'ready' ? 'Prêt' : status.state === 'importing' ? 'Import en cours' : status.state === 'error' ? 'Erreur' : 'À configurer'}
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
              className={cn('flex flex-col gap-0.5 rounded-[14px] px-4 py-3 text-left', mode === value ? 'border-[1.5px] border-ice bg-ice/8' : 'border border-line bg-raised hover:border-line-3')}
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
