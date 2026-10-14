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
] as const
export const darwinUnsandboxedCategories = [
  'tsgo_typecheck_darwin_unsandboxed',
  'tsgo_emit_darwin_unsandboxed',
  'package_tree_darwin_unsandboxed',
] as const
/** Only admitted Linux x86_64 native Rust commands retain cache-eligible categories. */
export const rustLocalOnlyCategories = ['rustc_excluded', 'rustc_deps_excluded'] as const
export const actionExclusionReasons = [
  'local-materialization-policy',
  'darwin-unsandboxed',
  'rust-local-only',
] as const
export type ActionExclusionReason = (typeof actionExclusionReasons)[number]
export type ActionExclusionCounts = Record<ActionExclusionReason, number>
export const actionExclusionReason = (
  category: string | null | undefined,
): ActionExclusionReason | null =>
  darwinUnsandboxedCategories.some((excluded) => excluded === category) === true
    ? 'darwin-unsandboxed'
    : rustLocalOnlyCategories.some((excluded) => excluded === category) === true
      ? 'rust-local-only'
      : localMaterializationCategories.some((excluded) => excluded === category) === true
        ? 'local-materialization-policy'
        : null
export const zeroActionExclusionCounts = (): ActionExclusionCounts => ({
  'local-materialization-policy': 0,
  'darwin-unsandboxed': 0,
  'rust-local-only': 0,
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

export type NativeRustCohortAction = {
  targetTriple: string
  commandKind: string
  target: string
  configuration: string
  digest: string
}
export type NativeRustCohortManifest = {
  headSha: string
  actions: readonly NativeRustCohortAction[]
}
export type NativeRustAdmissionViolation = {
  reason:
    | 'incomplete-action-artifact'
    | 'invalid-native-cohort-manifest'
    | 'remote-action-outside-native-cohort'
  action?: ActionRecord
}

/**
 * Audits a cohort-only q33 invocation, including its local prerequisites.
 *
 * The manifest must come from the analyzed, declared graph at this head, never
 * from filtering observed cache hits. Digest binding preserves the compiler
 * variant identity that q33's category/target/configuration alone cannot carry.
 * This detects a violation after remote access; it does not prevent that access
 * and cannot replace executor-level read/write exclusion.
 */
export const auditNativeRustCacheAdmission = ({
  artifact,
  manifest,
}: {
  artifact: ActionArtifact
  manifest: NativeRustCohortManifest
}): readonly NativeRustAdmissionViolation[] => {
  const violations: NativeRustAdmissionViolation[] = []
  if (
    artifact.header.status !== 'collected' ||
    artifact.header.complete !== true ||
    artifact.header.evidenceGaps.length !== 0 ||
    artifact.header.droppedActionCount !== 0 ||
    artifact.header.rows !== artifact.actions.length ||
    artifact.header.actionCount !== artifact.actions.length ||
    artifact.header.invocations.some((invocation) => invocation.complete !== true)
  )
    violations.push({ reason: 'incomplete-action-artifact' })

  const allowed = new Map<string, NativeRustCohortAction>()
  let compilerCount = 0
  let dependencyCount = 0
  let invalidManifest = false
  for (const entry of manifest.actions) {
    if (
      entry.targetTriple !== 'x86_64-unknown-linux-gnu' ||
      (entry.commandKind !== 'rustc' && entry.commandKind !== 'deps') ||
      /^[a-f0-9]{64}:[0-9]+$/u.test(entry.digest) !== true ||
      entry.target.length === 0 ||
      entry.configuration.length === 0 ||
      allowed.has(entry.digest) === true
    )
      invalidManifest = true
    if (entry.commandKind === 'rustc') compilerCount++
    if (entry.commandKind === 'deps') dependencyCount++
    allowed.set(entry.digest, entry)
  }
  if (
    invalidManifest === true ||
    compilerCount !== 89 ||
    dependencyCount !== 89 ||
    /^[a-f0-9]{40}$/u.test(manifest.headSha) !== true ||
    manifest.headSha !== artifact.header.metadata.headSha
  )
    violations.push({ reason: 'invalid-native-cohort-manifest' })

  for (const action of artifact.actions) {
    const remoteRead =
      action.executionKind === 2 ||
      action.executionKind === 3 ||
      action.executionKind === 9 ||
      action.executionKind === 11
    const remoteWrite =
      action.cacheUploadResult === 1 ||
      (action.cacheUploadResult >= 9 && action.cacheUploadResult <= 15)
    if (remoteRead === false && remoteWrite === false) continue
    const entry = action.digest === null ? undefined : allowed.get(action.digest)
    if (
      invalidManifest === true ||
      entry === undefined ||
      action.commandAction !== true ||
      action.exclusionReason !== null ||
      actionExclusionReason(action.category) !== null ||
      action.target !== entry.target ||
      action.configuration !== entry.configuration ||
      action.category !== entry.commandKind
    )
      violations.push({ reason: 'remote-action-outside-native-cohort', action })
  }
  return violations
}
