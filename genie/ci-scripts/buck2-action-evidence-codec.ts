import {
  actionExclusionReason,
  actionExclusionReasons,
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

/** Local cache hits are reuse, never avoidable local-execution candidates. */
export const classifyCacheAction = ({
  action,
  invocation,
}: {
  action: ActionRecord
  invocation: ActionInvocation | undefined
}): 'local-action-cache-hit' | 'fresh-local-execution' | 'other' => {
  if (action.executionKind === 10) return 'local-action-cache-hit'
  if (actionExclusionReason(action.category) !== null) return 'other'
  if (
    action.commandAction === true &&
    (action.executionKind === 1 || action.executionKind === 8) &&
    action.digest !== null &&
    invocation?.buildId === action.buildId &&
    invocation.freshRoot === true
  )
    return 'fresh-local-execution'
  return 'other'
}

/** Untrusted JSON boundaries: reconstruct allowlisted fields, never cast parsed input. */
export const field = ({ value, key }: { value: unknown; key: string }): unknown => {
  if (typeof value !== 'object' || value === null || Array.isArray(value) === true) return undefined
  return Reflect.get(value, key)
}
export const invalid = (): never => {
  throw new Error('Invalid cache evidence')
}
export const integer = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) === true && value >= 0
    ? value
    : invalid()
export const text = (value: unknown): string =>
  typeof value === 'string' && value.length > 0 ? value : invalid()
export const boolean = (value: unknown): boolean => (typeof value === 'boolean' ? value : invalid())
export const list = (value: unknown): unknown[] =>
  Array.isArray(value) === true ? value : invalid()
export const decodeActionExclusionCounts = (value: unknown): ActionExclusionCounts => {
  const darwinCount = field({ value: value, key: 'darwin-unsandboxed' })
  const rustCount = field({ value: value, key: 'rust-local-only' })
  return {
    'local-materialization-policy': integer(
      field({ value: value, key: 'local-materialization-policy' }),
    ),
    // Retained artifacts predate platform-specific categories; full rows still
    // validate these zeros against the current category policy below.
    'darwin-unsandboxed': darwinCount === undefined ? 0 : integer(darwinCount),
    'rust-local-only': rustCount === undefined ? 0 : integer(rustCount),
  }
}
const nullableText = ({
  value,
  grammar = /^[a-zA-Z0-9_.:-]+$/,
}: {
  value: unknown
  grammar?: RegExp
}): string | null => {
  if (value === null) return null
  const result = text(value)
  return result.length <= 4096 && grammar.test(result) === true ? result : invalid()
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
  if (field({ value: value, key: 'type' }) !== 'action') return invalid()
  const uploadOutcome = field({ value: value, key: 'uploadOutcome' })
  if (
    uploadOutcome !== 'uploaded' &&
    uploadOutcome !== 'failed' &&
    uploadOutcome !== 'not-uploaded'
  )
    return invalid()
  const action: ActionRecord = {
    type: 'action',
    buildId: nullableText({
      value: field({ value: value, key: 'buildId' }),
      grammar: /^[a-zA-Z0-9_.-]+$/,
    }),
    context: nullableText({ value: field({ value: value, key: 'context' }) }),
    category: nullableText({
      value: field({ value: value, key: 'category' }),
      grammar: /^[a-zA-Z0-9_.-]+$/,
    }),
    exclusionReason: actionExclusionReason(
      nullableText({
        value: field({ value: value, key: 'category' }),
        grammar: /^[a-zA-Z0-9_.-]+$/,
      }),
    ),
    target: nullableText({
      value: field({ value: value, key: 'target' }),
      grammar: /^[a-zA-Z0-9_.-]+\/\/[a-zA-Z0-9_./@+-]*:[a-zA-Z0-9_.@+/-]+$/,
    }),
    configuration: nullableText({
      value: field({ value: value, key: 'configuration' }),
      grammar: /^[a-zA-Z0-9_.-]+(?:\/\/[a-zA-Z0-9_./@+-]*:[a-zA-Z0-9_.@+/-]+)?#[a-fA-F0-9]+$/,
    }),
    digest: nullableText({
      value: field({ value: value, key: 'digest' }),
      grammar: /^[a-fA-F0-9]+:[0-9]+$/,
    }),
    executionKind: integer(field({ value: value, key: 'executionKind' })),
    cacheUploadResult: integer(field({ value: value, key: 'cacheUploadResult' })),
    outcome: outcome(field({ value: value, key: 'outcome' })),
    cacheOutcome: outcome(field({ value: value, key: 'cacheOutcome' })),
    uploadOutcome,
    startedAt: timestamp(field({ value: value, key: 'startedAt' })),
    completedAt: timestamp(field({ value: value, key: 'completedAt' })),
    endTime: timestamp(field({ value: value, key: 'endTime' })),
    uploadCompletedAt: timestamp(field({ value: value, key: 'uploadCompletedAt' })),
    commandAction: boolean(field({ value: value, key: 'commandAction' })),
  }
  const exclusionReason = field({ value: value, key: 'exclusionReason' })
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
  if (raw.endsWith('\n') === false) return invalid()
  const lines = raw.slice(0, -1).split('\n')
  const values: unknown[] = lines.map((line) => JSON.parse(line))
  const value = values.shift()
  if (
    field({ value: value, key: 'type' }) !== 'header' ||
    field({ value: value, key: 'schemaVersion' }) !== 1 ||
    field({ value: value, key: 'cacheOutcomeMapping' }) !== cacheOutcomeMapping
  )
    return invalid()
  const metadata = field({ value: value, key: 'metadata' })
  const posture = field({ value: metadata, key: 'posture' })
  if (posture !== 'read-only' && posture !== 'writer' && posture !== 'disabled-by-design')
    return invalid()
  const status = field({ value: value, key: 'status' })
  if (
    status !== 'collected' &&
    status !== 'no-native-logs' &&
    status !== 'remote-cache-disabled-by-design'
  )
    return invalid()
  const rawLane = field({ value: metadata, key: 'lane' })
  const header: ActionArtifactHeader = {
    type: 'header',
    schemaVersion: 1,
    cacheOutcomeMapping,
    metadata: {
      repo: nullableText({
        value: field({ value: metadata, key: 'repo' }),
        grammar: /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/,
      }),
      runId: nullableText({ value: field({ value: metadata, key: 'runId' }), grammar: /^[0-9]+$/ }),
      runAttempt: nullableText({
        value: field({ value: metadata, key: 'runAttempt' }),
        grammar: /^[0-9]+$/,
      }),
      job: nullableText({
        value: field({ value: metadata, key: 'job' }),
        grammar: /^[a-zA-Z0-9_.-]+$/,
      }),
      lane: rawLane === null ? null : lane(rawLane),
      headSha: nullableText({
        value: field({ value: metadata, key: 'headSha' }),
        grammar: /^[a-fA-F0-9]{40}$/,
      }),
      posture,
      startedAt: timestamp(field({ value: metadata, key: 'startedAt' })),
      finishedAt: timestamp(field({ value: metadata, key: 'finishedAt' })),
    },
    status,
    complete: boolean(field({ value: value, key: 'complete' })),
    actionCount: integer(field({ value: value, key: 'actionCount' })),
    excludedByDesign:
      field({ value: value, key: 'excludedByDesign' }) === undefined
        ? zeroActionExclusionCounts()
        : decodeActionExclusionCounts(field({ value: value, key: 'excludedByDesign' })),
    rows: integer(field({ value: value, key: 'rows' })),
    missingDigestCount: integer(field({ value: value, key: 'missingDigestCount' })),
    missingIdentityCount: integer(field({ value: value, key: 'missingIdentityCount' })),
    missingTimestampCount: integer(field({ value: value, key: 'missingTimestampCount' })),
    droppedActionCount: integer(field({ value: value, key: 'droppedActionCount' })),
    evidenceGaps: list(field({ value: value, key: 'evidenceGaps' })).map(
      (gap) => nullableText({ value: gap, grammar: /^[a-zA-Z0-9_.:-]+$/ }) ?? invalid(),
    ),
    invocations: list(field({ value: value, key: 'invocations' })).map((item) => ({
      buildId:
        nullableText({
          value: field({ value: item, key: 'buildId' }),
          grammar: /^[a-zA-Z0-9_.-]+$/,
        }) ?? invalid(),
      context: nullableText({ value: field({ value: item, key: 'context' }) }),
      startedAt: timestamp(field({ value: item, key: 'startedAt' })),
      completedAt: timestamp(field({ value: item, key: 'completedAt' })),
      freshRoot: boolean(field({ value: item, key: 'freshRoot' })),
      actionCount: integer(field({ value: item, key: 'actionCount' })),
      excludedByDesign:
        field({ value: item, key: 'excludedByDesign' }) === undefined
          ? zeroActionExclusionCounts()
          : decodeActionExclusionCounts(field({ value: item, key: 'excludedByDesign' })),
      complete: boolean(field({ value: item, key: 'complete' })),
    })),
  }
  const actions = values.map(decodeAction)
  // Retained artifacts predate policy fields; complete rows recover the same category policy.
  const actualExclusions = countActionExclusions(actions)
  if (field({ value: value, key: 'excludedByDesign' }) === undefined)
    header.excludedByDesign = actualExclusions
  if (
    header.complete === true &&
    actionExclusionReasons.some(
      (reason) => header.excludedByDesign[reason] !== actualExclusions[reason],
    ) === true
  )
    return invalid()
  const invocationValues = list(field({ value: value, key: 'invocations' }))
  for (const [index, invocation] of header.invocations.entries()) {
    const exclusions = countActionExclusions(
      actions.filter((action) => action.buildId === invocation.buildId),
    )
    if (field({ value: invocationValues[index], key: 'excludedByDesign' }) === undefined)
      invocation.excludedByDesign = exclusions
    if (
      header.complete === true &&
      actionExclusionReasons.some(
        (reason) => invocation.excludedByDesign[reason] !== exclusions[reason],
      ) === true
    )
      return invalid()
  }
  if (
    header.complete === true &&
    actions.some(
      (action) =>
        action.executionKind > 11 || action.executionKind === 5 || action.cacheUploadResult > 16,
    ) === true
  )
    return invalid()
  if (
    header.complete === true &&
    (header.rows !== actions.length ||
      header.actionCount !== actions.length ||
      header.droppedActionCount !== 0)
  )
    return invalid()
  const ids = new Set<string>()
  for (const invocation of header.invocations) {
    if (ids.has(invocation.buildId) === true) return invalid()
    ids.add(invocation.buildId)
    if (
      header.complete === true &&
      invocationWithinJobWindow({ invocation, metadata: header.metadata }) === false
    )
      return invalid()
    if (
      header.complete === true &&
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
      header.complete === true &&
      (invocation.complete === false ||
        invocation.startedAt === null ||
        invocation.completedAt === null)
    )
      return invalid()
    if (
      header.complete === true &&
      actions.some(
        (action) =>
          action.buildId === invocation.buildId &&
          ((action.startedAt !== null &&
            invocation.startedAt !== null &&
            action.startedAt < invocation.startedAt) ||
            (action.completedAt !== null &&
              invocation.completedAt !== null &&
              action.completedAt > invocation.completedAt)),
      ) === true
    )
      return invalid()
  }
  if (
    header.complete === true &&
    actions.some((action) => action.buildId === null || ids.has(action.buildId) === false) === true
  )
    return invalid()
  if (
    header.complete === true &&
    header.missingDigestCount !== actions.filter((action) => action.digest === null).length
  )
    return invalid()
  if (
    header.complete === true &&
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
    header.complete === true &&
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
