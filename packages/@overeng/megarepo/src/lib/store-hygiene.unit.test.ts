import { NodeContext } from '@effect/platform-node'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import type { MegarepoConfig } from './config.ts'
import type { LockFile } from './lock.ts'
import type { MegarepoStore } from './store.ts'
import {
  validateStoreMembers,
  runPreflightChecks,
  StoreHygieneError,
} from './store-hygiene.ts'

// =============================================================================
// Test Helpers
// =============================================================================

const makeTestStore = (basePath: AbsoluteDirPath): MegarepoStore => ({
  basePath,
  getRepoBasePath: (source) => {
    if (source.type === 'github') {
      return EffectPath.unsafe.absoluteDir(
        `${basePath}github.com/${source.owner}/${source.repo}/`,
      )
    }
    return EffectPath.unsafe.absoluteDir(`${basePath}other/`)
  },
  getBareRepoPath: (source) => {
    if (source.type === 'github') {
      return EffectPath.unsafe.absoluteDir(
        `${basePath}github.com/${source.owner}/${source.repo}/.bare/`,
      )
    }
    return EffectPath.unsafe.absoluteDir(`${basePath}other/.bare/`)
  },
  getWorktreePath: ({ source, ref }) => {
    if (source.type === 'github') {
      return EffectPath.unsafe.absoluteDir(
        `${basePath}github.com/${source.owner}/${source.repo}/refs/heads/${ref}/`,
      )
    }
    return EffectPath.unsafe.absoluteDir(`${basePath}other/refs/heads/${ref}/`)
  },
  hasBareRepo: () => Effect.succeed(true),
  hasWorktree: () => Effect.succeed(true),
  listRepos: () => Effect.succeed([]),
  listWorktrees: () => Effect.succeed([]),
  getRepoPath: (source) => {
    if (source.type === 'github') {
      return EffectPath.unsafe.absoluteDir(
        `${basePath}github.com/${source.owner}/${source.repo}/`,
      )
    }
    return EffectPath.unsafe.absoluteDir(`${basePath}other/`)
  },
  hasRepo: () => Effect.succeed(true),
})

const makeTestConfig = (members: Record<string, string>): MegarepoConfig =>
  ({ members }) as MegarepoConfig

const makeTestLockFile = (
  members: Record<string, { ref: string; commit: string }>,
): LockFile =>
  ({
    version: 1,
    members: Object.fromEntries(
      Object.entries(members).map(([name, { ref, commit }]) => [
        name,
        {
          url: `https://github.com/owner/${name}`,
          ref,
          commit,
          pinned: false,
          lockedAt: new Date().toISOString(),
        },
      ]),
    ),
  }) as LockFile

const runWithContext = <A, E>(
  effect: Effect.Effect<A, E, NodeContext.NodeContext>,
) => Effect.runPromise(effect.pipe(Effect.provide(NodeContext.layer)))

// =============================================================================
// Tests
// =============================================================================

describe('store-hygiene', () => {
  describe('validateStoreMembers', () => {
    it('returns empty array when no remote members', () =>
      runWithContext(
        Effect.gen(function* () {
          const store = makeTestStore(EffectPath.unsafe.absoluteDir('/tmp/test-store/'))
          const config = makeTestConfig({ local: './path/to/repo' })
          const lockFile = makeTestLockFile({})

          const issues = yield* validateStoreMembers({
            memberNames: ['local'],
            config,
            lockFile,
            store,
          })

          expect(issues).toEqual([])
        }),
      ),
    )

    it('returns empty array when member not in lock file', () =>
      runWithContext(
        Effect.gen(function* () {
          const store = makeTestStore(EffectPath.unsafe.absoluteDir('/tmp/test-store/'))
          const config = makeTestConfig({ myrepo: 'owner/myrepo#main' })
          const lockFile = makeTestLockFile({})

          const issues = yield* validateStoreMembers({
            memberNames: ['myrepo'],
            config,
            lockFile,
            store,
          })

          expect(issues).toEqual([])
        }),
      ),
    )

    it('reports missing_bare when bare repo does not exist', () =>
      runWithContext(
        Effect.gen(function* () {
          const store = makeTestStore(
            EffectPath.unsafe.absoluteDir('/tmp/nonexistent-test-store-xyz/'),
          )
          const config = makeTestConfig({ myrepo: 'owner/myrepo#main' })
          const lockFile = makeTestLockFile({
            myrepo: { ref: 'main', commit: 'a'.repeat(40) },
          })

          const issues = yield* validateStoreMembers({
            memberNames: ['myrepo'],
            config,
            lockFile,
            store,
          })

          expect(issues.length).toBe(1)
          expect(issues[0]!.type).toBe('missing_bare')
          expect(issues[0]!.severity).toBe('error')
          expect(issues[0]!.memberName).toBe('myrepo')
        }),
      ),
    )

    it('skips members not in memberNames', () =>
      runWithContext(
        Effect.gen(function* () {
          const store = makeTestStore(
            EffectPath.unsafe.absoluteDir('/tmp/nonexistent-test-store-xyz/'),
          )
          const config = makeTestConfig({
            myrepo: 'owner/myrepo#main',
            other: 'owner/other#main',
          })
          const lockFile = makeTestLockFile({
            myrepo: { ref: 'main', commit: 'a'.repeat(40) },
            other: { ref: 'main', commit: 'b'.repeat(40) },
          })

          const issues = yield* validateStoreMembers({
            memberNames: ['myrepo'],
            config,
            lockFile,
            store,
          })

          expect(issues.every((i) => i.memberName === 'myrepo')).toBe(true)
        }),
      ),
    )

    it('skips local path members', () =>
      runWithContext(
        Effect.gen(function* () {
          const store = makeTestStore(EffectPath.unsafe.absoluteDir('/tmp/test-store/'))
          const config = makeTestConfig({ local: '../some/path' })
          const lockFile = makeTestLockFile({})

          const issues = yield* validateStoreMembers({
            memberNames: ['local'],
            config,
            lockFile,
            store,
          })

          expect(issues).toEqual([])
        }),
      ),
    )

    it('reports missing_bare with fix suggestion and metadata', () =>
      runWithContext(
        Effect.gen(function* () {
          const store = makeTestStore(
            EffectPath.unsafe.absoluteDir('/tmp/nonexistent-test-store-xyz/'),
          )
          const config = makeTestConfig({ myrepo: 'owner/myrepo#main' })
          const lockFile = makeTestLockFile({
            myrepo: { ref: 'main', commit: 'a'.repeat(40) },
          })

          const issues = yield* validateStoreMembers({
            memberNames: ['myrepo'],
            config,
            lockFile,
            store,
          })

          expect(issues[0]!.fix).toBeDefined()
          expect(issues[0]!.meta?._tag).toBe('missing_bare')
        }),
      ),
    )
  })

  describe('runPreflightChecks', () => {
    it('succeeds when no issues', () =>
      runWithContext(
        runPreflightChecks({
          memberNames: ['local'],
          config: makeTestConfig({ local: './path' }),
          lockFile: makeTestLockFile({}),
          store: makeTestStore(EffectPath.unsafe.absoluteDir('/tmp/test-store/')),
        }),
      ),
    )

    it('fails with StoreHygieneError on error-severity issues', () =>
      runWithContext(
        Effect.gen(function* () {
          const result = yield* Effect.flip(runPreflightChecks({
            memberNames: ['myrepo'],
            config: makeTestConfig({ myrepo: 'owner/myrepo#main' }),
            lockFile: makeTestLockFile({
              myrepo: { ref: 'main', commit: 'a'.repeat(40) },
            }),
            store: makeTestStore(
              EffectPath.unsafe.absoluteDir('/tmp/nonexistent-test-store-xyz/'),
            ),
          }))

          expect(result).toBeInstanceOf(StoreHygieneError)
          if (result instanceof StoreHygieneError) {
            expect(result._tag).toBe('StoreHygieneError')
            expect(result.issues.length).toBeGreaterThan(0)
            expect(result.issues[0]!.memberName).toBe('myrepo')
          }
        }),
      ),
    )

    it('succeeds in non-strict mode even with errors', () =>
      runWithContext(
        runPreflightChecks({
          memberNames: ['myrepo'],
          config: makeTestConfig({ myrepo: 'owner/myrepo#main' }),
          lockFile: makeTestLockFile({
            myrepo: { ref: 'main', commit: 'a'.repeat(40) },
          }),
          store: makeTestStore(
            EffectPath.unsafe.absoluteDir('/tmp/nonexistent-test-store-xyz/'),
          ),
          strict: false,
        }),
      ),
    )

    it('includes actionable error messages', () =>
      runWithContext(
        Effect.gen(function* () {
          const result = yield* Effect.flip(runPreflightChecks({
            memberNames: ['myrepo'],
            config: makeTestConfig({ myrepo: 'owner/myrepo#main' }),
            lockFile: makeTestLockFile({
              myrepo: { ref: 'main', commit: 'a'.repeat(40) },
            }),
            store: makeTestStore(
              EffectPath.unsafe.absoluteDir('/tmp/nonexistent-test-store-xyz/'),
            ),
          }))

          expect(result).toBeInstanceOf(StoreHygieneError)
          if (result instanceof StoreHygieneError) {
            expect(result.message).toContain('Store hygiene check failed')
          }
        }),
      ),
    )
  })
})
