import type { CacheOutcome } from './buck2-cache-evidence.ts'

/** Repository-owned wire mapping; raw enums remain authoritative for alternate consumers. */
export const cacheOutcomeMapping = 'effect-utils/compact-cache-outcome/v1' as const
export const actionsArtifactName = 'buck2-cache-actions.jsonl.gz'
/** Hard action-payload ceiling, independent of compression ratio. Overflow is invalid evidence. */
export const maxActionArtifactBytes = 64 * 1024 * 1024
export type CacheLane = 'main-writer' | 'main-reader' | 'merge_group' | 'pr'
/** Cheap local materialization deliberately bypasses remote-cache reads and writes. */
export const localMaterializationCategories = [
  'pnpm_extract',
  'pnpm_store_entry',
  'pnpm_store_view',
  'package_tree',
  'pnpm_store_scc',
  // Per-file runtime source copies are explicitly noncacheable materialization.
  'runtime_module',
] as const
export const darwinUnsandboxedCategories = [
  'tsgo_typecheck_darwin_unsandboxed',
  'tsgo_emit_darwin_unsandboxed',
  'package_tree_darwin_unsandboxed',
] as const
export const actionExclusionReasons = [
  'local-materialization-policy',
  'darwin-unsandboxed',
] as const
export type ActionExclusionReason = (typeof actionExclusionReasons)[number]
export type ActionExclusionCounts = Record<ActionExclusionReason, number>
export const actionExclusionReason = (
  category: string | null | undefined,
): ActionExclusionReason | null =>
  darwinUnsandboxedCategories.some((excluded) => excluded === category) === true
    ? 'darwin-unsandboxed'
    : localMaterializationCategories.some((excluded) => excluded === category) === true
      ? 'local-materialization-policy'
      : null
export const zeroActionExclusionCounts = (): ActionExclusionCounts => ({
  'local-materialization-policy': 0,
  'darwin-unsandboxed': 0,
})
export const countActionExclusions = (
  actions: readonly { category: string | null }[],
): ActionExclusionCounts => {
  const counts = zeroActionExclusionCounts()
  for (const action of actions) {
    const reason = actionExclusionReason(action.category)
    if (reason !== null) counts[reason]++
  }
  return counts
}
export type CacheUploadError = {
  /** Sanitized native CacheUploadEnd.error; null when Buck supplied only a code. */
  error: string | null
  reErrorCode: string | null
}
export type ActionRecord = {
  type: 'action'
  buildId: string | null
  context: string | null
  category: string | null
  target: string | null
  exclusionReason: ActionExclusionReason | null
  configuration: string | null
  digest: string | null
  executionKind: number
  cacheUploadResult: number
  outcome: CacheOutcome
  cacheOutcome: CacheOutcome
  uploadOutcome: 'uploaded' | 'failed' | 'not-uploaded'
  /** One entry per failed native CacheUpload span; absent when none were observed. */
  uploadErrors?: CacheUploadError[]
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
  excludedByDesign: ActionExclusionCounts
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
  excludedByDesign: ActionExclusionCounts
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
export const invocationWithinJobWindow = ({
  invocation,
  metadata,
}: {
  invocation: ActionInvocation
  metadata: ActionArtifactHeader['metadata']
}): boolean =>
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
