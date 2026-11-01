// SPDX-License-Identifier: GPL-3.0-or-later
//
// Catalog strings with markup: `<b>bold part</b>` tags (no nesting) rendered by the caller, and
// `{name}` placeholders that may be React nodes (an address block, a link…). Translators move
// the tags and placeholders freely; the text in between stays plain text (no HTML injection).

import { Fragment, type ReactNode } from 'react';
import { t, type Key } from './index';

export type TagRenderers = Record<string, (chunks: ReactNode) => ReactNode>;

/** `text` with `<tag>…</tag>` rendered by `tags[tag]` and `{name}` replaced by `params[name]`. */
export function richText(text: string, tags: TagRenderers = {}, params: Record<string, ReactNode> = {}): ReactNode {
  const out: ReactNode[] = [];
  const re = /<(\w+)>([\s\S]*?)<\/\1>/g;
  let last = 0;
  let k = 0;
  const pushText = (s: string) => {
    s.split(/(\{\w+\})/g).forEach((part) => {
      if (part === '') return;
      const m = /^\{(\w+)\}$/.exec(part);
      out.push(<Fragment key={k++}>{m && m[1] !== undefined && m[1] in params ? params[m[1]] : part}</Fragment>);
    });
  };
  for (let m = re.exec(text); m; m = re.exec(text)) {
    pushText(text.slice(last, m.index));
    const [, tag = '', inner = ''] = m;
    const render = tags[tag];
    const innerNodes: ReactNode[] = [];
    inner.split(/(\{\w+\})/g).forEach((part) => {
      if (part === '') return;
      const p = /^\{(\w+)\}$/.exec(part);
      innerNodes.push(<Fragment key={innerNodes.length}>{p && p[1] !== undefined && p[1] in params ? params[p[1]] : part}</Fragment>);
    });
    out.push(<Fragment key={k++}>{render ? render(innerNodes) : innerNodes}</Fragment>);
    last = m.index + m[0].length;
  }
  pushText(text.slice(last));
  return out;
}

/** Rich version of `t`: `rt('key', { b: (c) => <strong>{c}</strong> }, { addr: <Addr/> })`. */
export function rt(key: Key, tags: TagRenderers = {}, params: Record<string, ReactNode> = {}): ReactNode {
  // Placeholders are filled here (they may be nodes), so the raw string is looked up untouched.
  return richText((t as (k: Key) => string)(key), tags, params);
}
