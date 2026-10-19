import { dirname, join } from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import {
  discoverBuckMaintainWorktrees,
  readBuckMaintainGitEvidence,
  readBuckMaintainOutputActivity,
} from './store-buck-maintain-evidence.ts'

const old = new Date('2020-01-01T00:00:00Z')
const recent = new Date('2026-10-19T00:00:00Z')

const makeGitWorktree = Effect.fn('test.makeGitWorktree')(function* (worktree: string) {
  const fs = yield* FileSystem.FileSystem
  const gitDir = join(worktree, '.git')
  yield* fs.makeDirectory(join(gitDir, 'logs'), { recursive: true })
  for (const name of ['HEAD', 'index', 'logs/HEAD']) {
    yield* fs.writeFileString(join(gitDir, name), 'fixture')
    yield* fs.utimes(join(gitDir, name), old, old)
  }
  return gitDir
})

const makeOutput = Effect.fn('test.makeOutput')(function* ({
  worktree,
  isolation,
}: {
  worktree: string
  isolation: string
}) {
  const fs = yield* FileSystem.FileSystem
  const base = join(worktree, 'buck-out', isolation)
  for (const name of ['log', 'daemon']) {
    const directory = join(base, name)
    yield* fs.makeDirectory(directory, { recursive: true })
    yield* fs.writeFileString(join(directory, 'state'), 'fixture')
    yield* fs.utimes(join(directory, 'state'), old, old)
    yield* fs.utimes(directory, old, old)
  }
  return base
})

it.live('discovers slash refs but rejects descendant links, archives, and nested worktrees', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const temp = yield* fs.makeTempDirectoryScoped()
    const root = join(temp, 'roots')
    const branch = join(root, 'refs/heads/owner/branch')
    const other = join(root, 'refs/heads/other')
    for (const path of [
      branch,
      other,
      join(branch, 'nested'),
      join(root, '.archive/old'),
      join(temp, 'outside'),
    ]) {
      yield* makeGitWorktree(path)
    }
    yield* fs.symlink(join(temp, 'outside'), join(root, 'escape'))
    yield* fs.symlink(join(root, 'refs'), join(root, 'alias'))
    yield* fs.symlink(join(root, 'refs/heads'), join(root, 'refs/heads/loop'))
    const configuredLink = join(temp, 'configured-link')
    yield* fs.symlink(root, configuredLink)
    expect(yield* discoverBuckMaintainWorktrees([configuredLink, root])).toEqual(
      [branch, other].toSorted(),
    )
    expect(yield* fs.exists(join(temp, 'outside/.git/HEAD'))).toBe(true)
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.live('requires all three readable Git activity files, including index and logs/HEAD', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const temp = yield* fs.makeTempDirectoryScoped()
    const complete = join(temp, 'complete')
    yield* makeGitWorktree(complete)
    expect(yield* readBuckMaintainGitEvidence(complete)).toEqual({
      locked: false,
      lastActivityMs: old.getTime(),
    })
    for (const missing of ['HEAD', 'index', 'logs/HEAD']) {
      const worktree = join(temp, missing.replaceAll('/', '-'))
      const gitDir = yield* makeGitWorktree(worktree)
      yield* fs.remove(join(gitDir, missing))
      expect((yield* readBuckMaintainGitEvidence(worktree)).lastActivityMs).toBeUndefined()
    }
    expect(yield* readBuckMaintainGitEvidence(join(temp, 'missing'))).toEqual({
      locked: undefined,
      lastActivityMs: undefined,
    })
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.live('vetoes stale lock files recursively and every Git operation state', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const temp = yield* fs.makeTempDirectoryScoped()
    const markers = [
      'locked',
      'index.lock',
      'HEAD.lock',
      'refs/heads/topic.lock',
      'custom/nested/other.lock',
      'MERGE_HEAD',
      'rebase-apply',
      'rebase-merge',
      'REBASE_HEAD',
      'CHERRY_PICK_HEAD',
      'BISECT_LOG',
      'BISECT_START',
      'BISECT_NAMES',
      'BISECT_EXPECTED_REV',
      'REVERT_HEAD',
      'sequencer',
      'BISECT_TERMS',
      'BISECT_CUSTOM',
      'REBASE_CUSTOM',
      'CHERRY_PICK_CUSTOM',
    ]
    for (const [index, marker] of markers.entries()) {
      const worktree = join(temp, String(index))
      const gitDir = yield* makeGitWorktree(worktree)
      const path = join(gitDir, marker)
      yield* fs.makeDirectory(dirname(path), { recursive: true })
      if (['rebase-apply', 'rebase-merge', 'sequencer'].includes(marker) === true) {
        yield* fs.makeDirectory(path)
      } else yield* fs.writeFileString(path, 'stale')
      yield* fs.utimes(path, old, old)
      expect((yield* readBuckMaintainGitEvidence(worktree)).locked).toBe(true)
      expect(yield* fs.exists(path)).toBe(true)
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.live('resolves linked gitdirs and relative common directories for shared ref locks', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const temp = yield* fs.makeTempDirectoryScoped()
    const adminOwner = join(temp, 'admin-owner')
    const gitDir = yield* makeGitWorktree(adminOwner)
    const worktree = join(temp, 'linked')
    yield* fs.makeDirectory(worktree)
    yield* fs.writeFileString(join(worktree, '.git'), 'gitdir: ../admin-owner/.git\n')
    const common = join(temp, 'common')
    yield* fs.makeDirectory(join(common, 'refs/heads'), { recursive: true })
    yield* fs.writeFileString(join(gitDir, 'commondir'), '../../common\n')
    expect((yield* readBuckMaintainGitEvidence(worktree)).locked).toBe(false)
    const sharedLock = join(common, 'refs/heads/topic.lock')
    yield* fs.writeFileString(sharedLock, '')
    expect((yield* readBuckMaintainGitEvidence(worktree)).locked).toBe(true)
    expect(yield* fs.exists(sharedLock)).toBe(true)
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.live('keeps failed lock scans and unresolved common directories unknown', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const temp = yield* fs.makeTempDirectoryScoped()
    const gitDir = yield* makeGitWorktree(temp)
    yield* fs.writeFileString(join(gitDir, 'commondir'), '../missing')
    expect((yield* readBuckMaintainGitEvidence(temp)).locked).toBeUndefined()
    yield* fs.remove(join(gitDir, 'commondir'))
    yield* fs.symlink(join(temp, 'missing'), join(gitDir, 'unreadable-subtree'))
    expect((yield* readBuckMaintainGitEvidence(temp)).locked).toBeUndefined()
    yield* fs.writeFileString(join(gitDir, 'index.lock'), '')
    expect((yield* readBuckMaintainGitEvidence(temp)).locked).toBe(true)
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.live(
  'uses recent exited-daemon state and directory activity rather than only old event logs',
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const temp = yield* fs.makeTempDirectoryScoped()
      const first = yield* makeOutput({ worktree: temp, isolation: 'first' })
      const second = yield* makeOutput({ worktree: temp, isolation: 'second' })
      expect(yield* readBuckMaintainOutputActivity(temp)).toBe(old.getTime())
      yield* fs.utimes(join(second, 'daemon/state'), recent, recent)
      expect(yield* readBuckMaintainOutputActivity(temp)).toBe(recent.getTime())
      yield* fs.utimes(join(second, 'daemon/state'), old, old)
      // A recently removed daemon pid/state file leaves activity in the directory itself.
      yield* fs.remove(join(first, 'daemon/state'))
      yield* fs.utimes(join(first, 'daemon'), recent, recent)
      expect(yield* readBuckMaintainOutputActivity(temp)).toBe(recent.getTime())
      yield* fs.utimes(join(first, 'daemon'), old, old)
      yield* fs.makeDirectory(join(first, 'log/nested'))
      yield* fs.writeFileString(join(first, 'log/nested/event'), 'event')
      yield* fs.utimes(join(first, 'log/nested/event'), recent, recent)
      yield* fs.utimes(join(first, 'log/nested'), old, old)
      yield* fs.utimes(join(first, 'log'), old, old)
      expect(yield* readBuckMaintainOutputActivity(temp)).toBe(recent.getTime())
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.live('missing output, isolation logs, or daemon state cannot prove inactivity', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const temp = yield* fs.makeTempDirectoryScoped()
    expect(yield* readBuckMaintainOutputActivity(temp)).toBeUndefined()
    yield* fs.makeDirectory(join(temp, 'buck-out'))
    expect(yield* readBuckMaintainOutputActivity(temp)).toBeUndefined()
    for (const missing of ['log', 'daemon']) {
      const worktree = join(temp, missing)
      const base = yield* makeOutput({ worktree, isolation: 'test' })
      yield* fs.remove(join(base, missing), { recursive: true })
      expect(yield* readBuckMaintainOutputActivity(worktree)).toBeUndefined()
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.live('unknown Git or output timestamps remain unknown even when other evidence is old', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const temp = yield* fs.makeTempDirectoryScoped()
    const gitDir = yield* makeGitWorktree(temp)
    const output = yield* makeOutput({ worktree: temp, isolation: 'test' })
    for (const missingMtime of [
      join(gitDir, 'HEAD'),
      join(gitDir, 'index'),
      join(gitDir, 'logs/HEAD'),
      join(output, 'log/state'),
      join(output, 'daemon'),
      join(output, 'daemon/state'),
    ]) {
      const unknownMtime: FileSystem.FileSystem = {
        ...fs,
        stat: (path) =>
          fs
            .stat(path)
            .pipe(
              Effect.map((info) =>
                path === missingMtime ? { ...info, mtime: Option.none() } : info,
              ),
            ),
      }
      if (missingMtime.startsWith(gitDir) === true) {
        const evidence = yield* readBuckMaintainGitEvidence(temp).pipe(
          Effect.provideService(FileSystem.FileSystem, unknownMtime),
        )
        expect(evidence.lastActivityMs).toBeUndefined()
      } else {
        expect(
          yield* readBuckMaintainOutputActivity(temp).pipe(
            Effect.provideService(FileSystem.FileSystem, unknownMtime),
          ),
        ).toBeUndefined()
      }
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)
