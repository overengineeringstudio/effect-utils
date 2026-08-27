import { lstat, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { expect } from 'vitest'

import {
  WORKSPACE_UPDATE_LOCK_PATH,
  type WorkspaceUpdateLockError,
} from './workspace-update-lock-schema.ts'
import {
  acquireWorkspaceUpdateLock,
  recoverStaleWorkspaceUpdateLock,
  releaseWorkspaceUpdateLock,
} from './workspace-update-lock.ts'

const tokenA = 'a'.repeat(32)
const tokenB = 'b'.repeat(32)

const fixture = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(NodePath.join(tmpdir(), 'megarepo-workspace-update-lock-'))),
  (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
)

const failureOf = <A>(effect: Effect.Effect<A, WorkspaceUpdateLockError>) =>
  Effect.result(effect).pipe(
    Effect.map((result) => {
      if (result._tag === 'Success') throw new Error('Expected workspace update lock failure')
      return result.failure
    }),
  )

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    (cause: unknown) => {
      if (
        typeof cause === 'object' &&
        cause !== null &&
        'code' in cause &&
        cause.code === 'ENOENT'
      ) {
        return false
      }
      throw cause
    },
  )

describe('workspace update lock', () => {
  it.effect('acquires by hardlink, fsyncs, and releases only its exact identity', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* fixture
        const synced: string[] = []
        const runtime = {
          token: () => tokenA,
          directoryFsync: async ({ path, sync }: { path: string; sync: () => Promise<void> }) => {
            synced.push(path)
            await sync()
          },
        }
        const held = yield* acquireWorkspaceUpdateLock({ workspaceRoot: root, runtime })
        const [lockInfo, ownerInfo] = yield* Effect.promise(() =>
          Promise.all([stat(held.lockPath), stat(held.ownerPath)]),
        )
        expect([lockInfo.dev, lockInfo.ino]).toEqual([ownerInfo.dev, ownerInfo.ino])
        expect(yield* Effect.promise(() => readFile(held.lockPath, 'utf8'))).toBe(
          `{"schema":1,"token":"${tokenA}","pid":${process.pid}}\n`,
        )
        yield* releaseWorkspaceUpdateLock({ held, runtime })
        expect(yield* Effect.promise(() => exists(held.lockPath))).toBe(false)
        expect(yield* Effect.promise(() => exists(held.ownerPath))).toBe(false)
        expect(synced.filter((path) => path === NodePath.join(root, '.megarepo')).length).toBe(2)
      }),
    ),
  )

  it.effect('durably removes both names when acquisition parent fsync fails', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* fixture
        const parent = NodePath.join(root, '.megarepo')
        let parentSyncs = 0
        const error = yield* failureOf(
          acquireWorkspaceUpdateLock({
            workspaceRoot: root,
            runtime: {
              token: () => tokenA,
              directoryFsync: async ({ path, sync }) => {
                if (path === parent) {
                  parentSyncs += 1
                  if (parentSyncs === 1) throw new Error('publication fsync failed')
                }
                await sync()
              },
            },
          }),
        )
        expect(error.reason).toBe('IoFailure')
        expect(parentSyncs).toBe(2)
        expect(
          yield* Effect.promise(() => exists(NodePath.join(root, WORKSPACE_UPDATE_LOCK_PATH))),
        ).toBe(false)
        expect(
          yield* Effect.promise(() =>
            exists(NodePath.join(root, `${WORKSPACE_UPDATE_LOCK_PATH}.owner-${tokenA}`)),
          ),
        ).toBe(false)
      }),
    ),
  )

  it.effect('refuses contention and reports the exact recovery token', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* fixture
        const held = yield* acquireWorkspaceUpdateLock({
          workspaceRoot: root,
          runtime: { token: () => tokenA },
        })
        const error = yield* failureOf(
          acquireWorkspaceUpdateLock({
            workspaceRoot: root,
            runtime: { token: () => tokenB },
          }),
        )
        expect(error.reason).toBe('LockHeld')
        expect(error.message).toContain(tokenA)
        expect(error.message).toContain('through mr')
        expect(yield* Effect.promise(() => exists(held.lockPath))).toBe(true)
        yield* releaseWorkspaceUpdateLock({ held })
      }),
    ),
  )

  it.effect('recovers only the exact token of a definitely dead owner', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* fixture
        const held = yield* acquireWorkspaceUpdateLock({
          workspaceRoot: root,
          runtime: { token: () => tokenA },
        })
        const wrong = yield* failureOf(
          recoverStaleWorkspaceUpdateLock({
            workspaceRoot: root,
            token: tokenB,
            runtime: { processAlive: async () => 'dead' },
          }),
        )
        expect(wrong.reason).toBe('RecoveryRefused')
        for (const state of ['alive', 'unknown'] as const) {
          const refused = yield* failureOf(
            recoverStaleWorkspaceUpdateLock({
              workspaceRoot: root,
              token: tokenA,
              runtime: { processAlive: async () => state },
            }),
          )
          expect(refused.reason).toBe('RecoveryRefused')
          expect(refused.message).toContain(state)
        }
        yield* recoverStaleWorkspaceUpdateLock({
          workspaceRoot: root,
          token: tokenA,
          runtime: { processAlive: async () => 'dead' },
        })
        expect(yield* Effect.promise(() => exists(held.lockPath))).toBe(false)
        expect(yield* Effect.promise(() => exists(held.ownerPath))).toBe(false)
      }),
    ),
  )

  it.effect('refuses malformed owner bytes without deleting either hardlink', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* fixture
        const held = yield* acquireWorkspaceUpdateLock({
          workspaceRoot: root,
          runtime: { token: () => tokenA },
        })
        yield* Effect.promise(() => writeFile(held.lockPath, '{"schema":1,"token":"bad"}\n'))
        const error = yield* failureOf(
          recoverStaleWorkspaceUpdateLock({
            workspaceRoot: root,
            token: tokenA,
            runtime: { processAlive: async () => 'dead' },
          }),
        )
        expect(error.reason).toBe('RecoveryRefused')
        expect(yield* Effect.promise(() => exists(held.lockPath))).toBe(true)
        expect(yield* Effect.promise(() => exists(held.ownerPath))).toBe(true)
        expect(yield* Effect.promise(() => readFile(held.lockPath, 'utf8'))).toContain('"bad"')
        yield* Effect.promise(() => rm(NodePath.join(root, '.megarepo'), { recursive: true }))
      }),
    ),
  )

  it.effect('uses the canonical workspace-relative lock path', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* fixture
        const held = yield* acquireWorkspaceUpdateLock({
          workspaceRoot: NodePath.join(root, '.'),
          runtime: { token: () => tokenA },
        })
        expect(held.lockPath).toBe(NodePath.join(root, WORKSPACE_UPDATE_LOCK_PATH))
        yield* releaseWorkspaceUpdateLock({ held })
      }),
    ),
  )
})
