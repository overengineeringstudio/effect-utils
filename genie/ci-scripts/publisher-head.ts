import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

export const PUBLISHER_HEAD_GRACE_MINUTES = 180
export type PublisherState =
  | { kind: 'api-error' | 'no-pr' }
  | {
      kind: 'pr'
      draft: boolean
      queued: boolean
      ejected: boolean
      mergeable: string
      health: 'failed' | 'green' | 'pending' | 'missing'
      headTime?: number
    }

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Array.isArray(value) === false
const timestamp = (value: unknown): number | undefined => {
  const time = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(time) === true ? time : undefined
}
const latestTime = (values: unknown): number | undefined => {
  if (Array.isArray(values) === false || values.length === 0) return undefined
  let latest = -Infinity
  for (const value of values) {
    const time = timestamp(value)
    if (time === undefined) return undefined
    latest = Math.max(latest, time)
  }
  return latest
}

const checkHealth = (
  connection: unknown,
): 'failed' | 'green' | 'pending' | 'missing' | undefined => {
  if (connection === null) return 'missing'
  if (
    record(connection) === false ||
    record(connection.pageInfo) === false ||
    connection.pageInfo.hasNextPage !== false ||
    Array.isArray(connection.nodes) === false
  )
    return undefined
  const latest = new Map<string, { time: number; result: string }>()
  for (const node of connection.nodes) {
    if (record(node) === false) return undefined
    const check = node['__typename'] === 'CheckRun'
    if (check === false && node['__typename'] !== 'StatusContext') return undefined
    const name = check === true ? node.name : node.context
    if (typeof name !== 'string') return undefined
    const time = timestamp(check === true ? node.startedAt : node.createdAt)
    const result =
      check === true ? (node.status === 'COMPLETED' ? node.conclusion : 'PENDING') : node.state
    if (typeof result !== 'string' && result !== null) return undefined
    const failure =
      check === true
        ? ['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED'].includes(result ?? '')
        : ['FAILURE', 'ERROR'].includes(result ?? '')
    const outcome =
      time === undefined
        ? 'pending'
        : failure === true
          ? 'failed'
          : ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(result ?? '') === true
            ? 'green'
            : 'pending'
    const key = `${node['__typename']}:${name}`
    const old = latest.get(key)
    if (old === undefined || (time ?? Infinity) > old.time)
      latest.set(key, { time: time ?? Infinity, result: outcome })
    else if ((time ?? Infinity) === old.time && outcome !== old.result) old.result = 'pending'
  }
  const results = [...latest.values()]
  if (results.some((entry) => entry.result === 'failed') === true) return 'failed'
  return results.length > 0 && results.every((entry) => entry.result === 'green') === true
    ? 'green'
    : 'pending'
}

export const decodePublisherState = (nodes: unknown): PublisherState => {
  if (Array.isArray(nodes) === false || nodes.length > 1) return { kind: 'api-error' }
  if (nodes.length === 0) return { kind: 'no-pr' }
  const pr: unknown = nodes[0]
  if (
    record(pr) === false ||
    typeof pr.draft !== 'boolean' ||
    typeof pr.queued !== 'boolean' ||
    ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'].includes(String(pr.mergeable)) === false
  )
    return { kind: 'api-error' }
  const health = checkHealth(pr.checks)
  if (health === undefined) return { kind: 'api-error' }
  const headTime = latestTime(pr.headTimes)
  const removal = latestTime(pr.removalTimes)
  return {
    kind: 'pr',
    draft: pr.draft,
    queued: pr.queued,
    mergeable: String(pr.mergeable),
    health,
    headTime,
    ejected: headTime !== undefined && removal !== undefined && removal > headTime,
  }
}

export const decidePublisherHead = ({
  state,
  now,
}: {
  state: PublisherState
  now: number
}): { refresh: boolean; reason: string } => {
  let reason: string = state.kind
  if (state.kind === 'pr') {
    const expired =
      state.headTime !== undefined && now > state.headTime + PUBLISHER_HEAD_GRACE_MINUTES * 60_000
    if (state.queued === true) reason = 'queued'
    else if (state.mergeable === 'CONFLICTING') reason = 'conflict'
    else if (state.ejected === true) reason = 'ejected'
    else if (state.mergeable === 'UNKNOWN') reason = expired === true ? 'stale-unknown' : 'unknown'
    else if (state.health === 'failed') reason = 'failed'
    else if (state.draft === true) reason = 'draft'
    else if (state.health === 'green') reason = 'green'
    else if (state.health === 'pending') reason = expired === true ? 'stale-pending' : 'pending'
    else reason = 'unknown'
  }
  return {
    refresh: /^(no-pr|conflict|ejected|failed|stale-pending|stale-unknown)$/.test(reason),
    reason,
  }
}

const query = `query($owner:String!, $name:String!) {
  repository(owner:$owner, name:$name) {
    pullRequests(first:2, states:OPEN, baseRefName:"main", headRefName:"automation/buck2-products-manifest") { nodes {
      headRefOid isDraft mergeable mergeQueueEntry { state }
      commits(last:1) { nodes { commit { committedDate pushedDate statusCheckRollup { contexts(first:100) {
        pageInfo { hasNextPage } nodes { __typename
          ... on CheckRun { name status conclusion startedAt completedAt checkSuite { workflowRun { databaseId } } }
          ... on StatusContext { context state createdAt }
        }
      } } } } }
      timelineItems(last:100, itemTypes:[REMOVED_FROM_MERGE_QUEUE_EVENT, HEAD_REF_FORCE_PUSHED_EVENT, PULL_REQUEST_COMMIT]) { nodes { __typename
        ... on RemovedFromMergeQueueEvent { createdAt }
        ... on HeadRefForcePushedEvent { createdAt afterCommit { oid } }
        ... on PullRequestCommit { commit { oid committedDate } }
      } }
    } }
  }
}`
const projection =
  '.data.repository.pullRequests.nodes | map(.headRefOid as $head | {draft: .isDraft, mergeable, queued: (.mergeQueueEntry != null), checks: .commits.nodes[0].commit.statusCheckRollup.contexts, headTimes: ([.commits.nodes[0].commit.committedDate, .commits.nodes[0].commit.pushedDate] + [(.timelineItems.nodes // [])[] | select(.__typename == "HeadRefForcePushedEvent" and .afterCommit.oid == $head) | .createdAt] | map(select(. != null))), removalTimes: [(.timelineItems.nodes // [])[] | select(.__typename == "RemovedFromMergeQueueEvent") | .createdAt]})'

export const readPublisherState = (repository: string): PublisherState => {
  try {
    if (/^[^/]+\/[^/]+$/.test(repository) === false) return { kind: 'api-error' }
    const [owner, name] = repository.split('/')
    const output = execFileSync('gh', ['api', 'graphql', '--input', '-', '--jq', projection], {
      input: JSON.stringify({ query, variables: { owner, name } }),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return decodePublisherState(JSON.parse(output))
  } catch {
    return { kind: 'api-error' }
  }
}

if (import.meta.main === true) {
  const decision = decidePublisherHead({
    state: readPublisherState(process.env.GITHUB_REPOSITORY ?? ''),
    now: Date.now(),
  })
  console.log(
    `publisher: ${decision.refresh === true ? 'refresh' : 'keep head'} (${decision.reason})`,
  )
  if (decision.reason === 'api-error')
    console.log(
      'publisher: PR state unavailable; leaving head unchanged; next main publication retries',
    )
  appendFileSync(process.env.GITHUB_OUTPUT!, `refresh=${decision.refresh}\n`)
}
