// SPDX-License-Identifier: GPL-3.0-or-later
//
// Custom servers (B2b): pure helpers shared by the settings UI (instant feedback) and the
// demo backend. The source of truth stays Rust (apps/desktop/src-tauri/src/servers.rs):
// these rules mirror docs/IPC.md §2.1 so the UI can flag an obvious mistake before the
// live check, never to relax anything.

import type { BtcNetworkKey, BtcServer, Network, Servers, SolanaCluster } from './ipc';

export const EMPTY_SERVERS: Servers = { bitcoin: {}, evm: {}, solana: {}, litecoin: {}, dogecoin: {}, tron: {}, xrp: {}, cardano: {} };

export function btcNetworkKey(network: Network): BtcNetworkKey {
  return network === 'mainnet' ? 'mainnet' : 'testnet4';
}

export function solanaCluster(network: Network): SolanaCluster {
  return network === 'mainnet' ? 'mainnet-beta' : 'devnet';
}

/** Bitcoin server of `network` (`default` when unset). */
export function bitcoinServerFor(servers: Servers, network: Network): BtcServer {
  return servers.bitcoin[btcNetworkKey(network)] ?? { kind: 'default' };
}

/** Loopback, RFC 1918, link-local, IPv6 ULA / link-local, or `localhost`. */
export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (h.includes(':')) {
    if (h === '::1') return true;
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
    if (mapped?.[1]) return isPrivateHost(mapped[1]);
    const first = parseInt(h.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return false;
}

export function isOnion(host: string): boolean {
  return host.toLowerCase().endsWith('.onion');
}

/** URL rule of §2.1. Returns the French reason, or null when acceptable. `allowPrivateHttp` = Bitcoin Core only. */
export function checkServerUrl(url: string, tor: boolean, allowPrivateHttp = false): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return `URL invalide « ${url} »`;
  }
  if (u.username || u.password) return 'pas d’identifiants dans l’URL (utilise les champs d’authentification)';
  const host = u.hostname;
  if (!host) return 'URL sans hôte';
  const onion = isOnion(host);
  if (u.protocol === 'https:') return onion && !tor ? 'adresse .onion : exige Tor activé' : null;
  if (u.protocol === 'http:') {
    if (onion) return tor ? null : 'adresse .onion : exige Tor activé';
    if (allowPrivateHttp && isPrivateHost(host)) return null;
    return allowPrivateHttp ? 'http:// n’est permis que pour une adresse locale ou .onion via Tor ; sinon https://' : 'http:// n’est permis que pour une adresse .onion via Tor ; sinon https://';
  }
  return `schéma non autorisé « ${u.protocol.replace(':', '')} »`;
}

/** SHA-256 fingerprint (`AB:CD…`, spaces or plain hex) → 64 lowercase hex, or null. */
export function normalizeFingerprint(s: string): string | null {
  const clean = s.replace(/[:\s]/g, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(clean) ? clean : null;
}

/** Readable fingerprint: 16 groups of 4 uppercase hex characters. */
export function fingerprintGroups(hex: string): string[] {
  const clean = hex.replace(/[:\s]/g, '').toUpperCase();
  return clean.match(/.{1,4}/g) ?? [];
}

/** Onion v3 host: 56 base32 characters + `.onion`. */
export function isOnionV3(host: string): boolean {
  return /^[a-z2-7]{56}\.onion$/.test(host.toLowerCase());
}

/**
 * Compact-filter peer rule (servers.rs `parse_peer`): "onion:port" (v3) or "ip:port"
 * ("[v6]:port"), never a host name (no DNS). Returns the reason, or null.
 */
export function checkCbfPeer(peer: string): string | null {
  const p = peer.trim();
  const i = p.lastIndexOf(':');
  if (i <= 0) return `pair « ${p} » : hôte:port attendu`;
  const port = Number(p.slice(i + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return `pair « ${p} » : port invalide`;
  const host = p.slice(0, i).replace(/^\[|\]$/g, '').toLowerCase();
  if (host.endsWith('.onion')) return isOnionV3(host) ? null : `pair « ${p} » : adresse .onion v3 attendue (56 caractères)`;
  const v4 = /^(\d{1,3})(\.\d{1,3}){3}$/.test(host) && host.split('.').every((x) => Number(x) <= 255);
  const v6 = host.includes(':') && /^[0-9a-f:.]+$/.test(host);
  return v4 || v6 ? null : `pair « ${p} » : adresse IP ou .onion attendue (pas de nom d’hôte : aucune requête DNS)`;
}

/** Syntax check of a Bitcoin server (no network). Returns the reason, or null. */
export function checkBtcServer(s: BtcServer, tor: boolean): string | null {
  switch (s.kind) {
    case 'default':
      return null;
    case 'cbf': {
      const peers = s.peers ?? [];
      for (const p of peers) {
        const bad = checkCbfPeer(p);
        if (bad) return bad;
      }
      if (!tor && peers.length > 0 && peers.every((p) => p.trim().toLowerCase().replace(/:\d+$/, '').endsWith('.onion'))) {
        return 'pairs .onion uniquement : exige Tor activé (ajoute un pair IP pour le mode clair)';
      }
      if (s.birthHeight !== undefined && (!Number.isInteger(s.birthHeight) || s.birthHeight < 0)) return 'hauteur de départ invalide';
      return null;
    }
    case 'esplora':
      return checkServerUrl(s.url, tor);
    case 'electrum': {
      const h = s.host.trim();
      if (!h || /[/@\s]/.test(h) || (h.includes(':') && !h.startsWith('['))) return `hôte Electrum invalide « ${s.host} »`;
      if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) return 'port Electrum invalide';
      const onion = isOnion(h);
      if (onion && !tor) return 'adresse .onion : exige Tor activé';
      if (s.tls === 'none' && !(onion && tor)) return 'Electrum sans TLS : uniquement vers une adresse .onion via Tor';
      if (s.tls === 'pinned' && !normalizeFingerprint(s.certSha256 ?? '')) return 'empreinte SHA-256 du certificat : 64 caractères hexadécimaux attendus';
      return null;
    }
    case 'core': {
      const bad = checkServerUrl(s.url, tor, true);
      if (bad) return bad;
      if (s.auth.kind === 'cookie') {
        const p = s.auth.cookiePath.trim();
        return p && (p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')) ? null : 'chemin du fichier .cookie : chemin absolu attendu';
      }
      if (!s.auth.user || s.auth.user.includes(':')) return 'utilisateur RPC invalide';
      return null;
    }
  }
}

/** True when Bitcoin Core at `url` is reached directly (local / LAN), not through Tor. */
export function coreIsLocal(url: string): boolean {
  try {
    return isPrivateHost(new URL(url.trim()).hostname);
  } catch {
    return false;
  }
}

/** `settings_get` view: Core passwords removed, `hasPassword` set (servers.rs `redacted`). */
export function redactServers(servers: Servers): Servers {
  const out = structuredClone(servers);
  for (const key of ['mainnet', 'testnet4'] as const) {
    const s = out.bitcoin[key];
    if (s?.kind === 'core' && s.auth.kind === 'userpass') {
      const { password, ...rest } = s.auth;
      s.auth = { ...rest, hasPassword: !!password };
    }
  }
  return out;
}

/**
 * Merge rule of `settings_set` (servers.rs `merge_secrets_from`): a Core `userpass` entry
 * without `password` keeps the stored one when URL and user are unchanged; `""` clears it.
 */
export function mergeServerSecrets(next: Servers, stored: Servers): Servers {
  const out = structuredClone(next);
  for (const key of ['mainnet', 'testnet4'] as const) {
    const n = out.bitcoin[key];
    const o = stored.bitcoin[key];
    if (n?.kind !== 'core' || n.auth.kind !== 'userpass') continue;
    const { hasPassword: _ignored, ...auth } = n.auth;
    if (auth.password === undefined && o?.kind === 'core' && o.auth.kind === 'userpass' && o.url === n.url && o.auth.user === auth.user && o.auth.password) {
      auth.password = o.auth.password;
    }
    if (auth.password === '') delete auth.password;
    n.auth = { ...auth, hasPassword: !!auth.password };
  }
  return out;
}
