import type { GitHubWorkflowArgs } from './mod.ts'

/**
 * Stable ledger path component, independent of unrelated steps and action refs.
 * IDs and names label identities but cannot replace action provenance or content.
 * Canonical input/environment ordering avoids churn from object insertion order.
 * Call once for every step in job order with a fresh ordinals map per job.
 * Only equivalent steps share an ordinal sequence; removing an earlier equivalent
 * step necessarily renumbers later occurrences.
 */
export const workflowPolicyStepIdentity = ({
  step,
  ordinals,
}: {
  step: GitHubWorkflowArgs['jobs'][string]['steps'][number]
  ordinals: Map<string, number>
}): string => {
  const label =
    step.id !== undefined
      ? `id:${JSON.stringify(step.id)}|`
      : step.name !== undefined
        ? `name:${JSON.stringify(step.name)}|`
        : ''
  const provenance = 'uses' in step ? `action:${JSON.stringify(step.uses.split('@')[0])}` : 'run'
  const content = JSON.stringify({
    if: step.if,
    env:
      step.env === undefined
        ? undefined
        : Object.entries(step.env).toSorted(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
    'continue-on-error': step['continue-on-error'],
    'timeout-minutes': step['timeout-minutes'],
    'working-directory': step['working-directory'],
    ...('uses' in step
      ? {
          with: Object.entries(step.with ?? {}).toSorted(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        }
      : { run: step.run, shell: step.shell }),
  })
  const identity = `${label}${provenance}|content:${content}`
  const ordinal = (ordinals.get(identity) ?? 0) + 1
  ordinals.set(identity, ordinal)
  return ordinal === 1 ? identity : `${identity}#${ordinal}`
}
