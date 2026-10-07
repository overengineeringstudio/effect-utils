import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { describe, expect, test } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import { MegarepoConfig } from '../core/config.ts'
import { createEmptyLockFile, LockFile, LockedMember, writeLockFile } from '../core/lock.ts'
import { syncNixLocks } from '../core/nix-lock/mod.ts'
import { generateSchema } from '../generators/schema.ts'
import { decodeJson, encodeJson } from '../test-utils/json.ts'
import { abbreviateStorePath, assertCanonicalMutationAllowed } from './store-path.ts'

describe('abbreviateStorePath', () => {
  test('branch ref', () => {
    expect(
      abbreviateStorePath('/Users/dev/.megarepo/github.com/alice/dev-workspace/refs/heads/main'),
    ).toBe('alice/dev-workspace@main')
  })

  test('branch with slash', () => {
    expect(
      abbreviateStorePath('/Users/dev/.megarepo/github.com/org/repo/refs/heads/feature/foo'),
    ).toBe('org/repo@feature/foo')
  })

  test('tag ref', () => {
    expect(abbreviateStorePath('/Users/dev/.megarepo/github.com/org/repo/refs/tags/v1.0.0')).toBe(
      'org/repo@v1.0.0',
    )
  })

  test('commit ref', () => {
    expect(
      abbreviateStorePath(
        '/Users/dev/.megarepo/github.com/org/repo/refs/commits/abc123def456789012345678901234567890abcd',
      ),
    ).toBe('org/repo@abc123def456789012345678901234567890abcd')
  })

  test('trailing slash', () => {
    expect(
      abbreviateStorePath('/Users/dev/.megarepo/github.com/alice/dev-workspace/refs/heads/main/'),
    ).toBe('alice/dev-workspace@main')
  })

  test('fallback to last path segment', () => {
    expect(abbreviateStorePath('/some/random/path/my-workspace')).toBe('my-workspace')
  })

  test('fallback root path', () => {
    expect(abbreviateStorePath('/')).toBe('/')
  })
})

describe('canonical mutation write boundaries', () => {
  test('fresh commit materialization permits only its exact root and repos directory', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const temp = yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
        const canonical = `${temp}/store/example.com/org/repo/refs/commits/${'a'.repeat(40)}`
        yield* fs.makeDirectory(canonical, { recursive: true })
        const deny = (target: string, materializedRoot = canonical) =>
          Effect.gen(function* () {
            const error = yield* assertCanonicalMutationAllowed({
              target,
              materializedRoot,
            }).pipe(Effect.flip)
            expect(error.reason._tag).toBe('PermissionDenied')
          })
        yield* assertCanonicalMutationAllowed({ target: canonical, materializedRoot: canonical })
        yield* assertCanonicalMutationAllowed({
          target: `${canonical}/repos`,
          materializedRoot: canonical,
        })
        for (const target of [
          `${canonical}/megarepo.json`,
          `${canonical}/megarepo.lock`,
          `${canonical}/flake.lock`,
          `${canonical}/schema/megarepo.schema.json`,
          `${canonical}/repos/child`,
        ]) {
          yield* deny(target)
          expect(yield* fs.exists(target)).toBe(false)
        }
        const sibling = `${canonical}-sibling`
        yield* fs.makeDirectory(sibling)
        yield* deny(sibling)
        yield* deny(`${sibling}/repos`)
        expect(yield* fs.readDirectory(sibling)).toEqual([])
        for (const refType of ['heads', 'tags']) {
          const otherRoot = `${temp}/store/example.com/org/repo/refs/${refType}/main`
          yield* fs.makeDirectory(otherRoot, { recursive: true })
          yield* deny(otherRoot, otherRoot)
          yield* deny(`${otherRoot}/repos`, otherRoot)
          expect(yield* fs.exists(`${otherRoot}/repos`)).toBe(false)
        }
        const preexistingError = yield* assertCanonicalMutationAllowed({
          target: canonical,
        }).pipe(Effect.flip)
        expect(preexistingError.reason._tag).toBe('PermissionDenied')
        expect(yield* fs.readDirectory(canonical)).toEqual([])
        const lockError = yield* writeLockFile({
          lockPath: EffectPath.unsafe.absoluteFile(`${canonical}/megarepo.lock`),
          lockFile: createEmptyLockFile(),
        }).pipe(Effect.flip)
        expect(lockError.reason._tag).toBe('PermissionDenied')
        const generatorError = yield* generateSchema({
          megarepoRoot: EffectPath.unsafe.absoluteDir(`${canonical}/`),
          config: new MegarepoConfig({ members: {} }),
        }).pipe(Effect.flip)
        expect(generatorError.reason._tag).toBe('PermissionDenied')
        expect(yield* fs.readDirectory(canonical)).toEqual([])
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    )
  })

  test('fresh commit materialization denies retargeted root and repos aliases without mutation', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const temp = yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
        const canonical = `${temp}/store/example.com/org/repo/refs/commits/${'a'.repeat(40)}`
        const owned = `${temp}/owned`
        const otherCanonical = `${temp}/store/example.com/org/other/refs/commits/${'b'.repeat(40)}`
        for (const directory of [canonical, owned, otherCanonical]) {
          yield* fs.makeDirectory(directory, { recursive: true })
        }
        const deny = (target: string) =>
          Effect.gen(function* () {
            const error = yield* assertCanonicalMutationAllowed({
              target,
              materializedRoot: canonical,
            }).pipe(Effect.flip)
            expect(error.reason._tag).toBe('PermissionDenied')
          })
        for (const destination of [canonical, owned, otherCanonical, `${owned}/missing`]) {
          yield* fs.symlink(destination, `${canonical}/repos`)
          yield* deny(`${canonical}/repos`)
          yield* fs.remove(`${canonical}/repos`)
        }
        expect(yield* fs.exists(`${owned}/missing`)).toBe(false)
        yield* fs.rename(canonical, `${canonical}-original`)
        yield* fs.symlink(owned, canonical)
        yield* deny(canonical)
        yield* deny(`${canonical}/repos`)
        yield* fs.remove(canonical)
        yield* fs.symlink(otherCanonical, canonical)
        yield* deny(canonical)
        yield* deny(`${canonical}/repos`)
        expect(yield* fs.readDirectory(`${canonical}-original`)).toEqual([])
        expect(yield* fs.readDirectory(owned)).toEqual([])
        expect(yield* fs.readDirectory(otherCanonical)).toEqual([])
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    )
  })

  test('materialization permission cannot escape through self or dangling repos aliases', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mr-materialize-guard-'))
    try {
      const canonical = path.join(root, 'store/example.com/org/repo/refs/heads/team/feature')
      await mkdir(canonical, { recursive: true })
      const run = (target: string, materializationRoot = canonical) =>
        Effect.runPromise(
          assertCanonicalMutationAllowed({ target, materializationRoot }).pipe(
            Effect.provide(NodeServices.layer),
          ),
        )
      await run(canonical)
      await run(`${canonical}/repos`)
      await symlink(canonical, `${canonical}/repos`)
      await expect(run(`${canonical}/repos`)).rejects.toThrow(canonical)
      await rm(`${canonical}/repos`)
      await symlink(`${canonical}/other-missing-directory`, `${canonical}/repos`)
      await expect(run(`${canonical}/repos`)).rejects.toThrow(canonical)
      await expect(readFile(`${canonical}/other-missing-directory`)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      const immutable = path.join(root, 'store/example.com/org/repo/refs/tags/refs/heads/lookalike')
      await mkdir(immutable, { recursive: true })
      await expect(run(immutable, immutable)).rejects.toThrow(immutable)
      await expect(run(`${immutable}/repos`, immutable)).rejects.toThrow(immutable)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('denies canonical aliases and missing outputs, but writes owned files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mr-write-guard-'))
    const previousOverride = process.env['MEGAREPO_ALLOW_CANONICAL_MUTATION']
    process.env['MEGAREPO_ALLOW_CANONICAL_MUTATION'] = 'true'
    try {
      const canonical = path.join(root, 'store/example.com/org/repo/refs/heads/team/feature')
      const alias = path.join(root, 'alias')
      await mkdir(canonical, { recursive: true })
      await symlink(canonical, alias)
      const owned = path.join(root, 'owned')
      await mkdir(owned)
      const lockFile = createEmptyLockFile()
      const run = <TA, TE>(effect: Effect.Effect<TA, TE, FileSystem.FileSystem>) =>
        Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))
      await expect(
        run(
          writeLockFile({
            lockPath: EffectPath.unsafe.absoluteFile(`${alias}/megarepo.lock`),
            lockFile,
          }),
        ),
      ).rejects.toThrow(canonical)
      await expect(readFile(`${canonical}/megarepo.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
      await symlink(`${canonical}/megarepo.lock`, `${owned}/megarepo.lock`)
      await expect(
        run(
          writeLockFile({
            lockPath: EffectPath.unsafe.absoluteFile(`${owned}/megarepo.lock`),
            lockFile,
          }),
        ),
      ).rejects.toThrow(canonical)
      await expect(readFile(`${canonical}/megarepo.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
      await rm(`${owned}/megarepo.lock`)
      await expect(
        run(
          generateSchema({
            megarepoRoot: EffectPath.unsafe.absoluteDir(`${alias}/`),
            config: new MegarepoConfig({ members: {} }),
          }),
        ),
      ).rejects.toThrow('--lock-sync=off')
      await expect(readFile(`${canonical}/schema/megarepo.schema.json`)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await run(
        writeLockFile({
          lockPath: EffectPath.unsafe.absoluteFile(`${owned}/megarepo.lock`),
          lockFile,
        }),
      )
      expect(decodeJson(await readFile(`${owned}/megarepo.lock`, 'utf8'))).toEqual({
        version: 1,
        members: {},
      })
    } finally {
      if (previousOverride === undefined) delete process.env['MEGAREPO_ALLOW_CANONICAL_MUTATION']
      else process.env['MEGAREPO_ALLOW_CANONICAL_MUTATION'] = previousOverride
      await rm(root, { recursive: true, force: true })
    }
  })

  test('preflights file aliases before rewriting other owned member outputs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mr-lock-preflight-'))
    const previousOverride = process.env['MEGAREPO_ALLOW_CANONICAL_MUTATION']
    process.env['MEGAREPO_ALLOW_CANONICAL_MUTATION'] = '0'
    try {
      const owned = path.join(root, 'repos/victim')
      const canonical = path.join(root, 'store/example.com/org/repo/refs/commits/abc')
      await mkdir(owned, { recursive: true })
      await mkdir(canonical, { recursive: true })
      const rev = 'a'.repeat(40)
      const source = `{ inputs.dep.url = "github:acme/dep/main?rev=${'b'.repeat(40)}"; }\n`
      await writeFile(`${canonical}/flake.nix`, source)
      await symlink(`${canonical}/flake.nix`, `${owned}/flake.nix`)
      const originalLock = encodeJson({
        version: 7,
        root: 'root',
        nodes: {
          root: { inputs: { dep: 'dep' } },
          dep: {
            locked: { type: 'git', url: 'https://github.com/acme/dep', rev },
            original: { type: 'git', url: 'https://github.com/acme/dep', ref: 'main' },
          },
        },
      })
      await writeFile(`${owned}/flake.lock`, originalLock)
      await expect(
        Effect.runPromise(
          syncNixLocks({
            megarepoRoot: EffectPath.unsafe.absoluteDir(`${root}/`),
            config: new MegarepoConfig({ members: { victim: './owned' } }),
            lockFile: new LockFile({
              version: 1,
              members: {
                dep: new LockedMember({
                  url: 'https://github.com/acme/dep',
                  ref: 'main',
                  commit: rev,
                  pinned: false,
                  lockedAt: '2026-01-01T00:00:00.000Z',
                }),
              },
            }),
          }).pipe(Effect.provide(NodeServices.layer)),
        ),
      ).rejects.toThrow(canonical)
      expect(await readFile(`${owned}/flake.lock`, 'utf8')).toBe(originalLock)
      expect(await readFile(`${canonical}/flake.nix`, 'utf8')).toBe(source)
    } finally {
      if (previousOverride === undefined) delete process.env['MEGAREPO_ALLOW_CANONICAL_MUTATION']
      else process.env['MEGAREPO_ALLOW_CANONICAL_MUTATION'] = previousOverride
      await rm(root, { recursive: true, force: true })
    }
  })
})
