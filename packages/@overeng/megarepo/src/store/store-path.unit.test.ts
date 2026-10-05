import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'
import type { FileSystem } from 'effect/FileSystem'
import { describe, expect, test } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import { MegarepoConfig } from '../core/config.ts'
import { createEmptyLockFile, LockFile, LockedMember, writeLockFile } from '../core/lock.ts'
import { syncNixLocks } from '../core/nix-lock/mod.ts'
import { generateSchema } from '../generators/schema.ts'
import { decodeJson, encodeJson } from '../test-utils/json.ts'
import { abbreviateStorePath } from './store-path.ts'

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
      const run = <TA, TE>(effect: Effect.Effect<TA, TE, FileSystem>) =>
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
