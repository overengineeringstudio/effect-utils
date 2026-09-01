import { Buffer } from 'node:buffer'
import * as NodePath from 'node:path'

import { Schema } from 'effect'

/** Canonical acquisition journal and root-ownership wire version. */
export const OWNED_WORKTREE_ACQUISITION_VERSION = 1 as const
/** Persistent ownership proof filename at the synthesized workspace root. */
export const OWNED_WORKTREE_ROOT_MANIFEST = '.megarepo-owned-worktree.json' as const

const AbsolutePath = Schema.String.check(
  Schema.makeFilter<string>((value) =>
    NodePath.isAbsolute(value) === true && NodePath.normalize(value) === value
      ? undefined
      : 'Expected a normalized absolute path',
  ),
).annotate({ identifier: 'Megarepo.OwnedWorktreeAbsolutePath' })

/** Canonical one-segment owned member name. */
export const OwnedWorktreeName = Schema.String.check(
  Schema.makeFilter<string>((value) =>
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) === true && value !== '.' && value !== '..'
      ? undefined
      : 'Expected one canonical member path segment',
  ),
).annotate({ identifier: 'Megarepo.OwnedWorktreeName' })

const GitHead = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40,64}$/u)).annotate({
  identifier: 'Megarepo.OwnedWorktreeGitHead',
})
const BranchRef = Schema.String.check(Schema.isPattern(/^refs\/heads\/.+$/u)).annotate({
  identifier: 'Megarepo.OwnedWorktreeBranchRef',
})
const Base64Bytes = Schema.String.check(
  Schema.makeFilter<string>((value) =>
    Buffer.from(value, 'base64').toString('base64') === value
      ? undefined
      : 'Expected canonical base64',
  ),
)

/** Exact token binding one durable lifecycle lock owner. */
export const OwnedWorktreeAcquisitionLockToken = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{32}$/u),
).annotate({ identifier: 'Megarepo.OwnedWorktreeAcquisitionLockToken' })
export type OwnedWorktreeAcquisitionLockToken = typeof OwnedWorktreeAcquisitionLockToken.Type

/** Strict durable owner record shared by live-lock errors and stale-lock recovery. */
export const OwnedWorktreeAcquisitionLockOwner = Schema.Struct({
  nonce: OwnedWorktreeAcquisitionLockToken,
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  version: Schema.Literal(OWNED_WORKTREE_ACQUISITION_VERSION),
}).annotate({ identifier: 'Megarepo.OwnedWorktreeAcquisitionLockOwner' })
export type OwnedWorktreeAcquisitionLockOwner = typeof OwnedWorktreeAcquisitionLockOwner.Type

/** Closed diagnostic journal state set; recovery still trusts observed paths and Git. */
export const OwnedWorktreeAcquisitionState = Schema.Literals([
  'prepared',
  'moved_to_temp',
  'root_created',
  'installed',
  'generated',
  'complete',
])
export type OwnedWorktreeAcquisitionState = typeof OwnedWorktreeAcquisitionState.Type

/** Supported authority config filename discovered from the owned member. */
export const OwnedWorktreeConfigName = Schema.Literals(['megarepo.kdl', 'megarepo.json'])
export type OwnedWorktreeConfigName = typeof OwnedWorktreeConfigName.Type

/** Durable intent record. Its state is only a diagnostic hint; recovery trusts observed paths and Git. */
export const OwnedWorktreeAcquisitionJournal = Schema.Struct({
  adminDir: AbsolutePath,
  bareRepo: AbsolutePath,
  branchRef: BranchRef,
  head: GitHead,
  ownedMember: OwnedWorktreeName,
  state: OwnedWorktreeAcquisitionState,
  statusPorcelainBase64: Base64Bytes,
  tempPath: AbsolutePath,
  version: Schema.Literal(OWNED_WORKTREE_ACQUISITION_VERSION),
  workspaceRoot: AbsolutePath,
}).annotate({ identifier: 'Megarepo.OwnedWorktreeAcquisitionJournal' })
export type OwnedWorktreeAcquisitionJournal = typeof OwnedWorktreeAcquisitionJournal.Type

/** Persistent ownership proof used for idempotence and exact teardown after the journal is removed. */
export const OwnedWorktreeRootManifest = Schema.Struct({
  adminDir: AbsolutePath,
  bareRepo: AbsolutePath,
  branchRef: BranchRef,
  head: GitHead,
  ownedMember: OwnedWorktreeName,
  statusPorcelainBase64: Base64Bytes,
  tempPath: AbsolutePath,
  version: Schema.Literal(OWNED_WORKTREE_ACQUISITION_VERSION),
  workspaceRoot: AbsolutePath,
}).annotate({ identifier: 'Megarepo.OwnedWorktreeRootManifest' })
export type OwnedWorktreeRootManifest = typeof OwnedWorktreeRootManifest.Type

/** Successful acquisition result with the owned member as default cwd. */
export const OwnedWorktreeAcquisitionResult = Schema.TaggedStruct('Acquired', {
  workspaceRoot: AbsolutePath,
  ownedWorktree: AbsolutePath,
  defaultCwd: AbsolutePath,
  configPath: AbsolutePath,
  configName: OwnedWorktreeConfigName,
}).annotate({ identifier: 'Megarepo.OwnedWorktreeAcquisitionResult' })
export type OwnedWorktreeAcquisitionResult = typeof OwnedWorktreeAcquisitionResult.Type

/** Explicit rollback or forward-recovery result. */
export const OwnedWorktreeRecoveryResult = Schema.Union([
  Schema.TaggedStruct('RolledBack', { workspaceRoot: AbsolutePath }),
  Schema.TaggedStruct('RolledForward', {
    workspaceRoot: AbsolutePath,
    ownedWorktree: AbsolutePath,
    defaultCwd: AbsolutePath,
    configPath: AbsolutePath,
    configName: OwnedWorktreeConfigName,
  }),
]).annotate({ identifier: 'Megarepo.OwnedWorktreeRecoveryResult' })
export type OwnedWorktreeRecoveryResult = typeof OwnedWorktreeRecoveryResult.Type

/** Successful restoration of the canonical branch worktree pathname. */
export const OwnedWorkspaceTeardownResult = Schema.TaggedStruct('TornDown', {
  restoredWorktree: AbsolutePath,
  defaultCwd: AbsolutePath,
}).annotate({ identifier: 'Megarepo.OwnedWorkspaceTeardownResult' })
export type OwnedWorkspaceTeardownResult = typeof OwnedWorkspaceTeardownResult.Type

/** Typed refusal or recoverable owned-worktree lifecycle failure. */
export class OwnedWorktreeAcquisitionError extends Schema.TaggedError<OwnedWorktreeAcquisitionError>()(
  'OwnedWorktreeAcquisitionError',
  {
    reason: Schema.Literals([
      'InvalidRequest',
      'AcquisitionLocked',
      'StaleLockRecoveryRefused',
      'PreflightRefused',
      'Collision',
      'GitIdentityConflict',
      'RecoveryConflict',
      'ForeignRootEntry',
      'ConfigMissing',
      'ConfigSymlinkInvalid',
      'GenerationFailed',
      'CleanupFailed',
      'CommandFailure',
      'IoFailure',
    ]),
    path: Schema.String,
    message: Schema.String,
    recoveryPaths: Schema.Array(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** One exact ordered filesystem, Git, or callback step in an acquisition dry-run. */
export const OwnedWorktreeAcquisitionPlanStep = Schema.Union([
  Schema.TaggedStruct('WriteJournal', {
    path: AbsolutePath,
    state: OwnedWorktreeAcquisitionState,
  }),
  Schema.TaggedStruct('GitWorktreeMove', {
    bareRepo: AbsolutePath,
    fromPath: AbsolutePath,
    toPath: AbsolutePath,
  }),
  Schema.TaggedStruct('PublishManagedRoot', {
    rootStagePath: AbsolutePath,
    workspaceRoot: AbsolutePath,
    reposPath: AbsolutePath,
    manifestPath: AbsolutePath,
  }),
  Schema.TaggedStruct('RemoveManagedRoot', { path: AbsolutePath }),
  Schema.TaggedStruct('CreateConfigSymlink', {
    path: AbsolutePath,
    target: Schema.String,
  }),
  Schema.TaggedStruct('InvokeGenerate', {
    workspaceRoot: AbsolutePath,
    ownedWorktree: AbsolutePath,
    configPath: AbsolutePath,
  }),
  Schema.TaggedStruct('RemoveJournal', { path: AbsolutePath }),
]).annotate({ identifier: 'Megarepo.OwnedWorktreeAcquisitionPlanStep' })
export type OwnedWorktreeAcquisitionPlanStep = typeof OwnedWorktreeAcquisitionPlanStep.Type

const OwnedWorktreePlanPaths = {
  workspaceRoot: AbsolutePath,
  ownedWorktree: AbsolutePath,
  tempPath: AbsolutePath,
  journalPath: AbsolutePath,
  rootStagePath: AbsolutePath,
  rootConfigPath: AbsolutePath,
  configPath: AbsolutePath,
  configName: OwnedWorktreeConfigName,
} as const

/** Read-only acquisition/recovery classification consumed by apply dry-run. */
export const OwnedWorktreeAcquisitionPlan = Schema.Union([
  Schema.TaggedStruct('AlreadySynthesized', OwnedWorktreePlanPaths),
  Schema.TaggedStruct('Acquire', {
    ...OwnedWorktreePlanPaths,
    steps: Schema.Array(OwnedWorktreeAcquisitionPlanStep),
  }),
  Schema.TaggedStruct('Recover', {
    ...OwnedWorktreePlanPaths,
    journalState: OwnedWorktreeAcquisitionState,
    action: Schema.Literals([
      'RemoveJournalAtCanonicalWorktree',
      'RollbackTemporary',
      'RollForwardInstalled',
      'FinishGenerated',
      'FinishComplete',
    ]),
    steps: Schema.Array(OwnedWorktreeAcquisitionPlanStep),
  }),
  Schema.TaggedStruct('Refused', {
    error: OwnedWorktreeAcquisitionError,
  }),
]).annotate({ identifier: 'Megarepo.OwnedWorktreeAcquisitionPlan' })
export type OwnedWorktreeAcquisitionPlan = typeof OwnedWorktreeAcquisitionPlan.Type
