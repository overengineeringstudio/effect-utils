import { cp } from 'node:fs/promises'
import { join } from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Exit, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as Command from 'effect/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'
import { expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'
import { Vitest } from '@overeng/utils-dev/node-vitest'

import { projectResolvedCapabilities } from '../buck2-capabilities/capability-projection.ts'
import * as Git from '../core/git.ts'
import { inspectPoolRoot } from './store-pool-preparation.ts'

const withTestCtx = Vitest.makeWithTestCtx({ makeLayer: () => NodeServices.layer })
const encodeCapabilityReferences = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.String)),
)

// Genuine Git history, generator output and Nix-added immutable profiles. Requires
// the normal Nix integration environment and its actual BUCK2_BIN, not a fake tool.
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
  const seed = join(root, 'seed')
  yield* fs.makeDirectory(seed)
  yield* Git.runCommand({ args: ['init', seed], cwd: root })
  yield* fs.writeFileString(join(seed, '.gitignore'), '.buck2/\n')
  yield* fs.writeFileString(
    join(seed, '.buckconfig'),
    '[cells]\n  capabilities = .buck2/capabilities\n',
  )
  yield* Git.runCommand({ args: ['add', '.'], cwd: seed })
  yield* Git.runCommand({
    args: [
      '-c',
      'user.name=Pool Fixture',
      '-c',
      'user.email=fixture@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'source',
    ],
    cwd: seed,
  })
  const bare = join(root, 'repo.git')
  yield* Git.runCommand({ args: ['clone', '--bare', seed, bare], cwd: root })
  yield* Git.runCommand({ args: ['config', 'core.logAllRefUpdates', 'true'], cwd: bare })
  const commit = yield* Git.getCurrentCommit(seed)
  const path = join(root, 'slot')
  yield* Git.createWorktreeDetached({ repoPath: bare, worktreePath: path, commit })
  const addToStore = (source: string) =>
    spawner
      .string(Command.make(process.env.NIX_STORE_BIN ?? 'nix-store', ['--add', source]))
      .pipe(Effect.map((output) => output.trim()))
  const data = join(root, 'data')
  yield* fs.makeDirectory(data)
  yield* fs.writeFileString(join(data, 'input'), 'real directory capability\n')
  const directory = yield* addToStore(data)
  const projection = join(root, 'projection')
  // Prefix-related names exercise the publisher's full-path reference ordering:
  // fixture-data-extra/... sorts before fixture-data/... despite traversal order.
  const toolIds = ['fixture-data', 'fixture-data-extra']
  const { generation } = yield* Effect.promise(() =>
    projectResolvedCapabilities({
      projectionPath: projection,
      platform: 'x86_64-linux',
      resolved: toolIds.map((toolId) => ({
        kind: 'directory',
        capability: {
          toolId,
          protocol: 'fixture/v1',
          flakePackage: 'fixture',
          kind: 'directory',
        },
        nixOutputPath: directory,
        closureStorePaths: [directory],
      })),
    }),
  )
  const profile = yield* addToStore(projection)
  const cell = join(path, '.buck2/capabilities')
  yield* fs.makeDirectory(join(path, '.buck2/capability-roots'), { recursive: true })
  yield* fs.makeDirectory(join(path, '.buck2/capability-references'))
  yield* Effect.promise(() => cp(projection, cell, { recursive: true, verbatimSymlinks: true }))
  yield* spawner.string(
    Command.make(process.env.NIX_STORE_BIN ?? 'nix-store', [
      '--realise',
      '--add-root',
      join(path, '.buck2/capability-roots', generation),
      '--indirect',
      profile,
    ]),
  )
  const platform = 'x86_64-linux'
  const toolRoot = join('tools', platform, 'fixture-data')
  const [digest] = yield* fs.readDirectory(join(cell, toolRoot))
  if (digest === undefined) return yield* Effect.die('Generator omitted fixture tool')
  const tool = join(toolRoot, digest)
  const references: string[] = []
  for (const toolId of toolIds) {
    const relative = join('tools', platform, toolId)
    for (const identity of yield* fs.readDirectory(join(cell, relative)))
      references.push(join(relative, identity))
  }
  yield* fs.writeFileString(
    join(path, '.buck2/capability-references', `${generation}.json`),
    `${encodeCapabilityReferences(references.toSorted())}\n`,
  )
  const provider = process.env.BUCK2_BIN
  if (provider === undefined)
    return yield* Effect.die('Real preparation integration requires BUCK2_BIN')
  const buck2Provider = yield* fs.realPath(provider)
  const target = {
    base: EffectPath.unsafe.absoluteDir(`${root}/`),
    path,
    commit,
    preparation: {
      mode: 'buck2' as const,
      buck2Provider,
      prepareTasks: ['buck2:editor:materialize'],
    },
  }
  return { fs, target, cell, profile, generation, tool, directory }
})

describe('real watched Buck capability preparation binding', () => {
  it.effect('qualifies the current real-directory layout without fabricated GVS backing', (test) =>
    Effect.gen(function* () {
      const { fs, target, cell } = yield* fixture
      expect((yield* fs.lstat(cell)).type).toBe('Directory')
      const before = yield* inspectPoolRoot(target)
      expect(before.backingPaths).toEqual([])
      expect(before.sourceHistory.commit).toBe(target.commit)
      expect(yield* inspectPoolRoot(target)).toEqual(before)
      // Retained packages are not the selected profile's input set.
      yield* fs.makeDirectory(join(cell, 'tools/x86_64-linux/retained', 'a'.repeat(64)), {
        recursive: true,
      })
      expect(yield* inspectPoolRoot(target)).toEqual(before)
    }).pipe(withTestCtx(test)),
  )

  for (const mutation of [
    'defs',
    'defs-bytes',
    'root-buck',
    'manifest',
    'tool-buck',
    'link-target',
    'extra-tool-file',
    'tool-directory-link',
    'defs-link',
    'profile-root',
    'references',
    'dirty-source',
    'wrong-commit',
    'writable-provider',
    'config',
  ] as const) {
    it.effect(`holds a current-layout root after ${mutation} mutation`, (test) =>
      Effect.gen(function* () {
        const { fs, target, cell, tool, directory, generation } = yield* fixture
        const before = yield* inspectPoolRoot(target)
        let changedTarget = target
        if (mutation === 'defs')
          yield* fs.writeFileString(join(cell, 'defs.bzl'), `GENERATION = "${'f'.repeat(64)}"\n`)
        else if (mutation === 'defs-bytes')
          yield* fs.writeFileString(
            join(cell, 'defs.bzl'),
            `${yield* fs.readFileString(join(cell, 'defs.bzl'))}# changed selected bytes\n`,
          )
        else if (mutation === 'root-buck')
          yield* fs.writeFileString(join(cell, 'BUCK'), 'tampered\n')
        else if (mutation === 'manifest')
          yield* fs.writeFileString(join(cell, tool, 'manifest.json'), '{}\n')
        else if (mutation === 'tool-buck')
          yield* fs.writeFileString(join(cell, tool, 'BUCK'), 'tampered\n')
        else if (mutation === 'link-target') {
          yield* fs.remove(join(cell, tool, 'directory'))
          yield* fs.symlink(`${directory}/.`, join(cell, tool, 'directory'))
        } else if (mutation === 'extra-tool-file')
          yield* fs.writeFileString(join(cell, tool, 'extra'), 'unselected input')
        else if (mutation === 'tool-directory-link') {
          const outside = join(target.path, '.buck2/moved-tool')
          yield* fs.rename(join(cell, tool), outside)
          yield* fs.symlink(outside, join(cell, tool))
        } else if (mutation === 'defs-link') {
          const outside = join(target.path, '.buck2/copied-defs')
          yield* fs.rename(join(cell, 'defs.bzl'), outside)
          yield* fs.symlink(outside, join(cell, 'defs.bzl'))
        } else if (mutation === 'profile-root') {
          const root = join(target.path, '.buck2/capability-roots', generation)
          yield* fs.remove(root)
          yield* fs.symlink(cell, root)
        } else if (mutation === 'references')
          yield* fs.writeFileString(
            join(target.path, '.buck2/capability-references', `${generation}.json`),
            '[]\n',
          )
        else if (mutation === 'dirty-source')
          yield* fs.writeFileString(join(target.path, 'untracked'), 'authored')
        else if (mutation === 'wrong-commit') changedTarget = { ...target, commit: '0'.repeat(40) }
        else if (mutation === 'writable-provider') {
          const provider = join(target.path, '.buck2/mutable-buck2')
          yield* fs.copyFile(target.preparation.buck2Provider, provider)
          yield* fs.chmod(provider, 0o755)
          changedTarget = {
            ...target,
            preparation: { ...target.preparation, buck2Provider: provider },
          }
        } else
          yield* fs.writeFileString(
            join(target.path, '.buckconfig.local'),
            '[build]\n  threads = 1\n',
          )
        const result = yield* Effect.exit(inspectPoolRoot(changedTarget))
        // Config changes may remain valid preparations but must invalidate READY.
        if (mutation === 'config' && Exit.isSuccess(result) === true)
          expect(result.value.identity).not.toBe(before.identity)
        else expect(Exit.isFailure(result)).toBe(true)
      }).pipe(withTestCtx(test)),
    )
  }
})
