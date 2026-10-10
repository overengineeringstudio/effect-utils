/**
 * `mr store gc` partial-deletion receipts on a real overlayfs store.
 *
 * The store fixture is copied into a tmpfs lower layer and overlaid at its own
 * path (xino=off, userxattr), so the worktree directory is lower-backed and
 * its quarantine rename fails with EXDEV. An inner tmpfs mount inside the
 * worktree then stops the in-place removal after a sibling is already gone.
 * Mounts live in a private user+mount namespace and never touch host mounts.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Cause, Effect, Exit, Schema } from 'effect'
import * as Cli from 'effect/cli'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { makeConsoleCapture } from '../test-utils/consoleCapture.ts'
import { createStoreFixture } from '../test-utils/store-setup.ts'
import { mrCommand } from './mod.ts'

/** Set inside the re-entered `unshare` child that owns a private user+mount namespace. */
const inPartialNamespace = process.env['MEGAREPO_GC_PARTIAL_NAMESPACE'] === '1'
const NAMESPACE_ARGS = ['--user', '--map-root-user', '--mount']

const overlayProbeScript = [
  'set -e',
  'mkdir "$1/lower" "$1/upper" "$1/merged"',
  'mount -t tmpfs lower "$1/lower"',
  'mount -t tmpfs upper "$1/upper"',
  'mkdir "$1/upper/layer" "$1/upper/work"',
  'mount -t overlay overlay -o "lowerdir=$1/lower,upperdir=$1/upper/layer,workdir=$1/upper/work,xino=off,userxattr" "$1/merged"',
  'mount -t tmpfs inner "$1/merged"',
].join('\n')

if (inPartialNamespace === false) {
  let skipReason: string | undefined
  if (process.platform !== 'linux') {
    skipReason = 'Linux only; pinned deletion is unsupported elsewhere'
  } else {
    // Probe the exact mounts the namespace suite performs; sandboxes without
    // unprivileged user namespaces, tmpfs, or overlayfs userxattr skip explicitly.
    const probeDir = mkdtempSync(join(tmpdir(), 'mr-gc-partial-probe-'))
    try {
      const probe = spawnSync(
        'unshare',
        [...NAMESPACE_ARGS, 'sh', '-c', overlayProbeScript, 'probe', probeDir],
        { env: { ...process.env, LC_ALL: 'C' }, encoding: 'utf8', timeout: 10_000 },
      )
      if (probe.status !== 0) {
        const detail =
          probe.error?.message ??
          (probe.stderr?.trim() || `exit ${probe.status}, signal ${probe.signal}`)
        skipReason = `unprivileged user+mount namespace with tmpfs and overlayfs (xino=off,userxattr) unavailable: ${detail}`
      }
    } finally {
      rmSync(probeDir, { recursive: true, force: true })
    }
  }
  if (skipReason !== undefined)
    console.log(`Skipping store gc partial-deletion namespace suite: ${skipReason}`)
  const describeNamespace = skipReason === undefined ? describe : describe.skip
  describeNamespace(
    `store gc partial deletion namespace${skipReason === undefined ? '' : ` (skipped: ${skipReason})`}`,
    () => {
      it('runs overlay partial-deletion receipts in a private user+mount namespace', () => {
        const file = fileURLToPath(import.meta.url)
        const packageDir = dirname(dirname(dirname(file)))
        const vitestBin = join(
          dirname(fileURLToPath(import.meta.resolve('vitest/package.json'))),
          'vitest.mjs',
        )
        const result = spawnSync(
          'unshare',
          [
            ...NAMESPACE_ARGS,
            process.execPath,
            vitestBin,
            'run',
            relative(packageDir, file),
            '--configLoader',
            'runner',
            '--no-cache',
            '--reporter',
            'verbose',
          ],
          {
            cwd: packageDir,
            env: { ...process.env, MEGAREPO_GC_PARTIAL_NAMESPACE: '1' },
            encoding: 'utf8',
            timeout: 180_000,
          },
        )
        console.log(result.stdout)
        expect(result.error, 'partial-deletion suite requires unshare').toBeUndefined()
        expect(result.status, `partial-deletion namespace suite failed: ${result.stderr}`).toBe(0)
      }, 180_000)
    },
  )
}

/** Mount inside the private namespace; lazy unmount on scope exit tolerates stacked mounts. */
const mountScoped = (args: ReadonlyArray<string>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const result = spawnSync('mount', args, { encoding: 'utf8' })
      expect(
        result.status,
        `mount ${args.join(' ')}: ${result.error?.message ?? result.stderr}`,
      ).toBe(0)
    }),
    () =>
      Effect.sync(() => {
        spawnSync('umount', ['-l', args.at(-1)!], { encoding: 'utf8' })
      }),
  )

const GcJsonOutput = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      status: Schema.String,
      outcome: Schema.optional(Schema.String),
      reason: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
      worklogBytesRemoved: Schema.optional(Schema.Finite),
    }),
  ),
})

describe.skipIf(inPartialNamespace === false)('store gc partial deletion (namespace)', () => {
  it.effect(
    'legacy --all reports a partial receipt and fails when an inner mount stops in-place overlay removal',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const created = yield* createStoreFixture([
          { host: 'github.com', owner: 'acme', repo: 'widget', branches: ['main'] },
        ])
        const worktree = created.worktreePaths['github.com/acme/widget#main']!.replace(/\/$/u, '')
        const tmpRoot = created.storePath.replace(/\/\.megarepo\/$/u, '')
        const layers = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: 'mr-gc-partial-layers-' }),
        )
        const lowerFs = `${layers}/lower-fs`
        const upperFs = `${layers}/upper-fs`
        yield* fs.makeDirectory(lowerFs)
        yield* fs.makeDirectory(upperFs)
        // Acquired after the fixture, so every mount is released before its temp removal.
        yield* mountScoped(['-t', 'tmpfs', 'lower', lowerFs])
        yield* mountScoped(['-t', 'tmpfs', 'upper', upperFs])
        const lower = `${lowerFs}/layer`
        const copy = spawnSync('cp', ['-a', `${tmpRoot}/.`, `${lower}/`], { encoding: 'utf8' })
        expect(copy.status, copy.stderr).toBe(0)
        const mountPoint = `${worktree}/mnt`
        // Lower-only mount point; the worktree itself is lower-backed, so its rename is EXDEV.
        yield* fs.makeDirectory(`${lower}/${relative(tmpRoot, mountPoint)}`)
        yield* fs.makeDirectory(`${upperFs}/layer`)
        yield* fs.makeDirectory(`${upperFs}/work`)
        // Overlay at the fixture's own path keeps every absolute git worktree path valid.
        yield* mountScoped([
          '-t',
          'overlay',
          'overlay',
          '-o',
          `lowerdir=${lower},upperdir=${upperFs}/layer,workdir=${upperFs}/work,xino=off,userxattr`,
          tmpRoot,
        ])
        // Name this before mnt in native readdir's ordering, proving actual partial removal.
        const sibling = `${worktree}/000-sibling`
        yield* fs.writeFileString(sibling, 'removable sibling')
        yield* mountScoped(['-t', 'tmpfs', 'inner', mountPoint])
        yield* fs.writeFileString(`${mountPoint}/survivor`, 'inner mount survives')

        const cwd = yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
        const { consoleLayer, getStdoutLines } = yield* makeConsoleCapture
        const previousStore = process.env['MEGAREPO_STORE']
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            process.env['MEGAREPO_STORE'] = created.storePath
          }),
          () =>
            Effect.sync(() => {
              if (previousStore === undefined) delete process.env['MEGAREPO_STORE']
              else process.env['MEGAREPO_STORE'] = previousStore
            }),
        )
        // --force: the fixture's untracked sibling makes the worktree dirty.
        const exit = yield* Cli.Command.runWith(mrCommand, { version: 'test' })([
          '--cwd',
          `${cwd}/`,
          'store',
          'gc',
          '--all',
          '--force',
          '--output',
          'json',
        ]).pipe(Effect.provide(consoleLayer), Effect.exit)
        const stdout = (yield* getStdoutLines).join('\n')

        expect(Exit.isFailure(exit), 'partial deletion must fail the command').toBe(true)
        if (Exit.isFailure(exit) === true) {
          expect(Cause.pretty(exit.cause)).toContain('deletion was partial')
        }
        const output = Schema.decodeUnknownSync(Schema.fromJsonString(GcJsonOutput))(stdout)
        const row = output.results.find((result) => result.path.replace(/\/$/u, '') === worktree)
        expect(row).toMatchObject({
          status: 'error',
          outcome: 'partial',
          reason: 'deletion-partial',
        })
        expect(row?.message).toBeDefined()
        expect(row?.worklogBytesRemoved).toBeUndefined()
        expect(yield* fs.exists(sibling)).toBe(false)
        expect(yield* fs.readFileString(`${mountPoint}/survivor`)).toBe('inner mount survives')
        expect(yield* fs.exists(worktree)).toBe(true)

        // A fresh plan can remove the remainder even if the interrupted traversal already
        // unlinked .git: the existing broken-worktree path still uses pinned deletion.
        const unmounted = spawnSync('umount', [mountPoint], { encoding: 'utf8' })
        expect(unmounted.status, unmounted.stderr).toBe(0)
        const retryCapture = yield* makeConsoleCapture
        const retry = yield* Cli.Command.runWith(mrCommand, { version: 'test' })([
          '--cwd',
          `${cwd}/`,
          'store',
          'gc',
          '--all',
          '--force',
          '--output',
          'json',
        ]).pipe(Effect.provide(retryCapture.consoleLayer), Effect.exit)
        expect(Exit.isSuccess(retry), Exit.isFailure(retry) ? Cause.pretty(retry.cause) : '').toBe(
          true,
        )
        const retryOutput = Schema.decodeUnknownSync(Schema.fromJsonString(GcJsonOutput))(
          (yield* retryCapture.getStdoutLines).join('\n'),
        )
        expect(
          retryOutput.results.find((result) => result.path.replace(/\/$/u, '') === worktree),
        ).toMatchObject({ status: 'removed' })
        expect(yield* fs.exists(worktree)).toBe(false)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})
