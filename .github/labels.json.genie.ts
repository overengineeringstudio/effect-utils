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

export default githubLabels({
  labels: [
    ...commonLabels,
    ...mqLabels,
    ...andonLabels,
    ...effectUtilsAreaLabels,
    ...effectUtilsAutomationLabels,
  ],
  deprecated: deprecatedDefaults,
  legacyMigrations,
})
