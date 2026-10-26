import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type { Path } from 'effect/Path'
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'
import type { Scope } from 'effect/Scope'
import { expect } from 'vitest'

import * as Git from '../core/git.ts'
import { createStoreFixture, createWorkspaceWithLock } from '../test-utils/store-setup.ts'
import { refreshWorkspaceRegistry } from './store-liveness.ts'
import { removeStoreWorktree } from './store-worktree-remove.ts'
import { makeStoreLayer, Store } from './store.ts'

const key = 'example.com/acme/widget'
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const result = yield* createStoreFixture([
    { host: 'example.com', owner: 'acme', repo: 'widget', branches: ['sibling'], withRemote: true },
  ])
  const store = yield* Store.pipe(Effect.provide(makeStoreLayer({ basePath: result.storePath })))
  const path = `${store.basePath}${key}/refs/heads/topic`
  const bare = result.bareRepoPaths[key]!
  const sibling = result.worktreePaths[`${key}#sibling`]!
  // Exercise the production creation helper used by `mr store worktree new`.
  yield* Git.createWorktree({
    repoPath: bare,
    worktreePath: path,
    branch: 'topic',
    createBranch: true,
    startPoint: 'origin/sibling',
  })
  yield* Git.runCommand({ cwd: sibling, args: ['switch', '-c', 'sibling', 'origin/sibling'] })
  const admin = (yield* fs.readFileString(`${path}/.git`)).trim().slice('gitdir: '.length)
  return { fs, store, path, bare, sibling, admin }
})
const testEffect = <TValue, TError>(
  effect: Effect.Effect<TValue, TError, FileSystem.FileSystem | ChildProcessSpawner | Path | Scope>,
) => effect.pipe(Effect.provide(NodeServices.layer), Effect.scoped)
// CI=1 chooses real Git fixtures rather than the developer's global store.
describe('scoped store worktree removal', () => {
  it.effect.skipIf(process.getuid?.() === 0)(
    'proves plain Git EACCES deletes its admin entry while materialized payload remains',
    () =>
      testEffect(
        Effect.gen(function* () {
          const f = yield* fixture
          const snapshot = `${f.path}/packages/.editor-view/.store/snapshot`
          yield* f.fs.makeDirectory(snapshot, { recursive: true })
          yield* f.fs.writeFileString(`${snapshot}/payload`, 'readonly materialization')
          yield* f.fs.writeFileString(`${f.bare}/info/exclude`, 'packages/.editor-view/\n')
          yield* f.fs.chmod(snapshot, 0o555)
          yield* Effect.addFinalizer(() => f.fs.chmod(snapshot, 0o755).pipe(Effect.ignore))
          const failure = yield* Git.runCommand({
            cwd: f.bare,
            args: ['worktree', 'remove', '--', f.path],
          }).pipe(Effect.flip)
          expect(String(failure)).toContain('Permission denied')
          expect(yield* f.fs.exists(f.path)).toBe(true)
          const hasMarker = yield* f.fs.exists(`${f.path}/.git`)
          expect(yield* f.fs.exists(`${snapshot}/payload`)).toBe(true)
          expect(yield* f.fs.exists(f.admin)).toBe(false)
          expect(yield* removeStoreWorktree(f).pipe(Effect.flip)).toMatchObject({
            reason: hasMarker === true ? 'teardown-required' : 'invalid-path',
          })
          // Simulate the successful owner's release: only a temp fixture is touched.
          yield* f.fs.chmod(snapshot, 0o755)
          yield* f.fs.remove(`${f.path}/packages`, { recursive: true })
          if (hasMarker === true) {
            // Git's traversal order determines whether tracked files were already
            // unlinked. Exercise that destructive partial state deterministically.
            if ((yield* f.fs.exists(`${f.path}/README.md`)) === true)
              yield* f.fs.remove(`${f.path}/README.md`)
            expect(yield* removeStoreWorktree(f).pipe(Effect.flip)).toMatchObject({
              reason: 'dirty',
            })
            yield* removeStoreWorktree({ ...f, discardChanges: true })
            expect(yield* f.fs.exists(f.path)).toBe(false)
          } else {
            const refused = yield* removeStoreWorktree({ ...f, discardChanges: true }).pipe(
              Effect.flip,
            )
            expect(refused).toMatchObject({ reason: 'invalid-path' })
            expect(String(refused)).toContain('Cannot prove worktree ownership')
            expect(yield* f.fs.exists(f.path)).toBe(true)
          }
        }),
      ),
  )

  it.effect('removes a torn-down worktree without changing sibling worktrees or refs', () =>
    testEffect(
      Effect.gen(function* () {
        const f = yield* fixture
        const refs = yield* Git.runCommand({ cwd: f.bare, args: ['show-ref'] })
        const sibling = yield* Git.getCurrentCommit(f.sibling)
        // Explicit release retains the persistent lease controls, not payloads.
        yield* f.fs.makeDirectory(`${f.path}/packages/.editor-view/.leases`, { recursive: true })
        yield* f.fs.writeFileString(`${f.bare}/info/exclude`, 'packages/.editor-view/\n')
        yield* removeStoreWorktree(f)
        expect(yield* f.fs.exists(f.path)).toBe(false)
        expect(yield* f.fs.exists(f.admin)).toBe(false)
        expect(yield* Git.runCommand({ cwd: f.bare, args: ['show-ref'] })).toBe(refs)
        expect(yield* Git.getCurrentCommit(f.sibling)).toBe(sibling)
        const again = yield* removeStoreWorktree(f).pipe(Effect.flip)
        expect(again).toMatchObject({ _tag: 'StoreWorktreeRemoveError', reason: 'not-found' })
      }),
    ),
  )

  it.effect(
    'refuses unreleased editor views with exact teardown guidance and no permission changes',
    () =>
      testEffect(
        Effect.gen(function* () {
          const f = yield* fixture
          const snapshot = `${f.path}/packages/.editor-view/.store/topic-snapshot`
          yield* f.fs.makeDirectory(snapshot, { recursive: true })
          yield* f.fs.writeFileString(`${snapshot}/payload`, 'shared payload')
          yield* f.fs.chmod(`${snapshot}/payload`, 0o444)
          yield* f.fs.chmod(snapshot, 0o555)
          yield* Effect.addFinalizer(() => f.fs.chmod(snapshot, 0o755).pipe(Effect.ignore))
          const failure = yield* removeStoreWorktree(f).pipe(Effect.flip)
          expect(failure).toMatchObject({
            _tag: 'StoreWorktreeRemoveError',
            reason: 'teardown-required',
          })
          expect(String(failure)).toContain('devenv tasks run worktree:teardown --mode single')
          expect((yield* f.fs.stat(snapshot)).mode & 0o777).toBe(0o555)
          expect((yield* f.fs.stat(`${snapshot}/payload`)).mode & 0o777).toBe(0o444)
          expect(yield* f.fs.exists(f.admin)).toBe(true)
        }),
      ),
  )

  it.effect('refuses dirty worktrees and permits explicit discard without --force', () =>
    testEffect(
      Effect.gen(function* () {
        const f = yield* fixture
        yield* f.fs.writeFileString(`${f.path}/untracked`, 'keep me')
        expect(yield* removeStoreWorktree(f).pipe(Effect.flip)).toMatchObject({ reason: 'dirty' })
        expect(yield* f.fs.readFileString(`${f.path}/untracked`)).toBe('keep me')
        yield* removeStoreWorktree({ ...f, discardChanges: true })
        expect(yield* f.fs.exists(f.path)).toBe(false)
      }),
    ),
  )

  it.effect('repairs a missing admin entry without changing refs', () =>
    testEffect(
      Effect.gen(function* () {
        const f = yield* fixture
        const refs = yield* Git.runCommand({ cwd: f.bare, args: ['show-ref'] })
        yield* f.fs.remove(f.admin, { recursive: true })
        expect(yield* removeStoreWorktree(f)).toMatchObject({ repaired: true })
        expect(yield* f.fs.exists(f.path)).toBe(false)
        expect(yield* Git.runCommand({ cwd: f.bare, args: ['show-ref'] })).toBe(refs)
      }),
    ),
  )

  it.effect(
    'refuses an empty symlinked administration root before orphan reconstruction writes',
    () =>
      testEffect(
        Effect.gen(function* () {
          const f = yield* fixture
          const adminRoot = `${f.bare}worktrees`
          const outside = yield* f.fs.makeTempDirectoryScoped()
          yield* f.fs.remove(f.admin, { recursive: true })
          yield* f.fs.rename(adminRoot, `${adminRoot}.saved`)
          yield* f.fs.symlink(outside, adminRoot)
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              yield* f.fs.remove(adminRoot)
              yield* f.fs.rename(`${adminRoot}.saved`, adminRoot)
            }).pipe(Effect.orDie),
          )
          const failure = yield* removeStoreWorktree(f).pipe(Effect.flip)
          expect(failure).toMatchObject({ reason: 'invalid-path' })
          expect(String(failure)).toContain('must be physical and not a symlink')
          expect(yield* f.fs.readDirectory(outside)).toEqual([])
          expect(yield* f.fs.exists(`${f.path}/.git`)).toBe(true)
        }),
      ),
  )

  it.effect(
    'repairs a proven orphan with missing nested parents and returns not-found on retry',
    () =>
      testEffect(
        Effect.gen(function* () {
          const f = yield* fixture
          const path = f.path.replace(/\/topic$/u, '/feature/topic')
          yield* Git.createWorktree({
            repoPath: f.bare,
            worktreePath: path,
            branch: 'feature/topic',
            createBranch: true,
            startPoint: 'origin/sibling',
          })
          const admin = (yield* f.fs.readFileString(`${path}/.git`)).trim().slice('gitdir: '.length)
          const refs = yield* Git.runCommand({ cwd: f.bare, args: ['show-ref'] })
          yield* f.fs.remove(path.replace(/\/topic$/u, ''), { recursive: true })
          expect(yield* removeStoreWorktree({ store: f.store, path })).toMatchObject({
            repaired: true,
          })
          expect(yield* f.fs.exists(admin)).toBe(false)
          expect(yield* f.fs.exists(f.admin)).toBe(true)
          expect(yield* Git.runCommand({ cwd: f.bare, args: ['show-ref'] })).toBe(refs)
          expect(
            yield* removeStoreWorktree({ store: f.store, path }).pipe(Effect.flip),
          ).toMatchObject({ reason: 'not-found' })
        }),
      ),
  )

  it.effect('never reconstructs markerless remnants even with destructive consent', () =>
    testEffect(
      Effect.gen(function* () {
        const f = yield* fixture
        yield* f.fs.remove(f.admin, { recursive: true })
        yield* f.fs.remove(`${f.path}/.git`)
        const failure = yield* removeStoreWorktree({
          ...f,
          discardChanges: true,
          allowUnpushed: true,
        }).pipe(Effect.flip)
        expect(failure).toMatchObject({ reason: 'invalid-path', path: f.path })
        expect(String(failure)).toContain('Cannot prove worktree ownership')
        expect(String(failure)).toContain('Editor-view GC or release')
        expect(yield* f.fs.exists(f.path)).toBe(true)
        expect(yield* f.fs.exists(f.admin)).toBe(false)
      }),
    ),
  )

  it.effect(
    'prunes only the matching orphan admin entry, leaving another missing entry untouched',
    () =>
      testEffect(
        Effect.gen(function* () {
          const f = yield* fixture
          const siblingAdmin = (yield* f.fs.readFileString(`${f.sibling}/.git`))
            .trim()
            .slice('gitdir: '.length)
          yield* f.fs.remove(f.path, { recursive: true })
          yield* f.fs.remove(f.sibling, { recursive: true })
          expect(yield* removeStoreWorktree(f)).toMatchObject({ repaired: true })
          expect(yield* f.fs.exists(f.admin)).toBe(false)
          expect(yield* f.fs.exists(siblingAdmin)).toBe(true)
        }),
      ),
  )

  it.effect('retains an orphan index containing staged changes until discard is explicit', () =>
    testEffect(
      Effect.gen(function* () {
        const f = yield* fixture
        yield* f.fs.writeFileString(`${f.path}/staged`, 'only in the index')
        yield* Git.runCommand({ cwd: f.path, args: ['add', 'staged'] })
        yield* f.fs.remove(f.path, { recursive: true })
        expect(yield* removeStoreWorktree(f).pipe(Effect.flip)).toMatchObject({ reason: 'dirty' })
        expect(yield* f.fs.exists(f.admin)).toBe(true)
        yield* removeStoreWorktree({ ...f, discardChanges: true })
        expect(yield* f.fs.exists(f.admin)).toBe(false)
      }),
    ),
  )

  it.effect('protects canonical main even with destructive consent flags', () =>
    testEffect(
      Effect.gen(function* () {
        const f = yield* fixture
        const path = `${f.store.basePath}${key}/refs/heads/main`
        expect(
          yield* removeStoreWorktree({
            store: f.store,
            path,
            discardChanges: true,
            allowUnpushed: true,
          }).pipe(Effect.flip),
        ).toMatchObject({ reason: 'protected' })
      }),
    ),
  )

  it.effect('protects worktrees referenced by registered workspaces', () =>
    testEffect(
      Effect.gen(function* () {
        const f = yield* fixture
        const { workspacePath } = yield* createWorkspaceWithLock({
          members: { widget: 'https://example.com/acme/widget#topic' },
        })
        yield* f.fs.makeDirectory(`${workspacePath}repos`, { recursive: true })
        yield* f.fs.symlink(f.path, `${workspacePath}repos/widget`)
        yield* refreshWorkspaceRegistry({
          workspaceRoot: workspacePath,
          store: f.store,
          now: Date.now(),
        })
        expect(yield* removeStoreWorktree(f).pipe(Effect.flip)).toMatchObject({
          reason: 'protected',
        })
        expect(yield* f.fs.exists(f.path)).toBe(true)
      }),
    ),
  )

  it.effect('protects explicitly locked registrations', () =>
    testEffect(
      Effect.gen(function* () {
        const f = yield* fixture
        yield* f.fs.writeFileString(`${f.admin}/locked`, 'in use')
        expect(yield* removeStoreWorktree(f).pipe(Effect.flip)).toMatchObject({
          reason: 'protected',
        })
        expect(yield* f.fs.exists(f.path)).toBe(true)
      }),
    ),
  )

  it.effect('refuses unpushed commits unless explicitly allowed, preserving the branch ref', () =>
    testEffect(
      Effect.gen(function* () {
        const f = yield* fixture
        yield* Git.runCommand({
          cwd: f.path,
          args: [
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.com',
            '-c',
            'commit.gpgsign=false',
            'commit',
            '--no-verify',
            '--allow-empty',
            '-m',
            'local only',
          ],
        })
        const commit = yield* Git.getCurrentCommit(f.path)
        expect(yield* removeStoreWorktree(f).pipe(Effect.flip)).toMatchObject({
          reason: 'unpushed',
        })
        yield* removeStoreWorktree({ ...f, allowUnpushed: true })
        expect(
          yield* Git.runCommand({ cwd: f.bare, args: ['rev-parse', 'refs/heads/topic'] }),
        ).toBe(commit)
      }),
    ),
  )

  it.effect('does not follow an external symlink while removing its worktree', () =>
    testEffect(
      Effect.gen(function* () {
        const f = yield* fixture
        const outside = yield* f.fs.makeTempDirectoryScoped()
        yield* f.fs.writeFileString(`${outside}/sentinel`, 'outside')
        yield* f.fs.chmod(outside, 0o555)
        yield* Effect.addFinalizer(() => f.fs.chmod(outside, 0o755).pipe(Effect.ignore))
        yield* f.fs.symlink(outside, `${f.path}/external`)
        yield* f.fs.writeFileString(`${f.bare}/info/exclude`, 'external\n')
        yield* removeStoreWorktree(f)
        expect(yield* f.fs.readFileString(`${outside}/sentinel`)).toBe('outside')
        expect((yield* f.fs.stat(outside)).mode & 0o777).toBe(0o555)
      }),
    ),
  )
})
