import { randomUUID } from 'node:crypto'

import { Effect, Exit, Schema, Semaphore, Stream } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as ChildProcess from 'effect/process/ChildProcess'

import { type AbsoluteDirPath } from '@overeng/effect-path'

import * as Git from '../core/git.ts'
import { withPoolRootActionLock } from './git-writer-lock.ts'
import { stopWorktreeBuckDaemons } from './store-buck-daemons.ts'
import { cleanPoolBuckOutput } from './store-buck-maintain.ts'
import { deletionLeasePath, withStoreWorktreeLease } from './store-deletion-lease.ts'
import { captureDeletionIdentity, withVerifiedDirectoryPins } from './store-pinned-deletion.ts'
import { inspectPoolBuckReset, requirePoolBuckDrain } from './store-pool-buck.ts'
import { type PoolHeadHistory } from './store-pool-head-history.ts'
import { poolBytes, runPoolCommand, type runPoolTasks } from './store-pool-install.ts'
import { requireOutsidePoolGlobal } from './store-pool-lock-order.ts'
import {
  PoolPreparation,
  preparePoolRoot,
  inspectPoolRoot,
  withPoolInstallUse,
} from './store-pool-preparation.ts'
import { completePoolUse, beginPoolReset, finishPoolRetarget } from './store-pool-retarget.ts'
import { inspectPoolGitSource, inspectPoolHolders, warmPoolRoot } from './store-pool-roots.ts'
import {
  beginPoolClaim,
  finishPoolClaim,
  PoolError,
  type PoolActor,
  type PoolState,
  type PoolSlot,
  requireDisposablePoolRoot,
  requirePoolPhysicalBirth,
  requirePoolSlotSnapshot,
  withPoolState,
} from './store-pool-state.ts'
import { assertWorktreeHolderEvidenceFresh } from './store-worktree-holder-client.ts'
import { type HolderEvidenceResponse } from './store-worktree-holder-codec.ts'

const Nonempty = Schema.NonEmptyString
const Task = Nonempty.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/u))
const Count = Schema.Finite.check(Schema.makeFilter((n) => Number.isSafeInteger(n) && n > 0))
/** Deployment configuration records actual qualification; shape alone cannot qualify a provider. */
export const PoolControllerConfig = Schema.Struct({
  base: Nonempty,
  bare: Nonempty,
  commit: Nonempty,
  serviceUnit: Nonempty.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9@_.-]*\.service$/u)),
  limits: Schema.Struct({ maxSlots: Count, maxBytes: Count }),
  client: Schema.Struct({ path: Nonempty, producerId: Nonempty, policyId: Nonempty }),
  preparation: PoolPreparation,
  devenvProvider: Nonempty.check(Schema.isPattern(/^\/nix\/store\/[^/]+\/.+$/u)),
  prewarmTasks: Schema.Array(Task),
  buckMaxBytes: Schema.Finite.check(Schema.makeFilter((n) => Number.isSafeInteger(n) && n >= 0)),
  maxIoPsiAvg60: Schema.optional(
    Schema.Finite.check(Schema.makeFilter((n) => Number.isFinite(n) && n > 0 && n <= 100)),
  ),
})
export type PoolControllerConfig = typeof PoolControllerConfig.Type
/** Validated operations accepted by the single-custodian controller. */
export const PoolControllerRequest = Schema.Union([
  Schema.Struct({ operation: Schema.Literal('warm') }),
  Schema.Struct({
    operation: Schema.Literal('run'),
    id: Nonempty,
    tasks: Schema.Array(Task).check(Schema.isMinLength(1)),
  }),
  Schema.Struct({
    operation: Schema.Literal('reset'),
    id: Nonempty,
    mode: Schema.Literals(['warm', 'wiped']),
  }),
])
export type PoolControllerRequest = typeof PoolControllerRequest.Type
const hold = () =>
  new PoolError({ message: 'Physical pool custody or source changed; retained HOLD' })
const capture = (path: string) => captureDeletionIdentity({ rootPath: '/', path })
const drain = (slot: PoolSlot) =>
  stopWorktreeBuckDaemons({ worktreePath: slot.path, reportRaces: false }).pipe(
    Effect.flatMap(requirePoolBuckDrain),
  )

/** One process owns all roots it births. Restart does not adopt any prior root or barrier. */
export const makePoolController = ({
  config,
  base,
}: {
  config: PoolControllerConfig
  base: AbsoluteDirPath
}) =>
  Effect.gen(function* () {
    const gate = yield* Semaphore.make(1)
    const custody = new Map<string, PoolSlot>()
    const saveCandidate = <TError, TRequirements>({
      expected,
      candidate,
    }: {
      expected: PoolSlot
      candidate: (state: PoolState) => Effect.Effect<PoolSlot, TError, TRequirements>
    }) =>
      withPoolState({
        base,
        use: (state, save) =>
          Effect.gen(function* () {
            yield* requirePoolSlotSnapshot({ state, expected })
            const next = yield* candidate(state)
            yield* save({
              ...state,
              slots: state.slots.map((slot) => (slot.id === next.id ? next : slot)),
            })
            custody.set(next.id, next)
            return next
          }),
      })

    /** Native checks and all IO precede short GLOBAL; verification commits while all pins remain held. */
    const prove = <TValue, TError, TRequirements>({
      slot,
      requireIdentity,
      commit,
    }: {
      slot: PoolSlot
      requireIdentity: boolean
      commit: (
        evidence: { response: HolderEvidenceResponse; actor: PoolActor },
        identity: string,
        charge: number,
        history: PoolHeadHistory,
      ) => Effect.Effect<TValue, TError, TRequirements>
    }) =>
      Effect.gen(function* () {
        yield* requireDisposablePoolRoot(slot)
        const admin = yield* Git.getAbsoluteGitDir(slot.path)
        yield* inspectPoolGitSource({ slot, admin })
        const binding = yield* inspectPoolRoot({
          path: slot.path,
          commit: slot.commit,
          base,
          preparation: config.preparation,
        })
        if (requireIdentity === true && binding.identity !== slot.identity) return yield* hold()
        const paths = [...new Set([slot.path, admin, ...binding.backingPaths])]
        const chains = yield* Effect.forEach(paths, capture)
        return yield* withVerifiedDirectoryPins({
          targets: chains.map((identity, index) => ({
            rootPath: '/',
            path: paths[index]!,
            identity,
          })),
          prepare: (pins) =>
            Effect.gen(function* () {
              const current = yield* inspectPoolRoot({
                path: slot.path,
                commit: slot.commit,
                base,
                preparation: config.preparation,
              })
              if (
                binding.identity !== current.identity ||
                binding.backingPaths.length !== current.backingPaths.length ||
                binding.backingPaths.some((path, index) => path !== current.backingPaths[index]) ===
                  true
              )
                return yield* hold()
              yield* inspectPoolGitSource({ slot, admin })
              const evidence = yield* inspectPoolHolders({
                client: config.client,
                chains: chains.slice(0, 2),
                pins,
              })
              yield* requirePoolPhysicalBirth({
                slot,
                birth: { bootId: evidence.actor.bootId, root: chains[0]!, gitAdmin: chains[1]! },
              })
              const charge = Math.max(
                yield* poolBytes({ path: slot.path, kind: 'logical' }),
                yield* poolBytes({ path: slot.path, kind: 'allocated' }),
              )
              return {
                evidence,
                identity: current.identity,
                charge,
                history: current.sourceHistory,
              }
            }),
          commit: ({ evidence, identity, charge, history }) =>
            Effect.gen(function* () {
              yield* assertWorktreeHolderEvidenceFresh(evidence.response)
              return yield* commit(evidence, identity, charge, history)
            }),
        })
      })

    /** Stop the exact cgroup synchronously. An already collected scope is accepted
     * only from systemd's explicit not-found LoadState, never an arbitrary failure. */
    const stopScope = ({ unit, cwd }: { unit: string; cwd: string }) =>
      runPoolCommand({ cwd, command: 'systemctl', args: ['--user', 'stop', unit] }).pipe(
        Effect.catch(() =>
          Effect.scoped(
            Effect.gen(function* () {
              const child = yield* ChildProcess.make(
                'systemctl',
                ['--user', 'show', unit, '--property=LoadState', '--value'],
                { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' },
              )
              const chunks = yield* Stream.runCollect(child.stdout)
              yield* child.exitCode
              if (Buffer.concat(Array.from(chunks)).toString('utf8').trim() !== 'not-found')
                return yield* hold()
            }),
          ),
        ),
      )

    /** Scope execution preserves real process ancestry for normal activation.
     * The whole task cgroup is stopped before any completion, including failure.
     * BindsTo also stops it if the actual controller service dies. */
    const run = ({ path, tasks }: Parameters<typeof runPoolTasks>[0]) => {
      const unit = `mr-pool-task-${randomUUID()}.scope`
      return Effect.gen(function* () {
        const execution = yield* Effect.exit(
          Effect.scoped(
            Effect.gen(function* () {
              const child = yield* ChildProcess.make(
                'systemd-run',
                [
                  '--user',
                  '--scope',
                  `--unit=${unit}`,
                  '--expand-environment=no',
                  '--property=KillMode=control-group',
                  '--property=TimeoutStopSec=30s',
                  `--property=BindsTo=${config.serviceUnit}`,
                  `--property=After=${config.serviceUnit}`,
                  '--',
                  config.devenvProvider,
                  'tasks',
                  'run',
                  ...tasks,
                ],
                {
                  cwd: path,
                  stdin: 'ignore',
                  stdout: 'inherit',
                  stderr: 'inherit',
                  // Bound launcher shutdown so cancellation reaches exact scope-stop.
                  forceKillAfter: '5 seconds',
                },
              )
              const code = yield* child.exitCode
              if (code !== 0)
                return yield* new PoolError({ message: `Pool task scope exited ${code}` })
            }),
          ),
        )
        yield* stopScope({ unit, cwd: path })
        return execution
      }).pipe(Effect.onInterrupt(() => stopScope({ unit, cwd: path }).pipe(Effect.orDie)))
    }

    // Preparation and reset use this same bounded cgroup runner as claimed use.
    // A failed or pressure-interrupted warm must not leave a detached Buck task
    // in the still-live controller service's cgroup.
    const runTasks: typeof runPoolTasks = (request) =>
      run(request).pipe(
        Effect.flatMap((execution) =>
          Exit.isFailure(execution) === true
            ? Effect.failCause(execution.cause)
            : Effect.succeed(execution.value),
        ),
        Effect.mapError(
          (cause) => new PoolError({ message: `Pool task scope failed: ${String(cause)}` }),
        ),
      )

    const reset = ({ slot, mode }: { slot: PoolSlot; mode: 'warm' | 'wiped' }) =>
      Effect.gen(function* () {
        if (slot.state !== 'completed' || slot.commit !== config.commit) return yield* hold()
        const before = yield* inspectPoolRoot({
          path: slot.path,
          commit: slot.commit,
          base,
          preparation: config.preparation,
        })
        const intent = yield* prove({
          slot,
          requireIdentity: true,
          commit: (evidence) =>
            saveCandidate({
              expected: slot,
              candidate: (state) =>
                Effect.gen(function* () {
                  yield* assertWorktreeHolderEvidenceFresh(evidence.response)
                  return yield* beginPoolReset({
                    state,
                    expected: slot,
                    token: slot.token,
                    actor: evidence.actor,
                    commit: slot.commit,
                  })
                }),
            }),
        })
        const observation = yield* inspectPoolBuckReset({
          slot: intent,
          maxBytes: mode === 'wiped' ? 0 : config.buckMaxBytes,
        })
        if (mode === 'wiped' || observation.disposition === 'over-bound') {
          // Stop this root's owned tasks before taking the new cleanup proof:
          // normal teardown may outlive a native snapshot's freshness window.
          yield* runTasks({ path: intent.path, tasks: ['worktree:teardown'] })
          yield* prove({
            slot: intent,
            requireIdentity: true,
            commit: (evidence) =>
              Effect.gen(function* () {
                yield* assertWorktreeHolderEvidenceFresh(evidence.response)
                // Same owner native cleanup, exact isolation; no recursive pool deletion.
                yield* cleanPoolBuckOutput({ slot: intent })
              }),
          })
        }
        yield* preparePoolRoot({ path: intent.path, preparation: config.preparation, runTasks })
        if (config.prewarmTasks.length !== 0)
          yield* runTasks({ path: intent.path, tasks: config.prewarmTasks })
        yield* drain(intent)
        const after = yield* inspectPoolRoot({
          path: intent.path,
          commit: intent.commit,
          base,
          preparation: config.preparation,
        })
        if (
          before.sourceHistory.commit !== after.sourceHistory.commit ||
          before.sourceHistory.digest !== after.sourceHistory.digest ||
          before.sourceHistory.byteLength !== after.sourceHistory.byteLength
        )
          return yield* hold()
        const buck = yield* inspectPoolBuckReset({ slot: intent, maxBytes: config.buckMaxBytes })
        if (mode === 'wiped' || buck.disposition === 'over-bound') {
          yield* prove({
            slot: intent,
            requireIdentity: false,
            commit: () => cleanPoolBuckOutput({ slot: intent }),
          })
          yield* drain(intent)
        }
        const finalBuck = yield* inspectPoolBuckReset({
          slot: intent,
          maxBytes: config.buckMaxBytes,
        })
        if (finalBuck.disposition === 'over-bound') return yield* hold()
        const ready = yield* prove({
          slot: intent,
          requireIdentity: false,
          commit: (evidence, identity, charge, history) =>
            saveCandidate({
              expected: intent,
              candidate: (state) =>
                Effect.gen(function* () {
                  if (
                    history.commit !== before.sourceHistory.commit ||
                    history.digest !== before.sourceHistory.digest ||
                    history.byteLength !== before.sourceHistory.byteLength
                  )
                    return yield* hold()
                  yield* assertWorktreeHolderEvidenceFresh(evidence.response)
                  return yield* finishPoolRetarget({
                    state,
                    intent,
                    prepared: { identity, charge },
                  })
                }),
            }),
        })
        return {
          id: ready.id,
          state: ready.state,
          generation: ready.generation,
          buck: finalBuck,
          mode,
        }
      })

    const dispatch = (request: PoolControllerRequest) =>
      Effect.gen(function* () {
        const started = performance.now()
        yield* requireOutsidePoolGlobal(hold)
        if (request.operation === 'warm') {
          const slot = yield* warmPoolRoot({ ...config, base, runTasks })
          custody.set(slot.id, slot)
          return { id: slot.id, state: slot.state, generation: slot.generation }
        }
        const slot = custody.get(request.id)
        if (slot === undefined) return yield* hold()
        return yield* Effect.gen(function* () {
          yield* withPoolState({
            base,
            use: (state) => requirePoolSlotSnapshot({ state, expected: slot }),
          })
          return yield* withPoolInstallUse({
            base,
            path: slot.path,
            commit: slot.commit,
            preparation: config.preparation,
          })(() =>
            Effect.gen(function* () {
              if (request.operation === 'reset') return yield* reset({ slot, mode: request.mode })
              const intent = yield* saveCandidate({
                expected: slot,
                candidate: () =>
                  beginPoolClaim({
                    slot,
                    identity: slot.identity,
                    owner: `service:${process.pid}`,
                  }),
              })
              const claimed = yield* prove({
                slot: intent,
                requireIdentity: true,
                commit: (evidence, identity) =>
                  saveCandidate({
                    expected: intent,
                    candidate: (state) =>
                      Effect.gen(function* () {
                        yield* assertWorktreeHolderEvidenceFresh(evidence.response)
                        return yield* finishPoolClaim({
                          state,
                          intent,
                          identity,
                          owner: intent.owner,
                          actor: evidence.actor,
                        })
                      }),
                  }),
              })
              const claimedAt = performance.now()
              const execution = yield* run({ path: claimed.path, tasks: request.tasks })
              const taskFinishedAt = performance.now()
              yield* drain(claimed)
              const completed = yield* prove({
                slot: claimed,
                requireIdentity: true,
                commit: (evidence) =>
                  saveCandidate({
                    expected: claimed,
                    candidate: (state) =>
                      Effect.gen(function* () {
                        yield* assertWorktreeHolderEvidenceFresh(evidence.response)
                        return yield* completePoolUse({
                          state,
                          expected: claimed,
                          token: claimed.token,
                          outcome: Exit.isSuccess(execution) === true ? 'success' : 'failure',
                        })
                      }),
                  }),
              })
              return {
                id: completed.id,
                state: completed.state,
                generation: completed.generation,
                success: Exit.isSuccess(execution),
                timings: {
                  claimMs: claimedAt - started,
                  taskMs: taskFinishedAt - claimedAt,
                  completionMs: performance.now() - taskFinishedAt,
                },
              }
            }),
          )
        }).pipe(
          withStoreWorktreeLease({
            storeBasePath: base,
            ownerPath: slot.path,
            bareRepoPath: slot.bare,
            persistentLease: {
              ownerPath: slot.path,
              token: slot.barrierToken,
              leasePath: deletionLeasePath({ storeBasePath: base, ownerPath: slot.path }),
            },
          }),
          withPoolRootActionLock(slot.path),
        )
      })
    // Admission and live cancellation use the kernel's actual some/avg60 sample.
    // No pressure configuration means no probe; configured missing/malformed data
    // is refusal, never zero pressure. The interval is resource monitoring, not a
    // lock, child-completion or quiescence proof.
    const pressure = Effect.gen(function* () {
      const maximum = config.maxIoPsiAvg60
      if (maximum === undefined) return
      const fs = yield* FileSystem.FileSystem
      const contents = yield* fs.readFileString('/proc/pressure/io').pipe(
        Effect.mapError(
          () =>
            new PoolError({
              message: 'Configured IO pressure sample unavailable; retained HOLD',
            }),
        ),
      )
      const line = contents.split('\n').find((value) => value.startsWith('some '))
      const sample =
        /^some avg10=\d+(?:\.\d+)? avg60=(\d+(?:\.\d+)?) avg300=\d+(?:\.\d+)? total=\d+$/u.exec(
          line ?? '',
        )
      const avg60 = sample?.[1] === undefined ? Number.NaN : Number(sample[1])
      if (Number.isFinite(avg60) === false || avg60 < 0 || avg60 > 100 || avg60 >= maximum)
        return yield* new PoolError({
          message: 'Configured IO pressure limit reached or sample malformed; retained HOLD',
        })
    })
    return {
      execute: (request: PoolControllerRequest) =>
        Effect.gen(function* () {
          yield* pressure
          if (config.maxIoPsiAvg60 === undefined) return yield* dispatch(request)
          const monitor = Effect.sleep('1 second').pipe(Effect.andThen(pressure), Effect.forever)
          // raceFirst interrupts the request and awaits its finalizers, including the
          // exact child-scope stop, before returning a pressure failure.
          return yield* Effect.raceFirst(dispatch(request), monitor)
        }).pipe(gate.withPermits(1)),
    }
  })
