import type { GitHubWorkflowArgs } from './mod.ts'

/** Symbol metadata survives step spreading but is not serialized into workflow YAML. */
export const jobCacheDescriptors = Symbol('jobCacheDescriptors')
/** Descriptor registry for references assembled outside install steps. */
export const workflowCacheDescriptors = Symbol('workflowCacheDescriptors')
/** Publisher step metadata identifying the write-secret expression's name. */
export const publisherWriteSecret = Symbol('publisherWriteSecret')

type CacheAddress = {
  readonly name: string
  readonly visibility: 'public' | 'private'
} & (
  | { readonly kind: 'nix-binary'; readonly uri: string }
  | { readonly kind: 'reapi'; readonly endpoint: string }
)

/** Private cache exposure on a non-fleet runner. */
export class PrivateBinaryCacheRunnerError extends Error {
  readonly _tag = 'PrivateBinaryCacheRunnerError'
  readonly cacheName: string
  readonly runner: string | readonly string[]
  constructor({ cacheName, runner }: { cacheName: string; runner: string | readonly string[] }) {
    super(`Private build cache ${cacheName} requires a static fleet sh-* runner`)
    this.name = 'PrivateBinaryCacheRunnerError'
    this.cacheName = cacheName
    this.runner = runner
  }
}

/** Publisher credential or write action outside a protected, step-local scope. */
export class CachePublisherJobError extends Error {
  readonly _tag = 'CachePublisherJobError'
  constructor(readonly jobName: string) {
    super(
      `Cache publisher job ${jobName} requires a protected main-branch trigger and job-level if; write secrets are step-local`,
    )
    this.name = 'CachePublisherJobError'
  }
}

const fleetLabels: Record<string, true> = {
  'sh-linux-x64': true,
  'sh-linux-arm64': true,
  'sh-darwin-arm64': true,
}

/** Admit only literal fleet labels with an optional Nix capability label. */
export const isFleetCacheRunner = (runner: string | readonly string[]): boolean => {
  const labels =
    typeof runner === 'string' ? [runner] : Array.isArray(runner) === true ? runner : []
  return (
    labels.some((label) => fleetLabels[label] === true) &&
    labels.every((label) => label === 'nix' || fleetLabels[label] === true)
  )
}

const protectedJobEvents = (condition: string | undefined): readonly string[] => {
  if (condition === undefined) return []
  const expression = condition
    .trim()
    .replace(/^\$\{\{\s*/, '')
    .replace(/\s*\}\}$/, '')
  const grouped = [
    ...expression.matchAll(
      /\(\s*github\.event_name == '(push|workflow_dispatch|schedule)'(?:\s*\|\|\s*github\.event_name == '(push|workflow_dispatch|schedule)')*\s*\)/g,
    ),
  ]
  const matches =
    grouped.length === 0
      ? [...expression.matchAll(/github\.event_name == '(push|workflow_dispatch|schedule)'/g)]
      : grouped
  if (matches.length !== 1) return []
  const withoutEvents = expression.replace(matches[0]![0], 'EVENT_GUARD')
  if (
    withoutEvents.includes('||') === true ||
    /(^|&&)\s*github\.ref == 'refs\/heads\/main'\s*(&&|$)/.test(withoutEvents) === false
  )
    return []
  return [
    ...matches[0]![0].matchAll(/github\.event_name == '(push|workflow_dispatch|schedule)'/g),
  ].map((match) => match[1]!)
}

const workflowEvents = (on: GitHubWorkflowArgs['on']): readonly string[] =>
  typeof on === 'string' ? [on] : Array.isArray(on) === true ? on : Object.keys(on)

const secretReferences = (value: unknown): readonly string[] =>
  [...JSON.stringify(value ?? '').matchAll(/\bsecrets\.([A-Za-z_][A-Za-z_0-9]*)\b/g)].map(
    (match) => match[1]!,
  )

const isWriteStep = (step: GitHubWorkflowArgs['jobs'][string]['steps'][number]): boolean => {
  const action = 'uses' in step && step.uses.startsWith('cachix/cachix-action@')
  return (
    (action && (step.with?.authToken !== undefined || step.with?.skipPush !== true)) ||
    step.env?.CACHIX_AUTH_TOKEN !== undefined ||
    ('run' in step && /\bcachix\s+push\b/.test(step.run))
  )
}

/** Inspect the complete workflow at the common githubWorkflow output boundary. */
export const validateWorkflowCachePolicy = ({
  workflow,
  caches = [],
}: {
  workflow: GitHubWorkflowArgs
  caches?: readonly CacheAddress[]
}): void => {
  const triggers = workflowEvents(workflow.on)
  const writeSecrets = new Set(['CACHIX_AUTH_TOKEN'])
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      if (publisherWriteSecret in step) writeSecrets.add(step[publisherWriteSecret] as string)
      if (isWriteStep(step) === true) {
        for (const secret of secretReferences(step)) writeSecrets.add(secret)
      }
    }
  }
  const containsWriteSecret = (value: unknown): boolean =>
    secretReferences(value).some((secret) => writeSecrets.has(secret) === true)
  if (containsWriteSecret(workflow.env) === true || workflow.env?.CACHIX_AUTH_TOKEN !== undefined) {
    throw new CachePublisherJobError('workflow')
  }
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (containsWriteSecret(job.env) === true || job.env?.CACHIX_AUTH_TOKEN !== undefined) {
      throw new CachePublisherJobError(name)
    }
    const jobCaches = [
      ...caches,
      ...(workflowCacheDescriptors in workflow
        ? (workflow[workflowCacheDescriptors] as readonly CacheAddress[])
        : []),
      ...job.steps.flatMap((step) =>
        jobCacheDescriptors in step ? (step[jobCacheDescriptors] as readonly CacheAddress[]) : [],
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
    const protectedEvents = protectedJobEvents(job.if)
    const protectedPublisher =
      protectedEvents.length !== 0 &&
      protectedEvents.every((event) => triggers.includes(event) === true) &&
      (protectedEvents.includes('push') === false ||
        (typeof workflow.on === 'object' &&
          workflow.on !== null &&
          Array.isArray(workflow.on) === false &&
          'push' in workflow.on &&
          workflow.on.push !== null &&
          workflow.on.push !== undefined &&
          'branches' in workflow.on.push &&
          workflow.on.push.branches?.includes('main') === true))
    for (const step of job.steps) {
      const writer = isWriteStep(step)
      if (
        (writer === true && protectedPublisher === false) ||
        (containsWriteSecret(step) === true && (writer === false || protectedPublisher === false))
      ) {
        throw new CachePublisherJobError(name)
      }
    }
  }
}
