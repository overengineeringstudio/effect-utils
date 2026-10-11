import {
  actionExclusionReason,
  countActionExclusions,
  cacheOutcomeMapping,
  invocationWithinJobWindow,
  outcomeFor,
  zeroActionExclusionCounts,
  type ActionExclusionCounts,
  type ActionArtifact,
  type ActionArtifactHeader,
  type ActionInvocation,
  type ActionRecord,
  type CacheLane,
} from './buck2-action-evidence.ts'
import type { CacheOutcome } from './buck2-cache-evidence.ts'
import { decodeEvidenceProducer, encodeEvidenceProducer } from './buck2-evidence-producer.ts'

/** Preserve legacy Actions metadata bytes while encoding the explicit host producer variant. */
export const encodeActionArtifact = (artifact: ActionArtifact): string =>
  `${JSON.stringify({ ...artifact.header, metadata: encodeEvidenceProducer(artifact.header.metadata) })}\n${artifact.actions.map((action) => `${JSON.stringify(action)}\n`).join('')}`

/** Local cache hits are reuse, never avoidable local-execution candidates. */
export const classifyCacheAction = (
  action: ActionRecord,
  invocation: ActionInvocation | undefined,
): 'local-action-cache-hit' | 'fresh-local-execution' | 'other' => {
  if (action.executionKind === 10) return 'local-action-cache-hit'
  if (actionExclusionReason(action.category) !== null) return 'other'
  if (
    action.commandAction &&
    (action.executionKind === 1 || action.executionKind === 8) &&
    action.digest !== null &&
    invocation?.buildId === action.buildId &&
    invocation.freshRoot
  )
    return 'fresh-local-execution'
  return 'other'
}

/** Untrusted JSON boundaries: reconstruct allowlisted fields, never cast parsed input. */
export const field = (value: unknown, key: string): unknown => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return Reflect.get(value, key)
}
export const invalid = (): never => {
  throw new Error('Invalid cache evidence')
}
export const integer = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalid()
export const text = (value: unknown): string =>
  typeof value === 'string' && value.length > 0 ? value : invalid()
export const boolean = (value: unknown): boolean => (typeof value === 'boolean' ? value : invalid())
export const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : invalid())
export const decodeActionExclusionCounts = (value: unknown): ActionExclusionCounts => ({
  'local-materialization-policy': integer(field(value, 'local-materialization-policy')),
})
const nullableText = (value: unknown, grammar = /^[a-zA-Z0-9_.:-]+$/): string | null => {
  if (value === null) return null
  const result = text(value)
  return result.length <= 4096 && grammar.test(result) ? result : invalid()
}
const timestamp = (value: unknown): number | null => (value === null ? null : integer(value))
export const lane = (value: unknown): CacheLane => {
  switch (value) {
    case 'main-writer':
    case 'main-reader':
    case 'merge_group':
    case 'pr':
      return value
    default:
      return invalid()
  }
}
const outcome = (value: unknown): CacheOutcome => {
  switch (value) {
    case 'remote-hit':
    case 'local':
    case 'uploaded':
    case 'local-cache':
    case 'remote-execution':
    case 'remote-dep-file-hit':
    case 'other':
      return value
    default:
      return invalid()
  }
}
const decodeAction = (value: unknown): ActionRecord => {
  if (field(value, 'type') !== 'action') return invalid()
  const uploadOutcome = field(value, 'uploadOutcome')
  if (
    uploadOutcome !== 'uploaded' &&
    uploadOutcome !== 'failed' &&
    uploadOutcome !== 'not-uploaded'
  )
    return invalid()
  const action: ActionRecord = {
    type: 'action',
    buildId: nullableText(field(value, 'buildId'), /^[a-zA-Z0-9_.-]+$/),
    context: nullableText(field(value, 'context')),
    category: nullableText(field(value, 'category'), /^[a-zA-Z0-9_.-]+$/),
    exclusionReason: actionExclusionReason(
      nullableText(field(value, 'category'), /^[a-zA-Z0-9_.-]+$/),
    ),
    target: nullableText(
      field(value, 'target'),
      /^[a-zA-Z0-9_.-]+\/\/[a-zA-Z0-9_./@+-]*:[a-zA-Z0-9_.@+/-]+$/,
    ),
    configuration: nullableText(
      field(value, 'configuration'),
      /^[a-zA-Z0-9_.-]+(?:\/\/[a-zA-Z0-9_./@+-]*:[a-zA-Z0-9_.@+/-]+)?#[a-fA-F0-9]+$/,
    ),
    digest: nullableText(field(value, 'digest'), /^[a-fA-F0-9]+:[0-9]+$/),
    executionKind: integer(field(value, 'executionKind')),
    cacheUploadResult: integer(field(value, 'cacheUploadResult')),
    outcome: outcome(field(value, 'outcome')),
    cacheOutcome: outcome(field(value, 'cacheOutcome')),
    uploadOutcome,
    startedAt: timestamp(field(value, 'startedAt')),
    completedAt: timestamp(field(value, 'completedAt')),
    endTime: timestamp(field(value, 'endTime')),
    uploadCompletedAt: timestamp(field(value, 'uploadCompletedAt')),
    commandAction: boolean(field(value, 'commandAction')),
  }
  const exclusionReason = field(value, 'exclusionReason')
  if (exclusionReason !== undefined && exclusionReason !== action.exclusionReason) return invalid()
  if (
    action.uploadOutcome !==
    (action.cacheUploadResult === 1
      ? 'uploaded'
      : action.cacheUploadResult >= 9 && action.cacheUploadResult <= 15
        ? 'failed'
        : 'not-uploaded')
  )
    return invalid()
  if (action.uploadOutcome !== 'uploaded' && action.uploadCompletedAt !== null) return invalid()
  if (
    action.startedAt !== null &&
    action.completedAt !== null &&
    action.startedAt > action.completedAt
  )
    return invalid()
  const expected = outcomeFor({
    executionKind: action.executionKind,
    uploadResult: action.cacheUploadResult,
  })
  if (
    action.outcome !== expected ||
    action.cacheOutcome !== expected ||
    action.endTime !== action.completedAt
  )
    return invalid()
  if (action.uploadOutcome === 'uploaded' && action.uploadCompletedAt !== action.completedAt)
    return invalid()
  return action
}
export const decodeActionArtifact = (raw: string): ActionArtifact => {
  // A final newline is part of the wire boundary: a cut-off last JSON row is never trusted.
  if (!raw.endsWith('\n')) return invalid()
  const lines = raw.slice(0, -1).split('\n')
  const values: unknown[] = lines.map((line) => JSON.parse(line))
  const value = values.shift()
  if (
    field(value, 'type') !== 'header' ||
    field(value, 'schemaVersion') !== 1 ||
    field(value, 'cacheOutcomeMapping') !== cacheOutcomeMapping
  )
    return invalid()
  const status = field(value, 'status')
  if (
    status !== 'collected' &&
    status !== 'no-native-logs' &&
    status !== 'remote-cache-disabled-by-design'
  )
    return invalid()
  const header: ActionArtifactHeader = {
    type: 'header',
    schemaVersion: 1,
    cacheOutcomeMapping,
    metadata: decodeEvidenceProducer(field(value, 'metadata')),
    status,
    complete: boolean(field(value, 'complete')),
    actionCount: integer(field(value, 'actionCount')),
    excludedByDesign:
      field(value, 'excludedByDesign') === undefined
        ? zeroActionExclusionCounts()
        : decodeActionExclusionCounts(field(value, 'excludedByDesign')),
    rows: integer(field(value, 'rows')),
    missingDigestCount: integer(field(value, 'missingDigestCount')),
    missingIdentityCount: integer(field(value, 'missingIdentityCount')),
    missingTimestampCount: integer(field(value, 'missingTimestampCount')),
    droppedActionCount: integer(field(value, 'droppedActionCount')),
    evidenceGaps: list(field(value, 'evidenceGaps')).map(
      (gap) => nullableText(gap, /^[a-zA-Z0-9_.:-]+$/) ?? invalid(),
    ),
    invocations: list(field(value, 'invocations')).map((item) => ({
      buildId: nullableText(field(item, 'buildId'), /^[a-zA-Z0-9_.-]+$/) ?? invalid(),
      context: nullableText(field(item, 'context')),
      startedAt: timestamp(field(item, 'startedAt')),
      completedAt: timestamp(field(item, 'completedAt')),
      freshRoot: boolean(field(item, 'freshRoot')),
      actionCount: integer(field(item, 'actionCount')),
      excludedByDesign:
        field(item, 'excludedByDesign') === undefined
          ? zeroActionExclusionCounts()
          : decodeActionExclusionCounts(field(item, 'excludedByDesign')),
      complete: boolean(field(item, 'complete')),
    })),
  }
  const actions = values.map(decodeAction)
  // Retained artifacts predate policy fields; complete rows recover the same category policy.
  const actualExclusions = countActionExclusions(actions)
  if (field(value, 'excludedByDesign') === undefined) header.excludedByDesign = actualExclusions
  if (
    header.complete &&
    header.excludedByDesign['local-materialization-policy'] !==
      actualExclusions['local-materialization-policy']
  )
    return invalid()
  const invocationValues = list(field(value, 'invocations'))
  for (const [index, invocation] of header.invocations.entries()) {
    const exclusions = countActionExclusions(
      actions.filter((action) => action.buildId === invocation.buildId),
    )
    if (field(invocationValues[index], 'excludedByDesign') === undefined)
      invocation.excludedByDesign = exclusions
    if (
      header.complete &&
      invocation.excludedByDesign['local-materialization-policy'] !==
        exclusions['local-materialization-policy']
    )
      return invalid()
  }
  if (
    header.complete &&
    actions.some(
      (action) =>
        action.executionKind > 11 || action.executionKind === 5 || action.cacheUploadResult > 16,
    )
  )
    return invalid()
  if (
    header.complete &&
    (header.rows !== actions.length ||
      header.actionCount !== actions.length ||
      header.droppedActionCount !== 0)
  )
    return invalid()
  const ids = new Set<string>()
  for (const invocation of header.invocations) {
    if (ids.has(invocation.buildId)) return invalid()
    ids.add(invocation.buildId)
    if (header.complete && !invocationWithinJobWindow(invocation, header.metadata)) return invalid()
    if (
      header.complete &&
      actions.filter((action) => action.buildId === invocation.buildId).length !==
        invocation.actionCount
    )
      return invalid()
    if (
      invocation.startedAt !== null &&
      invocation.completedAt !== null &&
      invocation.startedAt > invocation.completedAt
    )
      return invalid()
    if (
      header.complete &&
      (!invocation.complete || invocation.startedAt === null || invocation.completedAt === null)
    )
      return invalid()
    if (
      header.complete &&
      actions.some(
        (action) =>
          action.buildId === invocation.buildId &&
          ((action.startedAt !== null &&
            invocation.startedAt !== null &&
            action.startedAt < invocation.startedAt) ||
            (action.completedAt !== null &&
              invocation.completedAt !== null &&
              action.completedAt > invocation.completedAt)),
      )
    )
      return invalid()
  }
  if (
    header.complete &&
    actions.some((action) => action.buildId === null || !ids.has(action.buildId))
  )
    return invalid()
  if (
    header.complete &&
    header.missingDigestCount !== actions.filter((action) => action.digest === null).length
  )
    return invalid()
  if (
    header.complete &&
    header.missingIdentityCount !==
      actions.filter(
        (action) =>
          action.buildId === null ||
          action.category === null ||
          action.target === null ||
          action.configuration === null,
      ).length
  )
    return invalid()
  if (
    header.complete &&
    header.missingTimestampCount !==
      actions.filter(
        (action) =>
          action.startedAt === null ||
          action.completedAt === null ||
          (action.cacheUploadResult === 1 && action.uploadCompletedAt === null),
      ).length
  )
    return invalid()
  return { header, actions }
}
