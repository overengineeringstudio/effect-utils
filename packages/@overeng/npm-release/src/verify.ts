/**
 * Registry-facing side of verification: reads what npm serves, hashes what we packed,
 * and drives the pure classification in {@link registryVerification} until the registry
 * converges or the budget runs out.
 *
 * All judgement lives in `mod.ts`; this module only supplies it with facts.
 */

import { createHash } from 'node:crypto'

import { Effect, Schema } from 'effect'
import type { Schedule } from 'effect'
import { FileSystem } from 'effect/FileSystem'
import { ChildProcess as Command } from 'effect/unstable/process'

import { registryVerification, type RemoteRegistryState } from './mod.ts'

/** One package to verify. `tarball` is absent when this run did not pack it. */
export const PlanPackage = Schema.Struct({
  name: Schema.Trimmed.check(Schema.isNonEmpty()),
  tarball: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty())),
}).annotate({ identifier: 'NpmRelease.PlanPackage' })

/** The release a caller wants the registry to agree with. */
export const VerifyPlan = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  version: Schema.Trimmed.check(Schema.isNonEmpty()),
  npmTag: Schema.Trimmed.check(Schema.isNonEmpty()),
  packages: Schema.NonEmptyArray(PlanPackage),
}).annotate({ identifier: 'NpmRelease.VerifyPlan' })

export type VerifyPlan = typeof VerifyPlan.Type

/** A package the registry disagreed about, after the convergence budget was spent. */
export const VerifyFailure = Schema.Struct({
  package: Schema.String,
  reason: Schema.String,
  terminal: Schema.Boolean,
}).annotate({ identifier: 'NpmRelease.VerifyFailure' })

export type VerifyFailure = typeof VerifyFailure.Type

/** Raised when the plan file cannot be read or does not decode. */
export class PlanError extends Schema.TaggedErrorClass<PlanError>()('PlanError', {
  path: Schema.String,
  message: Schema.String,
}) {}

/** Raised when the registry does not serve the release the plan describes. */
export class VerificationFailed extends Schema.TaggedErrorClass<VerificationFailed>()(
  'VerificationFailed',
  {
    failures: Schema.Array(VerifyFailure),
    message: Schema.String,
  },
) {}

/** Registry state has not converged yet; retried until the budget is spent. */
class NotConverged extends Schema.TaggedErrorClass<NotConverged>()('NotConverged', {
  reason: Schema.String,
}) {}

const RegistryManifest = Schema.Struct({
  version: Schema.String,
  dist: Schema.optional(Schema.Struct({ integrity: Schema.optional(Schema.String) })),
})

const RegistryDistTags = Schema.Record(Schema.String, Schema.String)

/**
 * `npm view --json`, with every failure mode reported as absent data.
 *
 * npm exits non-zero *and* prints a JSON error object to stdout for an unpublished
 * version, so neither exit code nor parseability distinguishes "not there yet" from
 * "broken". Both are absence; the retry budget decides when absence becomes failure.
 */
const npmViewJson = Effect.fn('npmViewJson')(function* <A, I>(
  args: ReadonlyArray<string>,
  schema: Schema.Schema<A, I>,
  registry: string,
) {
  const raw = yield* Command.make('npm', 'view', ...args, '--json', `--registry=${registry}`).pipe(
    Command.string,
    Effect.orElseSucceed(() => ''),
  )

  return yield* Schema.decodeUnknown(Schema.fromJsonString(schema))(raw.trim()).pipe(
    Effect.orElseSucceed(() => undefined),
  )
})

/** Read what the registry currently serves for one package version. */
export const readRegistryState = Effect.fn('readRegistryState')(function* ({
  name,
  version,
  npmTag,
  registry,
}: {
  readonly name: string
  readonly version: string
  readonly npmTag: string
  readonly registry: string
}) {
  const manifest = yield* npmViewJson([`${name}@${version}`], RegistryManifest, registry)
  const distTags = yield* npmViewJson([name, 'dist-tags'], RegistryDistTags, registry)

  return {
    version: manifest?.version,
    integrity: manifest?.dist?.integrity,
    distTag: distTags?.[npmTag],
  } satisfies RemoteRegistryState
})

/** npm's `dist.integrity` format: base64 SHA-512 of the tarball, algorithm-prefixed. */
const tarballIntegrity = Effect.fn('tarballIntegrity')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  const bytes = yield* fs.readFile(path)
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
})

/**
 * Verify one package, retrying only while the registry may still converge.
 *
 * A `mismatch` fails immediately — a published npm version is immutable, so waiting
 * cannot change it, and retrying would turn a clear failure into a silent wait.
 */
const verifyPackage = Effect.fn('verifyPackage')(function* ({
  name,
  tarball,
  version,
  npmTag,
  registry,
  schedule,
}: {
  readonly name: string
  readonly tarball: string | undefined
  readonly version: string
  readonly npmTag: string
  readonly registry: string
  readonly schedule: Schedule.Schedule<unknown, unknown>
}) {
  // An unreadable tarball is a caller error, not a registry disagreement, but it still
  // belongs in the same report so one run surfaces every reason the release is unsound.
  const localIntegrity =
    tarball === undefined
      ? undefined
      : yield* tarballIntegrity(tarball).pipe(
          Effect.mapError(
            (cause) =>
              new VerificationFailed({
                failures: [
                  {
                    package: name,
                    reason: `cannot read packed tarball ${tarball}: ${String(cause)}`,
                    terminal: true,
                  },
                ],
                message: `cannot read packed tarball for ${name}`,
              }),
          ),
        )

  const attempt = Effect.gen(function* () {
    const remote = yield* readRegistryState({ name, version, npmTag, registry })
    const result = registryVerification({ pkg: name, version, npmTag, localIntegrity, remote })

    if (result._tag === 'mismatch') {
      return yield* new VerificationFailed({
        failures: [{ package: name, reason: result.reason, terminal: true }],
        message: result.reason,
      })
    }
    if (result._tag === 'pending') return yield* new NotConverged({ reason: result.reason })
  })

  return yield* attempt.pipe(
    Effect.retry({ schedule, while: (error) => error._tag === 'NotConverged' }),
    Effect.catchTag(
      'NotConverged',
      (error) =>
        new VerificationFailed({
          failures: [
            {
              package: name,
              reason: `${error.reason} — registry did not converge within the verification window`,
              terminal: false,
            },
          ],
          message: error.reason,
        }),
    ),
  )
})

/**
 * Verify every package in the plan, reporting all disagreements rather than the first.
 *
 * A release group fails as a unit, so an operator seeing only the first bad package
 * would fix it and immediately rediscover the next one.
 */
export const verifyPlan = Effect.fn('verifyPlan')(function* ({
  plan,
  registry,
  schedule,
}: {
  readonly plan: VerifyPlan
  readonly registry: string
  readonly schedule: Schedule.Schedule<unknown, unknown>
}) {
  const outcomes = yield* Effect.forEach(
    plan.packages,
    (pkg) =>
      verifyPackage({
        name: pkg.name,
        tarball: pkg.tarball,
        version: plan.version,
        npmTag: plan.npmTag,
        registry,
        schedule,
      }).pipe(Effect.either),
    { concurrency: 4 },
  )

  const failures: Array<VerifyFailure> = []
  for (const outcome of outcomes) {
    if (outcome._tag === 'Left') failures.push(...outcome.left.failures)
  }

  if (failures.length > 0) {
    return yield* new VerificationFailed({
      failures,
      message: `${failures.length} of ${plan.packages.length} package(s) did not match the registry`,
    })
  }
})

/** Read and decode a verify plan. */
export const readPlan = Effect.fn('readPlan')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  const content = yield* fs
    .readFileString(path)
    .pipe(
      Effect.mapError(
        (cause) => new PlanError({ path, message: `Cannot read plan: ${String(cause)}` }),
      ),
    )

  return yield* Schema.decodeUnknown(Schema.fromJsonString(VerifyPlan))(content).pipe(
    Effect.mapError((cause) => new PlanError({ path, message: `Invalid plan: ${cause}` })),
  )
})
