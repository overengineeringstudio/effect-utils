import { describe, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { expect } from 'vitest'

import { PoolPreparation } from './store-pool-preparation.ts'

const decode = Schema.decodeUnknownEffect(PoolPreparation, { onExcessProperty: 'error' })

// Configuration fixtures only, not executable/provider or native root qualification.
describe('explicit pool root preparation contract', () => {
  for (const preparation of [
    {
      mode: 'buck2',
      buck2Provider: '/nix/store/metadata-fixture/bin/buck2',
      prepareTasks: ['buck2:editor:materialize'],
    },
    {
      mode: 'pnpm-gvs',
      qualification: {
        storeCacheRoot: '/store/cache',
        pnpmProvider: '/nix/store/metadata-fixture/bin/pnpm',
        pnpmVersion: '12.23.0',
      },
    },
  ]) {
    it.effect(`preserves explicit ${preparation.mode} configuration`, () =>
      Effect.gen(function* () {
        expect(yield* decode(preparation)).toEqual(preparation)
      }),
    )
  }
  for (const preparation of [
    { mode: 'buck2', buck2Provider: 'buck2', prepareTasks: ['buck2:editor:materialize'] },
    {
      mode: 'buck2',
      buck2Provider: '/mutable/bin/buck2',
      prepareTasks: ['buck2:editor:materialize'],
    },
    {
      mode: 'buck2',
      buck2Provider: '/nix/store/metadata-fixture/../bin/buck2',
      prepareTasks: ['buck2:editor:materialize'],
    },
    { mode: 'buck2', buck2Provider: '/nix/store/metadata-fixture/bin/buck2', prepareTasks: [] },
    {
      mode: 'buck2',
      buck2Provider: '/nix/store/metadata-fixture/bin/buck2',
      prepareTasks: ['--unsafe'],
    },
    {
      mode: 'buck2',
      buck2Provider: '/nix/store/metadata-fixture/bin/buck2',
      prepareTasks: ['check;exit'],
    },
    {
      mode: 'buck2',
      buck2Provider: '/nix/store/metadata-fixture/bin/buck2',
      prepareTasks: ['check'],
      storeCacheRoot: '/invented',
    },
    { mode: 'pnpm-gvs' },
    { mode: 'guess-installed-layout' },
  ]) {
    it.effect(`rejects unsupported preparation ${JSON.stringify(preparation)}`, () =>
      Effect.gen(function* () {
        expect(yield* decode(preparation).pipe(Effect.flip)).toBeDefined()
      }),
    )
  }
})
