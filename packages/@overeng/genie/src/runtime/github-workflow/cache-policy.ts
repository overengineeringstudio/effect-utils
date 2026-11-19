import {
  type BinaryCacheDescriptor,
  decodeBinaryCacheDescriptor,
} from './binary-cache-descriptor.ts'
import type { GitHubWorkflowArgs } from './mod.ts'
import { stripSameRepoPullRequestGuard, workflowConditionConjuncts } from './policy.ts'

/** Symbol metadata survives step spreading but is not serialized into workflow YAML. */
export const jobCacheDescriptors = Symbol('jobCacheDescriptors')
/** Descriptor registry for references assembled outside install steps. */
export const workflowCacheDescriptors = Symbol('workflowCacheDescriptors')
/** Publisher step metadata identifying the write-secret expression's name. */
export const publisherWriteSecret = Symbol('publisherWriteSecret')

/** Explicit job-local capability; symbols never become workflow YAML. */
export const hostedPrivateCacheReads = Symbol('hostedPrivateCacheReads')
export type HostedPrivateCacheRead = {
  readonly job: string
  readonly cache: BinaryCacheDescriptor
  readonly readSecret: `CACHIX_READ_${string}`
  readonly trustedActors: readonly string[]
}

/** Scope is a provisioning contract, not something workflow YAML can prove. */
export const defineHostedPrivateCacheRead = (read: HostedPrivateCacheRead): HostedPrivateCacheRead => {
  if (
    /^[A-Za-z_][A-Za-z_0-9-]*$/.test(read.job) === false ||
    /^CACHIX_READ_[A-Z0-9_]+$/.test(read.readSecret) === false ||
    read.trustedActors.length === 0 ||
    read.trustedActors.some((actor) => /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(actor) === false) ||
    decodeBinaryCacheDescriptor(read.cache).visibility !== 'private'
  ) {
    throw new Error('Hosted private cache reads require an exact job, private cache, dedicated CACHIX_READ_ secret and trusted actors')
  }
  return read
}

/** Must be the first step, before checkout, credentials or any repository code. */
export const trustedHostedCacheReadGate = (read: HostedPrivateCacheRead) => {
  defineHostedPrivateCacheRead(read)
  const actors = JSON.stringify(read.trustedActors)
  const identities = [
    'github.event.pull_request.user.login',
    'github.event.pull_request.head.repo.owner.login',
    'github.event.sender.login',
    'github.triggering_actor',
  ]
  return {
    name: 'Require trusted private cache reader',
    shell: 'bash',
    env: {
      TRUSTED_HEAD: `\${{ github.event.pull_request.head.repo.full_name == github.repository && ${identities.map((identity) => `contains(fromJSON('${actors}'), ${identity})`).join(' && ')} }}`,
    },
    run: '[[ "$TRUSTED_HEAD" == true ]] || { echo "::error::Private cache reads require a trusted same-repository head"; exit 1; }',
  }
}

/** Spread onto the exact job; the descriptor also covers raw Nix extra-conf. */
export const hostedPrivateCacheReadPolicy = (...reads: readonly HostedPrivateCacheRead[]) => ({
  [hostedPrivateCacheReads]: reads.map(defineHostedPrivateCacheRead),
})

export const isHostedPrivateCacheReadRunner = (runner: string | readonly string[]): boolean => {
  const label = typeof runner === 'string' ? runner : runner.length === 1 ? runner[0] : undefined
  return label !== undefined &&
    /^(?:ubuntu-(?:latest|22\.04|24\.04)(?:-arm)?|macos-(?:latest|13|14|15|26)(?:-large|-xlarge)?|windows-(?:latest|2022|2025))$/.test(label)
}

/** Exact descriptor identity, not a name-only exemption for a substituted endpoint. */
export const matchesHostedPrivateCacheRead = (
  read: HostedPrivateCacheRead,
  job: string | undefined,
  cache: BinaryCacheDescriptor,
): boolean => {
  defineHostedPrivateCacheRead(read)
  const expected = read.cache
  return read.job === job && expected.name === cache.name && expected.kind === cache.kind &&
    expected.visibility === cache.visibility &&
    (expected.kind === 'nix-binary' && cache.kind === 'nix-binary'
      ? expected.uri === cache.uri && expected.publicKey === cache.publicKey
      : expected.kind === 'reapi' && cache.kind === 'reapi' &&
        expected.endpoint === cache.endpoint && expected.instanceName === cache.instanceName &&
        expected.digest === cache.digest)
}

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
  readonly jobName: string
  constructor(jobName: string) {
    super(
      `Cache publisher job ${jobName} requires protected main-branch publication or an exact main-push Buck2 secret guard; write secrets are step-local`,
    )
    this.jobName = jobName
    this.name = 'CachePublisherJobError'
  }
}

const fleetLabels: Record<string, true> = {
  'sh-linux-x64': true,
  'sh-linux-x64-heavy': true,
  'sh-linux-arm64': true,
  'sh-linux-x64-publish': true,
  'sh-linux-arm64-publish': true,
  'sh-linux-x64-ai-gateway': true,
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
  const expression = stripSameRepoPullRequestGuard(
    condition
      .trim()
      .replace(/^\$\{\{\s*/, '')
      .replace(/\s*\}\}$/, ''),
  )
  const conjuncts = workflowConditionConjuncts(expression)
  if (
    conjuncts === undefined ||
    conjuncts.some((part) => /^github\.ref\s*==\s*'refs\/heads\/main'$/.test(part)) === false
  )
    return []
  let events: readonly string[] | undefined
  for (const part of conjuncts) {
    // Only a complete, positive top-level event conjunct can prove event scope.
    // Every other conjunct is an opaque narrowing, never evidence for admission.
    if (
      /^github\.event_name\s*==\s*'[\w-]+'(?:\s*\|\|\s*github\.event_name\s*==\s*'[\w-]+')*$/.test(
        part,
      ) === false
    )
      continue
    const selected = [...part.matchAll(/github\.event_name\s*==\s*'([\w-]+)'/g)].map(
      (match) => match[1]!,
    )
    events =
      events === undefined ? selected : events.filter((event) => selected.includes(event) === true)
  }
  return events !== undefined &&
    events.every((event) => ['push', 'workflow_dispatch', 'schedule'].includes(event) === true) ===
      true
    ? events
    : []
}

const workflowEvents = (on: GitHubWorkflowArgs['on']): readonly string[] =>
  typeof on === 'string' ? [on] : Array.isArray(on) === true ? on : Object.keys(on)

const namedSecretReference =
  /\bsecrets(?:\.([A-Za-z_][A-Za-z_0-9]*)|\[\s*['"]([A-Za-z_][A-Za-z_0-9]*)['"]\s*\])/g

const secretReferences = (value: unknown): readonly string[] => {
  const text = JSON.stringify(value ?? '').replace(/\\"/g, '"')
  const names = [...text.matchAll(namedSecretReference)].map((match) => (match[1] ?? match[2])!)
  // Only expression bodies can pass the aggregate `secrets` context: ordinary
  // shell prose mentioning secrets is not a GitHub Actions context reference.
  const aggregate = [...text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].some((match) =>
    /\bsecrets\b/.test(match[1]!.replace(namedSecretReference, '')),
  )
  return aggregate === true ? [...names, '*'] : names
}

const isWriteStep = (step: GitHubWorkflowArgs['jobs'][string]['steps'][number]): boolean => {
  const action = 'uses' in step && step.uses.startsWith('cachix/cachix-action@')
  return (
    publisherWriteSecret in step ||
    (action && (step.with?.authToken !== undefined || step.with?.skipPush !== true)) ||
    step.env?.CACHIX_AUTH_TOKEN !== undefined ||
    step.env?.CACHIX_PUSH_TOKEN !== undefined ||
    step.env?.BUCK2_PUBLIC_CACHE_WRITE_AUTH !== undefined ||
    ('run' in step && /\bcachix\s+push\b/.test(step.run))
  )
}

/** Shared cache writers run only on protected main pushes or its native queue heads. */
export const trustedCacheWriterPredicate =
  "(github.event_name == 'push' && github.ref == 'refs/heads/main') || (github.event_name == 'merge_group' && github.event.merge_group.base_ref == 'refs/heads/main' && startsWith(github.ref, 'refs/heads/gh-readonly-queue/main/'))"

/** Expose a writer secret only after the protected-main or queue event guard passes. */
export const trustedCacheWriterGuardedSecret = (name: string): string =>
  `\${{ (${trustedCacheWriterPredicate}) && secrets.${name} || '' }}`

const pushRestrictedToMain = (on: GitHubWorkflowArgs['on']): boolean =>
  typeof on === 'object' &&
  on !== null &&
  Array.isArray(on) === false &&
  'push' in on &&
  on.push !== null &&
  on.push !== undefined &&
  'branches' in on.push &&
  on.push.branches?.length === 1 &&
  on.push.branches[0] === 'main'

/**
 * Inspect the complete workflow at the common githubWorkflow output boundary.
 * Every attached cache descriptor is decoded here, so invalid producer JSON
 * fails composition even when a caller skipped the JSON reader.
 * Raw YAML outside Genie and reusable-workflow `secrets: inherit` are not
 * covered by this generation-time validation.
 */
export const validateWorkflowCachePolicy = ({
  workflow,
  caches = [],
}: {
  workflow: GitHubWorkflowArgs
  caches?: readonly BinaryCacheDescriptor[]
}): void => {
  const triggers = workflowEvents(workflow.on)
  const writeSecrets = new Set(['CACHIX_AUTH_TOKEN', 'CACHIX_PUSH_TOKEN', 'BUCK2_PUBLIC_CACHE_WRITE_AUTH'])
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      if (publisherWriteSecret in step) writeSecrets.add(step[publisherWriteSecret] as string)
      if (isWriteStep(step) === true) {
        for (const secret of secretReferences(step)) {
          if (secret !== '*') writeSecrets.add(secret)
        }
      }
    }
  }
  const containsWriteSecret = (value: unknown): boolean =>
    secretReferences(value).some((secret) => secret === '*' || writeSecrets.has(secret) === true)
  if (containsWriteSecret(workflow.env) === true || workflow.env?.CACHIX_AUTH_TOKEN !== undefined) {
    throw new CachePublisherJobError('workflow')
  }
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (containsWriteSecret(job.env) === true || job.env?.CACHIX_AUTH_TOKEN !== undefined) {
      throw new CachePublisherJobError(name)
    }
    const reads = hostedPrivateCacheReads in job
      ? (job[hostedPrivateCacheReads] as readonly HostedPrivateCacheRead[])
      : []
    for (const read of reads) {
      defineHostedPrivateCacheRead(read)
      const fail = () => {
        throw new PrivateBinaryCacheRunnerError({ cacheName: read.cache.name, runner: job['runs-on'] })
      }
      if (read.job !== name || isHostedPrivateCacheReadRunner(job['runs-on']) === false ||
        writeSecrets.has(read.readSecret) ||
        JSON.stringify(job.steps[0]) !== JSON.stringify(trustedHostedCacheReadGate(read))) fail()
      // Job/workflow scope is evaluated before the first step. Only the dedicated
      // step-local reader environment may reference this credential.
      const { steps: _steps, ...jobScope } = job
      const { jobs: _jobs, ...workflowScope } = workflow
      if (secretReferences([workflowScope, jobScope]).length !== 0 ||
        workflow.env?.BASH_ENV !== undefined || job.env?.BASH_ENV !== undefined ||
        workflow.env?.ENV !== undefined || job.env?.ENV !== undefined ||
        job.container !== undefined || job.services !== undefined) fail()
      let credentialFound = false
      for (const step of job.steps.slice(1)) {
        const { env, ...rest } = step
        const { CACHIX_READ_TOKEN: token, ...otherEnv } = env ?? {}
        if (token === `\${{ secrets.${read.readSecret} }}`) credentialFound = true
        else if (secretReferences(token).includes(read.readSecret)) fail()
        if (secretReferences([rest, otherEnv]).some((secret) =>
          secret === '*' || secret === read.readSecret)) fail()
      }
      if (credentialFound === false) fail()
    }
    const jobCaches = [
      ...caches,
      ...(workflowCacheDescriptors in workflow
        ? (workflow[workflowCacheDescriptors] as readonly unknown[])
        : []),
      ...job.steps.flatMap((step) =>
        jobCacheDescriptors in step ? (step[jobCacheDescriptors] as readonly unknown[]) : [],
      ),
    ].map((cache) => decodeBinaryCacheDescriptor(cache))
    jobCaches.push(...reads.map((read) => decodeBinaryCacheDescriptor(read.cache)))
    const allText = JSON.stringify({ env: workflow.env, jobEnv: job.env, steps: job.steps })
    for (const cache of jobCaches) {
      if (cache.visibility !== 'private') continue
      const address = cache.kind === 'nix-binary' ? cache.uri : cache.endpoint
      if (allText.includes(address) === true && isFleetCacheRunner(job['runs-on']) === false &&
        (isHostedPrivateCacheReadRunner(job['runs-on']) === false ||
          reads.some((read) => matchesHostedPrivateCacheRead(read, name, cache)) === false)) {
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
      // The exception is credential-scoped: Cachix write actions still need a protected job.
      const guardedSecret = trustedCacheWriterGuardedSecret('BUCK2_PUBLIC_CACHE_WRITE_AUTH')
      const stepText = JSON.stringify(step)
      const trustedGuardedWriter =
        publisherWriteSecret in step &&
        step[publisherWriteSecret] === 'BUCK2_PUBLIC_CACHE_WRITE_AUTH' &&
        (triggers.includes('push') === false || pushRestrictedToMain(workflow.on)) &&
        stepText.includes(guardedSecret) &&
        containsWriteSecret(JSON.parse(stepText.replaceAll(guardedSecret, ''))) === false &&
        step.env?.CACHIX_AUTH_TOKEN === undefined &&
        ('uses' in step && step.uses.startsWith('cachix/cachix-action@')) === false &&
        ('run' in step && /\bcachix\s+push\b/.test(step.run)) === false
      if (trustedGuardedWriter === true) continue
      if (
        (writer === true && protectedPublisher === false) ||
        (containsWriteSecret(step) === true && (writer === false || protectedPublisher === false))
      ) {
        throw new CachePublisherJobError(name)
      }
    }
  }
}
