import { spawn } from 'node:child_process'
import { fstatSync } from 'node:fs'
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
              for (const view of views) {
                const pin = view.pins.at(-1)!
                expect(view.has({ kind: 'fd', ...pin })).toBe(true)
                expect(view.has({ kind: 'cwd', ...pin })).toBe(false)
              }
              expect(views[0]!.pins.at(-1)!.fd).not.toBe(views[1]!.pins.at(-1)!.fd)
              return 'prepared'
            }),
          commit: (...args: [string]) =>
            Effect.gen(function* () {
              expect(args).toEqual(['prepared'])
              for (const view of retained) {
                const pin = view.pins.at(-1)!
                expect(view.has({ kind: 'fd', ...pin })).toBe(false)
                const actual = fstatSync(pin.fd, { bigint: true })
                expect(actual.dev.toString()).toBe(pin.dev)
                expect(actual.ino.toString()).toBe(pin.ino)
              }
              expect(yield* fs.readFileString(state)).toBe('HOLD')
              yield* fs.writeFileString(state, 'READY')
              return args[0]
            }),
        })
        expect(result).toBe('prepared')
        expect(yield* fs.readFileString(state)).toBe('READY')
        for (const path of paths) expect(yield* fs.readFileString(`${path}/sentinel`)).toBe('original')
        for (const view of retained) expect(() => fstatSync(view.pins.at(-1)!.fd)).toThrow()
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
          for (const view of retained) {
            const pin = view.pins.at(-1)!
            expect(view.has({ kind: 'fd', ...pin })).toBe(false)
            expect(() => fstatSync(pin.fd)).toThrow()
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
          const { fs, targets, state } = yield* fixture
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
          for (const view of retained) {
            const pin = view.pins.at(-1)!
            expect(view.has({ kind: 'fd', ...pin })).toBe(false)
            expect(() => fstatSync(pin.fd)).toThrow()
          }
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  }

  it.effect(
    'refuses empty or stale target lists before prepare or commit',
    Effect.fnUntraced(
      function* () {
        const { fs, paths, targets } = yield* fixture
        yield* fs.rename(paths[1]!, `${paths[1]}-detached`)
        yield* fs.makeDirectory(paths[1]!)
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
    'SIGKILL after durable prepare but before verification leaves intent HOLD, never READY',
    Effect.fnUntraced(
      function* () {
        const { fs, rootPath, paths, state } = yield* fixture
        yield* fs.remove(state)
        const quote = Schema.encodeSync(Schema.fromJsonString(Schema.String))
        const quotePaths = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)))
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
            if (stdout.includes('\n')) resolve(stdout.trim())
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
        for (const path of paths) expect(yield* fs.readFileString(`${path}/sentinel`)).toBe('original')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})
