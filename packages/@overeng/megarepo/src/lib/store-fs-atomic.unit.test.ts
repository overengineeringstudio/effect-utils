/**
 * Unit tests for {@link writeFileAtomic} (decision 0010 atomicity helper).
 *
 * Exercises REAL filesystem writes against a scoped temp dir:
 * - the happy path lands the content via write-temp-then-rename;
 * - a rename failure (target path is a directory) fails the effect AND leaves
 *   no `.tmp-*` sibling lingering as garbage (the `tapError` cleanup branch).
 */

import { FileSystem } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import { writeFileAtomic } from './store-fs-atomic.ts'

describe('store-fs-atomic: writeFileAtomic', () => {
  it.effect(
    'writes content atomically with no temp file left behind',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const target = EffectPath.ops.join(dir, EffectPath.unsafe.relativeFile('record.json'))

        yield* writeFileAtomic({ path: target, content: '{"v":1}\n' })

        expect(yield* fs.readFileString(target)).toBe('{"v":1}\n')
        // No `.tmp-*` sibling survives the successful rename.
        const remaining = yield* fs.readDirectory(dir)
        expect(remaining.filter((name) => name.includes('.tmp-'))).toEqual([])
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'on a rename failure (target is a directory) it fails AND removes the temp file',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const target = EffectPath.ops.join(dir, EffectPath.unsafe.relativeFile('record.json'))

        // Make the target path a NON-EMPTY directory so `rename(temp, target)`
        // is refused (ENOTDIR/ENOTEMPTY) — the temp file is written, the rename
        // fails, and the cleanup branch must run.
        yield* fs.makeDirectory(target, { recursive: true })
        yield* fs.writeFileString(
          EffectPath.ops.join(
            EffectPath.unsafe.absoluteDir(`${target}/`),
            EffectPath.unsafe.relativeFile('occupant'),
          ),
          'blocks the rename\n',
        )

        const result = yield* writeFileAtomic({ path: target, content: 'x' }).pipe(Effect.either)
        expect(result._tag).toBe('Left')

        // The `.tmp-<digest>` sibling must not survive the failed write.
        const remaining = yield* fs.readDirectory(dir)
        expect(remaining.filter((name) => name.includes('.tmp-'))).toEqual([])
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )
})
