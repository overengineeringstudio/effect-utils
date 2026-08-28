import { Buffer } from 'node:buffer'
import * as NodePath from 'node:path'

import { Schema } from 'effect'

import { DistOverlayDestination, DistOverlayTarget } from './dist-overlay-schema.ts'
import { OwnedCpAMountMetadata, R6DistOverlayManifestIdentity } from './member-mount-r6.ts'

/** Durable overlay transaction wire version. */
export const DIST_OVERLAY_TRANSACTION_VERSION = 1 as const

const AbsolutePath = Schema.String.check(
  Schema.makeFilter<string>((value) =>
    NodePath.isAbsolute(value) === true && NodePath.normalize(value) === value
      ? undefined
      : 'Expected a normalized absolute path',
  ),
)
const MemberName = Schema.String.check(
  Schema.makeFilter<string>((value) =>
    value.length > 0 && value !== '.' && value !== '..' && /[/\\]/u.test(value) === false
      ? undefined
      : 'Expected one non-empty member path segment',
  ),
)
const InodeIdentity = Schema.Struct({ dev: Schema.Natural, ino: Schema.Natural })

/** Publish, replace, or remove one declared overlay. Null artifactPath requests removal. */
export const DistOverlayPublishRequest = Schema.Struct({
  workspaceRoot: AbsolutePath,
  member: MemberName,
  expectedMountIdentity: InodeIdentity,
  expectedMetadata: OwnedCpAMountMetadata,
  target: DistOverlayTarget,
  destination: DistOverlayDestination,
  artifactPath: Schema.NullOr(AbsolutePath),
  cpPath: AbsolutePath,
  mvPath: AbsolutePath,
  dryRun: Schema.Boolean,
}).annotate({ identifier: 'Megarepo.DistOverlayPublishRequest' })
export type DistOverlayPublishRequest = typeof DistOverlayPublishRequest.Type

/** Request to reconcile one durable overlay transaction. */
export const DistOverlayRecoveryRequest = Schema.Struct({
  workspaceRoot: AbsolutePath,
  member: MemberName,
  target: DistOverlayTarget,
  destination: DistOverlayDestination,
  expectedMountIdentity: InodeIdentity,
  mvPath: AbsolutePath,
}).annotate({ identifier: 'Megarepo.DistOverlayRecoveryRequest' })
export type DistOverlayRecoveryRequest = typeof DistOverlayRecoveryRequest.Type

/** Closed overlay publication operation set. */
export const DistOverlayOperation = Schema.Literals(['FirstPublish', 'Update', 'Remove'])
export type DistOverlayOperation = typeof DistOverlayOperation.Type

/** Diagnostic durable phase hints; recovery trusts observed identity instead. */
export const DistOverlayPhase = Schema.Literals([
  'Intent',
  'CandidateCreated',
  'CandidateValidated',
  'Published',
  'MetadataPublished',
  'Cleanup',
])
export type DistOverlayPhase = typeof DistOverlayPhase.Type

/** Durable identity transaction. Recovery trusts observed state, never phaseHint. */
export const DistOverlayTransaction = Schema.Struct({
  version: Schema.Literal(DIST_OVERLAY_TRANSACTION_VERSION),
  member: MemberName,
  target: DistOverlayTarget,
  destination: DistOverlayDestination,
  mountPath: AbsolutePath,
  destinationPath: AbsolutePath,
  stagePath: AbsolutePath,
  operation: DistOverlayOperation,
  phaseHint: DistOverlayPhase,
  mountIdentity: InodeIdentity,
  oldIdentity: Schema.NullOr(InodeIdentity),
  candidateIdentity: Schema.NullOr(InodeIdentity),
  oldOverlay: Schema.NullOr(R6DistOverlayManifestIdentity),
  newOverlay: Schema.NullOr(R6DistOverlayManifestIdentity),
  previousMetadata: OwnedCpAMountMetadata,
  nextMetadata: OwnedCpAMountMetadata,
}).annotate({ identifier: 'Megarepo.DistOverlayTransaction' })
export type DistOverlayTransaction = typeof DistOverlayTransaction.Type

/** Nonmutating overlay publication plan. */
export const DistOverlayPlan = Schema.TaggedStruct('DistOverlayPlan', {
  operation: DistOverlayOperation,
  member: MemberName,
  target: DistOverlayTarget,
  destination: DistOverlayDestination,
  destinationPath: AbsolutePath,
  stagePath: AbsolutePath,
  transactionPath: AbsolutePath,
  previousMetadata: OwnedCpAMountMetadata,
  nextMetadata: OwnedCpAMountMetadata,
  steps: Schema.Array(
    Schema.Literals([
      'AssertUpdateLock',
      'ValidateMount',
      'CreateTransaction',
      'CopyArtifact',
      'ProtectCandidate',
      'ValidateCandidate',
      'Publish',
      'ValidateRepositoryIdentity',
      'PublishMetadata',
      'ValidateOldIdentity',
      'DeleteOld',
      'RemoveTransaction',
    ]),
  ),
}).annotate({ identifier: 'Megarepo.DistOverlayPlan' })
export type DistOverlayPlan = typeof DistOverlayPlan.Type

/** Overlay publication and recovery result union. */
export const DistOverlayResult = Schema.Union([
  Schema.TaggedStruct('DryRun', { plan: DistOverlayPlan }),
  Schema.TaggedStruct('Published', {
    operation: DistOverlayOperation,
    destinationPath: AbsolutePath,
    metadata: OwnedCpAMountMetadata,
  }),
  Schema.TaggedStruct('Recovered', {
    action: Schema.Literals(['RolledBack', 'RolledForward']),
    destinationPath: AbsolutePath,
  }),
]).annotate({ identifier: 'Megarepo.DistOverlayResult' })
export type DistOverlayResult = typeof DistOverlayResult.Type

/** Typed overlay refusal, publication failure, or ambiguous recovery. */
export class DistOverlayError extends Schema.TaggedError<DistOverlayError>()('DistOverlayError', {
  reason: Schema.Literals([
    'InvalidRequest',
    'UpdateLockNotOwned',
    'UndeclaredDestination',
    'MountIdentityMismatch',
    'MetadataMismatch',
    'ArtifactInvalid',
    'DestinationRefused',
    'TransactionCollision',
    'CommandFailure',
    'RepositoryIdentityChanged',
    'MetadataPublishFailed',
    'AmbiguousRecovery',
    'IoFailure',
  ]),
  path: Schema.String,
  message: Schema.String,
  recoveryPaths: Schema.Array(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {}

const encodeSegment = (value: string): string => Buffer.from(value, 'utf8').toString('hex')

/** Transaction path keyed bijectively by member and exact destination. */
export const distOverlayTransactionPath = ({
  workspaceRoot,
  member,
  destination,
}: {
  workspaceRoot: string
  member: string
  destination: string
}): string =>
  NodePath.join(
    NodePath.resolve(workspaceRoot),
    'repos',
    '.mr',
    'overlay-transactions',
    `v1-${encodeSegment(member)}--${encodeSegment(destination)}.json`,
  )
