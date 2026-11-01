// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { call, toIpcError, type AccountChain, type ApiKeyName, type Settings } from '@kyro/shared';
import { findLookalike, outgoingHosts, type KnownAddress } from '@kyro/chains';
import { useApp, useVault, type SettingsSection } from '../state/app';
import { cn } from '../lib/cn';
import { shortAddress } from '../lib/format';
import { getBackupState, getContacts, saveContacts, type Contact, type ContactFamily } from '../lib/storage';
import { PasswordField } from '../components/kit';
import { PoisoningWarning } from '../components/Poisoning';
import { ServersSection } from './settings/Servers';
import { Devices } from './settings/Devices';
import { AccountsSection } from './settings/Accounts';
import { Dialog } from '../components/ui/dialog';
import { Badge, Button, Input, Notice, Segmented, Spinner, Switch } from '../components/ui/primitives';
import { IconCheck, IconEye, IconTor, IconTrash, IconWarn, IconX } from '../components/icons';
import { TorIndicator } from '../components/Tor';
import { torStore, useTor } from '../state/tor';
import { useMedia } from '../components/motion';

const SECTIONS: Array<{ key: SettingsSection; label: string }> = [
  { key: 'security', label: 'Sécurité' },
  { key: 'privacy', label: 'Confidentialité' },
  { key: 'accounts', label: 'Comptes' },
  { key: 'hardware', label: 'Appareils' },
  { key: 'networks', label: 'Réseaux et serveurs' },
  { key: 'display', label: 'Affichage et devise' },
  { key: 'apikeys', label: 'Clés API' },
  { key: 'connections', label: 'Connexions sortantes' },
  { key: 'contacts', label: 'Carnet d’adresses' },
];

export function SettingsScreen({ section: initial = 'security', family }: { section?: SettingsSection; family?: AccountChain }) {
  const [section, setSection] = useState<SettingsSection>(initial);
  const { settings, saveSettings } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Below 1280 px the outgoing-connections summary moves under the section instead of
  // squeezing it into a 300 px column.
  const wide = useMedia('(min-width: 1280px)');

  const save = async (patch: Partial<Settings>) => {
    setError(null);
    try {
      await saveSettings({ ...settings, ...patch });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError(toIpcError(e).message);
    }
  };

  return (
    <div className="flex min-h-0 flex-1">
      <nav aria-label="Sections des réglages" className="flex w-[240px] shrink-0 flex-col gap-0.5 border-r border-rail px-3.5 pt-6 pb-5">
        <h1 className="screen-title px-2.5 pb-5">Réglages</h1>
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            type="button"
            aria-current={section === s.key ? 'page' : undefined}
            onClick={() => setSection(s.key)}
            className={cn('group relative flex h-9 items-center gap-3 rounded-ctl px-2.5 text-left text-[13.5px] transition-colors duration-150', section === s.key ? 'font-medium text-text' : 'text-mute hover:text-text2')}
          >
            {section === s.key && (
              <motion.span layoutId="settings-section" aria-hidden="true" className="absolute inset-0 rounded-ctl border border-line-2 bg-raised" transition={{ type: 'spring', stiffness: 520, damping: 42 }}>
                <span className="absolute top-1/2 left-0 h-4 w-[2px] -translate-y-1/2 rounded-full bg-ice" />
              </motion.span>
            )}
            <span className="relative z-10 truncate">{s.label}</span>
          </button>
        ))}
        <div className="flex-1" />
        <div className="border-t border-line px-2.5 pt-4 text-[12px] text-mute">Kyro {__APP_VERSION__}</div>
      </nav>

      <div className="flex min-w-0 flex-1 gap-5 px-7 pt-6 pb-5">
        <div key={section} className="rise flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto scroll-thin">
          {error && <Notice tone="error">{error}</Notice>}
          {section === 'security' && <Security save={save} />}
          {section === 'privacy' && <Privacy />}
          {section === 'accounts' && <AccountsSection {...(family ? { family } : {})} />}
          {section === 'hardware' && <Devices />}
          {section === 'networks' && <ServersSection />}
          {section === 'display' && <Display save={save} />}
          {section === 'apikeys' && <ApiKeys />}
          {section === 'connections' && <Connections />}
          {section === 'contacts' && <Contacts />}
          {saved && <span className="fade-in text-[12px] text-up">✓ Réglage enregistré sur cet appareil</span>}
          {section !== 'connections' && section !== 'accounts' && !wide && (
            <div className="shrink-0">
              <Connections compact />
            </div>
          )}
        </div>
        {section !== 'connections' && section !== 'accounts' && wide && (
          <aside className="w-[400px] shrink-0">
            <Connections compact />
          </aside>
        )}
      </div>
    </div>
  );
}

type Save = (patch: Partial<Settings>) => Promise<void>;

function Panel({ children, className, tone }: { children: ReactNode; className?: string; tone?: 'danger' }) {
  return <section className={cn('flex flex-col rounded-panel border bg-card px-[22px] py-1.5', tone === 'danger' ? 'border-down/30' : 'border-line', className)}>{children}</section>;
}

function SettingRow({ title, desc, children, last }: { title: string; desc: string; children: ReactNode; last?: boolean }) {
  return (
    <div className={cn('flex items-center justify-between gap-6 py-4', !last && 'border-b border-line')}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[14px] font-medium">{title}</span>
        <span className="text-[12px] text-mute">{desc}</span>
      </div>
      {children}
    </div>
  );
}

function Security({ save }: { save: Save }) {
  const { settings } = useApp();
  return (
    <>
      <Panel>
        <SettingRow title="Verrouillage automatique" desc="Après une période d’inactivité, et à la mise en veille.">
          <Segmented
            label="Délai de verrouillage"
            value={settings.autoLockSecs}
            onChange={(v) => void save({ autoLockSecs: v })}
            options={[300, 900, 1800, 3600].map((s) => ({ value: s, label: s === 3600 ? '1 h' : `${s / 60} min` }))}
          />
        </SettingRow>
        <SettingRow title="Mot de passe à chaque transaction" desc="Toujours actif. Ne peut pas être désactivé.">
          <Switch label="Mot de passe à chaque transaction" checked disabled />
        </SettingRow>
        <SettingRow title="Bloquer les captures d’écran" desc="Complet sous Windows, partiel sous macOS.">
          <Switch
            label="Bloquer les captures d’écran"
            checked={settings.captureProtection}
            onCheckedChange={(v) => {
              void save({ captureProtection: v });
              void call('set_capture_protection', { enabled: v }).catch(() => undefined);
            }}
          />
        </SettingRow>
        <SettingRow title="Alerte presse-papier" desc="Bloque l’envoi si l’adresse collée change.">
          <Switch label="Alerte presse-papier" checked={settings.clipboardGuard} onCheckedChange={(v) => void save({ clipboardGuard: v })} />
        </SettingRow>
        <SettingRow title="Masquer les soldes au démarrage" desc="Utile en public ou en partage d’écran." last>
          <Switch label="Masquer les soldes au démarrage" checked={settings.hideBalancesOnStart} onCheckedChange={(v) => void save({ hideBalancesOnStart: v })} />
        </SettingRow>
      </Panel>
      <RevealPhrase />
    </>
  );
}

function Privacy() {
  const { settings, saveSettings } = useApp();
  const tor = useTor();
  const enabled = settings.tor.enabled;
  return (
    <>
      <Panel>
        <SettingRow title="Passer par Tor" desc="Activé par défaut. Toutes les requêtes réseau de Kyro passent par Tor, intégré à l’app." last>
          <Switch
            label="Passer par Tor"
            checked={enabled}
            disabled={tor.busy}
            onCheckedChange={(v) => {
              // Off: explicit confirmation first (nothing is saved before it). On: immediate.
              if (v) void torStore.enable(() => saveSettings({ ...settings, tor: { enabled: true } }));
              else torStore.requestDisable('settings');
            }}
          />
        </SettingRow>
      </Panel>
      <section className="flex flex-col gap-3.5 rounded-panel border border-line bg-card px-[22px] py-[18px]">
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-2 text-[15px] font-medium tracking-[-0.01em]">
            <IconTor size={16} className="text-mute" /> État de la connexion
          </span>
          <span className="font-mono text-[11px]">
            <TorIndicator />
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <div className="flex flex-col gap-1.5 rounded-box border border-line bg-raised px-4 py-3.5">
            <span className="flex items-center gap-2 text-[13px] font-semibold">
              <IconCheck size={14} className="text-up" /> Ce que Tor cache
            </span>
            <span className="text-[12px] leading-[1.5] text-mute">Ton adresse IP. Les serveurs voient celle d’un relais Tor, et deux familles de requêtes (Bitcoin, EVM, Solana, prix, swap) ne partagent jamais un circuit.</span>
          </div>
          <div className="flex flex-col gap-1.5 rounded-box border border-line bg-raised px-4 py-3.5">
            <span className="flex items-center gap-2 text-[13px] font-semibold">
              <IconX size={14} className="text-warn" /> Ce qu’il ne cache pas
            </span>
            <span className="text-[12px] leading-[1.5] text-mute">Ce que tu demandes : les serveurs voient toujours les adresses et les transactions que tu consultes. Pour l’éviter, utilise tes propres nœuds.</span>
          </div>
        </div>
        <p className="m-0 text-[12px] leading-[1.55] text-mute">
          Si Tor ne se connecte pas, Kyro bloque les requêtes et te demande quoi faire : jamais de repli en clair sans ton accord. Les détails sont dans la documentation de Kyro (page « Réseau »).
        </p>
        {!enabled && (
          <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
            Connexion directe : les serveurs contactés voient ton adresse IP. Réactive Tor ci-dessus pour la cacher.
          </Notice>
        )}
        {tor.actionError && tor.dialog === 'none' && <Notice tone="error">{tor.actionError}</Notice>}
      </section>
    </>
  );
}

function RevealPhrase() {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const backup = getBackupState();

  const close = () => {
    setPw('');
    setError(null);
    setShown(false);
    setOpen(false);
  };
  // Rust checks the password, asks in a native window, then shows the words in another native
  // window: they never reach this interface (a compromised page could not read them).
  const reveal = async () => {
    setBusy(true);
    setError(null);
    try {
      await call('vault_reveal_mnemonic', { password: pw });
      setPw('');
      setShown(true);
    } catch (e) {
      const err = toIpcError(e);
      setError(err.code === 'USER_REJECTED' ? 'Affichage annulé dans la fenêtre système.' : err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex items-center gap-4 rounded-panel border border-down/30 bg-card px-[22px] py-[18px]">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-ctl bg-down/12 text-down">
        <IconEye size={18} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-[14px] font-semibold">
          Phrase de récupération {backup === 'unknown' && <Badge tone="warn">Sauvegarde non vérifiée</Badge>}
        </span>
        <span className="text-[12px] leading-[1.5] text-mute">Mot de passe requis. Affichée dans une fenêtre du système, jamais dans l’interface. Jamais copiée.</span>
      </div>
      <Button variant="dangerOutline" size="md" onClick={() => setOpen(true)}>
        Afficher
      </Button>
      <Button variant="outline" size="md" disabled title="Changement de mot de passe : bientôt">
        Mot de passe
      </Button>
      <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : close())} title="Phrase de récupération" className="w-[620px]">
        {!shown ? (
          <>
            <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
              Vérifie que personne ne regarde ton écran et qu’aucun partage d’écran n’est actif. Quiconque voit ces mots contrôle tes fonds.
            </Notice>
            <p className="m-0 text-[13px] leading-[1.55] text-text2">
              Après ton mot de passe, Kyro te demande une confirmation dans une fenêtre du système, puis y affiche les mots. Si une fenêtre te demande ta phrase au lieu de l’afficher, c’est une arnaque.
            </p>
            <PasswordField id="reveal-pw" value={pw} onChange={setPw} autoFocus onEnter={() => pw && void reveal()} />
            {error && <Notice tone="error">{error}</Notice>}
            <div className="flex justify-end gap-2">
              <Button onClick={close}>Annuler</Button>
              <Button variant="danger" disabled={!pw || busy} onClick={() => void reveal()}>
                {busy && <Spinner />} {busy ? 'Fenêtre système ouverte…' : 'Afficher la phrase'}
              </Button>
            </div>
          </>
        ) : (
          <>
            <Notice tone="info">La fenêtre système est fermée : la phrase n’est plus affichée.</Notice>
            <div className="flex justify-end">
              <Button variant="primary" onClick={close}>
                Fermer
              </Button>
            </div>
          </>
        )}
      </Dialog>
    </section>
  );
}

function Display({ save }: { save: Save }) {
  const { settings } = useApp();
  return (
    <Panel>
      <SettingRow title="Devise" desc="Pour les prix, les soldes et les frais.">
        <Segmented label="Devise" value={settings.currency} onChange={(v) => void save({ currency: v })} options={[{ value: 'EUR', label: 'EUR €' }, { value: 'USD', label: 'USD $' }]} />
      </SettingRow>
      <SettingRow title="Masquer les soldes au démarrage" desc="Les montants s’affichent en •••••, l’œil les révèle." last>
        <Switch label="Masquer les soldes au démarrage" checked={settings.hideBalancesOnStart} onCheckedChange={(v) => void save({ hideBalancesOnStart: v })} />
      </SettingRow>
    </Panel>
  );
}

/**
 * API keys are write-only (settings_get returns `apiKeysSet` only): a saved key shows
 * « Clé enregistrée » with Remplacer / Supprimer, never its value. The field holds only what the
 * user is typing now, is cleared once saved, and is the only key value ever sent.
 */
function ApiKeys() {
  const { settings, config } = useApp();
  // config flags are « environment OR saved key »: environment only when nothing is saved.
  const rows: Array<{ key: ApiKeyName; label: string; desc: string; env: boolean }> = [
    { key: 'coingecko', label: 'CoinGecko', desc: 'Optionnelle : quota plus large pour les prix.', env: !!config?.hasCoingeckoKey && !settings.apiKeysSet.coingecko },
    { key: 'zerox', label: '0x', desc: 'Requise pour les devis 0x.', env: !!config?.hasZeroxKey && !settings.apiKeysSet.zerox },
    { key: 'trongrid', label: 'TronGrid', desc: 'Optionnelle : limites de débit plus hautes pour TRON (TRON-PRO-API-KEY).', env: !!config?.hasTrongridKey && !settings.apiKeysSet.trongrid },
  ];
  return (
    <Panel className="gap-4 py-5">
      <span className="text-[15px] font-medium tracking-[-0.01em]">Clés API</span>
      <p className="m-0 -mt-2 text-[13px] leading-[1.5] text-mute">
        Stockées dans le dossier de l’app et ajoutées aux requêtes par le noyau. Kyro ne réaffiche jamais une clé enregistrée : tu peux la remplacer ou la supprimer. Une clé intégrée à un binaire distribué est publique : utilise tes propres clés.
      </p>
      {rows.map((r) => (
        <ApiKeyRow key={r.key} name={r.key} label={r.label} desc={r.desc} env={r.env} saved={!!settings.apiKeysSet[r.key]} />
      ))}
    </Panel>
  );
}

function ApiKeyRow({ name, label, desc, env, saved }: { name: ApiKeyName; label: string; desc: string; env: boolean; saved: boolean }) {
  const { settings, saveSettings } = useApp();
  const [editing, setEditing] = useState(!saved);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => setEditing(!saved), [saved]);
  const write = async (v: string) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await saveSettings(settings, { [name]: v });
      setValue('');
      setDone(v ? 'Clé enregistrée.' : 'Clé supprimée.');
    } catch (e) {
      setError(toIpcError(e).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-1.5" data-api-key={name}>
      <span className="flex items-center gap-2 text-[12px] font-medium text-mute">
        {label} {env && <Badge tone="up">fournie par l’environnement</Badge>}
      </span>
      {saved && !editing ? (
        <div className="flex items-center gap-2 rounded-ctl border border-line-2 bg-raised px-3 py-2">
          <IconCheck size={14} className="text-up" />
          <span className="flex-1 text-[13px] text-text2">Clé enregistrée</span>
          <Button size="sm" onClick={() => setEditing(true)} disabled={busy}>
            Remplacer
          </Button>
          <Button size="sm" variant="dangerOutline" onClick={() => void write('')} disabled={busy}>
            {busy && <Spinner />} Supprimer
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Input type="password" autoComplete="off" value={value} placeholder={saved ? 'Nouvelle clé (remplace l’actuelle)' : desc} onChange={(e) => setValue(e.target.value)} aria-label={`Clé API ${label}`} className="flex-1 font-mono text-[13px]" />
          <Button variant="primary" size="sm" disabled={busy || value.trim() === ''} onClick={() => void write(value.trim())}>
            {busy && <Spinner />} Enregistrer
          </Button>
          {saved && (
            <Button
              size="sm"
              onClick={() => {
                setEditing(false);
                setValue('');
              }}
              disabled={busy}
            >
              Annuler
            </Button>
          )}
        </div>
      )}
      {error && <span className="text-[12px] text-down">{error}</span>}
      {done && !error && <span className="text-[12px] text-up">{done}</span>}
    </div>
  );
}

function Connections({ compact }: { compact?: boolean }) {
  const { settings, network, navigate } = useApp();
  const hosts = outgoingHosts(network, settings.servers);
  return (
    <section className="flex h-full flex-col gap-3 rounded-panel border border-line bg-card px-[22px] py-5">
      <span className="text-[15px] font-medium tracking-[-0.01em]">Connexions sortantes</span>
      <p className="m-0 text-[13px] leading-[1.55] text-mute">La liste complète des serveurs que Kyro contacte. Tout le reste est bloqué par le coffre.</p>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto scroll-thin">
        {hosts.map((h) => (
          <div key={h.host + h.purpose} className="flex items-center gap-3 rounded-ctl bg-raised px-4 py-2.5">
            <span className="size-1.5 shrink-0 rounded-full bg-up" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-mono text-[12px]">{h.host}</span>
              <span className="text-[12px] text-mute">{h.purpose}</span>
            </span>
            {h.custom && <Badge tone="ice">perso</Badge>}
          </div>
        ))}
      </div>
      {compact && (
        <Button variant="outline" size="lg" onClick={() => navigate({ name: 'settings', section: 'networks' })}>
          Utiliser mes propres serveurs
        </Button>
      )}
    </section>
  );
}

function Contacts() {
  const { accounts, adapters } = useVault();
  const { accountSources } = useApp();
  const [list, setList] = useState<Contact[]>(() => getContacts());
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [family, setFamily] = useState<ContactFamily>('evm');
  const adapter = family === 'evm' ? [...adapters.evm.values()][0] : family === 'ada' ? adapters.cardano : family === 'dot' ? adapters.polkadot : adapters[family];
  const valid = !!adapter && adapter.isValidAddress(address.trim());
  const persist = (l: Contact[]) => {
    setList(l);
    saveContacts(l);
  };
  // Address poisoning: a contact saved from a look-alike would become a « known » address. Compare
  // the new one with the other contacts and your own addresses before it goes into the book.
  const lookalike = (() => {
    if (!valid) return null;
    const own = [accounts.btc?.segwit.address, accounts.btc?.taproot.address, accounts.evm?.address, accounts.sol?.address, accounts.ltc?.address, accounts.doge?.address, accounts.tron?.address, accounts.xrp?.address, accounts.cardano?.address, accounts.polkadot?.address, ...accountSources.filter((x) => x.family === family).flatMap((x) => x.addresses)];
    const ownOfFamily = own.filter((a): a is string => !!a && (adapter?.isValidAddress(a) ?? false));
    const known: KnownAddress[] = [
      ...list.filter((c) => c.family === family).map((c) => ({ address: c.address, source: 'contact' as const, label: c.name })),
      ...ownOfFamily.map((a) => ({ address: a, source: 'own' as const, label: 'ton adresse' })),
    ];
    return findLookalike(address.trim(), known, family);
  })();
  const [ack, setAck] = useState(false);
  useEffect(() => setAck(false), [address, family]);
  return (
    <Panel className="gap-4 py-5">
      <span className="text-[15px] font-medium tracking-[-0.01em]">Carnet d’adresses</span>
      <p className="m-0 -mt-2 text-[13px] text-mute">Stocké sur cet appareil uniquement. Kyro reconnaît ces adresses à l’envoi.</p>
      <div className="flex flex-col gap-2">
        {list.length === 0 && <span className="text-[13px] text-faint">Aucun contact.</span>}
        {list.map((c) => (
          <div key={c.id} className="flex items-center gap-3 rounded-ctl bg-raised px-4 py-2.5">
            <span className="flex size-8 items-center justify-center rounded-full bg-ice-deep text-[13px] font-semibold text-ice-text">{c.name.slice(0, 1).toUpperCase()}</span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-[14px] font-semibold">{c.name}</span>
              <span className="font-mono text-[12px] text-mute">
                {c.family.toUpperCase()} · {shortAddress(c.address)}
              </span>
            </span>
            <button type="button" aria-label={`Supprimer ${c.name}`} onClick={() => persist(list.filter((x) => x.id !== c.id))} className="flex size-8 items-center justify-center rounded-full text-mute hover:bg-control hover:text-down">
              <IconTrash size={15} />
            </button>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <span className="text-[13px] font-semibold">Ajouter</span>
        <div className="flex gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom" className="w-[160px]" />
          <Segmented label="Réseau" value={family} onChange={setFamily} options={[{ value: 'evm', label: 'EVM' }, { value: 'btc', label: 'BTC' }, { value: 'sol', label: 'SOL' }, { value: 'ltc', label: 'LTC' }, { value: 'doge', label: 'DOGE' }, { value: 'tron', label: 'TRON' }, { value: 'xrp', label: 'XRP' }, { value: 'ada', label: 'ADA' }, { value: 'dot', label: 'DOT' }]} />
        </div>
        <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Adresse" className="font-mono text-[13px]" />
        {address && !valid && <span className="text-[12px] text-down">Adresse invalide pour ce réseau.</span>}
        {lookalike && <PoisoningWarning recipient={address.trim()} lookalike={lookalike} family={family} acknowledged={ack} onAcknowledge={setAck} />}
        <div>
          <Button
            variant="primary"
            disabled={!name.trim() || !valid || (!!lookalike && !ack)}
            onClick={() => {
              persist([...list, { id: crypto.randomUUID(), name: name.trim(), address: address.trim(), family, sends: 0 }]);
              setName('');
              setAddress('');
            }}
          >
            Ajouter au carnet
          </Button>
        </div>
      </div>
    </Panel>
  );
}
