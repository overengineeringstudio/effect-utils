import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Exit, Redacted, Schema, Stream } from 'effect'
import * as Cli from 'effect/cli'
import * as FileSystem from 'effect/FileSystem'
import * as ChildProcess from 'effect/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'
import { expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import { lockSyncCommand } from '../../cli/commands/lock-sync.ts'
import { Cwd } from '../../cli/context.ts'
import { decodeJson, encodeJson } from '../../test-utils/json.ts'
import { initGitRepo, runGitCommand } from '../../test-utils/setup.ts'
import { makeCanonicalTempDirectoryScoped } from '../../test-utils/temp-root.ts'
import { syncStandaloneLocks } from './standalone.ts'

const original = { type: 'github', owner: 'example', repo: 'library', ref: 'published' }
const locked = {
  type: 'github',
  owner: 'example',
  repo: 'library',
  rev: 'a'.repeat(40),
  narHash: 'sha256-root-resolution',
  lastModified: 1234567890,
  customMetadata: 'preserved',
}
const lock = ({
  stale = false,
  ref = 'published',
  nodeId = 'library_2',
}: { stale?: boolean; ref?: string; nodeId?: string } = {}) => ({
  version: 7,
  root: 'consumer',
  nodes: {
    consumer: { inputs: { library: nodeId } },
    [nodeId]: {
      original: { ...original, ref },
      locked: stale === true ? { ...locked, rev: 'b'.repeat(40), narHash: 'sha256-stale' } : locked,
      inputs: { nixpkgs: 'nixpkgs' },
      customNodeMetadata: 'keep',
    },
    nixpkgs: {
      locked: { type: 'path', path: './unchanged' },
      original: { type: 'path', path: './unchanged' },
    },
  },
})

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = EffectPath.unsafe.absoluteDir(`${yield* makeCanonicalTempDirectoryScoped()}/`)
  yield* initGitRepo(root)
  yield* fs.writeFileString(`${root}devenv.lock`, encodeJson(lock({ nodeId: 'root-library' })))
  for (const path of ['flake.lock', 'nix/tool/flake.lock', 'nested dir/sub/flake.lock']) {
    yield* fs.makeDirectory(`${root}${path.slice(0, path.lastIndexOf('/') + 1)}`, {
      recursive: true,
    })
    yield* fs.writeFileString(`${root}${path}`, encodeJson(lock({ stale: true })))
  }
  // Exercise both tracked and untracked discovery without committing fixtures.
  yield* runGitCommand(root, 'add', 'nix/tool/flake.lock')
  return { fs, root }
})

const withServices = <TA, TE, TR>(effect: Effect.Effect<TA, TE, TR>) =>
  effect.pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const requestedRev = 'c'.repeat(40)
const requestedLocked = {
  ...locked,
  rev: requestedRev,
  narHash: 'sha256-requested-resolution',
  lastModified: 1234567000,
}
const fixtureLocks = [
  'devenv.lock',
  'flake.lock',
  'nested dir/sub/flake.lock',
  'nix/tool/flake.lock',
]

/** Git ancestry and Nix metadata are fixture outputs, never real network commands. */
const revisionSpawner = ({
  mergeBase = requestedRev,
  ref = original.ref,
}: { mergeBase?: string; ref?: string } = {}) => {
  const calls: string[][] = []
  const expected = [
    ['git', expect.stringMatching(/^--git-dir=/), 'rev-parse', '--local-env-vars'],
    ['git', expect.stringMatching(/^--git-dir=/), 'init', '--bare', expect.any(String)],
    [
      'git',
      expect.stringMatching(/^--git-dir=/),
      'fetch',
      '--no-tags',
      '--',
      'https://github.com/example/library.git',
      ref,
    ],
    ['git', expect.stringMatching(/^--git-dir=/), 'merge-base', requestedRev, 'FETCH_HEAD'],
    ['nix', 'flake', 'prefetch', `github:example/library/${requestedRev}`, '--json'],
  ]
  const forbidden = (method: string) =>
    Effect.die(new Error(`Unexpected ChildProcessSpawner.${method} in offline revision test`))
  const service = {
    string: (command: ChildProcess.Command) =>
      Effect.gen(function* () {
        if (ChildProcess.isStandardCommand(command) === false) {
          return yield* forbidden('string with a piped command')
        }
        const call = [
          command.command,
          ...command.args.map((word) => (typeof word === 'string' ? word : Redacted.value(word))),
        ]
        calls.push(call)
        if (command.command === 'git') {
          expect(call).toEqual(expected[calls.length - 1])
          if (command.args.includes('--local-env-vars') === true) {
            return 'GIT_DIR\nGIT_INDEX_FILE\nGIT_OBJECT_DIRECTORY\nGIT_COMMON_DIR\n'
          }
          return command.args.includes('merge-base') === true ? `${mergeBase}\n` : ''
        }
        if (command.command === 'nix') {
          expect(call).toEqual(expected[4])
          return encodeJson({
            hash: requestedLocked.narHash,
            locked: requestedLocked,
          })
        }
        return yield* forbidden(`string: ${call.join(' ')}`)
      }),
    spawn: () => forbidden('spawn'),
    exitCode: () => forbidden('exitCode'),
    lines: () => forbidden('lines'),
    streamString: () => Stream.fromEffect(forbidden('streamString')),
    streamLines: () => Stream.fromEffect(forbidden('streamLines')),
  }
  return { service, calls, expected }
}

describe('standalone root lock synchronization', () => {
  it.effect('isolates ancestry Git writes from inherited hook repository overrides', () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner
      for (const write of [false, true]) {
        const { fs, root } = yield* fixture
        const upstream = EffectPath.unsafe.absoluteDir(`${root}upstream/`)
        const sentinel = EffectPath.unsafe.absoluteDir(`${root}sentinel/`)
        for (const repo of [upstream, sentinel]) {
          yield* fs.makeDirectory(repo)
          yield* initGitRepo(repo)
          yield* runGitCommand(repo, 'commit', '--allow-empty', '-m', 'initial')
        }
        const rev = yield* runGitCommand(upstream, 'rev-parse', 'HEAD')
        yield* runGitCommand(upstream, 'commit', '--allow-empty', '-m', 'ref tip ahead')
        yield* runGitCommand(upstream, 'branch', 'published')
        const tip = yield* runGitCommand(upstream, 'rev-parse', 'HEAD')
        const source = lock({ nodeId: 'root-library' })
        yield* fs.writeFileString(
          `${root}devenv.lock`,
          encodeJson({
            ...source,
            nodes: {
              ...source.nodes,
              'root-library': { ...source.nodes['root-library'], locked: { ...locked, rev: tip } },
            },
          }),
        )
        // Byte snapshots include every object, ref, configuration and index file.
        const snapshot = Effect.fn(function* (directory: string) {
          const paths = yield* fs.readDirectory(directory, { recursive: true })
          const entries: Array<readonly [string, string]> = []
          for (const path of paths.toSorted()) {
            const absolute = `${directory}/${path}`
            if ((yield* fs.stat(absolute)).type === 'Directory') continue
            entries.push([path, Buffer.from(yield* fs.readFile(absolute)).toString('hex')])
          }
          return entries
        })
        const before = yield* snapshot(`${sentinel}.git`)
        const rootBefore = yield* fs.readFileString(`${root}devenv.lock`)
        const overrides = {
          GIT_DIR: `${sentinel}.git`,
          GIT_WORK_TREE: sentinel,
          GIT_INDEX_FILE: `${sentinel}.git/index`,
          GIT_OBJECT_DIRECTORY: `${sentinel}.git/objects`,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: `${sentinel}.git/objects`,
          GIT_CONFIG: `${sentinel}.git/config`,
          GIT_COMMON_DIR: `${sentinel}.git`,
          GIT_NAMESPACE: 'sentinel-namespace',
          GIT_PREFIX: 'sentinel-prefix/',
          GIT_CEILING_DIRECTORIES: sentinel,
          GIT_TERMINAL_PROMPT: '0',
        }
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                const previous = Object.fromEntries(
                  Object.keys(overrides).map((key) => [key, process.env[key]]),
                )
                Object.assign(process.env, overrides)
                return previous
              }),
              (previous) =>
                Effect.sync(() => {
                  for (const [key, value] of Object.entries(previous)) {
                    if (value === undefined) delete process.env[key]
                    else process.env[key] = value
                  }
                }),
            )
            const isolatedSpawner = {
              ...spawner,
              string: (command: ChildProcess.Command) => {
                if (ChildProcess.isStandardCommand(command) === false)
                  return spawner.string(command)
                if (command.command === 'nix') {
                  return Effect.succeed(
                    encodeJson({
                      hash: requestedLocked.narHash,
                      locked: { ...requestedLocked, rev },
                    }),
                  )
                }
                expect(command.args[0]).toMatch(/^--git-dir=/)
                expect(command.options.env?.['GIT_DIR']).toBeUndefined()
                expect(command.options.env?.['GIT_INDEX_FILE']).toBeUndefined()
                if (command.args.includes('--local-env-vars') === false) {
                  for (const key of Object.keys(overrides)) {
                    if (key === 'GIT_TERMINAL_PROMPT') continue
                    expect(command.options.env?.[key]).toBeUndefined()
                  }
                  expect(command.options.extendEnv).toBe(false)
                  expect(command.options.env?.['GIT_TERMINAL_PROMPT']).toBe('0')
                  expect(command.options.env?.['HOME']).toBe(process.env['HOME'])
                }
                // Keep real Git execution, substituting only the remote URL for an offline repo.
                return spawner.string(
                  ChildProcess.make(
                    command.command,
                    command.args.map((arg) =>
                      arg === 'https://github.com/example/library.git' ? upstream : arg,
                    ),
                    command.options,
                  ),
                )
              },
            }
            expect(
              yield* syncStandaloneLocks({
                root,
                input: 'library',
                locks: ['flake.lock'],
                rev,
                write,
              }).pipe(Effect.provideService(ChildProcessSpawner, isolatedSpawner)),
            ).toEqual({
              checked: ['devenv.lock', 'flake.lock'],
              changed: ['devenv.lock', 'flake.lock'],
            })
          }),
        )
        expect(yield* snapshot(`${sentinel}.git`)).toEqual(before)
        if (write === false) {
          expect(yield* fs.readFileString(`${root}devenv.lock`)).toBe(rootBefore)
        } else {
          const expected = {
            ...source,
            nodes: {
              ...source.nodes,
              'root-library': {
                ...source.nodes['root-library'],
                locked: { ...requestedLocked, rev },
              },
            },
          }
          expect(decodeJson(yield* fs.readFileString(`${root}devenv.lock`))).toEqual(expected)
          expect(decodeJson(yield* fs.readFileString(`${root}flake.lock`))).toEqual({
            ...lock(),
            nodes: {
              ...lock().nodes,
              library_2: {
                ...lock().nodes['library_2'],
                locked: { ...requestedLocked, rev },
              },
            },
          })
        }
      }
    }).pipe(withServices),
  )

  it.effect(
    'resolves an explicit ancestor or identical revision without changing original ref intent',
    () =>
      Effect.gen(function* () {
        for (const tipRev of ['d'.repeat(40), requestedRev]) {
          const { fs, root } = yield* fixture
          const ref = 'release/stable'
          const source = lock({ nodeId: 'root-library', ref })
          yield* fs.writeFileString(
            `${root}devenv.lock`,
            encodeJson({
              ...source,
              nodes: {
                ...source.nodes,
                'root-library': {
                  ...source.nodes['root-library'],
                  locked: { ...locked, rev: tipRev },
                },
              },
            }),
          )
          const selected = ['flake.lock', 'nested dir/sub/flake.lock']
          for (const path of selected) {
            yield* fs.writeFileString(`${root}${path}`, encodeJson(lock({ stale: true, ref })))
          }
          const excludedBefore = yield* fs.readFileString(`${root}nix/tool/flake.lock`)
          const mock = revisionSpawner({ ref })
          const result = yield* syncStandaloneLocks({
            root,
            input: 'library',
            locks: selected,
            rev: requestedRev,
            write: true,
          }).pipe(Effect.provideService(ChildProcessSpawner, mock.service))
          expect(result).toEqual({
            checked: ['devenv.lock', ...selected],
            changed: ['devenv.lock', ...selected],
          })
          for (const path of ['devenv.lock', ...selected]) {
            const nodeId = path === 'devenv.lock' ? 'root-library' : 'library_2'
            const expected = lock({ nodeId, ref })
            expect(decodeJson(yield* fs.readFileString(`${root}${path}`))).toEqual({
              ...expected,
              nodes: {
                ...expected.nodes,
                [nodeId]: { ...expected.nodes[nodeId], locked: requestedLocked },
              },
            })
          }
          expect(yield* fs.readFileString(`${root}nix/tool/flake.lock`)).toBe(excludedBefore)
          expect(mock.calls).toEqual(mock.expected)
        }
      }).pipe(withServices),
  )

  it.effect('rejects unreachable revisions or a different merge base without writing locks', () =>
    Effect.gen(function* () {
      // A behind commit or a divergent commit has a merge base other than itself.
      for (const mergeBase of [locked.rev, 'd'.repeat(40)]) {
        const { fs, root } = yield* fixture
        const before = yield* Effect.forEach(fixtureLocks, (path) =>
          fs.readFileString(`${root}${path}`),
        )
        const mock = revisionSpawner({ mergeBase })
        const error = yield* syncStandaloneLocks({
          root,
          input: 'library',
          locks: fixtureLocks.slice(1),
          rev: requestedRev,
          write: true,
        }).pipe(Effect.provideService(ChildProcessSpawner, mock.service), Effect.flip)
        expect(error._tag).toBe('StandaloneLockSyncError')
        expect(
          yield* Effect.forEach(fixtureLocks, (path) => fs.readFileString(`${root}${path}`)),
        ).toEqual(before)
        expect(mock.calls).toEqual(mock.expected.slice(0, 4))
      }
    }).pipe(withServices),
  )

  it.effect('checks requested revision drift in root and standalone locks without writes', () =>
    Effect.gen(function* () {
      const { fs, root } = yield* fixture
      // The cohort already agrees with root; only the requested revision introduces drift.
      for (const path of fixtureLocks.slice(1)) {
        yield* fs.writeFileString(`${root}${path}`, encodeJson(lock()))
      }
      const before = yield* Effect.forEach(fixtureLocks, (path) =>
        fs.readFileString(`${root}${path}`),
      )
      const mock = revisionSpawner()
      const result = yield* syncStandaloneLocks({
        root,
        input: 'library',
        locks: fixtureLocks.slice(1),
        rev: requestedRev,
      }).pipe(Effect.provideService(ChildProcessSpawner, mock.service))
      expect(result).toEqual({ checked: fixtureLocks, changed: fixtureLocks })
      expect(
        yield* Effect.forEach(fixtureLocks, (path) => fs.readFileString(`${root}${path}`)),
      ).toEqual(before)
      expect(mock.calls).toEqual(mock.expected)
    }).pipe(withServices),
  )

  it.effect('preflights the whole revision cohort before writing even the root authority', () =>
    Effect.gen(function* () {
      const { fs, root } = yield* fixture
      yield* fs.writeFileString(
        `${root}nix/tool/flake.lock`,
        encodeJson(lock({ stale: true, ref: 'main' })),
      )
      const before = yield* Effect.forEach(fixtureLocks, (path) =>
        fs.readFileString(`${root}${path}`),
      )
      const mock = revisionSpawner()
      const error = yield* syncStandaloneLocks({
        root,
        input: 'library',
        locks: fixtureLocks.slice(1),
        rev: requestedRev,
        write: true,
      }).pipe(Effect.provideService(ChildProcessSpawner, mock.service), Effect.flip)
      expect(error).toMatchObject({
        _tag: 'StandaloneLockSyncError',
        path: `${root}nix/tool/flake.lock`,
      })
      expect(error.message).toContain('different original')
      expect(
        yield* Effect.forEach(fixtureLocks, (path) => fs.readFileString(`${root}${path}`)),
      ).toEqual(before)
      expect(mock.calls[0]).toEqual(mock.expected[0])
    }).pipe(withServices),
  )

  it.effect(
    'checks, copies complete locked metadata, preserves graph and original, and is idempotent',
    () =>
      Effect.gen(function* () {
        const { fs, root } = yield* fixture
        const sourceBefore = yield* fs.readFileString(`${root}devenv.lock`)
        const before = yield* fs.readFileString(`${root}nix/tool/flake.lock`)
        const check = yield* syncStandaloneLocks({ root, input: 'library' })
        expect(check.changed).toEqual([
          'flake.lock',
          'nested dir/sub/flake.lock',
          'nix/tool/flake.lock',
        ])
        expect(yield* fs.readFileString(`${root}nix/tool/flake.lock`)).toBe(before)
        expect(yield* syncStandaloneLocks({ root, input: 'library', write: true })).toEqual(check)
        for (const path of check.checked) {
          expect(decodeJson(yield* fs.readFileString(`${root}${path}`))).toEqual(lock())
        }
        expect(yield* fs.readFileString(`${root}devenv.lock`)).toBe(sourceBefore)
        const after = yield* fs.readFileString(`${root}nix/tool/flake.lock`)
        expect(
          (yield* syncStandaloneLocks({ root, input: 'library', write: true })).changed,
        ).toEqual([])
        expect((yield* syncStandaloneLocks({ root, input: 'library' })).changed).toEqual([])
        expect(yield* fs.readFileString(`${root}nix/tool/flake.lock`)).toBe(after)
      }).pipe(withServices),
  )

  it.effect(
    'limits synchronization to selected locks and leaves archived ref intent untouched',
    () =>
      Effect.gen(function* () {
        const { fs, root } = yield* fixture
        yield* fs.makeDirectory(`${root}archive`, { recursive: true })
        const archived = encodeJson(lock({ stale: true, ref: 'main' }))
        yield* fs.writeFileString(`${root}archive/flake.lock`, archived)
        const excludedBefore = yield* fs.readFileString(`${root}nix/tool/flake.lock`)
        const sourceBefore = yield* fs.readFileString(`${root}devenv.lock`)
        const options = { root, input: 'library', locks: ['flake.lock'] }
        expect(yield* syncStandaloneLocks(options)).toEqual({
          checked: ['flake.lock'],
          changed: ['flake.lock'],
        })
        yield* syncStandaloneLocks({ ...options, write: true })
        expect(decodeJson(yield* fs.readFileString(`${root}flake.lock`))).toEqual(lock())
        expect(yield* fs.readFileString(`${root}archive/flake.lock`)).toBe(archived)
        expect(yield* fs.readFileString(`${root}nix/tool/flake.lock`)).toBe(excludedBefore)
        expect(yield* fs.readFileString(`${root}devenv.lock`)).toBe(sourceBefore)
      }).pipe(withServices),
  )

  it.effect('names an included archived lock with a differing ref and writes nothing', () =>
    Effect.gen(function* () {
      const { fs, root } = yield* fixture
      yield* fs.makeDirectory(`${root}z-archive`, { recursive: true })
      const archived = encodeJson(lock({ stale: true, ref: 'main' }))
      yield* fs.writeFileString(`${root}z-archive/flake.lock`, archived)
      const before = yield* fs.readFileString(`${root}flake.lock`)
      const error = yield* syncStandaloneLocks({
        root,
        input: 'library',
        locks: ['flake.lock', 'z-archive/flake.lock'],
        write: true,
      }).pipe(Effect.flip)
      expect(error).toMatchObject({
        _tag: 'StandaloneLockSyncError',
        path: `${root}z-archive/flake.lock`,
      })
      expect(error.message).toContain('z-archive/flake.lock')
      expect(error.message).toContain('different original')
      expect(yield* fs.readFileString(`${root}flake.lock`)).toBe(before)
      expect(yield* fs.readFileString(`${root}z-archive/flake.lock`)).toBe(archived)
    }).pipe(withServices),
  )

  it.effect(
    'normalizes, deduplicates and sorts explicit lock paths without discovering others',
    () =>
      Effect.gen(function* () {
        const { fs, root } = yield* fixture
        const before = yield* fs.readFileString(`${root}flake.lock`)
        const options = {
          root,
          input: 'library',
          locks: [
            'nix/tool/flake.lock',
            './nested dir/sub/flake.lock',
            './nix/tool/flake.lock',
            'nested dir/sub/flake.lock',
          ],
        }
        const expected = ['nested dir/sub/flake.lock', 'nix/tool/flake.lock']
        expect(yield* syncStandaloneLocks(options)).toEqual({
          checked: expected,
          changed: expected,
        })
        expect(yield* syncStandaloneLocks({ ...options, write: true })).toEqual({
          checked: expected,
          changed: expected,
        })
        expect(yield* syncStandaloneLocks(options)).toEqual({ checked: expected, changed: [] })
        expect(yield* fs.readFileString(`${root}flake.lock`)).toBe(before)
      }).pipe(withServices),
  )

  it.effect('rejects missing, absolute and escaping selected paths before any writes', () =>
    Effect.gen(function* () {
      const { fs, root } = yield* fixture
      const before = yield* fs.readFileString(`${root}flake.lock`)
      for (const selected of [
        'z-missing/flake.lock',
        `${root}nix/tool/flake.lock`,
        '../flake.lock',
        'nix/tool/not-a-flake.lock',
      ]) {
        const error = yield* syncStandaloneLocks({
          root,
          input: 'library',
          locks: ['flake.lock', selected],
          write: true,
        }).pipe(Effect.flip)
        expect(error._tag).toBe('StandaloneLockSyncError')
        expect(error.message).toContain(selected)
        expect(yield* fs.readFileString(`${root}flake.lock`)).toBe(before)
      }
    }).pipe(withServices),
  )

  it.effect(
    'synchronizes one repository across dirs while preserving target original and locked dir',
    () =>
      Effect.gen(function* () {
        const { fs, root } = yield* fixture
        for (const { sourceDir, targetDir } of [
          { sourceDir: undefined, targetDir: 'sub' },
          { sourceDir: 'sub', targetDir: undefined },
          { sourceDir: 'source', targetDir: 'target' },
        ]) {
          const sourceMetadata = sourceDir === undefined ? {} : { dir: sourceDir }
          const targetMetadata = targetDir === undefined ? {} : { dir: targetDir }
          const source = {
            ...lock(),
            nodes: {
              ...lock().nodes,
              library_2: {
                ...lock().nodes.library_2,
                original: { ...original, ...sourceMetadata },
                locked: { ...locked, ...sourceMetadata },
              },
            },
          }
          const target = {
            ...lock({ stale: true }),
            nodes: {
              ...lock({ stale: true }).nodes,
              library_2: {
                ...lock({ stale: true }).nodes.library_2,
                original: { ...original, ...targetMetadata },
                locked: { ...locked, ...targetMetadata, rev: 'b'.repeat(40) },
              },
            },
          }
          const sourceContent = encodeJson(source)
          yield* fs.writeFileString(`${root}devenv.lock`, sourceContent)
          yield* fs.writeFileString(`${root}flake.lock`, encodeJson(target))
          const options = { root, input: 'library', locks: ['flake.lock'] }
          expect((yield* syncStandaloneLocks(options)).changed).toEqual(['flake.lock'])
          yield* syncStandaloneLocks({ ...options, write: true })
          expect(decodeJson(yield* fs.readFileString(`${root}flake.lock`))).toEqual({
            ...target,
            nodes: {
              ...target.nodes,
              library_2: {
                ...target.nodes.library_2,
                locked: { ...locked, ...targetMetadata },
              },
            },
          })
          expect(yield* fs.readFileString(`${root}devenv.lock`)).toBe(sourceContent)
          expect((yield* syncStandaloneLocks(options)).changed).toEqual([])
        }
      }).pipe(withServices),
  )

  it.effect('synchronizes every nested duplicate even without a named direct root input', () =>
    Effect.gen(function* () {
      const { fs, root } = yield* fixture
      const nested = {
        version: 7,
        root: 'consumer',
        nodes: {
          consumer: { inputs: { tool: 'tool' } },
          tool: { inputs: { library: 'library_2' } },
          library_2: { original, locked: { ...locked, rev: 'b'.repeat(40) } },
          library_3: { original, locked: { ...locked, rev: 'c'.repeat(40) } },
        },
      }
      yield* fs.writeFileString(`${root}flake.lock`, encodeJson(nested))
      expect((yield* syncStandaloneLocks({ root, input: 'library' })).changed).toContain(
        'flake.lock',
      )
      yield* syncStandaloneLocks({ root, input: 'library', write: true })
      expect(decodeJson(yield* fs.readFileString(`${root}flake.lock`))).toEqual({
        ...nested,
        nodes: {
          ...nested.nodes,
          library_2: { original, locked },
          library_3: { original, locked },
        },
      })
      expect((yield* syncStandaloneLocks({ root, input: 'library' })).changed).toEqual([])
    }).pipe(withServices),
  )

  it.effect('preflights a nested duplicate with a differing original before any write', () =>
    Effect.gen(function* () {
      const { fs, root } = yield* fixture
      const nestedMismatch = {
        ...lock(),
        nodes: {
          ...lock().nodes,
          library_3: { original: { ...original, ref: 'main' }, locked },
        },
      }
      const mismatchContent = encodeJson(nestedMismatch)
      yield* fs.writeFileString(`${root}nix/tool/flake.lock`, mismatchContent)
      const before = yield* fs.readFileString(`${root}flake.lock`)
      expect(
        Exit.isFailure(
          yield* Effect.exit(syncStandaloneLocks({ root, input: 'library', write: true })),
        ),
      ).toBe(true)
      expect(yield* fs.readFileString(`${root}flake.lock`)).toBe(before)
      expect(yield* fs.readFileString(`${root}nix/tool/flake.lock`)).toBe(mismatchContent)
    }).pipe(withServices),
  )

  it.effect('preflights nested mismatched originals across every GitHub transport', () =>
    Effect.gen(function* () {
      const { fs, root } = yield* fixture
      const before = yield* fs.readFileString(`${root}flake.lock`)
      for (const url of [
        'https://github.com/example/library.git',
        'git@github.com:example/library.git',
        'ssh://git@github.com/example/library.git',
        'git+ssh://git@github.com/example/library.git',
      ]) {
        const mismatch = encodeJson({
          ...lock(),
          nodes: {
            ...lock().nodes,
            nested: { inputs: { library: 'library_3' } },
            library_3: {
              original: { type: 'git', url, ref: 'main' },
              locked: { type: 'git', url, rev: 'b'.repeat(40) },
            },
          },
        })
        yield* fs.writeFileString(`${root}nix/tool/flake.lock`, mismatch)
        expect(
          Exit.isFailure(
            yield* Effect.exit(syncStandaloneLocks({ root, input: 'library', write: true })),
          ),
        ).toBe(true)
        expect(yield* fs.readFileString(`${root}flake.lock`)).toBe(before)
        expect(yield* fs.readFileString(`${root}nix/tool/flake.lock`)).toBe(mismatch)
      }
    }).pipe(withServices),
  )

  it.effect('fails closed on a missing declared root before writing an earlier valid lock', () =>
    Effect.gen(function* () {
      const { fs, root } = yield* fixture
      const malformed = encodeJson({ ...lock(), root: 'missing-root' })
      yield* fs.writeFileString(`${root}nix/tool/flake.lock`, malformed)
      const before = yield* fs.readFileString(`${root}flake.lock`)
      for (const write of [false, true]) {
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              syncStandaloneLocks({
                root,
                input: 'library',
                write,
              }),
            ),
          ),
        ).toBe(true)
      }
      expect(yield* fs.readFileString(`${root}flake.lock`)).toBe(before)
      expect(yield* fs.readFileString(`${root}nix/tool/flake.lock`)).toBe(malformed)
    }).pipe(withServices),
  )

  it.effect(
    'atomically replaces a lock while an existing hard link retains the complete old file',
    () =>
      Effect.gen(function* () {
        const { fs, root } = yield* fixture
        const target = `${root}nix/tool/flake.lock`
        const held = `${root}held.lock`
        const before = yield* fs.readFileString(target)
        yield* fs.link(target, held)
        yield* syncStandaloneLocks({ root, input: 'library', write: true })
        // An in-place/truncating write would also change the old inode through this hard link.
        expect(yield* fs.readFileString(held)).toBe(before)
        expect(decodeJson(yield* fs.readFileString(target))).toEqual(lock())
        expect(
          (yield* fs.readDirectory(`${root}nix/tool`)).filter((name) => name.includes('.tmp-')),
        ).toEqual([])
      }).pipe(withServices),
  )

  it.effect('restores every original lock when the second replacement rename fails', () =>
    Effect.gen(function* () {
      const { fs, root } = yield* fixture
      const paths = ['flake.lock', 'nested dir/sub/flake.lock', 'nix/tool/flake.lock']
      const before = yield* Effect.forEach(paths, (path) => fs.readFileString(`${root}${path}`))
      let injectedFailure = false
      const controlledFs: FileSystem.FileSystem = {
        ...fs,
        rename: (from, to) => {
          if (to === `${root}nested dir/sub/flake.lock` && injectedFailure === false) {
            injectedFailure = true
            return fs.rename(`${root}missing-replacement`, to)
          }
          return fs.rename(from, to)
        },
      }
      const result = yield* Effect.exit(
        syncStandaloneLocks({ root, input: 'library', write: true }).pipe(
          Effect.provideService(FileSystem.FileSystem, controlledFs),
        ),
      )
      expect(injectedFailure).toBe(true)
      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* Effect.forEach(paths, (path) => fs.readFileString(`${root}${path}`))).toEqual(
        before,
      )
    }).pipe(withServices),
  )

  it.effect('preflights differing originals across the whole cohort without partial writes', () =>
    Effect.gen(function* () {
      const { fs, root } = yield* fixture
      yield* fs.writeFileString(
        `${root}nix/tool/flake.lock`,
        encodeJson(lock({ stale: true, ref: 'main' })),
      )
      const before = yield* fs.readFileString(`${root}flake.lock`)
      const result = yield* Effect.exit(
        syncStandaloneLocks({ root, input: 'library', write: true }),
      )
      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* fs.readFileString(`${root}flake.lock`)).toBe(before)
    }).pipe(withServices),
  )

  it.effect(
    'ignores unrelated inputs and ignored caches and accepts an explicit root flake lock',
    () =>
      Effect.gen(function* () {
        const { fs, root } = yield* fixture
        yield* fs.writeFileString(`${root}flake.lock`, encodeJson(lock()))
        yield* fs.writeFileString(`${root}.gitignore`, 'cache/\n')
        yield* fs.makeDirectory(`${root}cache`, { recursive: true })
        yield* fs.writeFileString(`${root}cache/flake.lock`, 'not a lock')
        yield* fs.makeDirectory(`${root}other`, { recursive: true })
        const unrelated = encodeJson({ version: 7, root: 'root', nodes: { root: {} } })
        yield* fs.writeFileString(`${root}other/flake.lock`, unrelated)
        expect(
          (yield* syncStandaloneLocks({
            root,
            input: 'library',
            rootLock: 'flake.lock',
            write: true,
          })).changed,
        ).toEqual(['nested dir/sub/flake.lock', 'nix/tool/flake.lock'])
        expect(yield* fs.readFileString(`${root}other/flake.lock`)).toBe(unrelated)
        expect(yield* fs.readFileString(`${root}cache/flake.lock`)).toBe('not a lock')
      }).pipe(withServices),
  )

  it.effect('fails closed for a missing root input and malformed standalone locks', () =>
    Effect.gen(function* () {
      const { fs, root } = yield* fixture
      expect(
        Exit.isFailure(
          yield* Effect.exit(syncStandaloneLocks({ root, input: 'missing', write: true })),
        ),
      ).toBe(true)
      const before = yield* fs.readFileString(`${root}flake.lock`)
      yield* fs.writeFileString(`${root}nix/tool/flake.lock`, '{}')
      expect(
        Exit.isFailure(
          yield* Effect.exit(syncStandaloneLocks({ root, input: 'library', write: true })),
        ),
      ).toBe(true)
      expect(yield* fs.readFileString(`${root}flake.lock`)).toBe(before)
    }).pipe(withServices),
  )

  it.effect('resolves follows paths and rejects cycles before any writes', () =>
    Effect.gen(function* () {
      const { fs, root } = yield* fixture
      const followed = {
        ...lock({ stale: true }),
        nodes: {
          ...lock({ stale: true }).nodes,
          consumer: { inputs: { library: ['alias'], alias: 'library_2' } },
        },
      }
      yield* fs.writeFileString(`${root}flake.lock`, encodeJson(followed))
      yield* syncStandaloneLocks({ root, input: 'library', write: true })
      expect(decodeJson(yield* fs.readFileString(`${root}flake.lock`))).toEqual({
        ...lock(),
        nodes: { ...lock().nodes, consumer: followed.nodes.consumer },
      })
      yield* fs.writeFileString(
        `${root}nix/tool/flake.lock`,
        encodeJson({
          ...lock(),
          nodes: { ...lock().nodes, consumer: { inputs: { library: ['library'] } } },
        }),
      )
      expect(
        Exit.isFailure(
          yield* Effect.exit(syncStandaloneLocks({ root, input: 'library', write: true })),
        ),
      ).toBe(true)
    }).pipe(withServices),
  )

  it.effect('preflights symlink destinations before writing any lock', () =>
    Effect.gen(function* () {
      const { fs, root } = yield* fixture
      const outside = `${yield* makeCanonicalTempDirectoryScoped()}/outside.lock`
      const originalOutside = encodeJson(lock({ stale: true }))
      yield* fs.writeFileString(outside, originalOutside)
      yield* fs.remove(`${root}nix/tool/flake.lock`)
      yield* fs.symlink(outside, `${root}nix/tool/flake.lock`)
      const before = yield* fs.readFileString(`${root}flake.lock`)
      expect(
        Exit.isFailure(
          yield* Effect.exit(syncStandaloneLocks({ root, input: 'library', write: true })),
        ),
      ).toBe(true)
      expect(yield* fs.readFileString(outside)).toBe(originalOutside)
      expect(yield* fs.readFileString(`${root}flake.lock`)).toBe(before)
    }).pipe(withServices),
  )

  it.effect('CLI check fails on drift, write repairs it, and the same check then passes', () =>
    Effect.gen(function* () {
      const { root } = yield* fixture
      const run = (args: string[]) =>
        Cli.Command.runWith(lockSyncCommand, { version: 'test' })(args).pipe(
          Effect.provideService(Cwd, root),
        )
      expect(Exit.isFailure(yield* Effect.exit(run(['--input', 'library'])))).toBe(true)
      yield* run(['--input', 'library', '--write'])
      yield* run(['--input', 'library'])
    }).pipe(withServices),
  )

  it.effect('CLI accepts repeated exact --lock paths and excludes archived locks', () =>
    Effect.gen(function* () {
      const { fs, root } = yield* fixture
      yield* fs.makeDirectory(`${root}archive`, { recursive: true })
      const archived = encodeJson(lock({ stale: true, ref: 'main' }))
      yield* fs.writeFileString(`${root}archive/flake.lock`, archived)
      const before = yield* fs.readFileString(`${root}nix/tool/flake.lock`)
      const run = (args: string[]) =>
        Cli.Command.runWith(lockSyncCommand, { version: 'test' })(args).pipe(
          Effect.provideService(Cwd, root),
        )
      const args = [
        '--input',
        'library',
        '--lock',
        'nested dir/sub/flake.lock',
        '--lock',
        'flake.lock',
      ]
      expect(Exit.isFailure(yield* Effect.exit(run(args)))).toBe(true)
      yield* run([...args, '--write'])
      yield* run(args)
      expect(decodeJson(yield* fs.readFileString(`${root}flake.lock`))).toEqual(lock())
      expect(decodeJson(yield* fs.readFileString(`${root}nested dir/sub/flake.lock`))).toEqual(
        lock(),
      )
      expect(yield* fs.readFileString(`${root}nix/tool/flake.lock`)).toBe(before)
      expect(yield* fs.readFileString(`${root}archive/flake.lock`)).toBe(archived)
    }).pipe(withServices),
  )

  it.effect.prop(
    'preserves arbitrary ref intent while converging the resolved metadata',
    [Schema.NonEmptyString],
    ([ref]) =>
      Effect.gen(function* () {
        const { fs, root } = yield* fixture
        yield* fs.writeFileString(`${root}devenv.lock`, encodeJson(lock({ ref })))
        for (const path of ['flake.lock', 'nix/tool/flake.lock', 'nested dir/sub/flake.lock']) {
          yield* fs.writeFileString(`${root}${path}`, encodeJson(lock({ ref, stale: true })))
        }
        yield* syncStandaloneLocks({ root, input: 'library', write: true })
        expect(decodeJson(yield* fs.readFileString(`${root}flake.lock`))).toEqual(lock({ ref }))
        expect((yield* syncStandaloneLocks({ root, input: 'library' })).changed).toEqual([])
      }).pipe(withServices),
    { arbitrary: { runs: 8 } },
  )
})
