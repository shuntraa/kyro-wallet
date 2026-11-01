// SPDX-License-Identifier: GPL-3.0-or-later
//
// Network helpers. The webview has no direct network access (CSP):
// every request goes through the `net_fetch` command, which enforces the
// host allowlist of docs/IPC.md §3 and injects API keys on the Rust side.

import { call, type NetRequest, type NetResponse } from './ipc';
import { l10n } from './i18n';

export type NetFetch = (req: NetRequest) => Promise<NetResponse>;

/** Default transport: the `net_fetch` IPC command. */
export const netFetch: NetFetch = (req) => call('net_fetch', { req });

export class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, url: string) {
    super(`HTTP ${status} — ${hostOf(url)}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export interface JsonRequestInit {
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
}

/** Fetch + JSON parse; throws `HttpError` on non-2xx. */
export async function fetchJson<T>(fetcher: NetFetch, url: string, init: JsonRequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', ...init.headers };
  const req: NetRequest = { url, method: init.method ?? 'GET', headers };
  if (init.body !== undefined) {
    req.body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
    headers['content-type'] ??= 'application/json';
  }
  const res = await fetcher(req);
  if (res.status < 200 || res.status >= 300) throw new HttpError(res.status, res.body, url);
  try {
    return JSON.parse(res.body) as T;
  } catch {
    throw new HttpError(res.status, res.body.slice(0, 200), url);
  }
}

/** Fetch returning raw text; throws `HttpError` on non-2xx. */
export async function fetchText(fetcher: NetFetch, url: string, init: JsonRequestInit = {}): Promise<string> {
  const req: NetRequest = { url, method: init.method ?? 'GET', headers: { accept: 'text/plain', ...init.headers } };
  if (init.body !== undefined) req.body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
  const res = await fetcher(req);
  if (res.status < 200 || res.status >= 300) throw new HttpError(res.status, res.body, url);
  return res.body;
}

export class JsonRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
    this.data = data;
  }
}

let rpcId = 0;

/** Minimal JSON-RPC 2.0 client over `net_fetch`. */
export async function jsonRpc<T>(fetcher: NetFetch, url: string, method: string, params: unknown[] | Record<string, unknown> = []): Promise<T> {
  rpcId = (rpcId + 1) % 1_000_000;
  const res = await fetchJson<{ result?: T; error?: { code: number; message: string; data?: unknown } }>(fetcher, url, {
    method: 'POST',
    body: { jsonrpc: '2.0', id: rpcId, method, params },
  });
  if (res.error) throw new JsonRpcError(res.error.code, res.error.message, res.error.data);
  return res.result as T;
}

/** One answer of a JSON-RPC batch: the result, or the call's own error. */
export type JsonRpcOutcome = { ok: true; result: unknown } | { ok: false; error: JsonRpcError };

/**
 * JSON-RPC 2.0 batch (one HTTP request for many calls, same host). Answers are matched by id and
 * returned in call order; a call without an answer gets an error. Throws if the server does not
 * answer with an array (batches unsupported), so the caller can fall back on single calls.
 */
export async function jsonRpcBatch(fetcher: NetFetch, url: string, calls: Array<{ method: string; params: unknown[] }>): Promise<JsonRpcOutcome[]> {
  if (calls.length === 0) return [];
  const ids = calls.map(() => (rpcId = (rpcId + 1) % 1_000_000));
  const res = await fetchJson<unknown>(fetcher, url, {
    method: 'POST',
    body: calls.map((c, i) => ({ jsonrpc: '2.0', id: ids[i], method: c.method, params: c.params })),
  });
  if (!Array.isArray(res)) throw new JsonRpcError(-32600, l10n('lot JSON-RPC non pris en charge par ce nœud', 'JSON-RPC batch not supported by this node'));
  const byId = new Map<unknown, { result?: unknown; error?: { code: number; message: string; data?: unknown } }>();
  for (const r of res as Array<{ id?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } }>) if (r && typeof r === 'object') byId.set(r.id, r);
  return ids.map((id) => {
    const r = byId.get(id);
    if (!r) return { ok: false, error: new JsonRpcError(-32603, l10n('réponse absente du lot', 'response missing from the batch')) };
    if (r.error) return { ok: false, error: new JsonRpcError(r.error.code, r.error.message, r.error.data) };
    return { ok: true, result: r.result };
  });
}
