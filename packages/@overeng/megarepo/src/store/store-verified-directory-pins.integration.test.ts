import { spawn } from 'node:child_process'
import { fstatSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import { acquireDeletionLease, releaseDeletionLease } from './store-deletion-lease.ts'
import {
  captureDeletionIdentity,
  PinnedDeletionError,
  withVerifiedDirectoryPins,
  type OwnedDeletionPins,
} from './store-pinned-deletion.ts'
import { preparePoolGeneration, withPoolState, type PoolSlot } from './store-pool-state.ts'

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

const poolFixture = (overflow = false) =>
  Effect.gen(function* () {
    const actual = yield* fixture
    const base = EffectPath.unsafe.absoluteDir(`${actual.rootPath}/`)
    const slot: PoolSlot = {
      id: 'slot',
      path: actual.paths[0]!,
      bare: actual.paths[1]!,
      commit: 'a'.repeat(40),
      identity: '',
      charge: overflow === true ? 2 : 64,
      chargeKnown: true,
      generation: 1,
      state: 'preparing',
      token: '',
      barrierToken: '',
      owner: '',
      reason: '',
    }
    yield* withPoolState({
      base,
      limits: {
        maxSlots: overflow === true ? 2 : 1,
        maxBytes: overflow === true ? Number.MAX_SAFE_INTEGER : 256,
      },
      use: (state, save) =>
        save({
          ...state,
          slots:
            overflow === true
              ? [
                  slot,
                  {
                    ...slot,
                    id: 'other',
                    path: `${actual.rootPath}/other`,
                    charge: Number.MAX_SAFE_INTEGER,
                  },
                ]
              : [slot],
        }),
    })
    return { ...actual, base }
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
        for (const path of paths)
          expect(yield* fs.readFileString(`${path}/sentinel`)).toBe('original')
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

  for (const change of [
    'none',
    'root',
    'gvs',
    'cas',
    'budget',
    'overflow',
    'stale',
    'order',
  ] as const) {
    it.effect(
      `pool preparation ${change}: publishes only a verified, fenced, bounded result`,
      Effect.fnUntraced(
        function* () {
          const { fs, base, paths, targets } = yield* poolFixture(change === 'overflow')
          let called = false
          const result = yield* Effect.gen(function* () {
            if (change === 'order') {
              const globalPath = yield* fs.realPath(`${base}/.state/pool`)
              for (const ownerPath of [paths[0]!, globalPath]) {
                yield* Effect.acquireRelease(
                  acquireDeletionLease({ storeBasePath: base, ownerPath, now: Date.now() }),
                  releaseDeletionLease,
                )
              }
            }
            return yield* preparePoolGeneration({
              base,
              id: 'slot',
              generation: change === 'stale' ? 0 : 1,
              targets,
              prepare: () =>
                Effect.gen(function* () {
                  called = true
                  const held = yield* acquireDeletionLease({
                    storeBasePath: base,
                    ownerPath: paths[0]!,
                    now: Date.now(),
                  }).pipe(Effect.result)
                  expect(held._tag).toBe('Failure')
                  // GLOBAL must be free here; ROOT remains continuously held.
                  yield* withPoolState({
                    base,
                    use: (state, save) =>
                      Effect.gen(function* () {
                        expect(state.slots[0]?.state).toBe('preparing')
                        expect(state.slots[0]?.chargeKnown).toBe(false)
                        if (change === 'cas') {
                          const changed = { ...state.slots[0]!, generation: 3 }
                          yield* save({ ...state, slots: [changed] })
                        }
                      }),
                  })
                  if (change === 'root' || change === 'gvs') {
                    const path = paths[change === 'root' ? 0 : 1]!
                    yield* fs.rename(path, `${path}-detached`)
                    yield* fs.makeDirectory(path)
                  }
                  return {
                    identity: 'installed',
                    charge: change === 'budget' ? 257 : change === 'overflow' ? 1 : 80,
                  }
                }),
            })
          }).pipe(Effect.scoped, Effect.result)
          const untouched = change === 'stale' || change === 'order'
          expect(called).toBe(untouched === false)
          if (change === 'order')
            expect(result._tag === 'Failure' && result.failure).toMatchObject({
              _tag: 'DeletionLeaseUnavailableError',
              ownerPath: paths[0],
            })
          expect(result._tag).toBe(change === 'none' ? 'Success' : 'Failure')
          const recorded = yield* withPoolState({
            base,
            use: (state) => Effect.succeed(state.slots[0]!),
          })
          expect(recorded.state).toBe(change === 'none' ? 'ready' : 'preparing')
          expect(recorded.chargeKnown).toBe(change === 'none' || untouched === true)
          expect(recorded.token === '').toBe(change === 'none' || untouched === true)
          if (change === 'none') {
            expect(recorded.generation).toBe(2)
            expect(recorded.charge).toBe(80)
            expect(recorded.identity).toBe('installed')
          }
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  }

  const killedPreparation = (producer: 'engine' | 'pool') =>
    Effect.fnUntraced(
      function* () {
        const { fs, rootPath, paths, state } = yield* producer === 'pool' ? poolFixture() : fixture
        yield* fs.remove(state)
        const source = `
import { Effect } from ${quote(import.meta.resolve('effect'))}
import * as engine from ${quote(new URL('./store-pinned-deletion.ts', import.meta.url).href)}
import { NodeServices } from ${quote(import.meta.resolve('@effect/platform-node'))}
import { EffectPath } from ${quote(import.meta.resolve('@overeng/effect-path'))}
import * as pool from ${quote(new URL('./store-pool-state.ts', import.meta.url).href)}
import * as fs from 'node:fs'
process.stdin.resume()
const rootPath = ${quote(rootPath)}
const paths = ${quotePaths(paths)}
const state = ${quote(state)}
await Effect.runPromise(Effect.gen(function* () {
  const targets = []
  for (const path of paths)
    targets.push({ rootPath, path, identity: yield* engine.captureDeletionIdentity({ rootPath, path }) })
  return yield* ${
    producer === 'engine'
      ? 'engine.withVerifiedDirectoryPins({'
      : `pool.preparePoolGeneration({
    base: EffectPath.unsafe.absoluteDir(rootPath + '/'), id: 'slot', generation: 1,`
  }
    targets,
    prepare: () => Effect.gen(function* () {
      const fd = fs.openSync(state, 'wx', 0o600)
      try { fs.writeFileSync(fd, 'HOLD'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      const parent = fs.openSync(${quote(dirname(state))}, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
      try { fs.fsyncSync(parent) } finally { fs.closeSync(parent) }
      process.stdout.write('PREPARED\\n')
      return yield* Effect.never
    }),
    ${producer === 'engine' ? "commit: () => Effect.sync(() => fs.writeFileSync(state, 'READY'))," : ''}
  })
}).pipe(Effect.provide(NodeServices.layer)))`
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
        if (producer === 'pool') {
          const recorded = yield* withPoolState({
            base: EffectPath.unsafe.absoluteDir(`${rootPath}/`),
            use: (ledger) => Effect.succeed(ledger.slots[0]!),
          })
          expect(recorded.state).toBe('preparing')
          expect(recorded.chargeKnown).toBe(false)
          expect(recorded.token).not.toBe('')
          expect(recorded.generation).toBe(2)
        }
        for (const path of paths)
          expect(yield* fs.readFileString(`${path}/sentinel`)).toBe('original')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    )()
  for (const producer of ['engine', 'pool'] as const) {
    it.effect(`SIGKILL ${producer}: durable prepare remains HOLD, never READY`, () =>
      killedPreparation(producer),
    )
  }
})
