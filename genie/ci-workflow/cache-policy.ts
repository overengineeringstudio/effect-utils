import type { GitHubWorkflowArgs } from '../../packages/@overeng/genie/src/runtime/mod.ts'
import { isFleetCacheRunner, PrivateBinaryCacheRunnerError } from './binary-cache-composition.ts'
import type { BinaryCacheDescriptor } from './binary-cache-descriptors.ts'

export const jobCacheDescriptors = Symbol('jobCacheDescriptors')

export class CachePublisherJobError extends Error {
  readonly _tag = 'CachePublisherJobError'
  constructor(readonly jobName: string) {
    super(
      `Cache publisher job ${jobName} requires a protected main-branch trigger and job-level if`,
    )
    this.name = 'CachePublisherJobError'
  }
}

/** Evaluate only literal AND-guarded event/ref predicates. Unknown expressions fail closed. */
const protectedJobEvents = (condition: string | undefined): readonly string[] => {
  if (condition === undefined) return []
  const expression = condition
    .trim()
    .replace(/^\$\{\{\s*/, '')
    .replace(/\s*\}\}$/, '')
  const ref = "github.ref == 'refs/heads/main'"
  if (expression.includes(ref) === false) return []
  const event =
    /\(\s*github\.event_name == '(push|workflow_dispatch|schedule)'(?:\s*\|\|\s*github\.event_name == '(push|workflow_dispatch|schedule)')*\s*\)/g
  const grouped = [...expression.matchAll(event)]
  const matches =
    grouped.length === 0
      ? [...expression.matchAll(/github\.event_name == '(push|workflow_dispatch|schedule)'/g)]
      : grouped
  if (matches.length !== 1) return []
  const withoutEvents = expression.replace(matches[0]![0], 'EVENT_GUARD')
  if (withoutEvents.includes('||') === true) return []
  if (/(^|&&)\s*github\.ref == 'refs\/heads\/main'\s*(&&|$)/.test(withoutEvents) === false)
    return []
  return [
    ...matches[0]![0].matchAll(/github\.event_name == '(push|workflow_dispatch|schedule)'/g),
  ].map((match) => match[1]!)
}

const workflowEvents = (on: GitHubWorkflowArgs['on']): readonly string[] =>
  typeof on === 'string' ? [on] : Array.isArray(on) === true ? on : Object.keys(on)

const isWriteStep = (step: GitHubWorkflowArgs['jobs'][string]['steps'][number]): boolean => {
  const action = 'uses' in step && step.uses.startsWith('cachix/cachix-action@')
  return (
    (action && (step.with?.authToken !== undefined || step.with?.skipPush !== true)) ||
    step.env?.CACHIX_AUTH_TOKEN !== undefined ||
    ('run' in step && /\bcachix\s+push\b/.test(step.run))
  )
}

/** Inspect final jobs after all spread/step composition, before emitting workflow YAML. */
export const validateWorkflowCachePolicy = ({
  workflow,
  caches = [],
}: {
  workflow: GitHubWorkflowArgs
  caches?: readonly BinaryCacheDescriptor[]
}): void => {
  if (workflow.env?.CACHIX_AUTH_TOKEN !== undefined) {
    throw new CachePublisherJobError('workflow')
  }
  const triggers = workflowEvents(workflow.on)
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (job.env?.CACHIX_AUTH_TOKEN !== undefined) {
      throw new CachePublisherJobError(name)
    }
    const jobCaches = [
      ...caches,
      ...job.steps.flatMap((step) =>
        jobCacheDescriptors in step
          ? (step[jobCacheDescriptors] as readonly BinaryCacheDescriptor[])
          : [],
      ),
    ]
    const allText = JSON.stringify({ env: workflow.env, jobEnv: job.env, steps: job.steps })
    for (const cache of jobCaches) {
      if (cache.visibility !== 'private') continue
      const address = cache.kind === 'nix-binary' ? cache.uri : cache.endpoint
      if (allText.includes(address) === true && isFleetCacheRunner(job['runs-on']) === false) {
        throw new PrivateBinaryCacheRunnerError({ cacheName: cache.name, runner: job['runs-on'] })
      }
    }
    if (job.steps.some(isWriteStep) === false) continue
    const allowedEvents = protectedJobEvents(job.if)
    if (
      allowedEvents.length === 0 ||
      allowedEvents.some((event) => triggers.includes(event) === false) === true ||
      (triggers.includes('push') === true &&
        allowedEvents.includes('push') === true &&
        (typeof workflow.on !== 'object' ||
          workflow.on === null ||
          Array.isArray(workflow.on) === true ||
          !('push' in workflow.on) ||
          workflow.on.push == null ||
          !('branches' in workflow.on.push) ||
          workflow.on.push.branches?.includes('main') !== true))
    )
      throw new CachePublisherJobError(name)
  }
}
