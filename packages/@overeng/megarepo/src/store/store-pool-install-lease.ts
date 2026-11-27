import { isAbsolute, resolve } from 'node:path'

import { Effect, Schema } from 'effect'

import { type AbsoluteDirPath } from '@overeng/effect-path'

import { withPnpmStoreCacheReadLease } from './git-writer-lock.ts'
import {
  inspectPoolInstall,
  type PoolInstallBinding,
  runPoolCommand,
} from './store-pool-install.ts'
import { PoolError } from './store-pool-state.ts'

const CanonicalAbsolutePath = Schema.NonEmptyString.check(
  Schema.makeFilter((path) => isAbsolute(path) && resolve(path) === path && !path.includes('\0')),
)

/** Configuration shape, NOT evidence that a root/provider has been qualified. */
export const PoolInstallQualification = Schema.Struct({
  storeCacheRoot: CanonicalAbsolutePath,
  pnpmProvider: CanonicalAbsolutePath.check(Schema.isPattern(/^\/nix\/store\/[^/]+\/.+$/u)),
  pnpmVersion: Schema.Literals(['12.17.0', '12.23.0']),
})
export type PoolInstallQualification = typeof PoolInstallQualification.Type

const decodeQualification = Schema.decodeUnknownEffect(PoolInstallQualification, {
  onExcessProperty: 'error',
})

/** Strict configuration admission; rejected input and extra fields are not echoed. */
export const decodePoolInstallQualification = (input: unknown) =>
  decodeQualification(input).pipe(
    Effect.mapError(() => new PoolError({ message: 'Invalid pool install qualification; HOLD' })),
  )

/** Pure metadata comparison only: this cannot establish freshness or qualification. */
export const matchesPoolInstallQualification = ({
  binding,
  observedProviderVersion,
  qualification,
}: {
  binding: Pick<PoolInstallBinding, 'storeCacheRoot' | 'pnpmProvider'>
  observedProviderVersion: string
  qualification: PoolInstallQualification
}) =>
  binding.storeCacheRoot === qualification.storeCacheRoot &&
  binding.pnpmProvider === qualification.pnpmProvider &&
  observedProviderVersion === qualification.pnpmVersion

/**
 * Caller supplies configuration from the normally qualified root, never an env
 * override or a self-asserted boolean. All physical ROOT/claim/pin authority is
 * still the caller's responsibility. Do not let USE children outlive this scope.
 */
export const withQualifiedPoolInstall =
  ({
    base,
    path,
    commit,
    qualification,
  }: {
    base: AbsoluteDirPath
    path: string
    commit: string
    qualification: PoolInstallQualification
  }) =>
  <A, E, R>(use: (binding: PoolInstallBinding) => Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const qualified = yield* decodePoolInstallQualification(qualification)
      return yield* Effect.gen(function* () {
        const binding = yield* inspectPoolInstall({ base, path, commit })
        // Reject aliases before executing anything: an immutable store symlink
        // could otherwise point at a mutable or simply different executable.
        if (
          binding.storeCacheRoot !== qualified.storeCacheRoot ||
          binding.pnpmProvider !== qualified.pnpmProvider
        )
          return yield* new PoolError({
            message: 'Pool install/provider qualification mismatch; HOLD',
          })
        const observedProviderVersion = yield* runPoolCommand({
          cwd: path,
          command: binding.pnpmProvider,
          args: ['--version'],
        })
        if (
          matchesPoolInstallQualification({
            binding,
            observedProviderVersion,
            qualification: qualified,
          }) === false
        )
          return yield* new PoolError({
            message: 'Pool install/provider qualification mismatch; HOLD',
          })
        return yield* use(binding)
      }).pipe(withPnpmStoreCacheReadLease({ storeCacheRoot: qualified.storeCacheRoot }))
    })
