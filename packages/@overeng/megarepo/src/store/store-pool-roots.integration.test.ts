import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Cause, Effect, Exit } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'
import { Vitest } from '@overeng/utils-dev/node-vitest'

import * as Git from '../core/git.ts'
import { warmPoolRoot } from './store-pool-roots.ts'
import { reserveFreshPoolRoot, withPoolState } from './store-pool-state.ts'

const withTestCtx = Vitest.makeWithTestCtx({ makeLayer: () => NodeServices.layer })
// Invalid config is intentional: every case must refuse BEFORE calling any holder client.
const client = { path: '/not-a-holder-client', producerId: 'invalid', policyId: 'invalid' }
const limits = { maxSlots: 1, maxBytes: 1024 }
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
  const base = EffectPath.unsafe.absoluteDir(`${root}/store/`)
  const bare = `${base}example.test/owner/repo/.bare`
  yield* fs.makeDirectory(bare, { recursive: true })
  yield* Git.runCommand({ cwd: bare, args: ['init', '--bare'] })
  const tree = yield* Git.runCommand({ cwd: bare, args: ['write-tree'] })
  const commit = yield* Git.runCommand({ cwd: bare, args: ['-c', 'user.name=Pool Test', '-c', 'user.email=pool@example.test',
    'commit-tree', tree, '-m', 'Real empty source'] })
  return { fs, base, bare, commit }
})

describe('native pool prewarm admission (not warm runtime qualification)', () => {
  it.effect('requires an exact local commit, never resolving a branch into a reservation', (test) =>
    Effect.gen(function* () {
      const { fs, base, bare, commit } = yield* fixture
      yield* Git.runCommand({ cwd: bare, args: ['update-ref', 'refs/heads/source', commit] })
      const result = yield* Effect.exit(warmPoolRoot({ base, bare, commit: 'refs/heads/source', limits, client, prewarmTasks: [] }))
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain('Exact canonical local source')
      expect(yield* fs.exists(`${base}.state/pool/state.json`)).toBe(false)
      expect(yield* fs.exists(`${bare}/../pool`)).toBe(false)
    }).pipe(withTestCtx(test)),
  )

  it.effect('does not admit a bare outside the canonical store', (test) =>
    Effect.gen(function* () {
      const { fs, base, bare, commit } = yield* fixture
      const unrelated = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
      const result = yield* Effect.exit(warmPoolRoot({ base: unrelated, bare, commit, limits, client, prewarmTasks: [] }))
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain('Exact canonical local source')
      expect(yield* fs.readDirectory(unrelated)).toEqual([])
      expect(yield* fs.exists(`${base}.state`)).toBe(false)
    }).pipe(withTestCtx(test)),
  )

  it.effect('rejects task arguments that could override the root-owned task invocation', (test) =>
    Effect.gen(function* () {
      const { fs, base, bare, commit } = yield* fixture
      for (const task of ['--config', '', 'pnpm:install --mode single']) {
        const result = yield* Effect.exit(warmPoolRoot({ base, bare, commit, limits, client, prewarmTasks: [task] }))
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain('Exact canonical local source')
      }
      expect(yield* fs.exists(`${base}.state`)).toBe(false)
    }).pipe(withTestCtx(test)),
  )

  it.effect('refuses an existing symlink parent without chmod, reservation or adoption', (test) =>
    Effect.gen(function* () {
      const { fs, base, bare, commit } = yield* fixture
      const destination = yield* fs.makeTempDirectoryScoped()
      const parent = `${bare}/../pool`
      yield* fs.symlink(destination, parent)
      const before = yield* fs.stat(destination)
      const result = yield* Effect.exit(warmPoolRoot({ base, bare, commit, limits, client, prewarmTasks: [] }))
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain('Pool parent is not private and canonical')
      expect((yield* fs.lstat(parent)).type).toBe('SymbolicLink')
      expect((yield* fs.stat(destination)).mode).toBe(before.mode)
      expect(yield* fs.readDirectory(destination)).toEqual([])
      expect(yield* fs.exists(`${base}.state/pool/state.json`)).toBe(false)
    }).pipe(withTestCtx(test)),
  )

  it.effect('retains unknown accounting and refuses allocation before native birth', (test) =>
    Effect.gen(function* () {
      const { fs, base, bare, commit } = yield* fixture
      // Synthetic ledger uncertainty, not a runtime holder or installed-root fixture.
      const retained = yield* withPoolState({ base, limits, use: (state, save) => Effect.gen(function* () {
        const reservation = yield* reserveFreshPoolRoot({ state, bare, commit, charge: 1 })
        yield* save({ ...reservation.state, slots: [{ ...reservation.slot, chargeKnown: false }] })
        return reservation.slot
      }) })
      const ledger = `${base}.state/pool/state.json`
      const before = yield* fs.readFileString(ledger)
      const result = yield* Effect.exit(warmPoolRoot({ base, bare, commit, limits, client, prewarmTasks: [] }))
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain('retained bytes are unknown')
      expect(yield* fs.readFileString(ledger)).toBe(before)
      expect(yield* fs.exists(retained.path)).toBe(false)
      expect(yield* fs.readDirectory(`${bare}/../pool`)).toEqual([])
    }).pipe(withTestCtx(test)),
  )

  it.effect('uses the canonical Git accessor for a real detached locked linked admin', (test) =>
    Effect.gen(function* () {
      const { fs, bare, commit } = yield* fixture
      const worktree = `${yield* fs.realPath(yield* fs.makeTempDirectoryScoped())}/detached`
      yield* Git.createWorktreeDetached({ repoPath: bare, worktreePath: worktree, commit, lockReason: 'pool-boundary-test' })
      const admin = yield* Git.getAbsoluteGitDir(worktree)
      expect(admin.startsWith(`${yield* fs.realPath(bare)}/worktrees/`)).toBe(true)
      expect((yield* fs.readFileString(`${admin}/gitdir`)).trim()).toBe(`${worktree}/.git`)
      expect((yield* fs.readFileString(`${admin}/HEAD`)).trim()).toBe(commit)
      expect((yield* fs.readFileString(`${admin}/locked`)).trim()).toBe('pool-boundary-test')
    }).pipe(withTestCtx(test)),
  )
})
