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
  { name: 'area:rust', color: '1d76db', description: 'Rust code and tooling' },
  { name: 'area:tui', color: '1d76db', description: 'tui-react / tui-stories / TUI rendering' },
  {
    name: 'area:nix-hash',
    color: '1d76db',
    description: 'Nix hash determinism/staleness (pnpmDepsHash, lockfileHash, FOD cache behavior)',
  },
  { name: 'area:notion', color: '1d76db', description: 'Notion API client / react / schema packages' },
  { name: 'area:pty-effect', color: '1d76db', description: 'pty-effect client and server' },
  { name: 'area:genie', color: '1d76db', description: 'genie config generator runtime + CLI' },
  { name: 'area:megarepo', color: '1d76db', description: 'megarepo CLI and conventions' },
]

/** Repo-local utility labels used by automation in this repo. */
const effectUtilsAutomationLabels: readonly LabelDef[] = [
  {
    name: 'close-after-review',
    color: 'ededed',
    description: 'Close after the review/validation artifact has been inspected',
  },
  {
    name: 'debug-pr',
    color: 'ededed',
    description: 'Temporary PR used to debug or validate automation',
  },
  {
    name: 'measurement-validation',
    color: 'ededed',
    description: 'Temporary PR validates CI measurement/reporting behavior',
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
    ...effectUtilsAutomationLabels,
  ],
  deprecated: [...deprecatedDefaults, ...repoLocalDeprecated],
  legacyMigrations: [...legacyMigrations, ...repoLocalLegacyMigrations],
})
