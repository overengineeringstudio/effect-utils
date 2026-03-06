/**
 * AlignmentOutput Schema
 *
 * Effect Schema definitions for the alignment coordinator output.
 * Parses result files written by the bash scripts and manages alignment state.
 */

import { Schema } from 'effect'

// =============================================================================
// Task Result (from .tasks files)
// =============================================================================

/** Single task result: `task:name:status` parsed from .tasks file lines */
export const TaskResult = Schema.Struct({
  name: Schema.String,
  status: Schema.Literal('ok', 'warning'),
})
export type TaskResult = Schema.Schema.Type<typeof TaskResult>

/**
 * Parse a .tasks file line like `pnpm:install:ok` or `genie:run:warning`.
 * The status is the suffix after the LAST colon.
 */
export const parseTaskLine = (line: string): TaskResult | undefined => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return undefined

  const lastColon = trimmed.lastIndexOf(':')
  if (lastColon === -1) return undefined

  const name = trimmed.slice(0, lastColon)
  const status = trimmed.slice(lastColon + 1)

  if (status !== 'ok' && status !== 'warning') return undefined
  return { name, status }
}

/** Parse all lines from a .tasks file */
export const parseTasksFile = (content: string): readonly TaskResult[] =>
  content
    .split('\n')
    .map(parseTaskLine)
    .filter((r): r is TaskResult => r !== undefined)

// =============================================================================
// PR Result (from .result files)
// =============================================================================

export const PRStatus = Schema.Literal('created', 'updated', 'no-changes', 'skipped')
export type PRStatus = Schema.Schema.Type<typeof PRStatus>

export const AutoMergeStatus = Schema.Literal('enabled', 'needs-review', 'failed', 'n/a')
export type AutoMergeStatus = Schema.Schema.Type<typeof AutoMergeStatus>

export const PRResult = Schema.Struct({
  status: PRStatus,
  prNumber: Schema.optional(Schema.Number),
  prUrl: Schema.optional(Schema.String),
  filesChanged: Schema.optional(Schema.Number),
  safeOnly: Schema.optional(Schema.Boolean),
  autoMerge: Schema.optional(AutoMergeStatus),
  repoSlug: Schema.optional(Schema.String),
})
export type PRResult = Schema.Schema.Type<typeof PRResult>

/**
 * Parse a .result file (key=value pairs).
 * Example:
 * ```
 * STATUS=created
 * PR_NUMBER=123
 * PR_URL=https://github.com/.../pull/123
 * FILES_CHANGED=5
 * SAFE_ONLY=true
 * AUTO_MERGE=enabled
 * REPO_SLUG=owner/repo
 * ```
 */
export const parseResultFile = (content: string): PRResult => {
  const kvs: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const eq = line.indexOf('=')
    if (eq === -1) continue
    kvs[line.slice(0, eq)] = line.slice(eq + 1)
  }

  const status = kvs.STATUS
  if (status !== 'created' && status !== 'updated' && status !== 'no-changes' && status !== 'skipped') {
    return { status: 'skipped' }
  }

  return {
    status,
    prNumber: kvs.PR_NUMBER ? Number.parseInt(kvs.PR_NUMBER, 10) || undefined : undefined,
    prUrl: kvs.PR_URL || undefined,
    filesChanged: kvs.FILES_CHANGED ? Number.parseInt(kvs.FILES_CHANGED, 10) || undefined : undefined,
    safeOnly: kvs.SAFE_ONLY === 'true' ? true : kvs.SAFE_ONLY === 'false' ? false : undefined,
    autoMerge: (['enabled', 'needs-review', 'failed', 'n/a'] as const).includes(kvs.AUTO_MERGE as AutoMergeStatus)
      ? (kvs.AUTO_MERGE as AutoMergeStatus)
      : undefined,
    repoSlug: kvs.REPO_SLUG || undefined,
  }
}

// =============================================================================
// Poll Status
// =============================================================================

export const PollStatus = Schema.Literal(
  'merged',
  'checks_passed',
  'checks_failed',
  'closed',
  'pending',
  'timeout',
  'no_pr',
)
export type PollStatus = Schema.Schema.Type<typeof PollStatus>

// =============================================================================
// Member State
// =============================================================================

export const MemberState = Schema.Struct({
  name: Schema.String,
  taskResults: Schema.optional(Schema.Array(TaskResult)),
  taskStatus: Schema.optional(Schema.Literal('ok', 'warning', 'skipped')),
  prResult: Schema.optional(PRResult),
  pollStatus: Schema.optional(PollStatus),
  /** Error output from failed tasks (last N lines) */
  failedTaskDetails: Schema.optional(Schema.Array(Schema.Struct({
    taskName: Schema.String,
    output: Schema.String,
  }))),
})
export type MemberState = Schema.Schema.Type<typeof MemberState>

// =============================================================================
// Alignment State
// =============================================================================

export const AlignmentPhase = Schema.Literal('loading', 'tasks', 'prs', 'polling', 'complete')
export type AlignmentPhase = Schema.Schema.Type<typeof AlignmentPhase>

export const AlignmentState = Schema.Struct({
  phase: AlignmentPhase,
  members: Schema.Array(MemberState),
})
export type AlignmentState = Schema.Schema.Type<typeof AlignmentState>

// =============================================================================
// Alignment Actions
// =============================================================================

export const AlignmentAction = Schema.Union(
  Schema.TaggedStruct('SetState', { state: AlignmentState }),
  Schema.TaggedStruct('SetMembers', { members: Schema.Array(MemberState) }),
  Schema.TaggedStruct('SetPhase', { phase: AlignmentPhase }),
  Schema.TaggedStruct('UpdateMember', {
    name: Schema.String,
    update: Schema.Struct({
      taskResults: Schema.optional(Schema.Array(TaskResult)),
      taskStatus: Schema.optional(Schema.Literal('ok', 'warning', 'skipped')),
      prResult: Schema.optional(PRResult),
      pollStatus: Schema.optional(PollStatus),
      failedTaskDetails: Schema.optional(Schema.Array(Schema.Struct({
        taskName: Schema.String,
        output: Schema.String,
      }))),
    }),
  }),
  Schema.TaggedStruct('Interrupted', {}),
)
export type AlignmentAction = Schema.Schema.Type<typeof AlignmentAction>

// =============================================================================
// Reducer
// =============================================================================

export const alignmentReducer = ({
  state,
  action,
}: {
  state: AlignmentState
  action: AlignmentAction
}): AlignmentState => {
  switch (action._tag) {
    case 'SetState':
      return action.state

    case 'SetMembers':
      return { ...state, members: [...action.members] }

    case 'SetPhase':
      return { ...state, phase: action.phase }

    case 'UpdateMember': {
      const idx = state.members.findIndex((m) => m.name === action.name)
      if (idx === -1) {
        return {
          ...state,
          members: [...state.members, { name: action.name, ...action.update }],
        }
      }
      const updated = [...state.members]
      updated[idx] = { ...updated[idx]!, ...action.update }
      return { ...state, members: updated }
    }

    case 'Interrupted':
      return state
  }
}
