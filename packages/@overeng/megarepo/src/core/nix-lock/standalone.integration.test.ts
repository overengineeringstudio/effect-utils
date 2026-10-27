import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Exit, Schema } from 'effect'
import * as Cli from 'effect/cli'
import * as FileSystem from 'effect/FileSystem'
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

describe('standalone root lock synchronization', () => {
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
