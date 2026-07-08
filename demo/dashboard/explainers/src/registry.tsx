/**
 * registry.tsx — the set of explainers the SSG build renders. Add one entry per
 * explainer; the build loops this list. `css` names a per-explainer content CSS
 * file (in src/), inlined after the shared kit CSS.
 */
import type * as React from 'react'
import { Md } from './md.tsx'
import { Sqlite } from './sqlite.tsx'
// `React` clashes with the React namespace type import above, so alias on import.
import { React as ReactExplainer } from './react.tsx'
import { Codegen } from './codegen.tsx'
import { Iac } from './iac.tsx'

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
  // The registry `id` is ALSO the dashboard demo id (App.tsx maps EXPLAINER_BY_ID
  // by demo id), so codegen/iac use the DEMO ids `schema` (3.1) / `schema-iac`
  // (3.2), not `codegen`/`iac`. react's demo id already matches.
  {
    id: 'react',
    title: 'notion-react — a visual thread',
    css: 'react.css',
    Component: ReactExplainer,
  },
  {
    id: 'schema',
    title: 'notion schema — a visual thread',
    css: 'codegen.css',
    Component: Codegen,
  },
  {
    id: 'schema-iac',
    title: 'notion schema — a visual thread',
    css: 'iac.css',
    Component: Iac,
  },
]
