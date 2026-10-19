import { Schema } from 'effect'

/** Hard ceilings, not hints derived from untrusted ZIP or HTTP metadata. */
export const ARTIFACT_LIMITS = {
  metadataBytes: 1024 * 1024,
  artifactsPerPage: 100,
  maxPage: 1000,
  compressedBytes: 32 * 1024 * 1024,
  entries: 1024,
  memberBytes: 8 * 1024 * 1024,
  outputBytes: 256 * 1024,
  pathBytes: 1024,
} as const

const Id = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
const NonNegativeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)

const WindowLength = NonNegativeInt.check(Schema.isLessThanOrEqualTo(ARTIFACT_LIMITS.outputBytes))

/** Byte windows in decompressed content; the escaped JSON envelope has its own output ceiling. */
export const ArtifactReadWindow = Schema.Union([
  Schema.Struct({ offset: NonNegativeInt, length: WindowLength }),
  Schema.Struct({ tailBytes: WindowLength }),
]).annotate({ identifier: 'Artifacts.ReadWindow' })
export type ArtifactReadWindow = typeof ArtifactReadWindow.Type

/** Artifact API fields intentionally exclude signed download URLs and credentials. */
export const RetainedArtifact = Schema.Struct({
  id: Id,
  name: Schema.String.check(Schema.isMaxLength(1024)),
  size_in_bytes: NonNegativeInt,
  expired: Schema.Boolean,
  created_at: Schema.String,
  updated_at: Schema.String,
  expires_at: Schema.String,
  workflow_run: Schema.NullOr(Schema.Struct({ id: Id })),
}).annotate({ identifier: 'Artifacts.RetainedArtifact' })
export type RetainedArtifact = typeof RetainedArtifact.Type

/** One bounded page of retained artifact metadata returned by GitHub. */
export const RunArtifactsResponse = Schema.Struct({
  total_count: NonNegativeInt,
  artifacts: Schema.Array(RetainedArtifact).check(
    Schema.isMaxLength(ARTIFACT_LIMITS.artifactsPerPage),
  ),
}).annotate({ identifier: 'Artifacts.RunArtifactsResponse' })

/** Every operation names its repository and run, including failures. No job is inferred. */
export const ArtifactProvenance = Schema.Struct({ repo: Schema.String, runId: Id, artifactId: Id })
export type ArtifactProvenance = typeof ArtifactProvenance.Type

/** Member metadata enumerated without decompressing member content. */
export const ArtifactMember = Schema.Struct({
  path: Schema.String,
  compressedBytes: NonNegativeInt,
  decompressedBytes: NonNegativeInt,
  directory: Schema.Boolean,
}).annotate({ identifier: 'Artifacts.Member' })
export type ArtifactMember = typeof ArtifactMember.Type

/** Expected, sanitized artifact failures. Signed URLs and transport causes are never serialized. */
export class ArtifactError extends Schema.TaggedError<ArtifactError>()('ArtifactError', {
  repo: Schema.String,
  runId: Schema.Finite,
  artifactId: Schema.NullOr(Schema.Finite),
  member: Schema.NullOr(Schema.String),
  reason: Schema.Literals([
    'invalid-selection',
    'artifact-not-found',
    'expired',
    'run-mismatch',
    'member-not-found',
    'unsafe-archive',
    'unsupported-archive',
    'limit-exceeded',
    'binary-content',
    'transport',
  ]),
  message: Schema.String,
}) {}

/** Exact repository, workflow run and artifact selected by the caller. */
export interface ArtifactSelection {
  readonly repo: string
  readonly runId: number
  readonly artifactId: number
}
