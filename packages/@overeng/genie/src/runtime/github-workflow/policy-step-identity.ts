import type { GitHubWorkflowArgs } from './mod.ts'

/**
 * Stable ledger path component, independent of unrelated steps and action refs.
 * Call once for every step in job order with a fresh ordinals map per job.
 * Duplicate identities retain distinct keys, but removing an earlier duplicate
 * necessarily renumbers later duplicates; distinct IDs or names avoid that ambiguity.
 */
export const workflowPolicyStepIdentity = ({
  step,
  ordinals,
}: {
  step: GitHubWorkflowArgs['jobs'][string]['steps'][number]
  ordinals: Map<string, number>
}): string => {
  const identity =
    step.id !== undefined
      ? `id:${JSON.stringify(step.id)}`
      : step.name !== undefined
        ? `name:${JSON.stringify(step.name)}`
        : 'uses' in step
          ? `action:${JSON.stringify(step.uses.split('@')[0])}`
          : 'run'
  const ordinal = (ordinals.get(identity) ?? 0) + 1
  ordinals.set(identity, ordinal)
  return ordinal === 1 ? identity : `${identity}#${ordinal}`
}
