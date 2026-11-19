import { join } from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { it } from '@effect/vitest'
import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { runBuckMaintainWithProgress } from './store-buck-maintain-progress.ts'

it.live('rejects acting and invalid shards before runtime resolution or checkpoint creation', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()
    const invalid = [
      { dryRun: false, maxWorktrees: 1, message: 'explicit --dry-run' },
      { dryRun: true, maxWorktrees: 0, message: 'positive safe integer' },
    ]
    for (const [index, options] of invalid.entries()) {
      const progressDir = join(directory, `unopened-${index}`)
      const error = yield* runBuckMaintainWithProgress({
        configPath: undefined,
        dryRun: options.dryRun,
        progressDir,
        maxWorktrees: options.maxWorktrees,
      }).pipe(Effect.flip)
      expect(error).toMatchObject({
        _tag: 'BuckMaintainProgressError', message: expect.stringContaining(options.message),
      })
      expect(yield* fs.exists(progressDir)).toBe(false)
    }
    expect(yield* fs.readDirectory(directory)).toEqual([])
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)
