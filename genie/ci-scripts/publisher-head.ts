import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

export type PublisherState =
  | { kind: 'api-error' }
  | { kind: 'no-pr' }
  | {
      kind: 'pr'
      draft: boolean
      queued: boolean
      mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
      rollup: 'SUCCESS' | 'PENDING' | 'EXPECTED' | 'FAILURE' | 'ERROR' | null
    }

export type PublisherDecision = {
  refresh: boolean
  reason:
    | 'no-pr'
    | 'queued'
    | 'conflict'
    | 'failed'
    | 'pending'
    | 'green'
    | 'unknown'
    | 'draft'
    | 'api-error'
}

// The queue tests latest main. After this pinned PR merges, the next publication
// proposes newer products; a slightly older manifest is preferable to CI churn.
export const decidePublisherHead = (state: PublisherState): PublisherDecision => {
  if (state.kind === 'api-error') return { refresh: false, reason: 'api-error' }
  if (state.kind === 'no-pr') return { refresh: true, reason: 'no-pr' }
  if (state.queued === true) return { refresh: false, reason: 'queued' }
  if (state.mergeable === 'CONFLICTING') return { refresh: true, reason: 'conflict' }
  if (state.mergeable === 'UNKNOWN') return { refresh: false, reason: 'unknown' }
  if (state.rollup === 'FAILURE' || state.rollup === 'ERROR')
    return { refresh: true, reason: 'failed' }
  if (state.draft === true) return { refresh: false, reason: 'draft' }
  if (state.rollup === 'SUCCESS') return { refresh: false, reason: 'green' }
  if (state.rollup === 'PENDING' || state.rollup === 'EXPECTED')
    return { refresh: false, reason: 'pending' }
  return { refresh: false, reason: 'unknown' }
}

const query = `query($owner:String!, $name:String!) {
  repository(owner:$owner, name:$name) {
    pullRequests(first:2, states:OPEN, baseRefName:"main", headRefName:"automation/buck2-products-manifest") {
      nodes {
        isDraft mergeable mergeQueueEntry { state }
        commits(last:1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`

/** Decode the flattened API boundary; missing/ambiguous evidence never permits a push. */
export const readPublisherState = (repository: string): PublisherState => {
  try {
    const [owner, name, extra] = repository.split('/')
    if (
      owner === undefined ||
      owner === '' ||
      name === undefined ||
      name === '' ||
      extra !== undefined
    )
      return { kind: 'api-error' }
    const output = execFileSync(
      'gh',
      [
        'api',
        'graphql',
        '-f',
        `query=${query}`,
        '-f',
        `owner=${owner}`,
        '-f',
        `name=${name}`,
        '--jq',
        '.data.repository.pullRequests.nodes | map({draft: .isDraft, mergeable, queued: (.mergeQueueEntry != null), rollup: .commits.nodes[0].commit.statusCheckRollup.state})',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const nodes: unknown = JSON.parse(output)
    if (Array.isArray(nodes) === false) return { kind: 'api-error' }
    if (nodes.length === 0) return { kind: 'no-pr' }
    if (nodes.length !== 1) return { kind: 'api-error' }
    const pr: unknown = nodes[0]
    if (
      typeof pr !== 'object' ||
      pr === null ||
      !('draft' in pr) ||
      typeof pr.draft !== 'boolean' ||
      !('queued' in pr) ||
      typeof pr.queued !== 'boolean' ||
      !('mergeable' in pr) ||
      (pr.mergeable !== 'MERGEABLE' &&
        pr.mergeable !== 'CONFLICTING' &&
        pr.mergeable !== 'UNKNOWN') ||
      !('rollup' in pr) ||
      (pr.rollup !== null &&
        pr.rollup !== 'SUCCESS' &&
        pr.rollup !== 'PENDING' &&
        pr.rollup !== 'EXPECTED' &&
        pr.rollup !== 'FAILURE' &&
        pr.rollup !== 'ERROR')
    )
      return { kind: 'api-error' }
    return {
      kind: 'pr',
      draft: pr.draft,
      queued: pr.queued,
      mergeable: pr.mergeable,
      rollup: pr.rollup,
    }
  } catch {
    return { kind: 'api-error' }
  }
}

if (import.meta.main === true) {
  const decision = decidePublisherHead(readPublisherState(process.env.GITHUB_REPOSITORY ?? ''))
  console.log(
    `publisher: ${decision.refresh === true ? 'refresh' : 'keep head'} (${decision.reason})`,
  )
  if (decision.reason === 'api-error')
    console.log(
      'publisher: PR state unavailable; leaving head unchanged; next main publication retries',
    )
  appendFileSync(process.env.GITHUB_OUTPUT!, `refresh=${decision.refresh}\n`)
}
