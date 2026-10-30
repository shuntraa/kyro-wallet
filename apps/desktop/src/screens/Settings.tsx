// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState, type ReactNode } from 'react';
import { call, toIpcError, type Settings } from '@kyro/shared';
import { outgoingHosts } from '@kyro/chains';
import { useApp, useVault, type SettingsSection } from '../state/app';
import { cn } from '../lib/cn';
import { shortAddress } from '../lib/format';
import { getBackupState, getContacts, saveContacts, type Contact, type ContactFamily } from '../lib/storage';
import { PasswordField } from '../components/kit';
import { Dialog } from '../components/ui/dialog';
import { Badge, Button, Input, Notice, Segmented, Spinner, Switch } from '../components/ui/primitives';
import { IconCheck, IconEye, IconPhoneKey, IconTor, IconTrash, IconUsbKey, IconWarn, IconX } from '../components/icons';
import { TorIndicator } from '../components/Tor';
import { torStore, useTor } from '../state/tor';

const SECTIONS: Array<{ key: SettingsSection; label: string }> = [
  { key: 'security', label: 'Sécurité' },
  { key: 'privacy', label: 'Confidentialité' },
  { key: 'hardware', label: 'Hardware wallets' },
  { key: 'networks', label: 'Réseaux et RPC' },
  { key: 'display', label: 'Affichage et devise' },
  { key: 'apikeys', label: 'Clés API' },
  { key: 'connections', label: 'Connexions sortantes' },
  { key: 'contacts', label: 'Carnet d’adresses' },
];

export function SettingsScreen({ section: initial = 'security' }: { section?: SettingsSection }) {
  const [section, setSection] = useState<SettingsSection>(initial);
  const { settings, saveSettings } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

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
      <nav aria-label="Sections des réglages" className="flex w-[240px] shrink-0 flex-col gap-1 border-r border-rail px-3.5 py-[22px]">
        <h1 className="m-0 px-2.5 pb-4 text-[24px] font-semibold tracking-[-0.03em]">Réglages</h1>
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            type="button"
            aria-current={section === s.key ? 'page' : undefined}
            onClick={() => setSection(s.key)}
            className={cn('flex h-10 items-center gap-2.5 rounded-[12px] px-3.5 text-left text-[14px]', section === s.key ? 'bg-raised font-semibold' : 'text-text2 hover:bg-raised/60')}
          >
            {section === s.key && <span className="size-1.5 rounded-full bg-ice" />}
            <span className={section === s.key ? '' : 'pl-4'}>{s.label}</span>
          </button>
        ))}
        <div className="flex-1" />
        <div className="rounded-[16px] border border-line bg-card px-4 py-3.5">
          <div className="text-[14px] font-semibold">Kyro v{__APP_VERSION__}</div>
          <div className="text-[12px] leading-[1.5] text-mute">Open source · GPLv3. Build vérifiable depuis le code.</div>
        </div>
      </nav>

      <div className="flex min-w-0 flex-1 gap-4 px-[26px] py-[22px]">
        <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto scroll-thin">
          {error && <Notice tone="error">{error}</Notice>}
          {section === 'security' && <Security save={save} />}
          {section === 'privacy' && <Privacy />}
          {section === 'hardware' && <Hardware />}
          {section === 'networks' && <Networks save={save} />}
          {section === 'display' && <Display save={save} />}
          {section === 'apikeys' && <ApiKeys save={save} />}
          {section === 'connections' && <Connections />}
          {section === 'contacts' && <Contacts />}
          {saved && <span className="text-[12px] text-up">✓ Réglage enregistré sur cet appareil</span>}
        </div>
        {section !== 'connections' && (
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
  return <section className={cn('flex flex-col rounded-[22px] border bg-card px-[22px] py-1.5', tone === 'danger' ? 'border-down/30' : 'border-line', className)}>{children}</section>;
}

function SettingRow({ title, desc, children, last }: { title: string; desc: string; children: ReactNode; last?: boolean }) {
  return (
    <div className={cn('flex items-center justify-between gap-6 py-4', !last && 'border-b border-line')}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[14px] font-semibold">{title}</span>
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
      <Hardware />
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
      <section className="flex flex-col gap-3.5 rounded-[22px] border border-line bg-card px-[22px] py-[18px]">
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-2 text-[15px] font-semibold">
            <IconTor size={16} className="text-mute" /> État de la connexion
          </span>
          <span className="font-mono text-[11px]">
            <TorIndicator />
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <div className="flex flex-col gap-1.5 rounded-[16px] border border-line bg-raised px-4 py-3.5">
            <span className="flex items-center gap-2 text-[13px] font-semibold">
              <IconCheck size={14} className="text-up" /> Ce que Tor cache
            </span>
            <span className="text-[12px] leading-[1.5] text-mute">Ton adresse IP. Les serveurs voient celle d’un relais Tor, et deux familles de requêtes (Bitcoin, EVM, Solana, prix, swap) ne partagent jamais un circuit.</span>
          </div>
          <div className="flex flex-col gap-1.5 rounded-[16px] border border-line bg-raised px-4 py-3.5">
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
  const { settings } = useApp();
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState('');
  const [words, setWords] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [left, setLeft] = useState(60);
  const backup = getBackupState();

  // Capture protection while visible; auto-hide after 60 s; never kept.
  useEffect(() => {
    if (!words) return;
    void call('set_capture_protection', { enabled: true }).catch(() => undefined);
    setLeft(60);
    const id = window.setInterval(() => setLeft((l) => l - 1), 1000);
    return () => {
      window.clearInterval(id);
      void call('set_capture_protection', { enabled: settings.captureProtection }).catch(() => undefined);
    };
  }, [words]);
  useEffect(() => {
    if (left <= 0) close();
  }, [left]);

  const close = () => {
    setWords(null);
    setPw('');
    setError(null);
    setOpen(false);
  };
  const reveal = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await call('vault_reveal_mnemonic', { password: pw });
      setPw('');
      setWords(res.words);
    } catch (e) {
      setError(toIpcError(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex items-center gap-4 rounded-[22px] border border-down/30 bg-card px-[22px] py-[18px]">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-[12px] bg-down/12 text-down">
        <IconEye size={18} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-[14px] font-semibold">
          Phrase de récupération {backup === 'unknown' && <Badge tone="warn">Sauvegarde non vérifiée</Badge>}
        </span>
        <span className="text-[12px] leading-[1.5] text-mute">Mot de passe requis. Captures d’écran bloquées pendant l’affichage. Jamais copiée.</span>
      </div>
      <Button variant="dangerOutline" size="md" onClick={() => setOpen(true)}>
        Afficher
      </Button>
      <Button variant="outline" size="md" disabled title="Changement de mot de passe : bientôt">
        Mot de passe
      </Button>
      <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : close())} title="Phrase de récupération" className="w-[620px]">
        {!words ? (
          <>
            <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
              Vérifie que personne ne regarde ton écran. Quiconque voit ces mots contrôle tes fonds.
            </Notice>
            <PasswordField id="reveal-pw" value={pw} onChange={setPw} autoFocus onEnter={() => pw && void reveal()} />
            {error && <Notice tone="error">{error}</Notice>}
            <div className="flex justify-end gap-2">
              <Button onClick={close}>Annuler</Button>
              <Button variant="danger" disabled={!pw || busy} onClick={() => void reveal()}>
                {busy && <Spinner />} Afficher la phrase
              </Button>
            </div>
          </>
        ) : (
          <>
            <ol className={cn('m-0 grid list-none gap-2 p-0', words.length === 24 ? 'grid-cols-4' : 'grid-cols-3')}>
              {words.map((w, i) => (
                <li key={i} className="flex h-10 items-center gap-2 rounded-[10px] border border-line bg-raised px-2.5">
                  <span className="w-5 font-mono text-[11px] text-faint">{i + 1}</span>
                  <span className="font-mono text-[14px]">{w}</span>
                </li>
              ))}
            </ol>
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-mute">Masquage automatique dans {left} s</span>
              <Button variant="primary" onClick={close}>
                Masquer
              </Button>
            </div>
          </>
        )}
      </Dialog>
    </section>
  );
}

function Hardware() {
  return (
    <section className="flex flex-col gap-3.5 rounded-[22px] border border-line bg-card px-[22px] py-[18px]">
      <div className="flex items-center justify-between">
        <span className="text-[15px] font-semibold">Hardware wallets</span>
        <Badge tone="ice">Bientôt</Badge>
      </div>
      <p className="m-0 text-[13px] text-text2">Chaque signature se fera sur l’appareil. Même un ordinateur infecté ne pourra pas voler tes clés.</p>
      <div className="grid grid-cols-2 gap-2.5">
        {[
          ['Ledger', 'USB · Bluetooth plus tard', <IconUsbKey key="l" size={16} />],
          ['Trezor', 'USB', <IconPhoneKey key="t" size={16} />],
        ].map(([name, sub, icon]) => (
          <div key={String(name)} className="flex items-center gap-3 rounded-[16px] border border-line bg-raised px-4 py-3.5 opacity-75">
            <span className="flex size-[34px] items-center justify-center rounded-[10px] bg-control-2">{icon}</span>
            <span className="flex flex-col">
              <span className="text-[14px] font-semibold">{name}</span>
              <span className="text-[12px] text-mute">{sub}</span>
            </span>
          </div>
        ))}
      </div>
      <span className="flex items-center gap-2 text-[12px] text-faint">
        <span className="size-1.5 rounded-full bg-faint" /> Aucun appareil connecté · prise en charge en préparation
      </span>
    </section>
  );
}

function Networks({ save }: { save: Save }) {
  const { settings, network } = useApp();
  const [rpc, setRpc] = useState(settings.rpc);
  const fields: Array<{ key: keyof Settings['rpc']; label: string; placeholder: string }> = [
    { key: 'ethereum', label: network === 'testnet' ? 'Ethereum Sepolia (RPC)' : 'Ethereum (RPC)', placeholder: network === 'testnet' ? 'https://ethereum-sepolia-rpc.publicnode.com' : 'https://ethereum-rpc.publicnode.com' },
    { key: 'solana', label: 'Solana (RPC)', placeholder: network === 'testnet' ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com' },
    { key: 'esplora', label: 'Bitcoin (Esplora)', placeholder: network === 'testnet' ? 'https://mempool.space/testnet4/api' : 'https://mempool.space/api' },
  ];
  const invalid = Object.values(rpc).some((u) => u && !/^https:\/\/[^/\s]+/.test(u));
  return (
    <Panel className="gap-4 py-5">
      <div className="flex items-center justify-between">
        <span className="text-[15px] font-semibold">Réseau</span>
        <Badge tone={network === 'testnet' ? 'warn' : 'up'}>{network === 'testnet' ? 'Testnet' : 'Mainnet'}</Badge>
      </div>
      <p className="m-0 text-[13px] leading-[1.5] text-mute">{network === 'testnet' ? 'Bitcoin testnet4, Ethereum Sepolia et Solana devnet. Les jetons n’ont aucune valeur.' : 'Bitcoin, Ethereum + 6 réseaux EVM (même adresse), Solana.'} Le réseau est fixé au lancement (KYRO_NETWORK).</p>
      <span className="pt-2 text-[15px] font-semibold">Nœuds personnalisés</span>
      <p className="m-0 -mt-2 text-[13px] text-mute">Laisse vide pour utiliser les nœuds publics. HTTPS uniquement ; l’hôte saisi est ajouté à la liste autorisée.</p>
      {fields.map((f) => (
        <label key={f.key} className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-mute">{f.label}</span>
          <Input value={rpc[f.key] ?? ''} placeholder={f.placeholder} onChange={(e) => setRpc((r) => ({ ...r, [f.key]: e.target.value.trim() }))} className="font-mono text-[13px]" />
        </label>
      ))}
      {invalid && <span className="text-[12px] text-down">Adresse invalide : https:// obligatoire.</span>}
      <div className="flex gap-2 pb-1">
        <Button
          variant="primary"
          disabled={invalid}
          onClick={() => {
            const clean: Settings['rpc'] = {};
            for (const f of fields) {
              const v = rpc[f.key];
              if (v) clean[f.key] = v;
            }
            void save({ rpc: clean });
          }}
        >
          Enregistrer
        </Button>
        <Button onClick={() => setRpc({})}>Revenir aux nœuds publics</Button>
      </div>
    </Panel>
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

function ApiKeys({ save }: { save: Save }) {
  const { settings, config } = useApp();
  const [keys, setKeys] = useState(settings.apiKeys);
  const rows: Array<{ key: keyof Settings['apiKeys']; label: string; desc: string; env: boolean }> = [
    { key: 'coingecko', label: 'CoinGecko', desc: 'Optionnelle : quota plus large pour les prix.', env: !!config?.hasCoingeckoKey },
    { key: 'zerox', label: '0x', desc: 'Requise pour les devis 0x.', env: !!config?.hasZeroxKey },
    { key: 'oneinch', label: '1inch', desc: 'Requise pour les devis 1inch.', env: !!config?.hasOneinchKey },
  ];
  return (
    <Panel className="gap-4 py-5">
      <span className="text-[15px] font-semibold">Clés API</span>
      <p className="m-0 -mt-2 text-[13px] leading-[1.5] text-mute">Stockées dans le dossier de l’app et ajoutées aux requêtes par le noyau. Une clé intégrée à un binaire distribué est publique : utilise tes propres clés.</p>
      {rows.map((r) => (
        <label key={r.key} className="flex flex-col gap-1.5">
          <span className="flex items-center gap-2 text-[12px] font-medium text-mute">
            {r.label} {r.env && <Badge tone="up">fournie par l’environnement</Badge>}
          </span>
          <Input type="password" autoComplete="off" value={keys[r.key] ?? ''} placeholder={r.desc} onChange={(e) => setKeys((k) => ({ ...k, [r.key]: e.target.value.trim() }))} className="font-mono text-[13px]" />
        </label>
      ))}
      <div className="pb-1">
        <Button
          variant="primary"
          onClick={() => {
            const clean: Settings['apiKeys'] = {};
            for (const r of rows) {
              const v = keys[r.key];
              if (v) clean[r.key] = v;
            }
            void save({ apiKeys: clean });
          }}
        >
          Enregistrer
        </Button>
      </div>
    </Panel>
  );
}

function Connections({ compact }: { compact?: boolean }) {
  const { settings, network, navigate } = useApp();
  const hosts = outgoingHosts(network, settings.rpc);
  return (
    <section className="flex h-full flex-col gap-3 rounded-[22px] border border-line bg-card px-[22px] py-5">
      <div className="flex items-center justify-between">
        <span className="text-[15px] font-semibold">Connexions sortantes</span>
        <Badge tone="ice" className="h-[26px] px-3 text-[12px]">
          0 télémétrie
        </Badge>
      </div>
      <p className="m-0 text-[13px] leading-[1.55] text-mute">La liste complète des serveurs que Kyro contacte. Tout le reste est bloqué par le coffre.</p>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto scroll-thin">
        {hosts.map((h) => (
          <div key={h.host + h.purpose} className="flex items-center gap-3 rounded-[12px] bg-raised px-4 py-2.5">
            <span className="size-1.5 shrink-0 rounded-full bg-up" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-mono text-[12px]">{h.host}</span>
              <span className="text-[12px] text-mute">{h.purpose}</span>
            </span>
          </div>
        ))}
      </div>
      {compact && (
        <Button variant="outline" size="lg" onClick={() => navigate({ name: 'settings', section: 'networks' })}>
          Utiliser mes propres nœuds RPC
        </Button>
      )}
    </section>
  );
}

function Contacts() {
  const { accounts } = useVault();
  const { adapters } = useVault();
  const [list, setList] = useState<Contact[]>(() => getContacts());
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [family, setFamily] = useState<ContactFamily>('evm');
  const adapter = family === 'btc' ? adapters.btc : family === 'sol' ? adapters.sol : [...adapters.evm.values()][0];
  const valid = !!adapter && adapter.isValidAddress(address.trim());
  const persist = (l: Contact[]) => {
    setList(l);
    saveContacts(l);
  };
  void accounts;
  return (
    <Panel className="gap-4 py-5">
      <span className="text-[15px] font-semibold">Carnet d’adresses</span>
      <p className="m-0 -mt-2 text-[13px] text-mute">Stocké sur cet appareil uniquement. Kyro reconnaît ces adresses à l’envoi.</p>
      <div className="flex flex-col gap-2">
        {list.length === 0 && <span className="text-[13px] text-faint">Aucun contact.</span>}
        {list.map((c) => (
          <div key={c.id} className="flex items-center gap-3 rounded-[12px] bg-raised px-4 py-2.5">
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
          <Segmented label="Réseau" value={family} onChange={setFamily} options={[{ value: 'evm', label: 'EVM' }, { value: 'btc', label: 'BTC' }, { value: 'sol', label: 'SOL' }]} />
        </div>
        <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Adresse" className="font-mono text-[13px]" />
        {address && !valid && <span className="text-[12px] text-down">Adresse invalide pour ce réseau.</span>}
        <div>
          <Button
            variant="primary"
            disabled={!name.trim() || !valid}
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
