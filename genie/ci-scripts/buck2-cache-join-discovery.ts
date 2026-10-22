import type { CacheLane } from './buck2-action-evidence.ts'

export type EvidenceRun = {
  id: number
  event: string
  head_branch: string | null
  created_at: string
  workflow: string
}

export const classifyRun = (run: EvidenceRun): CacheLane | undefined => {
  if (run.event === 'merge_group') return 'merge_group'
  if (run.event === 'pull_request' || run.event === 'pull_request_target') return 'pr'
  if (run.head_branch === 'main') return run.workflow === 'ci.yml' ? 'main-writer' : 'main-reader'
  return undefined
}

const cacheLanes: CacheLane[] = ['main-writer', 'main-reader', 'merge_group', 'pr']

const compareRuns = (left: EvidenceRun, right: EvidenceRun): number =>
  Date.parse(left.created_at) - Date.parse(right.created_at) ||
  left.id - right.id ||
  left.workflow.localeCompare(right.workflow) ||
  left.event.localeCompare(right.event) ||
  (left.head_branch ?? '').localeCompare(right.head_branch ?? '')

/** Retain main writers; sample merge writers and reader lanes independently per UTC day. */
export const selectRuns = (
  runs: readonly EvidenceRun[],
  readerLimit = 25,
): {
  selected: EvidenceRun[]
  lanes: { lane: CacheLane; seen: number; selected: number }[]
} => {
  const seenIds = new Set<number>()
  const byLane: Record<CacheLane, EvidenceRun[]> = {
    'main-writer': [],
    'main-reader': [],
    merge_group: [],
    pr: [],
  }
  for (const run of [...runs].sort(compareRuns)) {
    if (seenIds.has(run.id) === true) continue
    seenIds.add(run.id)
    const lane = classifyRun(run)
    if (lane !== undefined) byLane[lane].push(run)
  }

  const selected: EvidenceRun[] = []
  const lanes = cacheLanes.map((lane) => {
    const byDay = new Map<string, EvidenceRun[]>()
    for (const run of byLane[lane]) {
      const day = new Date(run.created_at).toISOString().slice(0, 10)
      const cohort = byDay.get(day) ?? []
      cohort.push(run)
      byDay.set(day, cohort)
    }
    let selectedCount = 0
    for (const candidates of byDay.values()) {
      if (lane === 'merge_group') candidates.sort((left, right) => left.id - right.id)
      const limit = lane === 'main-writer' ? candidates.length : lane === 'merge_group' ? 50 : readerLimit
      const count = Math.min(candidates.length, Math.max(0, Math.floor(limit)))
      for (let index = 0; index < count; index++) {
        const position =
          count === candidates.length
            ? index
            : count === 1
              ? 0
              : Math.floor((index * (candidates.length - 1)) / (count - 1))
        selected.push(candidates[position]!)
      }
      selectedCount += count
    }
    return { lane, seen: byLane[lane].length, selected: selectedCount }
  })
  selected.sort(compareRuns)
  return { selected, lanes }
}

const evidencePrefix = 'buck2-cache-evidence-'
const disabledProducerPrefixes = [
  'buck2-cache-evidence-default-ref-policy-',
  'buck2-cache-evidence-cargo-',
  'buck2-cache-evidence-build-products-',
  'buck2-cache-evidence-publish-products-',
  'buck2-cache-evidence-publish-compiled-products-',
]

/** Keep unknown evidence producers; skip only known jobs with evidence production disabled. */
export const artifactCanMatter = (name: string): boolean => {
  if (name.startsWith(evidencePrefix) === false) return false
  for (const prefix of disabledProducerPrefixes) {
    if (name.startsWith(prefix) === true) return false
  }
  return true
}

/** Stop before the discovery call cap or the API reserve floor is reached. */
export const apiBudgetAvailable = ({
  calls,
  remaining,
}: {
  calls: number
  remaining: number | undefined
}): boolean => calls < 800 && (remaining === undefined || remaining > 200)

/** Match artifact creation timestamps within the half-open millisecond discovery window. */
export const artifactInWindow = ({
  createdAt,
  since,
  until,
}: {
  createdAt: string
  since: number
  until: number
}): boolean => {
  const timestamp = Date.parse(createdAt)
  return timestamp >= since && timestamp < until
}
