import { Context, Effect, FileSystem, Layer, Schema } from 'effect'

/** Adapter only: protocol.schema.json and fixtures/conformance.json are normative. */
export const Purpose = Schema.Literals([
  'state',
  'cache',
  'data',
  'runtime',
  'checkouts',
  'credentials',
]).annotate({ identifier: 'WorkStorage.Purpose' })
export type Purpose = typeof Purpose.Type

/** Canonical POSIX paths are rejected, never normalized, at the wire boundary. */
export const CanonicalPath = Schema.String.check(
  Schema.makeFilter(
    (path: string) =>
      path.startsWith('/') &&
      !path.includes('\0') &&
      (path === '/' ||
        path
          .slice(1)
          .split('/')
          .every((segment) => segment !== '' && segment !== '.' && segment !== '..')),
  ),
).annotate({ identifier: 'WorkStorage.CanonicalPath' })

const Paths = Schema.Record(Schema.String, CanonicalPath).check(
  Schema.makeFilter((paths) => Object.keys(paths).every(Schema.is(Purpose))),
)

/** The portable v1 manifest shape; the neutral JSON Schema remains normative. */
export const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  app: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*$(?![\s\S])/)),
  provider: Schema.Struct({
    kind: Schema.Literals(['apfs', 'zfs', 'fixture']),
    root: CanonicalPath,
    identity: Schema.NonEmptyString,
  }),
  paths: Paths,
  environment: Schema.Record(Schema.String, Schema.String),
}).annotate({ identifier: 'WorkStorage.Manifest' })
export type Manifest = typeof Manifest.Type

/** Observation comes from the gated launcher; it is not a readiness probe. */
export const Observation = Schema.Struct({
  present: Schema.Boolean,
  identity: Schema.String,
}).annotate({ identifier: 'WorkStorage.Observation' })
export type Observation = typeof Observation.Type

/** A manifest, its gated observation, and the purpose to resolve. */
export const Request = Schema.Struct({
  manifest: Manifest,
  observed: Observation,
  purpose: Schema.String,
}).annotate({ identifier: 'WorkStorage.Request' })
export type Request = typeof Request.Type

/** The closed set of portable protocol error codes. */
export const ErrorCode = Schema.Literals([
  'InvalidManifest',
  'FactoryAbsent',
  'IdentityMismatch',
  'UnknownPurpose',
  'UndeclaredPurpose',
])
export type ErrorCode = typeof ErrorCode.Type

/** The single portable protocol error tag carrying one of the five codes. */
export class StorageError extends Schema.TaggedError<StorageError>()('StorageError', {
  code: ErrorCode,
  message: Schema.String,
}) {}

/** IO errors remain distinct from the five portable protocol errors. */
export class ManifestReadError extends Schema.TaggedError<ManifestReadError>()(
  'ManifestReadError',
  {
    path: Schema.String,
    cause: Schema.Defect(),
    message: Schema.String,
  },
) {}

const invalid = () =>
  new StorageError({
    code: 'InvalidManifest',
    message: 'Invalid work-storage v1 manifest or observation',
  })

/** Decode manifest JSON text, rejecting any non-manifest shape. */
export const decodeManifest = Effect.fn('WorkStorage.decodeManifest')(function* (text: string) {
  return yield* Schema.decodeEffect(Schema.fromJsonString(Manifest))(text).pipe(
    Effect.mapError(invalid),
  )
})

// Preserve a BOM so JSON decoding rejects it, matching Rust's strict UTF-8 reader.
const manifestUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** Read and strictly decode a manifest file, preserving I/O failures. */
export const readManifest = Effect.fn('WorkStorage.readManifest')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  const bytes = yield* fs.readFile(path).pipe(
    Effect.mapError(
      (cause) =>
        new ManifestReadError({
          path,
          cause,
          message: `Unable to read work-storage manifest at ${path}`,
        }),
    ),
  )
  const text = yield* Effect.try({
    try: () => manifestUtf8.decode(bytes),
    catch: invalid,
  })
  return yield* decodeManifest(text)
})

/** Validate a manifest and observation, then apply admission precedence. */
export const admit = Effect.fn('WorkStorage.admit')(function* (
  manifest: unknown,
  observed: unknown,
) {
  const decoded = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ manifest: Manifest, observed: Observation }),
  )({ manifest, observed }).pipe(Effect.mapError(invalid))
  if (decoded.observed.present === false)
    return yield* new StorageError({
      code: 'FactoryAbsent',
      message: 'Declared work-storage provider is absent; refusing fallback storage',
    })
  if (decoded.observed.identity !== decoded.manifest.provider.identity)
    return yield* new StorageError({
      code: 'IdentityMismatch',
      message: 'Observed work-storage identity differs from the declared provider',
    })
  return decoded.manifest
})

/** Admitted manifest view: declared roles and opaque environment values. */
export interface WorkStorageService {
  readonly manifest: Manifest
  readonly environment: Manifest['environment']
  readonly role: (purpose: string) => Effect.Effect<string, StorageError>
}

const make = (manifest: Manifest): WorkStorageService => ({
  manifest,
  environment: manifest.environment,
  role: Effect.fn('WorkStorage.role')(function* (purpose: string) {
    if (Schema.is(Purpose)(purpose) === false)
      return yield* new StorageError({
        code: 'UnknownPurpose',
        message: `Unknown work-storage purpose: ${purpose}`,
      })
    const path = manifest.paths[purpose]
    if (path === undefined)
      return yield* new StorageError({
        code: 'UndeclaredPurpose',
        message: `Manifest does not declare work-storage purpose: ${purpose}`,
      })
    return path
  }),
})

/** Stateless reader: no mkdir, mount, fallback, or process-environment mutation. */
export class WorkStorage extends Context.Service<WorkStorage, WorkStorageService>()(
  '@overeng/work-storage/WorkStorage',
) {
  static readonly layer = ({ manifest, observed }: { manifest: unknown; observed: unknown }) =>
    Layer.effect(WorkStorage, admit(manifest, observed).pipe(Effect.map(make)))

  static readonly layerFile = ({ path, observed }: { path: string; observed: unknown }) =>
    Layer.effect(
      WorkStorage,
      readManifest(path).pipe(
        Effect.flatMap((manifest) => admit(manifest, observed)),
        Effect.map(make),
      ),
    )
}

/** Portable request entrypoint, including validation before admission errors. */
export const resolveRequest = Effect.fn('WorkStorage.resolveRequest')(function* (input: unknown) {
  const request = yield* Schema.decodeUnknownEffect(Request)(input).pipe(Effect.mapError(invalid))
  return yield* Effect.gen(function* () {
    const storage = yield* WorkStorage
    return yield* storage.role(request.purpose)
  }).pipe(
    Effect.provide(WorkStorage.layer({ manifest: request.manifest, observed: request.observed })),
  )
})
