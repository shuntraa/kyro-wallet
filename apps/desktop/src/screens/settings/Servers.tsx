// SPDX-License-Identifier: GPL-3.0-or-later
// Settings › Networks and servers (B2b): the user's own server per chain.

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
  type UtxoCoinKey,
} from '@kyro/shared';
import { evmChains, solChain } from '@kyro/chains';
import { useApp } from '../../state/app';
import { NetworkSwitchDialog, useNetworkInfo } from '../../components/NetworkSwitch';
import { NETWORK_HINT, NETWORK_LABEL } from '../../lib/network';
import { cbfPhaseLabel, cbfStore, useCbf } from '../../state/cbf';
import { usePortfolio } from '../../state/portfolio';
import { cn } from '../../lib/cn';
import { fmtIntl, fmtNumber, fmtTime } from '../../lib/format';
import { Dialog } from '../../components/ui/dialog';
import { Badge, Button, Input, Notice, Segmented, Spinner, Switch } from '../../components/ui/primitives';
import { IconCheck, IconInfo, IconWarn } from '../../components/icons';
import { t, useT, type Key } from '../../i18n';
import { rt } from '../../i18n/rich';

const bold = { b: (c: ReactNode) => <strong className="font-semibold text-text">{c}</strong> };
const boldPlain = { b: (c: ReactNode) => <strong className="font-semibold">{c}</strong> };

interface Note {
  text: string;
  warn?: boolean;
}

interface Failure {
  code: string;
  message: string;
}

const CODE_TITLE: Record<string, Key> = {
  SERVER_INVALID: 'servers.code.serverInvalid',
  SERVER_WRONG_NETWORK: 'servers.code.wrongNetwork',
  SERVER_UNREACHABLE: 'servers.code.unreachable',
  DEFAULT_SERVER_DISABLED: 'servers.code.defaultDisabled',
  TOR_UNAVAILABLE: 'servers.code.torUnavailable',
  INVALID_INPUT: 'servers.code.invalidInput',
  LOCKED: 'servers.code.locked',
};

const toFailure = (e: unknown): Failure => {
  const err = toIpcError(e);
  return { code: err.code, message: err.message };
};

function detail(message: string): string {
  return message.replace(/^(Serveur invalide|Mauvais réseau|Serveur injoignable|Tor indisponible|Entrée invalide|Erreur interne|Invalid server|Wrong network|Server unreachable|Tor unavailable|Invalid input|Internal error)\s*:\s*/i, '');
}

function FailureNotice({ failure }: { failure: Failure }) {
  const { t } = useT();
  const title = t((CODE_TITLE[failure.code] ?? 'servers.code.error') as 'servers.code.error');
  return (
    <Notice tone="error" icon={<IconWarn size={16} className="mt-0.5 shrink-0" />}>
      <span className="font-semibold">{t('servers.failureTitle', { title })}</span> {detail(failure.message)}
      {failure.code === 'SERVER_UNREACHABLE' && <span className="block text-[12px] opacity-80">{t('servers.nothingSaved')}</span>}
    </Notice>
  );
}

function TestOk({ result, chainLabel = 'chainId', ledgerLabel }: { result: ServerTestResult; chainLabel?: string; ledgerLabel?: string }) {
  const { t } = useT();
  const d = result.detected;
  const parts = [`${result.latencyMs} ms`];
  if (d.network) parts.push(t('servers.test.network', { network: d.network }));
  if (d.chainId !== undefined) parts.push(`${chainLabel} ${d.chainId}`);
  if (d.blockHeight !== undefined) parts.push(`${ledgerLabel ?? t('servers.test.block')} ${fmtNumber(d.blockHeight, 0)}`);
  if (d.serverVersion) parts.push(d.serverVersion);
  if (d.genesisHash) parts.push(`genesis ${d.genesisHash.slice(0, 8)}…${d.genesisHash.slice(-6)}`);
  return (
    <div role="status" className="flex items-start gap-2 rounded-ctl border border-up/30 bg-up/[.06] px-3.5 py-2.5 text-[12px] text-[#b8f3d8]">
      <IconCheck size={14} className="mt-0.5 shrink-0 text-up" />
      <span>
        <span className="font-semibold">{t('servers.test.ok')}</span> · {parts.join(' · ')}
        <span className="block text-mute">{t('servers.test.only')}</span>
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
  const { t } = useT();
  return (
    <Dialog open={open} onOpenChange={(v) => (v ? undefined : onCancel())} title={title ?? t('servers.back.title', { host })} className="w-[520px]">
      <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
        {body ?? rt('servers.back.body', bold, { host, sees })}
      </Notice>
      {failure && <FailureNotice failure={failure} />}
      <div className="flex justify-end gap-2">
        <Button variant="primary" onClick={onCancel} disabled={busy}>
          {t('servers.back.keep')}
        </Button>
        <Button variant="dangerOutline" onClick={onConfirm} disabled={busy}>
          {busy && <Spinner />} {t('servers.back.confirm')}
        </Button>
      </div>
    </Dialog>
  );
}

export function ServersSection() {
  const { network, settings } = useApp();
  const { t } = useT();
  const tor = settings.tor.enabled;
  return (
    <>
      <NetworkChoiceCard />
      <Card title={t('servers.title')} badge={<Badge tone={network === 'testnet' ? 'warn' : 'up'}>{network === 'testnet' ? 'Testnet' : 'Mainnet'}</Badge>}>
        <p className="m-0 text-[13px] leading-[1.55] text-mute">
          {network === 'testnet' ? t('servers.introTestnet') : t('servers.introMainnet')} {t('servers.introReplace')}
        </p>
        <Notice icon={<IconInfo size={16} className="mt-0.5 shrink-0 text-ice" />}>
          {rt('servers.noFallback', bold)} {tor ? t('servers.viaTor') : t('servers.torOff')}
        </Notice>
      </Card>
      <BitcoinCard />
      <UtxoServerCard coin="litecoin" />
      <UtxoServerCard coin="dogecoin" />
      <UtxoServerCard coin="bitcoincash" />
      <UtxoServerCard coin="dash" />
      <TronServerCard />
      <XrpServerCard />
      <CardanoServerCard />
      <MoneroServerCard />
      <EvmCard />
      <SolanaCard />
    </>
  );
}

function NetworkChoiceCard() {
  const { network, status, demo } = useApp();
  const info = useNetworkInfo();
  const [target, setTarget] = useState<Network | null>(null);
  const current = info.data?.network ?? network;
  const locked = info.data ? !info.data.canSwitch : true;
  const { t } = useT();
  return (
    <Card title={t('servers.network')} badge={<Badge tone={current === 'testnet' ? 'warn' : 'up'}>{NETWORK_LABEL[current]}</Badge>}>
      <div role="radiogroup" aria-label={t('servers.network')} className="flex gap-2.5">
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
                {NETWORK_LABEL[n]} {active && <span className="font-normal text-ice-text2">{t('servers.network.used')}</span>}
              </span>
              <span className="text-[12px] text-mute">{n === 'mainnet' ? t('servers.network.realFunds') : t('servers.network.worthless')}</span>
            </button>
          );
        })}
      </div>
      <p className="m-0 text-[13px] leading-[1.55] text-mute">
        {t('servers.network.explain', { network: NETWORK_LABEL[current].toLowerCase(), hint: NETWORK_HINT[current] })}
      </p>
      {info.data && !info.data.canSwitch && (
        <Notice icon={<IconInfo size={16} className="mt-0.5 shrink-0 text-ice" />}>{demo ? t('servers.network.demoForced') : t('servers.network.envForced')}</Notice>
      )}
      {info.error && <Notice tone="error">{t('servers.network.unreadable', { message: info.error.message })}</Notice>}
      {info.data && <NetworkSwitchDialog info={info.data} target={target} hasVault={status?.exists ?? true} onClose={() => setTarget(null)} />}
    </Card>
  );
}

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

/** Approximate block height at a date, minus a one-week safety margin (1008 blocks). */
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

function comparable(s: BtcServer): string {
  if (s.kind === 'core' && s.auth.kind === 'userpass') return JSON.stringify({ ...s, auth: { kind: 'userpass', user: s.auth.user } });
  return JSON.stringify(s);
}

function btcKinds(): Array<{ value: BtcServerKind; label: string }> {
  return [
    { value: 'default', label: t('servers.default') },
    { value: 'esplora', label: t('servers.btc.kind.esplora') },
    { value: 'electrum', label: 'Electrum' },
    { value: 'core', label: 'Bitcoin Core' },
    { value: 'cbf', label: t('servers.btc.kind.cbf') },
  ];
}

/** « …; the IP of a Tor exit relay » / « …; and your IP address »: what the server sees of you. */
function ipPart(tor: boolean, onion = false): string {
  return tor ? (onion ? t('servers.ipTorOnion') : t('servers.ipTor')) : t('servers.ipDirect');
}

function btcSees(d: BtcDraft, tor: boolean): string {
  switch (d.kind) {
    case 'default':
      return tor ? t('servers.btc.sees.defaultTor') : t('servers.btc.sees.defaultDirect');
    case 'esplora':
      return t('servers.btc.sees.esplora', { ip: ipPart(tor, true) });
    case 'electrum':
      return t('servers.btc.sees.electrum', { ip: ipPart(tor, true) });
    case 'cbf':
      return tor ? t('servers.btc.sees.cbfTor') : t('servers.btc.sees.cbfDirect');
    case 'core':
      return coreIsLocal(d.coreUrl) ? t('servers.btc.sees.coreLocal') : t('servers.btc.sees.coreRemote');
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
  const { t } = useT();
  const kinds = btcKinds();

  const [busy, setBusy] = useState<'test' | 'save' | 'cert' | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [result, setResult] = useState<ServerTestResult | null>(null);
  const [notice, setNotice] = useState<Note | null>(null);
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
  const hint = d.kind === 'default' ? null : (checkBtcServer(server, tor) ?? (needsPassword ? t('servers.btc.passwordRequired') : null));
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
      setNotice({ text: d.kind === 'cbf' ? t('servers.btc.savedCbf') : t('servers.btc.saved') });
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
      setNotice({ text: t('servers.btc.restored'), warn: true });
    } catch (e) {
      setFailure(toFailure(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title={network === 'testnet' ? 'Bitcoin testnet4' : 'Bitcoin'}
      badge={saved.kind === 'default' ? <Badge>{t('servers.default')}</Badge> : <Badge tone="ice">{t('servers.customKind', { kind: kinds.find((k) => k.value === saved.kind)?.label ?? '' })}</Badge>}
    >
      <Segmented
        label={t('servers.btc.kindLabel')}
        value={d.kind}
        onChange={(kind) => {
          reset();
          set({ kind });
        }}
        options={kinds.map((k) => (k.value === 'cbf' && cbfOff && saved.kind !== 'cbf' ? { ...k, disabled: true } : k))}
        className="max-w-full flex-wrap gap-y-[3px] self-start"
      />
      {cbfOff && (
        <span className="flex items-center gap-1.5 text-[12px] text-faint">
          <IconInfo size={13} /> {t('servers.btc.cbfLater')}
        </span>
      )}
      <Sees>{btcSees(d, tor)}</Sees>

      {d.kind === 'esplora' && (
        <Field label={t('servers.btc.esploraUrl')} hint={t('servers.urlHint')}>
          <Input value={d.esploraUrl} onChange={(e) => set({ esploraUrl: e.target.value })} placeholder={network === 'testnet' ? t('servers.btc.esploraPlaceholderTestnet') : t('servers.btc.esploraPlaceholder')} className="font-mono text-[13px]" />
        </Field>
      )}

      {d.kind === 'electrum' && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-2.5">
            <Field label={t('servers.btc.host')}>
              <Input
                value={d.host}
                onChange={(e) => {
                  const host = e.target.value;
                  // TLS off is only allowed for a .onion over Tor: switch it back on otherwise.
                  set({ host, ...(!(isOnion(host.trim()) && tor) ? { tls: true } : {}) });
                }}
                placeholder={t('servers.btc.hostPlaceholder')}
                className="font-mono text-[13px]"
              />
            </Field>
            <Field label={t('servers.btc.port')}>
              <Input value={d.port} inputMode="numeric" onChange={(e) => set({ port: e.target.value.replace(/\D/g, '').slice(0, 5) })} placeholder="50002" className="font-mono text-[13px]" />
            </Field>
          </div>
          <div className="flex items-center justify-between gap-4 rounded-box border border-line bg-raised px-4 py-3">
            <span className="flex flex-col gap-0.5">
              <span className="text-[13px] font-semibold">{t('servers.btc.tls')}</span>
              <span className="text-[12px] text-mute">{onionHost && tor ? t('servers.btc.tlsOnion') : t('servers.btc.tlsRequired')}</span>
            </span>
            <Switch label="TLS" checked={d.tls} disabled={!(onionHost && tor)} onCheckedChange={(tls) => set({ tls })} />
          </div>
          {d.tls && (
            <div className="flex flex-col gap-2">
              <Segmented
                label={t('servers.btc.certValidation')}
                value={d.tlsMode}
                onChange={(tlsMode) => set({ tlsMode })}
                options={[
                  { value: 'webpki', label: t('servers.btc.webpki') },
                  { value: 'pinned', label: t('servers.btc.pinned') },
                ]}
                className="self-start"
              />
              <span className="text-[12px] leading-[1.45] text-faint">
                {d.tlsMode === 'webpki' ? t('servers.btc.webpkiHint') : t('servers.btc.pinnedHint')}
              </span>
              {d.tlsMode === 'pinned' &&
                (normalizeFingerprint(d.cert) ? (
                  <Fingerprint hex={d.cert} compact />
                ) : (
                  <span className="text-[12px] text-warn">{t('servers.btc.noPin')}</span>
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
      {notice && !failure && <Notice tone={notice.warn ? 'warn' : 'success'}>{notice.text}</Notice>}

      <div className="flex flex-wrap gap-2">
        {d.kind !== 'default' && (
          <Button onClick={() => void test()} disabled={busy !== null}>
            {(busy === 'test' || busy === 'cert') && <Spinner />} {t('servers.test')}
          </Button>
        )}
        <Button variant="primary" onClick={() => void save()} disabled={busy !== null || !dirty}>
          {busy === 'save' && <Spinner />} {d.kind === 'default' && saved.kind !== 'default' ? t('servers.back.confirm') : t('servers.save')}
        </Button>
        {dirty && (
          <Button variant="ghost" onClick={() => (reset(), setD(draftOf(saved, network)))} disabled={busy !== null}>
            {t('servers.discard')}
          </Button>
        )}
      </div>

      {saved.kind === 'core' && d.kind === 'core' && <CoreWallet />}
      {saved.kind === 'cbf' && d.kind === 'cbf' && <CbfPanel />}

      <BackToDefaultDialog
        open={confirmDefault}
        host="mempool.space"
        sees={t('servers.btc.backSees')}
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
  const { t } = useT();
  return (
    <div aria-label={t('servers.cert.fingerprintLabel', { groups: groups.join(' ') })} className={cn('grid grid-cols-8 gap-x-2 gap-y-1 rounded-ctl border border-ice-line bg-ice/[.06] font-mono text-ice-text', compact ? 'px-3 py-2 text-[12px]' : 'px-4 py-3 text-[13px]')}>
      {groups.map((g, i) => (
        <span key={i}>{g}</span>
      ))}
    </div>
  );
}

function CertDialog({ cert, onCancel, onChoose }: { cert: { info: ElectrumCertInfo; host: string; port: number; changed: boolean } | null; onCancel: () => void; onChoose: (mode: 'pinned' | 'webpki') => void }) {
  const { t } = useT();
  return (
    <Dialog open={cert !== null} onOpenChange={(v) => (v ? undefined : onCancel())} title={t('servers.cert.title')} className="w-[600px]">
      {cert && (
        <>
          <p className="m-0 text-[13px] leading-[1.55] text-text2">
            {rt('servers.cert.presented', {}, { host: <span className="font-mono text-text">{`${cert.host}:${cert.port}`}</span> })}
          </p>
          {cert.changed && (
            <Notice tone="error" icon={<IconWarn size={16} className="mt-0.5 shrink-0" />}>
              {rt('servers.cert.changed', boldPlain)}
            </Notice>
          )}
          <div className="flex flex-col gap-1.5">
            <span className="flex items-center justify-between text-[12px] font-medium text-mute">
              {t('servers.cert.fingerprint')}
              {cert.info.webpkiValid ? <Badge tone="up">{t('servers.cert.recognized')}</Badge> : <Badge tone="warn">{t('servers.cert.selfSigned')}</Badge>}
            </span>
            <Fingerprint hex={cert.info.sha256} />
          </div>
          <p className="m-0 text-[12px] leading-[1.55] text-mute">
            {rt('servers.cert.compare', {}, { cmd: <span className="font-mono">openssl x509 -noout -fingerprint -sha256 -in cert.pem</span> })}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={onCancel}>{t('common.cancel')}</Button>
            <Button variant="outline" disabled={!cert.info.webpkiValid} title={cert.info.webpkiValid ? undefined : t('servers.cert.onlyPin')} onClick={() => onChoose('webpki')}>
              {t('servers.cert.useWebpki')}
            </Button>
            <Button variant="primary" onClick={() => onChoose('pinned')}>
              {t('servers.cert.trust')}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}

function CbfForm({ d, set, network, tor }: { d: BtcDraft; set: (p: Partial<BtcDraft>) => void; network: 'mainnet' | 'testnet'; tor: boolean }) {
  const estimate = d.birthMode === 'date' ? estimateBirthHeight(d.birthDate, network) : null;
  const { t } = useT();
  return (
    <div className="flex flex-col gap-3">
      <Field
        label={t('servers.cbf.peers')}
        hint={tor ? t('servers.cbf.peersHintTor') : t('servers.cbf.peersHint')}
      >
        <textarea
          value={d.cbfPeers}
          onChange={(e) => set({ cbfPeers: e.target.value })}
          rows={3}
          spellCheck={false}
          placeholder={network === 'testnet' ? t('servers.cbf.peersPlaceholderTestnet') : t('servers.cbf.peersPlaceholder')}
          className="w-full resize-y rounded-ctl border border-line-2 bg-bg px-3.5 py-2.5 font-mono text-[13px] text-text placeholder:text-faint focus:border-ice-line"
        />
      </Field>
      <div className="flex flex-col gap-2">
        <span className="eyebrow">{t('servers.cbf.birth')}</span>
        <Segmented
          label={t('servers.cbf.birthLabel')}
          value={d.birthMode}
          onChange={(birthMode) => set({ birthMode })}
          options={[
            { value: 'genesis', label: t('servers.cbf.fromGenesis') },
            { value: 'date', label: t('servers.cbf.fromDate') },
            { value: 'height', label: t('servers.cbf.fromHeight') },
          ]}
          className="self-start"
        />
        {d.birthMode === 'date' && (
          <div className="flex items-center gap-3">
            <Input type="date" value={d.birthDate} onChange={(e) => set({ birthDate: e.target.value })} max={new Date().toISOString().slice(0, 10)} className="w-[200px]" />
            {estimate !== null && <span className="text-[12px] text-mute">{t('servers.cbf.estimate', { height: fmtNumber(estimate, 0) })}</span>}
          </div>
        )}
        {d.birthMode === 'height' && <Input value={d.birthHeight} inputMode="numeric" onChange={(e) => set({ birthHeight: e.target.value.replace(/\D/g, '') })} placeholder={t('servers.cbf.heightPlaceholder')} className="w-[200px] font-mono text-[13px]" />}
        <span className="text-[12px] leading-[1.45] text-faint">
          {t('servers.cbf.birthHint')}
        </span>
      </div>
      <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
        <span className="block">{rt('servers.cbf.noMempool', boldPlain)}</span>
        <span className="block">{rt('servers.cbf.fees', boldPlain)}</span>
      </Notice>
    </div>
  );
}

const CBF_STEPS: Array<{ key: 'headers' | 'filters' | 'blocks'; label: Key }> = [
  { key: 'headers', label: 'servers.cbf.step.headers' },
  { key: 'filters', label: 'servers.cbf.step.filters' },
  { key: 'blocks', label: 'servers.cbf.step.blocks' },
];

function CbfPanel() {
  const { status, error } = useCbf();
  const [busy, setBusy] = useState(false);
  const { t, tp } = useT();
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
          <span className="text-[13px] font-semibold">{t('servers.cbf.syncTitle')}</span>
          <span className="text-[12px] text-mute">
            {st ? t(st.tor ? 'servers.cbf.statusTor' : 'servers.cbf.statusDirect', { phase: cbfPhaseLabel(st), peers: tp('servers.cbf.peerCount', st.peers.length) }) : t('servers.cbf.unknown')}
          </span>
        </span>
        {st && <Badge tone={st.state === 'synced' ? 'up' : st.state === 'error' ? 'down' : running ? 'ice' : 'mute'}>{st.state === 'synced' ? t('servers.cbf.upToDate') : st.state === 'error' ? t('servers.cbf.error') : running ? t('servers.cbf.running') : t('servers.cbf.waiting')}</Badge>}
      </div>
      <ol className="m-0 grid list-none grid-cols-3 gap-2 p-0" aria-label={t('servers.cbf.stepsLabel')}>
        {CBF_STEPS.map((step, i) => {
          const done = phaseIndex > i || (step.key === 'blocks' && phaseIndex >= 3);
          const active = phaseIndex === i || (step.key === 'blocks' && phaseIndex === 1 && (st?.matchedBlocks ?? 0) > 0);
          const detail =
            step.key === 'headers'
              ? st?.tipHeight != null
                ? t('servers.cbf.block', { height: fmtNumber(st.tipHeight, 0) })
                : '—'
              : step.key === 'filters'
                ? st?.scannedHeight != null
                  ? t('servers.cbf.upToBlock', { height: fmtNumber(st.scannedHeight, 0) })
                  : t('servers.cbf.fromBlock', { height: fmtNumber(st?.birthHeight ?? 0, 0) })
                : tp('servers.cbf.downloaded', st?.matchedBlocks ?? 0);
          return (
            <li key={step.key} aria-current={active ? 'step' : undefined} className={cn('flex flex-col gap-0.5 rounded-ctl border px-3 py-2', done ? 'border-up/30 bg-up/[.05]' : active ? 'border-ice-line bg-ice/[.06]' : 'border-line bg-card')}>
              <span className="flex items-center gap-1.5 text-[12px] font-semibold">
                {done ? <IconCheck size={12} className="text-up" /> : active ? <Spinner className="size-3 border-[1.5px] text-ice" /> : <span className="size-1.5 rounded-full bg-faint" />}
                {t(step.label as 'servers.cbf.step.headers')}
              </span>
              <span className="font-mono text-[12px] text-mute">{detail}</span>
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
            {st?.state === 'synced' ? (st.lastSyncUnix ? t('servers.cbf.lastSync', { time: fmtTime(st.lastSyncUnix * 1000) }) : t('servers.cbf.upToDate')) : t('servers.cbf.filtersPct', { pct: fmtIntl(pct / 100, { style: 'percent' }) })} · {t('servers.cbf.watched', { count: st?.watchedScripts ?? 0 })}
          </span>
        </div>
      )}
      {st && st.peers.length > 0 && (
        <details className="text-[12px] text-mute">
          <summary className="cursor-pointer select-none">{t('servers.cbf.peersConnected', { count: st.peers.length })}</summary>
          <ul className="m-0 mt-1.5 flex list-none flex-col gap-0.5 p-0 font-mono text-[12px]">
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
          {(busy || running) && <Spinner />} {running ? t('servers.cbf.syncing') : t('servers.cbf.syncNow')}
        </Button>
      </div>
    </div>
  );
}

function CoreForm({ d, set, savedIsCore, passwordLost, tor }: { d: BtcDraft; set: (p: Partial<BtcDraft>) => void; savedIsCore: boolean; passwordLost: boolean; tor: boolean }) {
  const local = coreIsLocal(d.coreUrl);
  const { t } = useT();
  return (
    <div className="flex flex-col gap-3">
      <Field label={t('servers.core.url')} hint={t('servers.core.urlHint')}>
        <Input value={d.coreUrl} onChange={(e) => set({ coreUrl: e.target.value })} placeholder="http://127.0.0.1:48332" className="font-mono text-[13px]" />
      </Field>
      {d.coreUrl.trim() &&
        (local ? (
          <Notice icon={<IconInfo size={16} className="mt-0.5 shrink-0 text-ice" />}>
            {rt('servers.core.local', bold)}
          </Notice>
        ) : (
          <span className="text-[12px] text-mute">{tor ? t('servers.core.remoteTor') : t('servers.core.remoteDirect')}</span>
        ))}
      <div className="flex flex-col gap-2">
        <span className="eyebrow">{t('servers.core.auth')}</span>
        <Segmented
          label={t('servers.core.authLabel')}
          value={d.authKind}
          onChange={(authKind) => set({ authKind })}
          options={[
            { value: 'cookie', label: t('servers.core.cookie') },
            { value: 'userpass', label: t('servers.core.userpass') },
          ]}
          className="self-start"
        />
      </div>
      {d.authKind === 'cookie' ? (
        <CookiePicker d={d} set={set} local={local} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label={t('servers.core.user')}>
              <Input value={d.user} onChange={(e) => set({ user: e.target.value })} placeholder="kyro" className="font-mono text-[13px]" />
            </Field>
            <Field label={t('servers.core.password')} hint={d.hasPassword && !passwordLost ? t('servers.core.passwordKept') : undefined}>
              <Input type="password" autoComplete="off" value={d.password} onChange={(e) => set({ password: e.target.value })} placeholder={d.hasPassword && !passwordLost ? t('servers.core.passwordUnchanged') : ''} className="font-mono text-[13px]" />
            </Field>
          </div>
          {passwordLost && savedIsCore && <span className="text-[12px] text-warn">{t('servers.core.passwordLost')}</span>}
          <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
            {rt('servers.core.plaintext', boldPlain)}
          </Notice>
        </>
      )}
    </div>
  );
}

/**
 * `.cookie` chosen in the system file picker opened by Rust (`btc_core_pick_cookie`): the interface
 * cannot type a path, so it cannot point Kyro at another file (settings, vault…).
 */
function CookiePicker({ d, set, local }: { d: BtcDraft; set: (p: Partial<BtcDraft>) => void; local: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { t } = useT();
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
    <Field label={t('servers.core.cookieFile')} hint={t('servers.core.cookieHint')}>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2.5">
          <Button variant="outline" size="md" disabled={busy || !local} onClick={() => void pick()}>
            {busy && <Spinner />} {t('servers.core.pickCookie')}
          </Button>
          <span className={cn('min-w-0 truncate font-mono text-[12.5px]', d.cookiePath ? 'text-text2' : 'text-faint')} title={d.cookiePath || undefined}>
            {d.cookiePath || t('servers.core.noCookie')}
          </span>
        </div>
        {!local && d.coreUrl.trim() && <span className="text-[12px] text-warn">{t('servers.core.cookieLocalOnly')}</span>}
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Field>
  );
}

function CoreWallet() {
  const pf = usePortfolio();
  const [status, setStatus] = useState<CoreStatus | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'now' | 'date'>('now');
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const wasImporting = useRef(false);
  const { t } = useT();

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
    const ms = Date.parse(`${date}T00:00:00Z`);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
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
          <span className="text-[13px] font-semibold">{t('servers.watch.title')}</span>
          <span className="font-mono text-[12px] text-mute">{status?.wallet ?? 'kyro-watch-…'}</span>
        </span>
        {status && (
          <Badge tone={status.state === 'ready' ? 'up' : status.state === 'error' ? 'down' : status.state === 'importing' ? 'ice' : 'warn'}>
            {status.state === 'ready' ? t('servers.watch.ready') : status.state === 'importing' ? t('servers.watch.importing') : status.state === 'error' ? t('servers.watch.error') : status.state === 'not-configured' ? t('servers.watch.notConfigured') : t('servers.watch.toSetup')}
          </Badge>
        )}
      </div>
      <p className="m-0 text-[12px] leading-[1.5] text-mute">
        {rt('servers.watch.explain', { b: (c) => <strong className="font-semibold text-text2">{c}</strong> })}
      </p>
      {importing && (
        <div role="status" className="flex flex-col gap-1.5">
          <div className="h-1.5 overflow-hidden rounded-full bg-control-2">
            <div className={cn('h-full rounded-full bg-ice transition-[width]', pct === null && 'animate-pulse')} style={{ width: `${pct ?? 15}%` }} />
          </div>
          <span className="text-[12px] text-mute">
            {pct === null
              ? t('servers.watch.importDescriptors')
              : status?.scanDurationSecs !== undefined
                ? t('servers.watch.rescanSecs', { pct: fmtIntl(pct / 100, { style: 'percent' }), secs: status.scanDurationSecs })
                : t('servers.watch.rescan', { pct: fmtIntl(pct / 100, { style: 'percent' }) })}{' '}
            {t('servers.watch.canLeave')}
          </span>
        </div>
      )}
      {status?.error && <Notice tone="error">{status.error}</Notice>}
      {failure && <FailureNotice failure={failure} />}
      {status?.state !== 'importing' && (
        <div>
          <Button variant={status?.state === 'ready' ? 'outline' : 'primary'} onClick={() => setOpen(true)}>
            {status?.state === 'ready' ? t('servers.watch.reconfigure') : t('servers.watch.configure')}
          </Button>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen} title={t('servers.watch.configure')} className="w-[560px]">
        <p className="m-0 text-[13px] leading-[1.55] text-text2">{t('servers.watch.dialogIntro')}</p>
        <div role="radiogroup" aria-label={t('servers.watch.rescanFrom')} className="flex flex-col gap-2">
          {(
            [
              ['now', t('servers.watch.now'), t('servers.watch.nowDesc')],
              ['date', t('servers.watch.fromDate'), t('servers.watch.fromDateDesc')],
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
          <Field label={t('servers.watch.firstTxDate')}>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} max={new Date().toISOString().slice(0, 10)} className="w-[200px]" />
          </Field>
        )}
        {failure && <FailureNotice failure={failure} />}
        <div className="flex justify-end gap-2">
          <Button onClick={() => setOpen(false)} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void setup()} disabled={busy || rescanFrom === null}>
            {busy && <Spinner />} {t('servers.watch.start')}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

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
  defaultSees: string;
  last?: boolean;
}) {
  const { settings } = useApp();
  const { t } = useT();
  const [url, setUrl] = useState(saved ?? '');
  useEffect(() => setUrl(saved ?? ''), [saved]);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [result, setResult] = useState<ServerTestResult | null>(null);
  const [notice, setNotice] = useState<Note | null>(null);
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
      setNotice(value ? { text: t('servers.rpc.saved') } : { text: t('servers.rpc.restored', { host: defaultHost, sees: defaultSees }), warn: true });
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
        {saved ? <Badge tone="ice">{t('servers.custom')}</Badge> : <Badge>{t('servers.default')}</Badge>}
      </div>
      <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t('servers.defaultSuffix', { url: defaultUrl })} aria-label={`RPC ${title}`} className="font-mono text-[13px]" />
      {hint && (
        <span className="flex items-center gap-1.5 text-[12px] text-warn">
          <IconWarn size={13} /> {hint}
        </span>
      )}
      {failure && <FailureNotice failure={failure} />}
      {result && !failure && <TestOk result={result} />}
      {notice && !failure && <Notice tone={notice.warn ? 'warn' : 'success'}>{notice.text}</Notice>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void test()} disabled={!clean || busy !== null}>
          {busy === 'test' && <Spinner />} {t('servers.test')}
        </Button>
        <Button size="sm" variant="primary" onClick={() => (clean ? void save(clean) : setConfirmDefault(true))} disabled={!dirty || busy !== null}>
          {busy === 'save' && <Spinner />} {clean || !saved ? t('servers.save') : t('servers.back.confirm')}
        </Button>
        {saved && !dirty && (
          <Button size="sm" variant="ghost" onClick={() => setConfirmDefault(true)} disabled={busy !== null}>
            {t('servers.back.confirm')}
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

function utxoMeta(): Record<UtxoCoinKey, { name: string; testnet: string; noDefaultTestnet: boolean; hosts: Record<'mainnet' | 'testnet', string>; first: Record<'mainnet' | 'testnet', string>; electrs: string; sees: (hosts: string, tor: boolean) => string }> {
  return {
    litecoin: {
      name: 'Litecoin',
      testnet: 'testnet4',
      noDefaultTestnet: false,
      hosts: { mainnet: 'litecoinspace.org', testnet: 'litecoinspace.org' },
      first: { mainnet: 'litecoinspace.org', testnet: 'litecoinspace.org' },
      electrs: 'electrs-litecoin',
      sees: (_h, tor) => t('servers.utxo.sees.ltc', { ip: ipPart(tor) }),
    },
    dogecoin: {
      name: 'Dogecoin',
      testnet: 'testnet',
      noDefaultTestnet: true,
      hosts: { mainnet: t('servers.utxo.dogeHosts'), testnet: '' },
      first: { mainnet: 'doge.electrum1.cipig.net', testnet: '' },
      electrs: 'electrs-dogecoin',
      sees: (h, tor) => t('servers.utxo.sees.doge', { hosts: h, ip: ipPart(tor) }),
    },
    bitcoincash: {
      name: 'Bitcoin Cash',
      testnet: 'chipnet',
      noDefaultTestnet: false,
      hosts: { mainnet: t('servers.utxo.bchHosts'), testnet: t('servers.utxo.bchHostsTestnet') },
      first: { mainnet: 'bch.imaginary.cash', testnet: 'chipnet.imaginary.cash' },
      electrs: t('servers.utxo.esploraFor', { name: 'Bitcoin Cash' }),
      sees: (h, tor) => t('servers.utxo.sees.bch', { hosts: h, ip: ipPart(tor) }),
    },
    dash: {
      name: 'Dash',
      testnet: 'testnet',
      noDefaultTestnet: true,
      hosts: { mainnet: t('servers.utxo.dashHosts'), testnet: '' },
      first: { mainnet: 'dash.electrum1.cipig.net', testnet: '' },
      electrs: t('servers.utxo.esploraFor', { name: 'Dash' }),
      sees: (h, tor) => t('servers.utxo.sees.dash', { hosts: h, ip: ipPart(tor) }),
    },
  };
}

/**
 * Litecoin / Dogecoin / Bitcoin Cash / Dash: Rust accepts the default or an Esplora server
 * (docs/IPC.md §2.4).
 */
function UtxoServerCard({ coin }: { coin: UtxoCoinKey }) {
  const { settings, network } = useApp();
  const tor = settings.tor.enabled;
  const nk = network === 'mainnet' ? 'mainnet' : 'testnet';
  const saved = settings.servers[coin]?.[nk];
  const savedUrl = saved?.kind === 'esplora' ? saved.url : '';
  const meta = utxoMeta()[coin];
  const name = meta.name;
  /** Dogecoin / Dash testnet: no public server found, the user must set one. */
  const noDefault = meta.noDefaultTestnet && nk === 'testnet';
  const { t } = useT();
  const defaultHosts = meta.hosts[nk];
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
  const [notice, setNotice] = useState<Note | null>(null);
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
          ? { text: noDefault ? t('servers.utxo.removedDoge', { name }) : t('servers.utxo.restored', { hosts: defaultHosts, name }), warn: true }
          : { text: t('servers.utxo.saved', { name }) },
      );
    } catch (e) {
      setFailure(toFailure(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title={network === 'testnet' ? `${name} ${meta.testnet}` : name}
      badge={savedUrl ? <Badge tone="ice">{t('servers.utxo.customEsplora')}</Badge> : noDefault ? <Badge tone="warn">{t('servers.utxo.noServer')}</Badge> : <Badge>{t('servers.default')}</Badge>}
    >
      <Segmented
        label={t('servers.utxo.serverLabel', { name })}
        value={kind}
        onChange={(k) => {
          reset();
          setKind(k);
        }}
        options={[
          { value: 'default', label: noDefault ? t('servers.utxo.noneOption') : t('servers.default') },
          { value: 'esplora', label: t('servers.btc.kind.esplora') },
        ]}
        className="self-start"
      />
      {kind === 'default' && noDefault ? (
        <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
          {rt('servers.utxo.noPublic', boldPlain, { name, electrs: meta.electrs })}
        </Notice>
      ) : (
        <Sees>
          {kind === 'default'
            ? meta.sees(defaultHosts, tor)
            : t('servers.utxo.sees.esplora', { name, ip: ipPart(tor, true) })}
        </Sees>
      )}
      {kind === 'esplora' && (
        <Field label={t('servers.utxo.esploraUrl', { name })} hint={coin === 'litecoin' ? t('servers.urlHint') : t('servers.utxo.esploraHint', { electrs: meta.electrs })}>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t('servers.utxo.placeholder', { coin })} aria-label={t('servers.utxo.urlAria', { name })} className="font-mono text-[13px]" />
        </Field>
      )}
      {hint && (
        <span className="flex items-center gap-1.5 text-[12px] text-warn">
          <IconWarn size={13} /> {hint}
        </span>
      )}
      {failure && <FailureNotice failure={failure} />}
      {result && !failure && <TestOk result={result} />}
      {notice && !failure && <Notice tone={notice.warn ? 'warn' : 'success'}>{notice.text}</Notice>}
      <div className="flex flex-wrap gap-2">
        {(kind === 'esplora' || !noDefault) && (
          <Button onClick={() => void test()} disabled={busy !== null || (kind === 'esplora' && !clean)}>
            {busy === 'test' && <Spinner />} {t('servers.test')}
          </Button>
        )}
        <Button variant="primary" onClick={() => (kind === 'esplora' ? void save(false) : setConfirmDefault(true))} disabled={busy !== null || !dirty || (kind === 'esplora' && !clean)}>
          {busy === 'save' && <Spinner />} {kind === 'default' && savedUrl ? (noDefault ? t('servers.utxo.remove') : t('servers.back.confirm')) : t('servers.save')}
        </Button>
      </div>
      <BackToDefaultDialog
        open={confirmDefault}
        host={noDefault ? name : meta.first[nk]}
        {...(noDefault ? { title: t('servers.utxo.removeTitle', { name }), body: t('servers.utxo.removeBody', { name }) } : {})}
        sees={noDefault ? t('servers.utxo.removeSees', { name }) : t('servers.utxo.backSees', { name })}
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

/**
 * TRON: TronGrid by default (api.trongrid.io / nile.trongrid.io) or the user's java-tron HTTP API
 * (FullNode).
 */
function TronServerCard() {
  const { settings, network, config } = useApp();
  const tor = settings.tor.enabled;
  const nk = network === 'mainnet' ? 'mainnet' : 'testnet';
  const defaultHost = network === 'mainnet' ? 'api.trongrid.io' : 'nile.trongrid.io';
  const { t } = useT();
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
  const [notice, setNotice] = useState<Note | null>(null);
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
      setNotice(toDefault ? { text: t('servers.tron.restored', { host: defaultHost }), warn: true } : { text: t('servers.tron.saved') });
    } catch (e) {
      setFailure(toFailure(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title={network === 'testnet' ? 'TRON Nile (testnet)' : 'TRON'}
      badge={savedUrl ? <Badge tone="ice">{t('servers.tron.customBadge')}</Badge> : <Badge>{t('servers.tron.defaultBadge')}</Badge>}
    >
      <Segmented
        label={t('servers.tron.serverLabel')}
        value={kind}
        onChange={(k) => {
          reset();
          setKind(k);
        }}
        options={[
          { value: 'default', label: 'TronGrid' },
          { value: 'http', label: t('servers.tron.customOption') },
        ]}
        className="self-start"
      />
      <Sees>
        {kind === 'default'
          ? t('servers.tron.sees.default', { host: defaultHost, ip: ipPart(tor) })
          : t('servers.tron.sees.custom', { ip: ipPart(tor, true) })}
      </Sees>
      <Notice icon={<IconInfo size={16} className="mt-0.5 shrink-0 text-ice" />}>
        {rt('servers.tron.history', bold, { wallet: <span className="font-mono">/wallet</span>, v1: <span className="font-mono">/v1</span> })}
      </Notice>
      {kind === 'http' && (
        <Field label={t('servers.tron.url')} hint={t('servers.urlHint')}>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t('servers.tron.placeholder')} aria-label={t('servers.tron.urlAria')} className="font-mono text-[13px]" />
        </Field>
      )}
      {config?.hasTrongridKey && kind === 'default' && <span className="text-[12px] text-mute">{t('servers.tron.keySet')}</span>}
      {hint && (
        <span className="flex items-center gap-1.5 text-[12px] text-warn">
          <IconWarn size={13} /> {hint}
        </span>
      )}
      {failure && <FailureNotice failure={failure} />}
      {result && !failure && <TestOk result={result} />}
      {notice && !failure && <Notice tone={notice.warn ? 'warn' : 'success'}>{notice.text}</Notice>}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void test()} disabled={busy !== null || (kind === 'http' && !clean)}>
          {busy === 'test' && <Spinner />} {t('servers.test')}
        </Button>
        <Button variant="primary" onClick={() => (kind === 'http' ? void save(false) : setConfirmDefault(true))} disabled={busy !== null || !dirty || (kind === 'http' && !clean)}>
          {busy === 'save' && <Spinner />} {kind === 'default' && savedUrl ? t('servers.tron.back') : t('servers.save')}
        </Button>
      </div>
      <BackToDefaultDialog
        open={confirmDefault}
        host={defaultHost}
        sees={t('servers.tron.backSees')}
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

/**
 * XRP Ledger: Ripple's public rippled by default (s.altnet.rippletest.net on testnet,
 * xrplcluster.com on mainnet) or the user's rippled JSON-RPC.
 */
function XrpServerCard() {
  const { settings, network } = useApp();
  const tor = settings.tor.enabled;
  const nk = network === 'mainnet' ? 'mainnet' : 'testnet';
  const defaultHost = network === 'mainnet' ? 'xrplcluster.com' : 's.altnet.rippletest.net';
  const { t } = useT();
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
  const [notice, setNotice] = useState<Note | null>(null);
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
      setNotice(toDefault ? { text: t('servers.xrp.restored', { host: defaultHost }), warn: true } : { text: t('servers.xrp.saved') });
    } catch (e) {
      setFailure(toFailure(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title={network === 'testnet' ? 'XRP Ledger testnet' : 'XRP Ledger'} badge={savedUrl ? <Badge tone="ice">{t('servers.xrp.customBadge')}</Badge> : <Badge>{t('servers.default')}</Badge>}>
      <Segmented
        label={t('servers.xrp.serverLabel')}
        value={kind}
        onChange={(k) => {
          reset();
          setKind(k);
        }}
        options={[
          { value: 'default', label: t('servers.default') },
          { value: 'jsonRpc', label: t('servers.xrp.customOption') },
        ]}
        className="self-start"
      />
      <Sees>
        {kind === 'default'
          ? t('servers.xrp.sees.default', { host: defaultHost, ip: ipPart(tor) })
          : t('servers.xrp.sees.custom', { ip: ipPart(tor, true) })}
      </Sees>
      {kind === 'jsonRpc' && (
        <Field label={t('servers.xrp.url')} hint={network === 'mainnet' ? t('servers.xrp.hintMainnet') : t('servers.xrp.hintTestnet')}>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t('servers.xrp.placeholder')} aria-label={t('servers.xrp.urlAria')} className="font-mono text-[13px]" />
        </Field>
      )}
      {hint && (
        <span className="flex items-center gap-1.5 text-[12px] text-warn">
          <IconWarn size={13} /> {hint}
        </span>
      )}
      {failure && <FailureNotice failure={failure} />}
      {result && !failure && <TestOk result={result} chainLabel="network_id" ledgerLabel={t('servers.test.validatedLedger')} />}
      {notice && !failure && <Notice tone={notice.warn ? 'warn' : 'success'}>{notice.text}</Notice>}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void test()} disabled={busy !== null || (kind === 'jsonRpc' && !clean)}>
          {busy === 'test' && <Spinner />} {t('servers.test')}
        </Button>
        <Button variant="primary" onClick={() => (kind === 'jsonRpc' ? void save(false) : setConfirmDefault(true))} disabled={busy !== null || !dirty || (kind === 'jsonRpc' && !clean)}>
          {busy === 'save' && <Spinner />} {kind === 'default' && savedUrl ? t('servers.back.confirm') : t('servers.save')}
        </Button>
      </div>
      <BackToDefaultDialog
        open={confirmDefault}
        host={defaultHost}
        sees={t('servers.xrp.backSees')}
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

/**
 * Monero: a public monerod by default (Cake Wallet's on mainnet, Stack Wallet's on stagenet) or the
 * user's own node.
 */
function MoneroServerCard() {
  const { settings, network } = useApp();
  const tor = settings.tor.enabled;
  const nk = network === 'mainnet' ? 'mainnet' : 'testnet';
  const defaultHost = network === 'mainnet' ? 'xmr-node.cakewallet.com' : 'monero-stagenet.stackwallet.com';
  const { t } = useT();
  const saved = settings.servers.monero?.[nk];
  const savedUrl = saved?.kind === 'node' ? saved.url : '';
  const [kind, setKind] = useState<'default' | 'node'>(savedUrl ? 'node' : 'default');
  const [url, setUrl] = useState(savedUrl);
  useEffect(() => {
    setKind(savedUrl ? 'node' : 'default');
    setUrl(savedUrl);
  }, [savedUrl]);
  const saveServers = useSaveServers();
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [result, setResult] = useState<ServerTestResult | null>(null);
  const [notice, setNotice] = useState<Note | null>(null);
  const [confirmDefault, setConfirmDefault] = useState(false);
  const clean = url.trim();
  const hint = kind === 'node' && clean ? checkServerUrl(clean, tor) : null;
  const dirty = kind === 'node' ? clean !== savedUrl : !!savedUrl;
  const reset = () => {
    setFailure(null);
    setResult(null);
    setNotice(null);
  };
  const test = async () => {
    reset();
    setBusy('test');
    try {
      setResult(await call('server_test', { target: { family: 'monero', network: nk, server: kind === 'node' ? { kind: 'node', url: clean } : { kind: 'default' } } }));
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
        s.monero = { ...(s.monero ?? {}) };
        if (toDefault) delete s.monero[nk];
        else s.monero[nk] = { kind: 'node', url: clean };
      });
      setConfirmDefault(false);
      setNotice(toDefault ? { text: t('servers.xmr.restored', { host: defaultHost }), warn: true } : { text: t('servers.xmr.saved') });
    } catch (e) {
      setFailure(toFailure(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title={network === 'testnet' ? 'Monero stagenet' : 'Monero'} badge={savedUrl ? <Badge tone="ice">{t('servers.xmr.customBadge')}</Badge> : <Badge>{t('servers.default')}</Badge>}>
      <Segmented
        label={t('servers.xmr.nodeLabel')}
        value={kind}
        onChange={(k) => {
          reset();
          setKind(k);
        }}
        options={[
          { value: 'default', label: t('servers.default') },
          { value: 'node', label: t('servers.xmr.customOption') },
        ]}
        className="self-start"
      />
      <Sees>
        {kind === 'default'
          ? t('servers.xmr.sees.default', { host: defaultHost, ip: tor ? t('servers.ipTor') : t('servers.xmr.ipDirect') })
          : t('servers.xmr.sees.custom', { ip: tor ? t('servers.ipTorOnion') : t('servers.xmr.ipDirect') })}
      </Sees>
      {kind === 'node' && (
        <Field label={t('servers.xmr.url')} hint={t('servers.xmr.hint', { network: network === 'mainnet' ? 'mainnet' : 'stagenet' })}>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={network === 'mainnet' ? t('servers.xmr.placeholderMainnet') : t('servers.xmr.placeholderTestnet')} aria-label={t('servers.xmr.urlAria')} className="font-mono text-[13px]" />
        </Field>
      )}
      {hint && (
        <span className="flex items-center gap-1.5 text-[12px] text-warn">
          <IconWarn size={13} /> {hint}
        </span>
      )}
      {failure && <FailureNotice failure={failure} />}
      {result && !failure && <TestOk result={result} ledgerLabel={t('servers.xmr.height')} />}
      {notice && !failure && <Notice tone={notice.warn ? 'warn' : 'success'}>{notice.text}</Notice>}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void test()} disabled={busy !== null || (kind === 'node' && !clean)}>
          {busy === 'test' && <Spinner />} {t('servers.test')}
        </Button>
        <Button variant="primary" onClick={() => (kind === 'node' ? void save(false) : setConfirmDefault(true))} disabled={busy !== null || !dirty || (kind === 'node' && !clean)}>
          {busy === 'save' && <Spinner />} {kind === 'default' && savedUrl ? t('servers.xmr.backConfirm') : t('servers.save')}
        </Button>
      </div>
      <BackToDefaultDialog
        open={confirmDefault}
        host={defaultHost}
        sees={t('servers.xmr.backSees')}
        busy={busy === 'save'}
        failure={confirmDefault ? failure : null}
        onConfirm={() => void save(true)}
        onCancel={() => {
          setConfirmDefault(false);
          setKind('node');
        }}
      />
    </Card>
  );
}

/**
 * Cardano: Koios by default (preprod.koios.rest / api.koios.rest, free keyless tier) or the user's
 * Koios-compatible REST API (`…/api/v1`).
 */
function CardanoServerCard() {
  const { settings, network } = useApp();
  const tor = settings.tor.enabled;
  const nk = network === 'mainnet' ? 'mainnet' : 'testnet';
  const defaultHost = network === 'mainnet' ? 'api.koios.rest' : 'preprod.koios.rest';
  const { t } = useT();
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
  const [notice, setNotice] = useState<Note | null>(null);
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
      setNotice(toDefault ? { text: t('servers.ada.restored', { host: defaultHost }), warn: true } : { text: t('servers.ada.saved') });
    } catch (e) {
      setFailure(toFailure(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title={network === 'testnet' ? 'Cardano preprod' : 'Cardano'} badge={savedUrl ? <Badge tone="ice">{t('servers.ada.customBadge')}</Badge> : <Badge>{t('servers.ada.defaultBadge')}</Badge>}>
      <Segmented
        label={t('servers.ada.serverLabel')}
        value={kind}
        onChange={(k) => {
          reset();
          setKind(k);
        }}
        options={[
          { value: 'default', label: t('servers.default') },
          { value: 'koios', label: t('servers.ada.customOption') },
        ]}
        className="self-start"
      />
      <Sees>
        {kind === 'default'
          ? t('servers.ada.sees.default', { host: defaultHost, ip: ipPart(tor) })
          : t('servers.ada.sees.custom', { ip: ipPart(tor, true) })}
      </Sees>
      {kind === 'koios' && (
        <Field label={t('servers.ada.url')} hint={network === 'mainnet' ? t('servers.ada.hintMainnet') : t('servers.ada.hintTestnet')}>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t('servers.ada.placeholder')} aria-label={t('servers.ada.urlAria')} className="font-mono text-[13px]" />
        </Field>
      )}
      {hint && (
        <span className="flex items-center gap-1.5 text-[12px] text-warn">
          <IconWarn size={13} /> {hint}
        </span>
      )}
      {failure && <FailureNotice failure={failure} />}
      {result && !failure && <TestOk result={result} chainLabel="magic" />}
      {notice && !failure && <Notice tone={notice.warn ? 'warn' : 'success'}>{notice.text}</Notice>}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void test()} disabled={busy !== null || (kind === 'koios' && !clean)}>
          {busy === 'test' && <Spinner />} {t('servers.test')}
        </Button>
        <Button variant="primary" onClick={() => (kind === 'koios' ? void save(false) : setConfirmDefault(true))} disabled={busy !== null || !dirty || (kind === 'koios' && !clean)}>
          {busy === 'save' && <Spinner />} {kind === 'default' && savedUrl ? t('servers.back.confirm') : t('servers.save')}
        </Button>
      </div>
      <BackToDefaultDialog
        open={confirmDefault}
        host={defaultHost}
        sees={t('servers.ada.backSees')}
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
  const { t, tp } = useT();
  return (
    <Card title={t('servers.evm.title')} badge={<Badge>{tp('servers.evm.chains', chains.length)}</Badge>}>
      <Sees>{t('servers.evm.sees', { ip: ipPart(tor) })}</Sees>
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
            defaultSees={t('servers.evm.backSees')}
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
  const { t } = useT();
  const active = solChain(network).cluster;
  const clusters: Array<{ cluster: SolanaCluster; url: string }> = [
    { cluster: active, url: solChain(network).rpcUrl },
    { cluster: active === 'devnet' ? 'mainnet-beta' : 'devnet', url: solChain(network === 'testnet' ? 'mainnet' : 'testnet').rpcUrl },
  ];
  return (
    <Card title="Solana" badge={<Badge>{t('servers.sol.perCluster')}</Badge>}>
      <Sees>{t('servers.sol.sees', { ip: ipPart(tor) })}</Sees>
      <div className="flex flex-col">
        {clusters.map(({ cluster, url }, i) => (
          <RpcRow
            key={cluster}
            title={`Solana ${cluster}`}
            subtitle={cluster === active ? t('servers.sol.used') : t('servers.sol.inactive')}
            defaultUrl={url}
            saved={settings.servers.solana[cluster]?.url}
            target={(u) => ({ family: 'solana', cluster, server: { url: u } })}
            onSave={(u) =>
              saveServers((s) => {
                if (u) s.solana[cluster] = { url: u };
                else delete s.solana[cluster];
              })
            }
            defaultSees={t('servers.sol.backSees')}
            last={i === clusters.length - 1}
          />
        ))}
      </div>
    </Card>
  );
}
