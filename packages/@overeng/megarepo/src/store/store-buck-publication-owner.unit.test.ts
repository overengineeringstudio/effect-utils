import { NodeServices } from '@effect/platform-node'
import { it } from '@effect/vitest'
import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as ChildProcess from 'effect/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'
import { expect } from 'vitest'

it.effect(
  'protects real maintenance writes and releases the publication owner on failure and interruption',
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
      // This is the shared bracket's real filesystem contract, not a fake Buck executable.
      // Native daemon lifecycle coverage remains in the capability and teardown regressions.
      const script = `
      import { strict as assert } from 'node:assert'
      import { existsSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
      import { join } from 'node:path'
      import { Deferred, Effect, Exit, Fiber } from 'effect'
      import { withEditorPublicationOwner, releaseEditorPublicationOwner, tryAcquireEditorPublicationOwner, editorPublicationIsolation } from '@overeng/buck2-tools'
      import { withBuckIsolationMaintenance } from ${JSON.stringify(new URL('./store-buck-daemons.ts', import.meta.url).href)}
      const root = process.argv[1]
      const marker = join(root, 'maintenance-write')
      const run = Effect.sync(() => writeFileSync(marker, 'actual filesystem mutation'))
      await withEditorPublicationOwner({ root, run: async (owner) => {
        assert.deepEqual(Reflect.ownKeys(owner), [])
        assert.deepEqual(await Effect.runPromise(withBuckIsolationMaintenance({
          root, isolation: editorPublicationIsolation, run,
        })), { _tag: 'blocked', reason: 'editor-publication-busy' })
        assert.equal(existsSync(marker), false)
        assert.equal((await Effect.runPromise(withBuckIsolationMaintenance({ root, isolation: 'v2', run })))._tag, 'completed')
        assert.equal(existsSync(marker), true)
      } })
      const completed = await Effect.runPromise(withBuckIsolationMaintenance({
        root, isolation: editorPublicationIsolation, run: Effect.sync(() => {
          assert.equal(tryAcquireEditorPublicationOwner({ root }), undefined)
          writeFileSync(marker, 'owned mutation')
        }),
      }))
      assert.equal(completed._tag, 'completed')
      const assertReleased = () => {
        const owner = tryAcquireEditorPublicationOwner({ root })
        assert.notEqual(owner, undefined)
        releaseEditorPublicationOwner(owner)
      }
      assertReleased()
      const failed = await Effect.runPromise(withBuckIsolationMaintenance({
        root, isolation: editorPublicationIsolation, run: Effect.fail('command failed'),
      }).pipe(Effect.exit))
      assert.equal(Exit.isFailure(failed), true)
      assertReleased()
      const entered = await Effect.runPromise(Deferred.make())
      const fiber = Effect.runFork(withBuckIsolationMaintenance({
        root, isolation: editorPublicationIsolation,
        run: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      }))
      await Effect.runPromise(Deferred.await(entered))
      assert.equal(tryAcquireEditorPublicationOwner({ root }), undefined)
      await Effect.runPromise(Fiber.interrupt(fiber))
      assertReleased()
      const directoryRoot = join(root, 'directory')
      mkdirSync(join(directoryRoot, '.devenv', 'editor-view-publication.lock'), { recursive: true })
      const symlinkRoot = join(root, 'symlink')
      mkdirSync(join(symlinkRoot, '.devenv'), { recursive: true })
      const target = join(root, 'must-not-truncate')
      writeFileSync(target, 'unchanged')
      symlinkSync(target, join(symlinkRoot, '.devenv', 'editor-view-publication.lock'))
      const inodeRoot = join(root, 'hardlink')
      mkdirSync(join(inodeRoot, '.devenv'), { recursive: true })
      linkSync(target, join(inodeRoot, '.devenv', 'editor-view-publication.lock'))
      for (const [unknownRoot, diagnostic] of [
        [directoryRoot, /EISDIR/], [join(root, 'missing'), /ENOENT/], [symlinkRoot, /ELOOP|symlink|regular file/],
        [inodeRoot, /different lock inode/],
      ]) {
        const unknownMarker = join(unknownRoot, 'must-not-write')
        const result = await Effect.runPromise(withBuckIsolationMaintenance({
          root: unknownRoot, isolation: editorPublicationIsolation,
          run: Effect.sync(() => writeFileSync(unknownMarker, 'forbidden')),
        }))
        assert.equal(result._tag, 'blocked')
        assert.match(result.reason, /^editor-publication-owner-unknown: /)
        assert.match(result.reason, diagnostic)
        assert.ok(result.cause instanceof Error)
        assert.equal(existsSync(unknownMarker), false)
      }
      assert.equal(readFileSync(target, 'utf8'), 'unchanged')
    `
      const bun =
        process.env.BUN_BIN ?? (process.versions.bun === undefined ? 'bun' : process.execPath)
      const spawner = yield* ChildProcessSpawner
      const code = yield* spawner.exitCode(
        ChildProcess.make(bun, ['--eval', script, root], { stderr: 'inherit' }),
      )
      expect(code).toBe(0)
      expect(yield* fs.readFileString(`${root}/maintenance-write`)).toBe('owned mutation')
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)
