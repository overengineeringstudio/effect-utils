import { join, relative } from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import {
  captureDeletionIdentity,
  DeletionIdentity,
  PinnedDeletionError,
  withPinnedDeletion,
} from './store-pinned-deletion.ts'

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const base = yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
  const rootPath = `${base}/mutable/admitted`
  const path = `${rootPath}/owner/output`
  yield* fs.makeDirectory(`${path}/nested/deeper`, { recursive: true })
  yield* fs.writeFileString(`${path}/nested/deeper/artifact`, 'original artifact')
  return { fs, base, rootPath, path }
})

// Every race uses real rename/symlink operations while the helper holds its actual directory fds.
describe.skipIf(process.platform !== 'linux')('store pinned deletion', () => {
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
        expect(rootIdentity.dev, '/dev/shm fixture must be on another device than /').not.toBe(
          identity[0]!.dev,
        )
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
        const { fs, base, rootPath, path } = yield* fixture
        const owner = `${rootPath}/owner`
        const detached = `${base}/detached-owner`
        const identity = yield* captureDeletionIdentity({ rootPath, path })
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
})

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
