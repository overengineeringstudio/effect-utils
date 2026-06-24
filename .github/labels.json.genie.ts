import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  andonLabels,
  commonLabels,
  deprecatedDefaults,
  legacyMigrations,
  mqLabels,
} from '../genie/labels.ts'
import { githubLabels, type LabelDef } from '../packages/@overeng/genie/src/runtime/mod.ts'

/**
 * Repo-local `area:*` labels specific to effect-utils. Cross-repo concerns
 * (area:nix, area:typescript, area:ci, area:storybook, area:effect, area:devenv,
 * area:tooling) live in `genie/labels.ts` as `commonLabels`.
 */
const effectUtilsAreaLabels: readonly LabelDef[] = [
  { name: 'area:rust', color: '1d76db', description: 'Rust code and tooling · Set: manual' },
  {
    name: 'area:tui',
    color: '1d76db',
    description: 'tui-react / tui-stories / TUI rendering · Set: manual',
  },
  {
    name: 'area:nix-hash',
    color: '1d76db',
    description:
      'Nix hash determinism/staleness (pnpmDepsHash, lockfileHash, FOD cache) · Set: manual',
  },
  {
    name: 'area:notion',
    color: '1d76db',
    description: 'Notion API client / react / schema packages · Set: manual',
  },
  {
    name: 'area:pty-effect',
    color: '1d76db',
    description: 'pty-effect client and server · Set: manual',
  },
  {
    name: 'area:genie',
    color: '1d76db',
    description: 'genie config generator runtime + CLI · Set: manual',
  },
  {
    name: 'area:megarepo',
    color: '1d76db',
    description: 'megarepo CLI and conventions · Set: manual',
  },
]

/**
 * Repo-local `system:*` labels — one per concrete `@overeng/*` package. A
 * `system:*` value names a thing with its own identity that issues and feedback
 * are attributed *to*, distinct from the cross-cutting `area:*` concern axis.
 * Derived from the package directories (derive-don't-author) so the catalog
 * tracks the workspace automatically; the genie freshness gate regenerates and
 * diffs `labels.json`, so adding/removing a package is always reflected here.
 */
const effectUtilsSystemLabels: readonly LabelDef[] = readdirSync(
  fileURLToPath(new URL('../packages/@overeng', import.meta.url)),
  { withFileTypes: true },
)
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
  .map((pkg) => ({
    name: `system:${pkg}`,
    color: 'a371f7',
    description: `@overeng/${pkg} package · Set: manual`,
  }))

/** Repo-local utility labels used by automation in this repo. */
const effectUtilsAutomationLabels: readonly LabelDef[] = [
  {
    name: 'close-after-review',
    color: 'ededed',
    description: 'Close after the review/validation artifact has been inspected · Set: manual',
  },
  {
    name: 'debug-pr',
    color: 'ededed',
    description: 'Temporary PR used to debug or validate automation · Set: manual',
  },
  {
    name: 'measurement-validation',
    color: 'ededed',
    description: 'Temporary PR validates CI measurement/reporting behavior · Set: manual',
  },
]

/** Repo-local orphans being migrated into the structured `area:*` axis. */
const repoLocalDeprecated: readonly string[] = ['devenv', 'nix-hash']
const repoLocalLegacyMigrations = [
  { from: 'devenv', to: 'area:devenv' },
  { from: 'nix-hash', to: 'area:nix-hash' },
] as const

export default githubLabels({
  labels: [
    ...commonLabels,
    ...mqLabels,
    ...andonLabels,
    ...effectUtilsAreaLabels,
    ...effectUtilsSystemLabels,
    ...effectUtilsAutomationLabels,
  ],
  deprecated: [...deprecatedDefaults, ...repoLocalDeprecated],
  legacyMigrations: [...legacyMigrations, ...repoLocalLegacyMigrations],
})
