import { decodeWorkflowPolicyLedger } from '../../packages/@overeng/genie/src/runtime/github-workflow/policy.ts'
import type {
  WorkflowPolicy,
  WorkflowPolicyException,
  WorkflowPolicyViolation,
} from '../../packages/@overeng/genie/src/runtime/github-workflow/policy.ts'
import exceptions from './policy-exceptions.json' with { type: 'json' }
import migrationLedger from './policy-migration-ledger.json' with { type: 'json' }
import { fleetRunnerLabels, nixRunnerSelector } from './runners.ts'

/** Fleet policy values live here; the generator package supplies only the mechanism. */
export const fleetWorkflowPolicy = ({
  repository,
  workflow,
  mode = 'enforce',
  ledger,
}: {
  readonly repository: string
  readonly workflow: string
  readonly mode?: 'enforce' | 'report'
  readonly ledger?: readonly WorkflowPolicyViolation[]
}): WorkflowPolicy => ({
  repository,
  workflow,
  mode,
  admittedRunnerLabels: [...Object.values(fleetRunnerLabels), nixRunnerSelector],
  exclusiveRunnerLabels: [fleetRunnerLabels.linuxX64Heavy],
  bannedActions: [
    'actions/upload-artifact',
    'actions/download-artifact',
    'actions/cache',
    'actions/upload-pages-artifact',
    'Swatinem/rust-cache',
    'namespacelabs/nscloud-cache-action',
  ],
  setupActionCaches: [
    { action: 'actions/setup-go', input: 'cache', defaultEnabled: true },
    { action: 'actions/setup-python', input: 'cache', defaultEnabled: true },
    { action: 'actions/setup-node', input: 'cache', defaultEnabled: false },
    { action: 'actions/setup-java', input: 'cache', defaultEnabled: false },
    { action: 'actions/setup-dotnet', input: 'cache', defaultEnabled: false },
    { action: 'oven-sh/setup-bun', input: 'cache', defaultEnabled: false },
  ],
  exceptions: exceptions.exceptions satisfies readonly WorkflowPolicyException[],
  ...(ledger === undefined ? {} : { ledger }),
})

/** This repository's existing allocations/storage are inventoried, never excepted. */
export const effectUtilsWorkflowPolicy = (workflow: string): WorkflowPolicy =>
  fleetWorkflowPolicy({
    repository: 'overengineeringstudio/effect-utils',
    workflow,
    mode: 'report',
    ledger: decodeWorkflowPolicyLedger(migrationLedger.violations).filter(
      (entry) => entry.workflow === workflow,
    ),
  })
