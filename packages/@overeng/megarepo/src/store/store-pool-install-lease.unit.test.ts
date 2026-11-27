import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { expect } from 'vitest'

import {
  decodePoolInstallQualification,
  matchesPoolInstallQualification,
} from './store-pool-install-lease.ts'

// Synthetic metadata only: these paths are not claimed to exist or be qualified.
// Actual doctor/provider execution and SHARED lifetime require native qualification.
const input = {
  storeCacheRoot: '/native/store',
  pnpmProvider: '/nix/store/00000000000000000000000000000000-pnpm/bin/pnpm',
  pnpmVersion: '12.23.0',
}

const invalid: ReadonlyArray<{ name: string; value: unknown }> = [
  { name: 'missing configuration', value: undefined },
  { name: 'missing root', value: { pnpmProvider: input.pnpmProvider, pnpmVersion: input.pnpmVersion } },
  { name: 'null root', value: { ...input, storeCacheRoot: null } },
  { name: 'relative root', value: { ...input, storeCacheRoot: 'do-not-echo' } },
  { name: 'noncanonical root', value: { ...input, storeCacheRoot: '/native/../do-not-echo' } },
  { name: 'trailing root slash', value: { ...input, storeCacheRoot: '/native/store/' } },
  { name: 'ambient provider', value: { ...input, pnpmProvider: 'pnpm' } },
  { name: 'nonimmutable provider', value: { ...input, pnpmProvider: '/tmp/do-not-echo' } },
  { name: 'provider traversal', value: { ...input, pnpmProvider: '/nix/store/x/../../do-not-echo' } },
  { name: 'provider NUL', value: { ...input, pnpmProvider: `${input.pnpmProvider}\0do-not-echo` } },
  { name: 'unsupported minor version', value: { ...input, pnpmVersion: '12.24.0' } },
  { name: 'unsupported patch version', value: { ...input, pnpmVersion: '12.23.1' } },
  { name: 'boolean qualification bypass', value: { ...input, qualified: true } },
  { name: 'extra environment override', value: { ...input, env: { SECRET: 'do-not-echo' } } },
]

describe('pool install qualification metadata (not native evidence)', () => {
  for (const pnpmVersion of ['12.17.0', '12.23.0']) {
    it.effect(`accepts only an exact metadata tuple at audited version ${pnpmVersion}`, () =>
      Effect.gen(function* () {
        const qualification = yield* decodePoolInstallQualification({ ...input, pnpmVersion })
        const binding = { storeCacheRoot: input.storeCacheRoot, pnpmProvider: input.pnpmProvider }
        expect(matchesPoolInstallQualification({ binding, observedProviderVersion: pnpmVersion, qualification })).toBe(true)
        for (const observedProviderVersion of ['12.23.1', '12.24.0', `${pnpmVersion}-preview`, `${pnpmVersion}\n`]) {
          expect(matchesPoolInstallQualification({ binding, observedProviderVersion, qualification })).toBe(false)
        }
        const otherVersion = pnpmVersion === '12.17.0' ? '12.23.0' : '12.17.0'
        expect(matchesPoolInstallQualification({ binding, observedProviderVersion: otherVersion, qualification })).toBe(false)
      }),
    )
  }

  it.effect('does not infer matching roots or providers from aliases, layouts or equal version strings', () =>
    Effect.gen(function* () {
      const qualification = yield* decodePoolInstallQualification(input)
      for (const binding of [
        { storeCacheRoot: `${input.storeCacheRoot}/v11`, pnpmProvider: input.pnpmProvider },
        { storeCacheRoot: `${input.storeCacheRoot}-alias`, pnpmProvider: input.pnpmProvider },
        { storeCacheRoot: input.storeCacheRoot, pnpmProvider: `${input.pnpmProvider}-alias` },
        { storeCacheRoot: input.storeCacheRoot, pnpmProvider: '/nix/store/11111111111111111111111111111111-pnpm/bin/pnpm' },
      ]) {
        expect(matchesPoolInstallQualification({ binding, observedProviderVersion: '12.23.0', qualification })).toBe(false)
      }
    }),
  )

  for (const { name, value } of invalid) {
    it.effect(`refuses ${name} without exporting rejected configuration`, () =>
      Effect.gen(function* () {
        const error = yield* decodePoolInstallQualification(value).pipe(Effect.flip)
        expect(error.message).toBe('Invalid pool install qualification; HOLD')
        expect(JSON.stringify(error)).not.toContain('do-not-echo')
      }),
    )
  }
})
