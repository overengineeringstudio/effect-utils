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

export const Request = Schema.Struct({
  manifest: Manifest,
  observed: Observation,
  purpose: Schema.String,
}).annotate({ identifier: 'WorkStorage.Request' })
export type Request = typeof Request.Type

export const ErrorCode = Schema.Literals([
  'InvalidManifest',
  'FactoryAbsent',
  'IdentityMismatch',
  'UnknownPurpose',
  'UndeclaredPurpose',
])
export type ErrorCode = typeof ErrorCode.Type

export class StorageError extends Schema.TaggedErrorClass<StorageError>()('StorageError', {
  code: ErrorCode,
  message: Schema.String,
}) {}

/** IO errors remain distinct from the five portable protocol errors. */
export class ManifestReadError extends Schema.TaggedErrorClass<ManifestReadError>()(
  'ManifestReadError',
  {
    path: Schema.String,
    cause: Schema.Defect,
    message: Schema.String,
  },
) {}

const invalid = () =>
  new StorageError({
    code: 'InvalidManifest',
    message: 'Invalid work-storage v1 manifest or observation',
  })

export const decodeManifest = Effect.fn('WorkStorage.decodeManifest')(function* (text: string) {
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))(text).pipe(
    Effect.mapError(invalid),
  )
})

export const readManifest = Effect.fn('WorkStorage.readManifest')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(path).pipe(
    Effect.mapError(
      (cause) =>
        new ManifestReadError({
          path,
          cause,
          message: `Unable to read work-storage manifest at ${path}`,
        }),
    ),
  )
  return yield* decodeManifest(text)
})

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
  static readonly layer = (manifest: unknown, observed: unknown) =>
    Layer.effect(WorkStorage, admit(manifest, observed).pipe(Effect.map(make)))

  static readonly layerFile = (path: string, observed: unknown) =>
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
  }).pipe(Effect.provide(WorkStorage.layer(request.manifest, request.observed)))
})
