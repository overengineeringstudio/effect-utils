import type { CacheOutcome } from './buck2-cache-evidence.ts'

/** Repository-owned wire mapping; raw enums remain authoritative for alternate consumers. */
export const cacheOutcomeMapping = 'effect-utils/compact-cache-outcome/v1' as const
export const actionsArtifactName = 'buck2-cache-actions.jsonl.gz'
/** Hard action-payload ceiling, independent of compression ratio. Overflow is invalid evidence. */
export const maxActionArtifactBytes = 64 * 1024 * 1024
export type CacheLane = 'main-writer' | 'main-reader' | 'merge_group' | 'pr'
export type ActionRecord = {
  type: 'action'
  buildId: string | null
  context: string | null
  category: string | null
  target: string | null
  configuration: string | null
  digest: string | null
  executionKind: number
  cacheUploadResult: number
  outcome: CacheOutcome
  cacheOutcome: CacheOutcome
  uploadOutcome: 'uploaded' | 'failed' | 'not-uploaded'
  startedAt: number | null
  completedAt: number | null
  endTime: number | null
  /** Action end bounds successful upload completion; never derived from wall_time. */
  uploadCompletedAt: number | null
  commandAction: boolean
}
export type ActionInvocation = {
  buildId: string
  context: string | null
  startedAt: number | null
  completedAt: number | null
  freshRoot: boolean
  actionCount: number
  complete: boolean
}
export type ActionArtifactHeader = {
  type: 'header'
  schemaVersion: 1
  cacheOutcomeMapping: typeof cacheOutcomeMapping
  metadata: {
    repo: string | null
    runId: string | null
    runAttempt: string | null
    job: string | null
    lane: CacheLane | null
    headSha: string | null
    posture: 'read-only' | 'writer' | 'disabled-by-design'
    startedAt: number | null
    finishedAt: number | null
  }
  status: 'collected' | 'no-native-logs' | 'remote-cache-disabled-by-design'
  complete: boolean
  actionCount: number
  rows: number
  missingDigestCount: number
  missingIdentityCount: number
  missingTimestampCount: number
  droppedActionCount: number
  evidenceGaps: string[]
  invocations: ActionInvocation[]
}
export type ActionArtifact = { header: ActionArtifactHeader; actions: ActionRecord[] }
/** Native time, not filesystem mtime, binds retained invocations to this fresh-state observation. */
export const invocationWithinJobWindow = (
  invocation: ActionInvocation,
  metadata: ActionArtifactHeader['metadata'],
): boolean =>
  metadata.startedAt !== null &&
  metadata.finishedAt !== null &&
  invocation.startedAt !== null &&
  invocation.completedAt !== null &&
  metadata.startedAt <= invocation.startedAt &&
  invocation.startedAt <= invocation.completedAt &&
  invocation.completedAt <= metadata.finishedAt

export const outcomeFor = ({
  executionKind,
  uploadResult,
}: {
  executionKind: number
  uploadResult: number
}): CacheOutcome => {
  if (uploadResult === 1) return 'uploaded'
  switch (executionKind) {
    case 1:
    case 8:
      return 'local'
    case 3:
      return 'remote-hit'
    case 7:
    case 10:
      return 'local-cache'
    case 2:
    case 11:
      return 'remote-execution'
    case 9:
      return 'remote-dep-file-hit'
    default:
      return 'other'
  }
}
