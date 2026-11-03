import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'

import { EffectPath } from '@overeng/effect-path'

import * as Git from '../core/git.ts'
import { createEmptyLockFile, writeLockFile } from '../core/lock.ts'
import { addCommit } from './setup.ts'
import { createStoreFixture, createWorkspaceWithLock } from './store-setup.ts'

/** Scoped foreign-owned commit tree with tracked inputs and ignored mounted payloads. */
export const rehomeFixture = Effect.fnUntraced(function* (seedCanonical = true) {
  const fs = yield* FileSystem.FileSystem
  const store = yield* createStoreFixture([{ host: 'example.com', owner: 'acme', repo: 'widget' }])
  const bareRepoPath = store.bareRepoPaths['example.com/acme/widget']!
  const mounted = EffectPath.unsafe.absoluteDir(
    `${yield* fs.realPath(yield* fs.makeTempDirectoryScoped())}/`,
  )
  yield* fs.writeFileString(`${mounted}payload`, 'mounted files stay untouched\n')
  const { workspacePath: source } = yield* createWorkspaceWithLock({ members: { mounted } })
  yield* writeLockFile({
    lockPath: EffectPath.unsafe.absoluteFile(`${source}megarepo.lock`),
    lockFile: createEmptyLockFile(),
  })
  yield* addCommit({ repoPath: source, message: 'Commit nested inputs' })
  if (seedCanonical === true)
    yield* Git.runCommand({
      cwd: bareRepoPath,
      args: ['fetch', source, 'HEAD:refs/heads/rehome-fixture'],
    })
  const commit = yield* Git.getCurrentCommit(source)
  const worktreePath = EffectPath.unsafe.absoluteDir(
    `${bareRepoPath.replace(/\.bare\/$/u, '')}refs/commits/${commit}/`,
  )
  const foreignRoot = yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
  const foreign = EffectPath.unsafe.absoluteDir(`${foreignRoot}/foreign.bare/`)
  yield* Git.runCommand({
    cwd: bareRepoPath,
    args: ['clone', '--bare', seedCanonical === true ? bareRepoPath : source, foreign],
  })
  yield* Git.runCommand({
    cwd: foreign,
    args: ['worktree', 'add', '--detach', worktreePath, commit],
  })
  for (const bare of [foreign, bareRepoPath]) {
    yield* fs.writeFileString(`${bare}info/exclude`, 'ignored.bin\nrepos/\n')
  }
  yield* fs.writeFile(`${worktreePath}ignored.bin`, new Uint8Array([0, 255, 10, 128]))
  yield* fs.makeDirectory(`${worktreePath}repos`)
  yield* fs.symlink(mounted, `${worktreePath}repos/mounted`)
  const foreignAdmin = (yield* fs.readFileString(`${worktreePath}.git`))
    .trim()
    .slice('gitdir: '.length)
  return { fs, store, bareRepoPath, worktreePath, foreign, foreignAdmin, mounted, commit }
})
