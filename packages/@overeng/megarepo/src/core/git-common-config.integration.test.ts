import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import {
  createStoreWorktree,
  createStoreWorktreeDetached,
  withStoreWorktreeLease,
} from '../store/store-deletion-lease.ts'
import { makeStoreLayer } from '../store/store.ts'
import { syncMember } from '../sync/member.ts'
import * as Git from './git.ts'

process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_SYSTEM = '/dev/null'

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.makeTempDirectoryScoped()
  const source = `${root}/source`
  const store = EffectPath.unsafe.absoluteDir(`${root}/store/`)
  const bare = `${store}example.com/owner/repo/.bare`
  yield* fs.makeDirectory(source)
  yield* Git.runCommand({ cwd: source, args: ['init', '-b', 'main'] })
  yield* Git.runCommand({
    cwd: source,
    args: [
      '-c', 'user.name=Test User', '-c', 'user.email=test@example.com',
      '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'initial',
    ],
  })
  // Use Git directly so refusal tests can also detect accidental writer-lock creation.
  yield* Git.runCommand({ args: ['clone', '--bare', source, bare] })
  const config = (key: string, value: string) =>
    Git.runCommand({ args: ['config', '-f', `${bare}/config`, '--no-includes', key, value] })
  return { fs, root, store, bare, config }
})

describe('common bare config with worktree config', () => {
  for (const value of ['true', 'false', '']) {
    it.effect(`detects the presence of common core.bare=${JSON.stringify(value)}`, () =>
      Effect.gen(function* () {
        const { bare, config } = yield* fixture
        yield* config('extensions.worktreeConfig', 'true')
        yield* config('core.bare', value)
        expect(yield* Git.hasCommonBareWithWorktreeConfig({ repoPath: bare })).toBe(true)
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    )
  }

  it.effect('accepts disabled/missing extension and absent common core.bare', () =>
    Effect.gen(function* () {
      const { bare, config } = yield* fixture
      expect(yield* Git.hasCommonBareWithWorktreeConfig({ repoPath: bare })).toBe(false)
      expect(yield* Git.repairCommonBareWithWorktreeConfig({ repoPath: bare })).toBe(false)
      yield* config('extensions.worktreeConfig', 'false')
      expect(yield* Git.hasCommonBareWithWorktreeConfig({ repoPath: bare })).toBe(false)
      expect(yield* Git.repairCommonBareWithWorktreeConfig({ repoPath: bare })).toBe(false)
      yield* config('extensions.worktreeConfig', 'true')
      yield* Git.runCommand({ args: ['config', '-f', `${bare}/config`, '--unset-all', 'core.bare'] })
      expect(yield* Git.hasCommonBareWithWorktreeConfig({ repoPath: bare })).toBe(false)
      expect(yield* Git.repairCommonBareWithWorktreeConfig({ repoPath: bare })).toBe(false)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('does not follow included extension or core.bare settings', () =>
    Effect.gen(function* () {
      const { fs, root, bare, config } = yield* fixture
      const included = `${root}/included-config`
      yield* fs.writeFileString(included, '[extensions]\nworktreeConfig = true\n')
      yield* config('include.path', included)
      expect(yield* Git.hasCommonBareWithWorktreeConfig({ repoPath: bare })).toBe(false)
      yield* config('extensions.worktreeConfig', 'true')
      yield* Git.runCommand({ args: ['config', '-f', `${bare}/config`, '--unset-all', 'core.bare'] })
      yield* fs.writeFileString(included, '[core]\nbare = true\n')
      expect(yield* Git.hasCommonBareWithWorktreeConfig({ repoPath: bare })).toBe(false)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('refuses member acquisition before fetch, directory or lifecycle lock mutation', () =>
    Effect.gen(function* () {
      const { fs, root, store, bare, config } = yield* fixture
      yield* config('extensions.worktreeConfig', 'true')
      const workspace = EffectPath.unsafe.absoluteDir(`${root}/workspace/`)
      yield* fs.makeDirectory(workspace)
      const before = yield* fs.readDirectory(root, { recursive: true })
      const beforeConfig = yield* fs.readFileString(`${bare}/config`)
      const result = yield* syncMember({
        name: 'member',
        sourceString: 'https://example.com/owner/repo#main',
        megarepoRoot: workspace,
        lockFile: undefined,
        mode: 'fetch',
        dryRun: false,
        force: false,
      }).pipe(Effect.provide(makeStoreLayer({ basePath: store })))
      expect(result.status).toBe('error')
      expect(result.message).toContain('core.bare')
      expect(result.message).toContain('mr store fix')
      expect(yield* fs.readDirectory(root, { recursive: true })).toEqual(before)
      expect(yield* fs.readFileString(`${bare}/config`)).toBe(beforeConfig)
      expect(yield* fs.exists(`${bare}/FETCH_HEAD`)).toBe(false)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('reads the common config when called through a linked worktree', () =>
    Effect.gen(function* () {
      const { root, bare, config } = yield* fixture
      const worktree = `${root}/linked`
      yield* Git.runCommand({ cwd: bare, args: ['worktree', 'add', worktree, 'main'] })
      yield* config('extensions.worktreeConfig', 'true')
      yield* Git.runCommand({
        args: ['config', '-f', `${bare}/worktrees/linked/config.worktree`, 'core.bare', 'false'],
      })
      expect(yield* Git.hasCommonBareWithWorktreeConfig({ repoPath: worktree })).toBe(true)
      expect(yield* Git.repairCommonBareWithWorktreeConfig({ repoPath: worktree })).toBe(true)
      expect(yield* Git.hasCommonBareWithWorktreeConfig({ repoPath: worktree })).toBe(false)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('repairs all common bare entries only, preserving reflog policy and other config', () =>
    Effect.gen(function* () {
      const { fs, bare, config } = yield* fixture
      yield* config('extensions.worktreeConfig', 'true')
      yield* config('core.logAllRefUpdates', 'always')
      yield* config('custom.keep', 'unchanged')
      yield* Git.runCommand({ args: ['config', '-f', `${bare}/config`, '--add', 'core.bare', 'false'] })
      yield* fs.writeFileString(`${bare}/config.worktree`, '[core]\nbare = true\n')
      const worktreeConfig = yield* fs.readFileString(`${bare}/config.worktree`)
      expect(yield* Git.repairCommonBareWithWorktreeConfig({ repoPath: bare })).toBe(true)
      expect(yield* Git.hasCommonBareWithWorktreeConfig({ repoPath: bare })).toBe(false)
      for (const [key, value] of [
        ['core.logAllRefUpdates', 'always'],
        ['custom.keep', 'unchanged'],
        ['extensions.worktreeConfig', 'true'],
      ]) {
        expect(yield* Git.runCommand({ args: ['config', '-f', `${bare}/config`, '--no-includes', '--get', key!] })).toBe(value)
      }
      expect(yield* fs.readFileString(`${bare}/config.worktree`)).toBe(worktreeConfig)
      const repairedConfig = yield* fs.readFileString(`${bare}/config`)
      expect(yield* Git.repairCommonBareWithWorktreeConfig({ repoPath: bare })).toBe(false)
      expect(yield* fs.readFileString(`${bare}/config`)).toBe(repairedConfig)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  for (const operation of ['clone-existing', 'branch', 'detached', 'store-branch', 'store-detached', 'lease'] as const) {
    it.effect(`refuses ${operation} before directory, writer lock, container lock or lease mutation`, () =>
      Effect.gen(function* () {
        const { fs, root, store, bare, config } = yield* fixture
        yield* config('extensions.worktreeConfig', 'true')
        const worktree = `${store}example.com/owner/repo/refs/heads/new/nested`
        const before = yield* fs.readDirectory(root, { recursive: true })
        const beforeConfig = yield* fs.readFileString(`${bare}/config`)
        const branchArgs = { repoPath: bare, worktreePath: worktree, branch: 'new', createBranch: true }
        const detachedArgs = { repoPath: bare, worktreePath: worktree, commit: 'main' }
        const acquire = operation === 'clone-existing'
          ? Git.cloneBare({ url: `${root}/source`, targetPath: bare }).pipe(Effect.asVoid)
          : operation === 'branch'
            ? Git.createWorktree(branchArgs)
          : operation === 'detached'
            ? Git.createWorktreeDetached(detachedArgs)
            : operation === 'store-branch'
              ? createStoreWorktree({ ...branchArgs, storeBasePath: store })
              : operation === 'store-detached'
                ? createStoreWorktreeDetached({ ...detachedArgs, storeBasePath: store })
                : withStoreWorktreeLease({ storeBasePath: store, ownerPath: worktree, bareRepoPath: bare })(
                    fs.makeDirectory(worktree, { recursive: true }),
                  )
        const error = yield* Effect.flip(acquire)
        expect(error).toBeInstanceOf(Git.CommonBareWorktreeConfigError)
        if (error instanceof Git.CommonBareWorktreeConfigError) {
          expect(error.repoPath).toBe(bare)
          expect(error.fixCommand).toBe('mr store fix')
          expect(error.message).toContain('core.bare')
        }
        expect(yield* fs.readDirectory(root, { recursive: true })).toEqual(before)
        expect(yield* fs.readFileString(`${bare}/config`)).toBe(beforeConfig)
        expect(yield* fs.exists(worktree)).toBe(false)
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    )
  }
})
