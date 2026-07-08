/**
 * registry.tsx — the id → React component map for the control dashboard's INLINE
 * explainer render. App.tsx derives `EXPLAINER_BY_ID` from this list and mounts
 * `EXPLAINER_BY_ID[d.id]` under `.explainer-root.x-<id>`. Add one entry per
 * explainer.
 *
 * Each explainer's content CSS (src/<id>.css) is self-scoped at its source and
 * imported DIRECTLY by app/src/main.tsx — the registry only maps id → Component.
 */
import type * as React from 'react'
import { Md } from './md.tsx'
import { Sqlite } from './sqlite.tsx'
// `React` clashes with the React namespace type import above, so alias on import.
import { React as ReactExplainer } from './react.tsx'
import { Codegen } from './codegen.tsx'
import { Iac } from './iac.tsx'

export interface ExplainerEntry {
  /** dashboard demo id — App.tsx mounts this under `.explainer-root.x-<id>` */
  readonly id: string
  readonly Component: React.FC
}

export const EXPLAINERS: readonly ExplainerEntry[] = [
  { id: 'sqlite', Component: Sqlite },
  { id: 'md', Component: Md },
  // The registry `id` is ALSO the dashboard demo id (App.tsx maps EXPLAINER_BY_ID
  // by demo id), so codegen/iac use the DEMO ids `schema` (3.1) / `schema-iac`
  // (3.2), not `codegen`/`iac`. react's demo id already matches.
  { id: 'react', Component: ReactExplainer },
  { id: 'schema', Component: Codegen },
  { id: 'schema-iac', Component: Iac },
]
