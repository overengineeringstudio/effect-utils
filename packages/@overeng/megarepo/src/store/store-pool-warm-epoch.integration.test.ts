import { NodeServices } from '@effect/platform-node'
import { it } from '@effect/vitest'
import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'
import { Vitest } from '@overeng/utils-dev/node-vitest'

import { runPoolTasks } from './store-pool-install.ts'
import { withPoolGlobalEpoch } from './store-pool-lock-order.ts'
import { warmPoolRoot } from './store-pool-roots.ts'

const withTestCtx = Vitest.makeWithTestCtx({ makeLayer: () => NodeServices.layer })

it.effect(
  'refuses warm from GLOBAL before missing-root FS, ledger, native or client access',
  (test) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
      const error = yield* warmPoolRoot({
        base: EffectPath.unsafe.absoluteDir(`${root}/missing-store/`),
        bare: `${root}/missing-store/repo/.bare`,
        commit: 'a'.repeat(40),
        limits: { maxSlots: 1, maxBytes: 1_000_000_000 },
        // Negative metadata only. The specific GLOBAL refusal must precede even client validation.
        client: {
          path: '/nonexistent-holder-client-before-global',
          producerId: 'unused',
          policyId: 'unused',
        },
        prewarmTasks: [],
        runTasks: runPoolTasks,
        preparation: {
          mode: 'buck2',
          buck2Provider: '/nix/store/unexecuted-fixture/bin/buck2',
          prepareTasks: ['buck2:editor:materialize'],
        },
      }).pipe(withPoolGlobalEpoch, Effect.flip)
      expect(error._tag).toBe('PoolError')
      expect(error.message).toBe('Pool warming inside GLOBAL; HOLD')
      expect(yield* fs.readDirectory(root)).toEqual([])
    }).pipe(withTestCtx(test)),
)
