/**
 * Shared `system:*` label derivation, reused across primary megarepo members.
 *
 * A `system:*` value names a thing with its own identity (a concrete package, a
 * VRS-homed subsystem) that issues and feedback are attributed *to* — distinct
 * from the cross-cutting `area:*` concern axis. The *values* are legitimately
 * per-repo, but the derivation *logic* (read a directory, one `system:<name>`
 * per subdirectory, violet `a371f7`, `· Set: manual`) was copy-pasted between
 * effect-utils and dotfiles. This is that logic, once.
 *
 * Lives in `genie/` (consumed via the megarepo path / `#mr` alias by peer repos'
 * `.github/labels.json.genie.ts`), not in the published `@overeng/genie` runtime
 * package — it is genie-eval-time `readdirSync` glue, and the runtime should not
 * carry it. Only the `LabelDef` *type* is imported from the runtime.
 */

import { readdirSync } from 'node:fs'

import type { LabelDef } from '../packages/@overeng/genie/src/runtime/github-labels/mod.ts'

/** Single, axis-consistent color for every `system:*` chip (violet, distinct from area blue). */
export const systemLabelColor = 'a371f7'

export interface DeriveSystemLabelsArgs {
  /**
   * Absolute directory whose immediate subdirectories each become one
   * `system:<name>`. Callers resolve this from their own genie file, e.g.
   * `fileURLToPath(new URL('../packages/@overeng', import.meta.url))`.
   */
  dir: string
  /** Map a subdirectory name to the label description (the `· Set: manual` suffix is appended). */
  describe: (name: string) => string
  /** Subdirectory names to skip (e.g. already covered by an `area:*` label). */
  exclude?: readonly string[]
  /** Optional rename of the `system:` segment for a given subdirectory, e.g. `{ '19-feedback': 'feedback' }`. */
  aliases?: Readonly<Record<string, string>>
}

/**
 * Derive-don't-author `system:*` labels from a directory's subdirectories, sorted
 * for byte-stable output so the genie freshness gate reflects package/subsystem
 * adds and removes automatically.
 */
export const deriveSystemLabels = ({
  dir,
  describe,
  exclude = [],
  aliases = {},
}: DeriveSystemLabelsArgs): readonly LabelDef[] => {
  const excluded = new Set(exclude)
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => excluded.has(name) === false)
    .toSorted()
    .map((name) => ({
      name: `system:${aliases[name] ?? name}`,
      color: systemLabelColor,
      description: `${describe(name)} · Set: manual`,
    }))
}
