/**
 * registry.tsx — the set of explainers the SSG build renders. Add one entry per
 * explainer; the build loops this list. `css` names a per-explainer content CSS
 * file (in src/), inlined after the shared kit CSS.
 */
import type * as React from 'react'
import { Md } from './md.tsx'
import { Sqlite } from './sqlite.tsx'

export interface ExplainerEntry {
  /** output basename → demo/explainers/notion-<id>.next.html */
  readonly id: string
  /** <title> of the emitted document */
  readonly title: string
  /** per-explainer content CSS file in src/ (inlined after kit CSS), if any */
  readonly css?: string
  readonly Component: React.FC
}

export const EXPLAINERS: readonly ExplainerEntry[] = [
  {
    id: 'sqlite',
    title: 'notion db — a visual thread',
    css: 'sqlite.css',
    Component: Sqlite,
  },
  {
    id: 'md',
    title: 'notion md — a visual thread',
    css: 'md.css',
    Component: Md,
  },
]
