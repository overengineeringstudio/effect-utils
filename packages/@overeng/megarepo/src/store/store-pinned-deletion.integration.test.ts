import { spawnSync } from 'node:child_process'
import { lstatSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import {
  captureDeletionIdentity,
  DeletionIdentity,
  PinnedDeletionError,
  readDirectoryEvidence,
  withPinnedDeletion,
} from './store-pinned-deletion.ts'

const fixtureIn = (directory?: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const base = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped(directory === undefined ? {} : { directory }),
    )
    const rootPath = `${base}/mutable/admitted`
    const path = `${rootPath}/owner/output`
    yield* fs.makeDirectory(`${path}/nested/deeper`, { recursive: true })
    yield* fs.writeFileString(`${path}/nested/deeper/artifact`, 'original artifact')
    return { fs, base, rootPath, path }
  })
const fixture = fixtureIn()

/** Set inside the re-entered `unshare` child that owns a private user+mount namespace. */
const inOverlayNamespace = process.env['MEGAREPO_PINNED_OVERLAY_NAMESPACE'] === '1'
const NAMESPACE_ARGS = ['--user', '--map-root-user', '--mount']

// Every race uses real rename/symlink operations while the helper holds its actual directory fds.
describe.skipIf(process.platform !== 'linux' || inOverlayNamespace)('store pinned deletion', () => {
  it.effect(
    'removes nested directories through pinned fds without following child symlinks',
    Effect.fnUntraced(
      function* () {
        const { fs, base, rootPath, path } = yield* fixture
        const outside = `${base}/outside`
        yield* fs.makeDirectory(`${outside}/nested`, { recursive: true })
        yield* fs.writeFileString(`${outside}/nested/sentinel`, 'outside survives')
        yield* fs.symlink(outside, `${path}/nested/outside-link`)
        yield* fs.writeFileString(`${rootPath}/owner/sibling`, 'keep sibling')
        const identity = yield* captureDeletionIdentity({ rootPath, path })
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(DeletionIdentity))(
          identity,
        )
        const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(DeletionIdentity))(encoded)
        expect(decoded[0]?.path).toBe('/')
        expect(decoded.at(-1)?.path).toBe(path)
        expect(decoded.some((entry) => entry.path === rootPath)).toBe(true)
        yield* withPinnedDeletion({ rootPath, path, identity: decoded })
        expect(yield* fs.exists(path)).toBe(false)
        expect(yield* fs.readFileString(`${outside}/nested/sentinel`)).toBe('outside survives')
        expect(yield* fs.readFileString(`${rootPath}/owner/sibling`)).toBe('keep sibling')
        expect(yield* fs.readDirectory(`${rootPath}/owner`)).toEqual(['sibling'])
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'allows mounted ancestors above an admitted tmpfs root and unlinks cross-device symlinks',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const base = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ directory: '/dev/shm', prefix: 'mr-pinned-device-' }),
        )
        const outside = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ directory: '/tmp' }))
        const rootPath = `${base}/admitted`
        const path = `${rootPath}/owner/output`
        yield* fs.makeDirectory(`${path}/nested`, { recursive: true })
        yield* fs.writeFileString(`${path}/nested/artifact`, 'remove')
        yield* fs.writeFileString(`${outside}/sentinel`, 'outside survives')
        yield* fs.symlink(outside, `${path}/nested/outside-link`)
        const identity = yield* captureDeletionIdentity({ rootPath, path })
        const rootIdentity = identity.find((entry) => entry.path === rootPath)!
        expect(rootIdentity.mountId, '/dev/shm fixture must be another mount than /').not.toBe(
          identity[0]!.mountId,
        )
        expect(readDirectoryEvidence(rootPath).mountId).toBe(rootIdentity.mountId)
        yield* withPinnedDeletion({ rootPath, path, identity })
        expect(yield* fs.exists(path)).toBe(false)
        expect(yield* fs.readFileString(`${outside}/sentinel`)).toBe('outside survives')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  for (const ancestor of ['mutable', 'mutable/admitted', 'mutable/admitted/owner']) {
    it.effect(
      `refuses an ancestor symlink swap at ${ancestor} immediately before removal`,
      Effect.fnUntraced(
        function* () {
          const { fs, base, rootPath, path } = yield* fixture
          const ancestorPath = `${base}/${ancestor}`
          const detached = `${base}/detached`
          const outside = `${base}/outside`
          const descendant = relative(ancestorPath, path)
          const outsideTarget = join(outside, descendant)
          yield* fs.makeDirectory(`${outsideTarget}/nested/deeper`, { recursive: true })
          yield* fs.writeFileString(`${outsideTarget}/nested/deeper/artifact`, 'outside survives')
          const identity = yield* captureDeletionIdentity({ rootPath, path })
          let callbackRan = false
          const result = yield* withPinnedDeletion({
            rootPath,
            path,
            identity,
            beforeRemove: () =>
              Effect.gen(function* () {
                callbackRan = true
                yield* fs.rename(ancestorPath, detached)
                yield* fs.symlink(outside, ancestorPath)
              }),
          }).pipe(Effect.result)
          expect(callbackRan).toBe(true)
          expect(result._tag).toBe('Failure')
          expect(result._tag === 'Failure' && result.failure).toBeInstanceOf(PinnedDeletionError)
          expect(yield* fs.readFileString(`${outsideTarget}/nested/deeper/artifact`)).toBe(
            'outside survives',
          )
          expect(
            yield* fs.readFileString(`${join(detached, descendant)}/nested/deeper/artifact`),
          ).toBe('original artifact')
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  }

  it.effect(
    'rejects an ancestor replaced between capture and apply even when the target inode is unchanged',
    Effect.fnUntraced(
      function* () {
        // Strict cross-plan inode binding is the non-overlay contract; overlay directories bind
        // by mount + path (covered in the overlay namespace suite), so pin this fixture to tmpfs.
        const { fs, base, rootPath, path } = yield* fixtureIn('/dev/shm')
        const owner = `${rootPath}/owner`
        const detached = `${base}/detached-owner`
        const identity = yield* captureDeletionIdentity({ rootPath, path })
        expect(identity.at(-2)?._tag, '/dev/shm fixture must not be overlayfs').toBe('Inode')
        yield* fs.rename(owner, detached)
        yield* fs.makeDirectory(owner)
        yield* fs.rename(`${detached}/output`, path)
        const changed = yield* captureDeletionIdentity({ rootPath, path })
        expect(changed.at(-1)).toEqual(identity.at(-1))
        expect(changed.at(-2)).not.toEqual(identity.at(-2))
        let callbackRan = false
        const result = yield* withPinnedDeletion({
          rootPath,
          path,
          identity,
          beforeRemove: () =>
            Effect.sync(() => {
              callbackRan = true
            }),
        }).pipe(Effect.result)
        expect(result._tag).toBe('Failure')
        expect(result._tag === 'Failure' && result.failure).toBeInstanceOf(PinnedDeletionError)
        expect(callbackRan).toBe(false)
        expect(yield* fs.readFileString(`${path}/nested/deeper/artifact`)).toBe('original artifact')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'refuses a target symlink swapped after pinning and keeps both trees',
    Effect.fnUntraced(
      function* () {
        const { fs, base, rootPath, path } = yield* fixture
        const outside = `${base}/outside`
        const detached = `${base}/detached-output`
        yield* fs.makeDirectory(outside)
        yield* fs.writeFileString(`${outside}/sentinel`, 'outside survives')
        const identity = yield* captureDeletionIdentity({ rootPath, path })
        const result = yield* withPinnedDeletion({
          rootPath,
          path,
          identity,
          beforeRemove: () =>
            Effect.gen(function* () {
              yield* fs.rename(path, detached)
              yield* fs.symlink(outside, path)
            }),
        }).pipe(Effect.result)
        expect(result._tag).toBe('Failure')
        expect(result._tag === 'Failure' && result.failure).toBeInstanceOf(PinnedDeletionError)
        expect(yield* fs.readFileString(`${outside}/sentinel`)).toBe('outside survives')
        expect(yield* fs.readFileString(`${detached}/nested/deeper/artifact`)).toBe(
          'original artifact',
        )
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'unlinks a substituted intermediate child symlink instead of traversing its outside referent',
    Effect.fnUntraced(
      function* () {
        const { fs, base, rootPath, path } = yield* fixture
        const outside = `${base}/outside`
        const detached = `${base}/detached-child`
        yield* fs.makeDirectory(`${outside}/deeper`, { recursive: true })
        yield* fs.writeFileString(`${outside}/deeper/artifact`, 'outside survives')
        const identity = yield* captureDeletionIdentity({ rootPath, path })
        yield* withPinnedDeletion({
          rootPath,
          path,
          identity,
          beforeRemove: () =>
            Effect.gen(function* () {
              yield* fs.rename(`${path}/nested`, detached)
              yield* fs.symlink(outside, `${path}/nested`)
            }),
        })
        expect(yield* fs.exists(path)).toBe(false)
        expect(yield* fs.readFileString(`${outside}/deeper/artifact`)).toBe('outside survives')
        expect(yield* fs.readFileString(`${detached}/deeper/artifact`)).toBe('original artifact')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'keeps the target when the pinned final authority callback refuses unknown evidence',
    Effect.fnUntraced(
      function* () {
        const { fs, rootPath, path } = yield* fixture
        const identity = yield* captureDeletionIdentity({ rootPath, path })
        const refusal = new PinnedDeletionError({ path, message: 'Final authority is unknown' })
        const result = yield* withPinnedDeletion({
          rootPath,
          path,
          identity,
          beforeRemove: () => Effect.fail(refusal),
        }).pipe(Effect.result)
        expect(result._tag).toBe('Failure')
        expect(result._tag === 'Failure' && result.failure).toBe(refusal)
        expect(yield* fs.readFileString(`${path}/nested/deeper/artifact`)).toBe('original artifact')
        expect(yield* fs.readDirectory(`${rootPath}/owner`)).toEqual(['output'])
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'refuses capture through an existing symlink above the admitted root',
    Effect.fnUntraced(
      function* () {
        const { fs, base, rootPath, path } = yield* fixture
        const alias = `${base}/alias`
        yield* fs.symlink(`${base}/mutable`, alias)
        const result = yield* captureDeletionIdentity({
          rootPath: `${alias}/admitted`,
          path: `${alias}/admitted/owner/output`,
        }).pipe(Effect.result)
        expect(result._tag).toBe('Failure')
        expect(result._tag === 'Failure' && result.failure).toBeInstanceOf(PinnedDeletionError)
        expect(yield* fs.readFileString(`${path}/nested/deeper/artifact`)).toBe('original artifact')
        expect(yield* fs.exists(rootPath)).toBe(true)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'reads directory evidence through one no-follow fd and refuses symlinks and files',
    Effect.fnUntraced(
      function* () {
        const { fs, base, rootPath, path } = yield* fixture
        yield* fs.symlink(rootPath, `${base}/root-link`)
        const evidence = readDirectoryEvidence(path)
        expect(evidence.stat.isDirectory()).toBe(true)
        const identity = yield* captureDeletionIdentity({ rootPath, path })
        expect(evidence.mountId).toBe(identity.at(-1)!.mountId)
        expect(() => readDirectoryEvidence(`${base}/root-link`)).toThrow(PinnedDeletionError)
        expect(() => readDirectoryEvidence(`${path}/nested/deeper/artifact`)).toThrow(
          PinnedDeletionError,
        )
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})

// Overlay and inner-mount fixtures need real mounts. Re-enter this file inside an unprivileged
// user+mount namespace so mounts stay private to the test and never touch host mounts or stores.
const overlayProbeScript = [
  'set -e',
  'mkdir "$1/lower" "$1/upper" "$1/merged"',
  'mount -t tmpfs lower "$1/lower"',
  'mount -t tmpfs upper "$1/upper"',
  'mkdir "$1/upper/layer" "$1/upper/work"',
  'mount -t overlay overlay -o "lowerdir=$1/lower,upperdir=$1/upper/layer,workdir=$1/upper/work,xino=off,userxattr" "$1/merged"',
].join('\n')
if (inOverlayNamespace === false) {
  let skipReason: string | undefined
  if (process.platform !== 'linux') {
    skipReason = 'Linux only; pinned deletion is unsupported elsewhere'
  } else {
    // Probe the exact mounts the namespace suite performs; kernels or sandboxes without
    // unprivileged user namespaces, tmpfs, or overlayfs userxattr support skip explicitly.
    const probeDir = mkdtempSync(join(tmpdir(), 'mr-pinned-overlay-probe-'))
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
    console.log(`Skipping pinned deletion overlay namespace suite: ${skipReason}`)
  const describeNamespace = skipReason === undefined ? describe : describe.skip
  describeNamespace(
    `pinned deletion overlay namespace${skipReason === undefined ? '' : ` (skipped: ${skipReason})`}`,
    () => {
      it('runs overlayfs and inner-mount pinned deletion in a private user+mount namespace', () => {
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
            env: { ...process.env, MEGAREPO_PINNED_OVERLAY_NAMESPACE: '1' },
            encoding: 'utf8',
            timeout: 120_000,
          },
        )
        console.log(result.stdout)
        expect(result.error, 'overlay suite requires unshare').toBeUndefined()
        expect(result.status, `overlay namespace suite failed: ${result.stderr}`).toBe(0)
      }, 120_000)
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

/** Populated lower and upper layers on separate tmpfs mounts, merged by overlayfs with xino=off. */
const overlayFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const base = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: 'mr-pinned-overlay-' }),
  )
  const lowerFs = `${base}/lower-fs`
  const upperFs = `${base}/upper-fs`
  const merged = `${base}/merged`
  for (const directory of [lowerFs, upperFs, merged]) yield* fs.makeDirectory(directory)
  // Layers on different filesystems with xino=off: overlayfs reports per-layer st_dev for
  // non-directories and non-persistent directory inode numbers.
  yield* mountScoped(['-t', 'tmpfs', 'lower', lowerFs])
  yield* mountScoped(['-t', 'tmpfs', 'upper', upperFs])
  const lower = `${lowerFs}/layer`
  const upper = `${upperFs}/layer`
  const output = 'admitted/owner/output'
  yield* fs.makeDirectory(`${lower}/${output}/nested/deeper`, { recursive: true })
  yield* fs.makeDirectory(`${lower}/${output}/lower-only/inner`, { recursive: true })
  yield* fs.writeFileString(`${lower}/${output}/nested/deeper/artifact`, 'lower artifact')
  yield* fs.writeFileString(`${lower}/${output}/lower-only/inner/file`, 'lower file')
  yield* fs.writeFileString(`${lower}/${output}/lower-file`, 'lower file')
  yield* fs.writeFileString(`${lower}/admitted/owner/sibling`, 'keep sibling')
  // Partial fixture: overlay lists upper entries before lower-only ones, so in-place removal
  // unlinks the upper sibling before reaching the lower-only mount point.
  yield* fs.makeDirectory(`${lower}/admitted/owner/partial/mnt`, { recursive: true })
  yield* fs.makeDirectory(`${upper}/admitted/owner/partial`, { recursive: true })
  yield* fs.writeFileString(`${upper}/admitted/owner/partial/sibling`, 'removable sibling')
  yield* fs.makeDirectory(`${upper}/${output}/nested`, { recursive: true })
  yield* fs.makeDirectory(`${upper}/${output}/upper-only`)
  yield* fs.writeFileString(`${upper}/${output}/nested/upper-artifact`, 'upper artifact')
  yield* fs.writeFileString(`${upper}/${output}/upper-only/file`, 'upper file')
  yield* fs.makeDirectory(`${upperFs}/work`)
  yield* mountScoped([
    '-t',
    'overlay',
    'overlay',
    '-o',
    `lowerdir=${lower},upperdir=${upper},workdir=${upperFs}/work,xino=off,userxattr`,
    merged,
  ])
  return {
    fs,
    base,
    lower,
    upperFs,
    merged,
    rootPath: `${merged}/admitted`,
    path: `${merged}/${output}`,
  }
})

describe.skipIf(inOverlayNamespace === false)(
  'store pinned deletion on overlayfs (namespace)',
  () => {
    it.effect(
      'removes merged, lower-only, and upper-only content of a lower-backed overlay target',
      Effect.fnUntraced(
        function* () {
          const { fs, base, lower, rootPath, path } = yield* overlayFixture
          const outside = `${base}/outside`
          yield* fs.makeDirectory(outside)
          yield* fs.writeFileString(`${outside}/sentinel`, 'outside survives')
          yield* fs.symlink(outside, `${path}/nested/outside-link`)
          const evidence = readDirectoryEvidence(path)
          expect(evidence.overlay).toBe(true)
          // The st_dev boundary check this replaces refused exactly these lower-layer files.
          expect(
            lstatSync(`${path}/lower-file`, { bigint: true }).dev,
            'xino=off must report a per-layer st_dev for lower files',
          ).not.toBe(evidence.stat.dev)
          const captured = yield* captureDeletionIdentity({ rootPath, path })
          const identity = yield* Schema.decodeEffect(Schema.fromJsonString(DeletionIdentity))(
            yield* Schema.encodeEffect(Schema.fromJsonString(DeletionIdentity))(captured),
          )
          expect(identity.at(-1)).toEqual({
            _tag: 'OverlayDirectory',
            path,
            mountId: evidence.mountId,
          })
          expect(identity.find((entry) => entry.path === rootPath)?._tag).toBe('OverlayDirectory')
          yield* withPinnedDeletion({ rootPath, path, identity })
          expect(yield* fs.exists(path)).toBe(false)
          expect((yield* fs.readDirectory(`${rootPath}/owner`)).toSorted()).toEqual([
            'partial',
            'sibling',
          ])
          expect(yield* fs.readFileString(`${outside}/sentinel`)).toBe('outside survives')
          // Overlay removal records whiteouts in the upper layer; the lower layer is never written.
          expect(
            yield* fs.readFileString(`${lower}/admitted/owner/output/nested/deeper/artifact`),
          ).toBe('lower artifact')
          expect(
            yield* fs.readFileString(`${lower}/admitted/owner/output/lower-only/inner/file`),
          ).toBe('lower file')
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'quarantines and removes an upper-only overlay target',
      Effect.fnUntraced(
        function* () {
          const { fs, rootPath } = yield* overlayFixture
          const path = `${rootPath}/owner/fresh`
          yield* fs.makeDirectory(`${path}/a/b`, { recursive: true })
          yield* fs.writeFileString(`${path}/a/b/file`, 'upper only')
          const identity = yield* captureDeletionIdentity({ rootPath, path })
          yield* withPinnedDeletion({ rootPath, path, identity })
          expect(yield* fs.exists(path)).toBe(false)
          expect((yield* fs.readDirectory(`${rootPath}/owner`)).toSorted()).toEqual([
            'output',
            'partial',
            'sibling',
          ])
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'refuses an overlay target symlink swapped after pinning and keeps both trees',
      Effect.fnUntraced(
        function* () {
          const { fs, base, rootPath } = yield* overlayFixture
          const path = `${rootPath}/owner/fresh`
          const detached = `${rootPath}/detached`
          const outside = `${base}/outside`
          yield* fs.makeDirectory(`${path}/nested`, { recursive: true })
          yield* fs.writeFileString(`${path}/nested/artifact`, 'original artifact')
          yield* fs.makeDirectory(outside)
          yield* fs.writeFileString(`${outside}/sentinel`, 'outside survives')
          const identity = yield* captureDeletionIdentity({ rootPath, path })
          const result = yield* withPinnedDeletion({
            rootPath,
            path,
            identity,
            beforeRemove: () =>
              Effect.gen(function* () {
                yield* fs.rename(path, detached)
                yield* fs.symlink(outside, path)
              }),
          }).pipe(Effect.result)
          expect(result._tag).toBe('Failure')
          expect(result._tag === 'Failure' && result.failure).toBeInstanceOf(PinnedDeletionError)
          expect(yield* fs.readFileString(`${outside}/sentinel`)).toBe('outside survives')
          expect(yield* fs.readFileString(`${detached}/nested/artifact`)).toBe('original artifact')
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'unlinks a lower-layer file substituted by a symlink without touching its referent',
      Effect.fnUntraced(
        function* () {
          const { fs, base, rootPath, path } = yield* overlayFixture
          const outside = `${base}/outside`
          yield* fs.makeDirectory(outside)
          yield* fs.writeFileString(`${outside}/sentinel`, 'outside survives')
          const identity = yield* captureDeletionIdentity({ rootPath, path })
          yield* withPinnedDeletion({
            rootPath,
            path,
            identity,
            beforeRemove: () =>
              Effect.gen(function* () {
                yield* fs.rename(`${path}/lower-file`, `${rootPath}/moved-file`)
                yield* fs.symlink(outside, `${path}/lower-file`)
              }),
          })
          expect(yield* fs.exists(path)).toBe(false)
          expect(yield* fs.readFileString(`${outside}/sentinel`)).toBe('outside survives')
          expect(yield* fs.readFileString(`${rootPath}/moved-file`)).toBe('lower file')
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'binds overlay plan identity to its mount: a stacked overlay at the same path is refused',
      Effect.fnUntraced(
        function* () {
          const { fs, lower, upperFs, merged, rootPath, path } = yield* overlayFixture
          const identity = yield* captureDeletionIdentity({ rootPath, path })
          yield* fs.makeDirectory(`${upperFs}/layer2`)
          yield* fs.makeDirectory(`${upperFs}/work2`)
          yield* mountScoped([
            '-t',
            'overlay',
            'overlay',
            '-o',
            `lowerdir=${lower},upperdir=${upperFs}/layer2,workdir=${upperFs}/work2,xino=off,userxattr`,
            merged,
          ])
          const replanned = yield* captureDeletionIdentity({ rootPath, path })
          expect(replanned.at(-1)?.path).toBe(path)
          expect(replanned.at(-1)?.mountId).not.toBe(identity.at(-1)?.mountId)
          let callbackRan = false
          const result = yield* withPinnedDeletion({
            rootPath,
            path,
            identity,
            beforeRemove: () =>
              Effect.sync(() => {
                callbackRan = true
              }),
          }).pipe(Effect.result)
          expect(result._tag).toBe('Failure')
          expect(result._tag === 'Failure' && result.failure).toBeInstanceOf(PinnedDeletionError)
          expect(callbackRan).toBe(false)
          expect(yield* fs.readFileString(`${path}/nested/deeper/artifact`)).toBe('lower artifact')
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'reports partial in-place overlay removal after unlinking a sibling and refusing an inner mount',
      Effect.fnUntraced(
        function* () {
          const { fs, rootPath } = yield* overlayFixture
          const path = `${rootPath}/owner/partial`
          const mounted = `${path}/mnt`
          yield* mountScoped(['-t', 'tmpfs', 'inner', mounted])
          yield* fs.writeFileString(`${mounted}/sentinel`, 'mounted survives')
          expect(yield* fs.readDirectory(path)).toEqual(['sibling', 'mnt'])
          const identity = yield* captureDeletionIdentity({ rootPath, path })
          const result = yield* withPinnedDeletion({ rootPath, path, identity }).pipe(Effect.result)
          expect(result._tag).toBe('Failure')
          expect(result._tag === 'Failure' && result.failure).toBeInstanceOf(PinnedDeletionError)
          expect(result._tag === 'Failure' && result.failure.partial).toBe(true)
          expect(yield* fs.exists(`${path}/sibling`)).toBe(false)
          expect(yield* fs.readFileString(`${mounted}/sentinel`)).toBe('mounted survives')
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    const innerMounts = [
      {
        label: 'a tmpfs inside an overlay target',
        // Lower-backed overlay targets are removed in place, so any refusal there is partial.
        partial: true,
        setup: Effect.gen(function* () {
          const { fs, rootPath, path } = yield* overlayFixture
          const mounted = `${path}/nested`
          yield* mountScoped(['-t', 'tmpfs', 'inner', mounted])
          yield* fs.writeFileString(`${mounted}/sentinel`, 'mounted survives')
          return { fs, rootPath, path, sentinel: `${mounted}/sentinel` }
        }),
      },
      {
        label: 'a tmpfs inside a non-overlay target',
        partial: undefined,
        setup: Effect.gen(function* () {
          const { fs, rootPath, path } = yield* fixture
          const mounted = `${path}/nested`
          yield* mountScoped(['-t', 'tmpfs', 'inner', mounted])
          yield* fs.writeFileString(`${mounted}/sentinel`, 'mounted survives')
          return { fs, rootPath, path, sentinel: `${mounted}/sentinel` }
        }),
      },
      {
        // A same-filesystem bind mount keeps st_dev; only the mount ID reveals the boundary.
        label: 'a same-filesystem bind mount inside a non-overlay target',
        partial: undefined,
        setup: Effect.gen(function* () {
          const { fs, base, rootPath, path } = yield* fixture
          const source = `${base}/bind-source`
          yield* fs.makeDirectory(source)
          yield* fs.writeFileString(`${source}/sentinel`, 'mounted survives')
          yield* mountScoped(['--bind', source, `${path}/nested`])
          expect(lstatSync(`${path}/nested`).dev).toBe(lstatSync(path).dev)
          return { fs, rootPath, path, sentinel: `${source}/sentinel` }
        }),
      },
    ]
    for (const { label, partial, setup } of innerMounts) {
      it.effect(
        `refuses to descend into ${label}`,
        Effect.fnUntraced(
          function* () {
            const { fs, rootPath, path, sentinel } = yield* setup
            const identity = yield* captureDeletionIdentity({ rootPath, path })
            const result = yield* withPinnedDeletion({ rootPath, path, identity }).pipe(
              Effect.result,
            )
            expect(result._tag).toBe('Failure')
            expect(result._tag === 'Failure' && result.failure).toBeInstanceOf(PinnedDeletionError)
            expect(yield* fs.readFileString(sentinel)).toBe('mounted survives')
            expect(result._tag === 'Failure' && result.failure.partial).toBe(partial)
          },
          Effect.provide(NodeServices.layer),
          Effect.scoped,
        ),
      )
    }
  },
)

describe.skipIf(process.platform === 'linux')('unsupported pinned deletion platform', () => {
  it.effect(
    'refuses real filesystem capture and removal without a path-based fallback',
    Effect.fnUntraced(
      function* () {
        const { fs, rootPath, path } = yield* fixture
        const captured = yield* captureDeletionIdentity({ rootPath, path }).pipe(Effect.result)
        expect(captured._tag).toBe('Failure')
        expect(captured._tag === 'Failure' && captured.failure).toBeInstanceOf(PinnedDeletionError)
        const removed = yield* withPinnedDeletion({ rootPath, path, identity: [] }).pipe(
          Effect.result,
        )
        expect(removed._tag).toBe('Failure')
        expect(removed._tag === 'Failure' && removed.failure).toBeInstanceOf(PinnedDeletionError)
        expect(yield* fs.readFileString(`${path}/nested/deeper/artifact`)).toBe('original artifact')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})
