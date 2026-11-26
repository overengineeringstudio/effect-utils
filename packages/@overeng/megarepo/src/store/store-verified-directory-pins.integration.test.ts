import { spawn } from 'node:child_process'
import { fstatSync, lstatSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import {
  captureDeletionIdentity,
  PinnedDeletionError,
  withVerifiedDirectoryPins,
  type OwnedDeletionPins,
} from './store-pinned-deletion.ts'

const quote = Schema.encodeSync(Schema.fromJsonString(Schema.String))
const quotePaths = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)))

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const base = yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
  const rootPath = `${base}/root`
  const paths = [`${rootPath}/payload`, `${rootPath}/administration`]
  for (const path of paths) {
    yield* fs.makeDirectory(path, { recursive: true })
    yield* fs.writeFileString(`${path}/sentinel`, 'original')
  }
  const targets = yield* Effect.forEach(paths, (path) =>
    captureDeletionIdentity({ rootPath, path }).pipe(
      Effect.map((identity) => ({ rootPath, path, identity })),
    ),
  )
  const state = `${base}/intent`
  yield* fs.writeFileString(state, 'HOLD')
  return { fs, rootPath, paths, targets, state }
})

// This scope never performs physical deletion; every race below mutates only its real fixture.
describe.skipIf(process.platform !== 'linux')('verified directory pin transaction', () => {
  it.effect(
    'commits only after all chains verify, while all descriptors remain held and views are revoked',
    Effect.fnUntraced(
      function* () {
        const { fs, paths, targets, state } = yield* fixture
        let retained: ReadonlyArray<OwnedDeletionPins> = []
        const result = yield* withVerifiedDirectoryPins({
          targets,
          prepare: (views) =>
            Effect.sync(() => {
              retained = views
              expect(Object.isFrozen(views)).toBe(true)
              expect(views).toHaveLength(2)
              for (const [index, view] of views.entries()) {
                const path = paths[index]!
                const pin = view.targetPin(path)
                expect(pin).toBeDefined()
                if (pin === undefined) throw new Error('Engine did not expose its acquired target')
                const target = lstatSync(path, { bigint: true })
                const held = fstatSync(pin.fd, { bigint: true })
                expect(held.dev).toBe(target.dev)
                expect(held.ino).toBe(target.ino)
                expect(readFileSync(`/proc/${pin.pid}/fd/${pin.fd}/sentinel`, 'utf8')).toBe(
                  'original',
                )
                expect(view.targetPin(path)).toBe(pin)
                expect(view.pins.includes(pin)).toBe(true)
                expect(view.targetPin(dirname(path))).toBeUndefined()
                expect(view.targetPin(paths[1 - index]!)).toBeUndefined()
                expect(view.has({ kind: 'fd', ...pin })).toBe(true)
                expect(view.has({ kind: 'cwd', ...pin })).toBe(false)
              }
              expect(views[0]!.targetPin(paths[0]!)!.fd).not.toBe(
                views[1]!.targetPin(paths[1]!)!.fd,
              )
              return 'prepared'
            }),
          commit: (...args: [string]) =>
            Effect.gen(function* () {
              expect(args).toEqual(['prepared'])
              for (const [index, view] of retained.entries()) {
                expect(view.targetPin(paths[index]!)).toBeUndefined()
                for (const pin of view.pins) {
                  expect(view.has({ kind: 'fd', ...pin })).toBe(false)
                  const actual = fstatSync(pin.fd, { bigint: true })
                  expect(actual.dev.toString()).toBe(pin.dev)
                  expect(actual.ino.toString()).toBe(pin.ino)
                }
              }
              expect(yield* fs.readFileString(state)).toBe('HOLD')
              yield* fs.writeFileString(state, 'READY')
              return args[0]
            }),
        })
        expect(result).toBe('prepared')
        expect(yield* fs.readFileString(state)).toBe('READY')
        for (const path of paths)
          expect(yield* fs.readFileString(`${path}/sentinel`)).toBe('original')
        for (const [index, view] of retained.entries()) {
          expect(view.targetPin(paths[index]!)).toBeUndefined()
          for (const pin of view.pins) expect(() => fstatSync(pin.fd)).toThrow()
        }
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'binds the original requested target at acquisition without retargeting on caller mutation',
    Effect.fnUntraced(
      function* () {
        const { fs, rootPath, paths, targets } = yield* fixture
        const requested = `${rootPath}//payload/`
        const target = { ...targets[0]!, path: requested }
        let retained: OwnedDeletionPins | undefined
        let copied: OwnedDeletionPins | undefined
        yield* withVerifiedDirectoryPins({
          targets: [target],
          prepare: (views) =>
            Effect.sync(() => {
              const view = views[0]!
              retained = view
              copied = { ...view }
              const pin = view.targetPin(requested)
              expect(pin).toBeDefined()
              if (pin === undefined) throw new Error('Requested target has no acquired leaf')
              target.path = paths[1]!
              expect(view.targetPin(requested)).toBe(pin)
              expect(view.targetPin(paths[0]!)).toBeUndefined()
              expect(view.targetPin(target.path)).toBeUndefined()
              expect(copied.targetPin(requested)).toBe(pin)
              expect(readFileSync(`/proc/${pin.pid}/fd/${pin.fd}/sentinel`, 'utf8')).toBe(
                'original',
              )
            }),
          commit: () =>
            Effect.sync(() => {
              expect(retained?.targetPin(requested)).toBeUndefined()
              expect(copied?.targetPin(requested)).toBeUndefined()
            }),
        })
        for (const path of paths)
          expect(yield* fs.readFileString(`${path}/sentinel`)).toBe('original')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'exposes each scope’s exact leaf even when separate acquisitions have identical inode evidence',
    Effect.fnUntraced(
      function* () {
        const { paths, targets } = yield* fixture
        yield* withVerifiedDirectoryPins({
          targets: [targets[0]!, targets[0]!],
          prepare: (views) =>
            Effect.sync(() => {
              const left = views[0]!.targetPin(paths[0]!)
              const right = views[1]!.targetPin(paths[0]!)
              expect(left).toBeDefined()
              expect(right).toBeDefined()
              if (left === undefined || right === undefined)
                throw new Error('Acquired leaf missing')
              expect([left.dev, left.ino]).toEqual([right.dev, right.ino])
              expect(left.fd).not.toBe(right.fd)
              expect(views[0]!.has({ kind: 'fd', ...right })).toBe(false)
              expect(views[1]!.has({ kind: 'fd', ...left })).toBe(false)
            }),
          commit: () => Effect.void,
        })
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  for (const changedTarget of [0, 1]) {
    it.effect(
      `keeps HOLD and never commits when target ${changedTarget} changes during prepare`,
      Effect.fnUntraced(
        function* () {
          const { fs, paths, targets, state } = yield* fixture
          const path = paths[changedTarget]!
          let committed = false
          let retained: ReadonlyArray<OwnedDeletionPins> = []
          const result = yield* withVerifiedDirectoryPins({
            targets,
            prepare: (views) =>
              Effect.gen(function* () {
                retained = views
                yield* fs.rename(path, `${path}-detached`)
                yield* fs.makeDirectory(path)
                yield* fs.writeFileString(`${path}/sentinel`, 'replacement')
              }),
            commit: () =>
              Effect.gen(function* () {
                committed = true
                yield* fs.writeFileString(state, 'READY')
              }),
          }).pipe(Effect.result)
          expect(result._tag).toBe('Failure')
          expect(result._tag === 'Failure' && result.failure).toBeInstanceOf(PinnedDeletionError)
          expect(committed).toBe(false)
          expect(yield* fs.readFileString(state)).toBe('HOLD')
          expect(yield* fs.readFileString(`${path}-detached/sentinel`)).toBe('original')
          expect(yield* fs.readFileString(`${path}/sentinel`)).toBe('replacement')
          for (const [index, view] of retained.entries()) {
            expect(view.targetPin(paths[index]!)).toBeUndefined()
            for (const pin of view.pins) {
              expect(view.has({ kind: 'fd', ...pin })).toBe(false)
              expect(() => fstatSync(pin.fd)).toThrow()
            }
          }
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  }

  for (const failDuring of ['prepare', 'commit'] as const) {
    it.effect(
      `revokes views and closes both chains when ${failDuring} throws`,
      Effect.fnUntraced(
        function* () {
          const { fs, paths, targets, state } = yield* fixture
          let retained: ReadonlyArray<OwnedDeletionPins> = []
          let committed = false
          const result = yield* withVerifiedDirectoryPins({
            targets,
            prepare: (views) => {
              retained = views
              if (failDuring === 'prepare') throw new Error('prepare defect')
              return Effect.void
            },
            commit: () => {
              committed = true
              throw new Error('commit defect')
            },
          }).pipe(Effect.exit)
          expect(result._tag).toBe('Failure')
          expect(committed).toBe(failDuring === 'commit')
          expect(yield* fs.readFileString(state)).toBe('HOLD')
          for (const [index, view] of retained.entries()) {
            expect(view.targetPin(paths[index]!)).toBeUndefined()
            for (const pin of view.pins) {
              expect(view.has({ kind: 'fd', ...pin })).toBe(false)
              expect(() => fstatSync(pin.fd)).toThrow()
            }
          }
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  }

  it.effect(
    'refuses empty target lists or a symlink replacement before prepare or commit',
    Effect.fnUntraced(
      function* () {
        const { fs, paths, targets } = yield* fixture
        yield* fs.rename(paths[1]!, `${paths[1]}-detached`)
        yield* fs.symlink(`${paths[1]}-detached`, paths[1]!)
        for (const attempted of [[], targets]) {
          let called = false
          const result = yield* withVerifiedDirectoryPins({
            targets: attempted,
            prepare: () => {
              called = true
              return Effect.void
            },
            commit: () => {
              called = true
              return Effect.void
            },
          }).pipe(Effect.result)
          expect(result._tag).toBe('Failure')
          expect(called).toBe(false)
        }
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'refuses plan-time directory inode replacement where recorded identities bind inodes',
    (context) =>
      Effect.gen(function* () {
        const { fs, paths, targets } = yield* fixture
        if (targets[1]!.identity.at(-1)?._tag === 'OverlayDirectory') {
          return context.skip(
            'Overlay plan identity binds mountId + path, not a persistent inode; post-pin replacement is tested separately',
          )
        }
        yield* fs.rename(paths[1]!, `${paths[1]}-detached`)
        yield* fs.makeDirectory(paths[1]!)
        let called = false
        const result = yield* withVerifiedDirectoryPins({
          targets,
          prepare: () => {
            called = true
            return Effect.void
          },
          commit: () => {
            called = true
            return Effect.void
          },
        }).pipe(Effect.result)
        expect(result._tag).toBe('Failure')
        expect(called).toBe(false)
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect(
    'SIGKILL after durable prepare but before verification leaves intent HOLD, never READY',
    Effect.fnUntraced(
      function* () {
        const { fs, rootPath, paths, state } = yield* fixture
        yield* fs.remove(state)
        const source = `
import { Effect } from ${quote(import.meta.resolve('effect'))}
import * as engine from ${quote(new URL('./store-pinned-deletion.ts', import.meta.url).href)}
import * as fs from 'node:fs'
process.stdin.resume()
const rootPath = ${quote(rootPath)}
const paths = ${quotePaths(paths)}
const state = ${quote(state)}
await Effect.runPromise(Effect.gen(function* () {
  const targets = []
  for (const path of paths)
    targets.push({ rootPath, path, identity: yield* engine.captureDeletionIdentity({ rootPath, path }) })
  return yield* engine.withVerifiedDirectoryPins({
    targets,
    prepare: () => Effect.gen(function* () {
      const fd = fs.openSync(state, 'wx', 0o600)
      try { fs.writeFileSync(fd, 'HOLD'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      const parent = fs.openSync(${quote(dirname(state))}, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
      try { fs.fsyncSync(parent) } finally { fs.closeSync(parent) }
      process.stdout.write('PREPARED\\n')
      return yield* Effect.never
    }),
    commit: () => Effect.sync(() => fs.writeFileSync(state, 'READY')),
  })
}))`
        const child = yield* Effect.acquireRelease(
          Effect.sync(() =>
            spawn(process.execPath, ['--input-type=module', '-e', source], {
              cwd: dirname(fileURLToPath(import.meta.url)),
              stdio: ['pipe', 'pipe', 'pipe'],
            }),
          ),
          (child) =>
            Effect.promise(() => {
              if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
              const { promise, resolve } = Promise.withResolvers<void>()
              child.once('exit', () => resolve())
              child.kill('SIGKILL')
              return promise
            }),
        )
        const ready = yield* Effect.promise(() => {
          const { promise, resolve, reject } = Promise.withResolvers<string>()
          let stdout = ''
          let stderr = ''
          child.stderr!.on('data', (data) => {
            stderr += String(data)
          })
          child.once('error', reject)
          child.once('exit', () => reject(new Error(`Child exited before prepare: ${stderr}`)))
          child.stdout!.on('data', (data) => {
            stdout += String(data)
            if (stdout.includes('\n') === true) resolve(stdout.trim())
          })
          return promise
        }).pipe(Effect.timeout('10 seconds'))
        expect(ready).toBe('PREPARED')
        const signal = yield* Effect.promise(() => {
          const { promise, resolve, reject } = Promise.withResolvers<NodeJS.Signals | null>()
          child.once('exit', (_code, observedSignal) => resolve(observedSignal))
          if (child.kill('SIGKILL') === false) reject(new Error('Failed to signal owned child'))
          return promise
        })
        expect(signal).toBe('SIGKILL')
        expect(yield* fs.readFileString(state)).toBe('HOLD')
        for (const path of paths)
          expect(yield* fs.readFileString(`${path}/sentinel`)).toBe('original')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})
