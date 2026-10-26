import type { GitHubWorkflowArgs } from '../../packages/@overeng/genie/src/runtime/github-workflow/mod.ts'
import {
  collectEffectiveWorkflowPolicyViolations,
  collectWorkflowPolicyViolations,
  decodeWorkflowPolicyLedger,
  WorkflowPolicyError,
} from '../../packages/@overeng/genie/src/runtime/github-workflow/policy.ts'
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
  exceptionEntries = exceptions.exceptions,
}: {
  readonly repository: string
  readonly workflow: string
  readonly mode?: 'enforce' | 'report'
  readonly ledger?: readonly WorkflowPolicyViolation[]
  readonly exceptionEntries?: readonly WorkflowPolicyException[]
}): WorkflowPolicy => ({
  repository,
  workflow,
  mode,
  admittedRunnerLabels: [...Object.values(fleetRunnerLabels), nixRunnerSelector],
  sameRepoGuardRunnerLabels: Object.values(fleetRunnerLabels),
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
    // https://github.com/actions/setup-go/blob/v6/action.yml: cache defaults true.
    { action: 'actions/setup-go', input: 'cache', defaultEnabled: true },
    // https://github.com/actions/setup-python/blob/v6/action.yml: optional cache, no default.
    { action: 'actions/setup-python', input: 'cache', defaultEnabled: false },
    // https://github.com/actions/setup-node/blob/v6/action.yml: explicit cache plus automatic
    // npm caching (v5+) via packageManager/devEngines; unknown pinned refs fail closed.
    { action: 'actions/setup-node', input: 'cache', defaultEnabled: false },
    {
      action: 'actions/setup-node',
      input: 'package-manager-cache',
      defaultEnabled: true,
      enabledUnless: 'false',
      minimumMajor: 5,
    },
    // https://github.com/actions/setup-java/blob/v5/action.yml: optional cache, no default.
    { action: 'actions/setup-java', input: 'cache', defaultEnabled: false },
    // https://github.com/actions/setup-dotnet/blob/v5/action.yml: cache defaults false.
    { action: 'actions/setup-dotnet', input: 'cache', defaultEnabled: false },
    // https://github.com/oven-sh/setup-bun/blob/v2/action.yml: executable caching is on
    // unless no-cache is explicitly true; there is no `cache` input.
    {
      action: 'oven-sh/setup-bun',
      input: 'no-cache',
      defaultEnabled: true,
      enabledUnless: 'true',
    },
  ],
  exceptions: exceptionEntries.filter(
    (entry) => entry.repository === repository && entry.workflow === workflow,
  ),
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

/** Stale or unmatched exceptions belong to a complete repository census, not one workflow. */
export const validateFleetPolicyExceptionRegistry = ({
  repository,
  workflows,
  exceptionEntries = exceptions.exceptions,
}: {
  readonly repository: string
  readonly workflows: Readonly<Record<string, GitHubWorkflowArgs>>
  readonly exceptionEntries?: readonly WorkflowPolicyException[]
}): void => {
  const violations = Object.entries(workflows).flatMap(([workflow, value]) =>
    collectWorkflowPolicyViolations({
      workflow: value,
      policy: fleetWorkflowPolicy({ repository, workflow, exceptionEntries: [] }),
    }),
  )
  const stale = exceptionEntries.filter(
    (entry) =>
      entry.repository === repository &&
      violations.some(
        (violation) =>
          violation.workflow === entry.workflow &&
          violation.job === entry.job &&
          violation.rule === entry.rule,
      ) === false,
  )
  if (stale.length > 0) {
    throw new WorkflowPolicyError(
      stale.map((entry) => ({
        kind: 'INVALID_EXCEPTION',
        message: `Stale or unmatched exception: ${entry.repository}/${entry.workflow}/${entry.job}/${entry.rule}`,
      })),
    )
  }
}

/** Generate the same exception-filtered observations that report-mode validation compares. */
export const collectFleetPolicyMigrationLedger = ({
  repository,
  workflows,
  exceptionEntries = exceptions.exceptions,
}: {
  readonly repository: string
  readonly workflows: Readonly<Record<string, GitHubWorkflowArgs>>
  readonly exceptionEntries?: readonly WorkflowPolicyException[]
}): readonly WorkflowPolicyViolation[] =>
  Object.entries(workflows).flatMap(([workflow, value]) =>
    collectEffectiveWorkflowPolicyViolations({
      workflow: value,
      policy: fleetWorkflowPolicy({ repository, workflow, exceptionEntries }),
    }),
  )
