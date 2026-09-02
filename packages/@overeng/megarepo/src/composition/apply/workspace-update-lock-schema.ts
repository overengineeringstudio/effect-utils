import { Schema } from 'effect'

/** Durable workspace-update lock wire version. */
export const WORKSPACE_UPDATE_LOCK_SCHEMA = 1 as const
/** Exclusive composition update lock below the workspace root. */
export const WORKSPACE_UPDATE_LOCK_PATH = '.megarepo/workspace-update.lock' as const

/** Exact recovery token for one workspace update owner. */
export const WorkspaceUpdateLockTokenSchema = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{32}$/u),
).annotate({ identifier: 'Megarepo.WorkspaceUpdateLockToken' })
export type WorkspaceUpdateLockToken = typeof WorkspaceUpdateLockTokenSchema.Type

/** Strict durable owner record. Extra fields are refused by the lock decoder. */
export const WorkspaceUpdateLockOwnerSchema = Schema.Struct({
  schema: Schema.Literal(WORKSPACE_UPDATE_LOCK_SCHEMA),
  token: WorkspaceUpdateLockTokenSchema,
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
}).annotate({ identifier: 'Megarepo.WorkspaceUpdateLockOwner' })
export type WorkspaceUpdateLockOwner = typeof WorkspaceUpdateLockOwnerSchema.Type

/** Conservative ownership, recovery, or filesystem failure. */
export class WorkspaceUpdateLockError extends Schema.TaggedError<WorkspaceUpdateLockError>()(
  'WorkspaceUpdateLockError',
  {
    reason: Schema.Literals(['LockHeld', 'RecoveryRefused', 'ReleaseRefused', 'IoFailure']),
    path: Schema.String,
    message: Schema.String,
    recoveryPaths: Schema.Array(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
