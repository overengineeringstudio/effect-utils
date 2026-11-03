import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type { Path } from 'effect/Path'
import type { PlatformError } from 'effect/PlatformError'
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'
import type { Scope } from 'effect/Scope'
import { expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import { syncMegarepo } from '../cli/commands/engine.ts'
import * as Git from '../core/git.ts'
import { collectSyncErrors } from '../sync/mod.ts'
import {
  rehomeFixture as fixture,
  snapshotRehome as snapshot,
} from '../test-utils/rehome-fixture.ts'
import { createWorkspaceWithLock } from '../test-utils/store-setup.ts'
import { inspectForeignGitDir, rehomeCommitWorktree } from './store-rehome.ts'
import { makeStoreLayer } from './store.ts'

const testEffect = <TValue, TError>(
  effect: Effect.Effect<TValue, TError, FileSystem.FileSystem | ChildProcessSpawner | Path | Scope>,
) => effect.pipe(Effect.provide(NodeServices.layer), Effect.scoped)

// All repositories and mounts are scoped temporary fixtures, never the real store.
describe('foreign Git common directory rehome', () => {
  it.effect('diagnoses the physical foreign common directory without writes', () =>
    testEffect(
      Effect.gen(function* () {
        const f = yield* fixture()
        const before = yield* snapshot(f.store.storePath)
        const foreignBefore = yield* snapshot(f.foreign)
        expect(yield* inspectForeignGitDir(f)).toBe(yield* f.fs.realPath(f.foreign))
        expect(yield* snapshot(f.store.storePath)).toEqual(before)
        expect(yield* snapshot(f.foreign)).toEqual(foreignBefore)
      }),
    ),
  )

  it.effect('dry-run returns a plan and preserves both stores byte-for-byte', () =>
    testEffect(
      Effect.gen(function* () {
        const f = yield* fixture()
        const before = yield* snapshot(f.store.storePath)
        const foreignBefore = yield* snapshot(f.foreign)
        const plan = yield* rehomeCommitWorktree({ ...f, dryRun: true })
        expect(plan).toContain(f.commit)
        expect(yield* snapshot(f.store.storePath)).toEqual(before)
        expect(yield* snapshot(f.foreign)).toEqual(foreignBefore)
      }),
    ),
  )

  it.effect(
    'reparents only Git administration, retaining payloads and foreign administration',
    () =>
      testEffect(
        Effect.gen(function* () {
          const f = yield* fixture(false)
          const canonicalCommit = Git.runCommand({
            cwd: f.bareRepoPath,
            args: ['cat-file', '-t', f.commit],
          })
          yield* canonicalCommit.pipe(Effect.flip)
          const tracked = yield* f.fs.readFile(`${f.worktreePath}megarepo.json`)
          const ignored = yield* snapshot(`${f.worktreePath}ignored.bin`)
          const mount = yield* snapshot(`${f.worktreePath}repos/mounted`)
          const foreignBefore = yield* snapshot(f.foreign)
          const result = yield* rehomeCommitWorktree(f)
          expect((yield* canonicalCommit).trim()).toBe('commit')
          expect(result.length).toBeGreaterThan(0)
          expect(yield* inspectForeignGitDir(f)).toBeUndefined()
          const common = yield* Git.runCommand({
            cwd: f.worktreePath,
            args: ['rev-parse', '--path-format=absolute', '--git-common-dir'],
          })
          expect(yield* f.fs.realPath(common.trim())).toBe(yield* f.fs.realPath(f.bareRepoPath))
          expect(yield* Git.getCurrentCommit(f.worktreePath)).toBe(f.commit)
          expect(yield* f.fs.readFile(`${f.worktreePath}megarepo.json`)).toEqual(tracked)
          expect(yield* snapshot(`${f.worktreePath}ignored.bin`)).toEqual(ignored)
          expect(yield* snapshot(`${f.worktreePath}repos/mounted`)).toEqual(mount)
          expect(yield* f.fs.exists(f.foreignAdmin)).toBe(true)
          expect(yield* snapshot(f.foreign)).toEqual(foreignBefore)
        }),
      ),
  )

  for (const staged of [false, true]) {
    it.effect(
      `refuses ${staged === true ? 'staged' : 'unstaged'} tracked changes without writes`,
      () =>
        testEffect(
          Effect.gen(function* () {
            const f = yield* fixture()
            yield* f.fs.writeFileString(`${f.worktreePath}megarepo.json`, 'dirty tracked bytes\n')
            if (staged === true) {
              yield* Git.runCommand({ cwd: f.worktreePath, args: ['add', 'megarepo.json'] })
            }
            const before = yield* snapshot(f.store.storePath)
            const foreignBefore = yield* snapshot(f.foreign)
            expect(String(yield* rehomeCommitWorktree(f).pipe(Effect.flip))).toMatch(
              /dirty|tracked/iu,
            )
            expect(yield* snapshot(f.store.storePath)).toEqual(before)
            expect(yield* snapshot(f.foreign)).toEqual(foreignBefore)
          }),
        ),
    )
  }

  it.effect('refuses HEAD that differs from the canonical commit path without writes', () =>
    testEffect(
      Effect.gen(function* () {
        const f = yield* fixture()
        yield* Git.runCommand({ cwd: f.worktreePath, args: ['switch', '--detach', 'main'] })
        const before = yield* snapshot(f.store.storePath)
        const foreignBefore = yield* snapshot(f.foreign)
        expect(String(yield* rehomeCommitWorktree(f).pipe(Effect.flip))).toMatch(/HEAD|commit/iu)
        expect(yield* snapshot(f.store.storePath)).toEqual(before)
        expect(yield* snapshot(f.foreign)).toEqual(foreignBefore)
      }),
    ),
  )

  it.effect('reports foreign branch worktrees but refuses even dry-run repair', () =>
    testEffect(
      Effect.gen(function* () {
        const f = yield* fixture()
        const worktreePath = EffectPath.unsafe.absoluteDir(
          `${f.bareRepoPath.replace(/\.bare\/$/u, '')}refs/heads/topic/`,
        )
        yield* Git.runCommand({
          cwd: f.foreign,
          args: ['worktree', 'add', '-b', 'topic', worktreePath, f.commit],
        })
        const args = { worktreePath, bareRepoPath: f.bareRepoPath }
        const before = yield* snapshot(f.store.storePath)
        const foreignBefore = yield* snapshot(f.foreign)
        expect(yield* inspectForeignGitDir(args)).toBe(yield* f.fs.realPath(f.foreign))
        expect(
          String(yield* rehomeCommitWorktree({ ...args, dryRun: true }).pipe(Effect.flip)),
        ).toMatch(/branch|commit/iu)
        expect(yield* snapshot(f.store.storePath)).toEqual(before)
        expect(yield* snapshot(f.foreign)).toEqual(foreignBefore)
      }),
    ),
  )

  it.effect('nested apply reuses the rehomed prepared tree without payload writes', () =>
    testEffect(
      Effect.gen(function* () {
        const f = yield* fixture()
        yield* rehomeCommitWorktree(f)
        const { workspacePath } = yield* createWorkspaceWithLock({
          members: { widget: 'https://example.com/acme/widget#rehome-fixture' },
          lockEntries: {
            widget: {
              url: 'https://example.com/acme/widget',
              ref: 'rehome-fixture',
              commit: f.commit,
            },
          },
        })
        const before = yield* snapshot(f.worktreePath)
        const result = yield* syncMegarepo({
          megarepoRoot: workspacePath,
          options: {
            mode: 'apply',
            dryRun: false,
            force: false,
            all: true,
            only: undefined,
            skip: undefined,
            gitProtocol: 'https',
            createBranches: false,
            commitMode: true,
            lockSyncMode: 'off',
          },
        }).pipe(Effect.provide(makeStoreLayer({ basePath: f.store.storePath })))
        expect(collectSyncErrors(result)).toEqual([])
        expect(result.nestedResults).toHaveLength(1)
        expect(yield* f.fs.realPath(`${workspacePath}repos/widget`)).toBe(
          f.worktreePath.replace(/\/$/u, ''),
        )
        expect(yield* snapshot(f.worktreePath)).toEqual(before)
      }),
    ),
  )
})
