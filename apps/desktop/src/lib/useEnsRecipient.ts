// SPDX-License-Identifier: GPL-3.0-or-later
// The recipient field of Send: `name.eth` to an address, on EVM chains only. The result lives in
// this hook's state and nowhere else: a lookup is never stored.

import { useEffect, useState } from 'react';
import { looksLikeEnsName, normalizeEnsName, type AdapterSet, type AssetDef, type EnsResult } from '@kyro/chains';

export type EnsState = { status: 'idle' } | { status: 'invalid' | 'loading' | 'notFound' | 'offchain' | 'failed'; input: string } | { status: 'ok'; input: string; name: string; address: string };

/** What the field shows while `input` is being read. */
export function ensActive(ens: EnsState, input: string): boolean {
  return ens.status !== 'idle' && ens.input === input.trim();
}

/** The address Send may use: only the answer to exactly what is in the field. */
export function ensAddress(ens: EnsState, input: string): string | null {
  return ens.status === 'ok' && ens.input === input.trim() ? ens.address : null;
}

const DEBOUNCE_MS = 400;

/** The lookup for a send of `asset`: read on Ethereum, for its chain. Null outside EVM chains. */
export function ensResolver(asset: AssetDef | undefined, adapters: Pick<AdapterSet, 'evm'>, network: 'mainnet' | 'testnet'): ((name: string) => Promise<EnsResult>) | null {
  if (asset?.family !== 'evm') return null;
  const target = adapters.evm.get(asset.chainKey);
  const ethereum = adapters.evm.get(network === 'testnet' ? 'sepolia' : 'ethereum');
  return target && ethereum ? (name) => ethereum.resolveEns(name, target.chain.chainId) : null;
}

/** `chainKey`: another chain can mean another address, so it restarts the lookup. */
export function useEnsRecipient(input: string, resolve: ((name: string) => Promise<EnsResult>) | null, chainKey: string | undefined): EnsState {
  const name = input.trim();
  const wanted = resolve !== null && looksLikeEnsName(name);
  const [state, setState] = useState<EnsState>({ status: 'idle' });

  useEffect(() => {
    if (!wanted || !resolve) {
      setState({ status: 'idle' });
      return;
    }
    if (normalizeEnsName(name) === null) {
      setState({ status: 'invalid', input: name });
      return;
    }
    setState({ status: 'loading', input: name });
    let stale = false;
    const timer = setTimeout(() => {
      resolve(name).then(
        (r) => {
          if (!stale) setState(r.kind === 'ok' ? { status: 'ok', input: name, name: r.name, address: r.address } : { status: r.kind, input: name });
        },
        () => {
          if (!stale) setState({ status: 'failed', input: name });
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
    // `resolve` is a new function at each render of Send; `chainKey` stands for it.
  }, [name, wanted, chainKey]);

  return state;
}
