import { Schema } from 'effect'

import {
  InspectorWatchFrame,
  type ExplorerEvent,
  type InspectorSnapshotFrame,
  type InspectorWatchFrame as InspectorWatchFrameType,
  type RequestIdentity,
  type RetentionCounters,
  type RpcDescriptorWire,
  type RpcRecord,
} from '@overeng/effect-rpc-explorer'

/** The transport-neutral client consumed by the explorer. Every result is decoded before use. */
export interface ExplorerClient {
  readonly getSnapshot: () => Promise<unknown>
  readonly watch: (afterRevision?: number) => AsyncIterable<unknown>
  readonly clearHistory: () => Promise<unknown>
}

/** Observable transport and recovery state for the explorer surface. */
export type ExplorerConnection =
  | { readonly _tag: 'loading' }
  | { readonly _tag: 'live' }
  | { readonly _tag: 'recovering'; readonly reason: RecoveryReason }
  | { readonly _tag: 'disconnected'; readonly message: string }
  | { readonly _tag: 'error'; readonly message: string }

/** Content-free reason that caused the projection to request a fresh snapshot. */
export type RecoveryReason =
  | 'malformed-frame'
  | 'revision-gap'
  | 'unknown-target'
  | 'behind'
  | 'overflow'
  | 'cleared'
  | 'instanceChanged'

/** One immutable, revision-consistent client-side inspector projection. */
export interface ExplorerProjection {
  readonly instanceId: string | undefined
  readonly revision: number | undefined
  readonly descriptors: ReadonlyMap<string, RpcDescriptorWire>
  readonly active: ReadonlyMap<string, RpcRecord>
  readonly completed: ReadonlyMap<string, RpcRecord>
  readonly events: ReadonlyMap<number, ExplorerEvent>
  readonly counters: RetentionCounters
  readonly connection: ExplorerConnection
  readonly stale: boolean
  readonly resetReason: RecoveryReason | undefined
}

/** Zeroed retention counters used before the first snapshot. */
export const emptyRetentionCounters: RetentionCounters = {
  activeEvicted: 0,
  completedEvicted: 0,
  streamValuesTruncated: 0,
  subscriberResets: 0,
}

/** Stable server snapshot for useSyncExternalStore before transport startup. */
export const initialExplorerProjection: ExplorerProjection = {
  instanceId: undefined,
  revision: undefined,
  descriptors: new Map(),
  active: new Map(),
  completed: new Map(),
  events: new Map(),
  counters: emptyRetentionCounters,
  connection: { _tag: 'loading' },
  stale: true,
  resetReason: undefined,
}

/** Stable identity containing every typed request-key field, including the request-id tag. */
export const recordIdentityKey = (identity: RequestIdentity): string =>
  JSON.stringify([
    identity.observerSide,
    identity.connectionId,
    identity.direction,
    identity.requestId._tag,
    identity.requestId.value,
  ])

const recordsByIdentity = (records: ReadonlyArray<RpcRecord>): ReadonlyMap<string, RpcRecord> =>
  new Map(records.map((record) => [recordIdentityKey(record.key), record] as const))

/** Atomically projects a decoded wire snapshot into indexed immutable maps. */
export const projectionFromSnapshot = (snapshot: InspectorSnapshotFrame): ExplorerProjection => ({
  instanceId: snapshot.instanceId,
  revision: snapshot.revision,
  descriptors: new Map(
    snapshot.descriptors.map((descriptor) => [descriptor.descriptorId, descriptor]),
  ),
  active: recordsByIdentity(snapshot.active),
  completed: recordsByIdentity(snapshot.completed),
  events: new Map(snapshot.events.map((event) => [event.eventId, event])),
  counters: snapshot.counters,
  connection: { _tag: 'live' },
  stale: false,
  resetReason: undefined,
})

/** Transactional delta outcome: applied projection or mandatory recovery. */
export type DeltaApplyResult =
  | { readonly _tag: 'applied'; readonly projection: ExplorerProjection }
  | { readonly _tag: 'recover'; readonly reason: 'revision-gap' | 'unknown-target' }

/**
 * Applies a complete delta transactionally. Maps are copied first and are only
 * exposed after every operation has passed its target checks.
 */
export const applyDelta = ({
  state,
  frame,
}: {
  readonly state: ExplorerProjection
  readonly frame: Extract<InspectorWatchFrameType, { readonly _tag: 'Delta' }>
}): DeltaApplyResult => {
  if (
    state.stale === true ||
    state.revision === undefined ||
    frame.fromRevision !== state.revision ||
    frame.toRevision <= frame.fromRevision
  ) {
    return { _tag: 'recover', reason: 'revision-gap' }
  }

  const active = new Map(state.active)
  const completed = new Map(state.completed)
  const events = new Map(state.events)
  let counters = state.counters

  for (const operation of frame.operations) {
    switch (operation._tag) {
      case 'UpsertRecord': {
        const key = recordIdentityKey(operation.record.key)
        if (operation.bucket === 'active') {
          active.set(key, operation.record)
          completed.delete(key)
        } else {
          completed.set(key, operation.record)
          active.delete(key)
        }
        break
      }
      case 'RemoveRecord': {
        const key = recordIdentityKey(operation.key)
        const bucket = operation.bucket === 'active' ? active : completed
        if (bucket.delete(key) === false) return { _tag: 'recover', reason: 'unknown-target' }
        break
      }
      case 'AppendEvent':
        if (events.has(operation.event.eventId) === true) {
          return { _tag: 'recover', reason: 'unknown-target' }
        }
        events.set(operation.event.eventId, operation.event)
        break
      case 'RemoveEvent':
        if (events.delete(operation.eventId) === false) {
          return { _tag: 'recover', reason: 'unknown-target' }
        }
        break
      case 'CountersChanged':
        counters = operation.counters
        break
    }
  }

  return {
    _tag: 'applied',
    projection: {
      ...state,
      revision: frame.toRevision,
      active,
      completed,
      events,
      counters,
      connection: { _tag: 'live' },
      stale: false,
      resetReason: undefined,
    },
  }
}

/** Applies a decoded watch frame without exposing mixed revisions. */
export const reduceFrame = ({
  state,
  frame,
}: {
  readonly state: ExplorerProjection
  readonly frame: InspectorWatchFrameType
}): DeltaApplyResult => {
  if (frame._tag === 'Snapshot') {
    return {
      _tag: 'applied',
      projection: { ...projectionFromSnapshot(frame), resetReason: state.resetReason },
    }
  }
  if (frame._tag === 'Reset') {
    return {
      _tag: 'applied',
      projection: {
        ...state,
        connection: { _tag: 'recovering', reason: frame.reason },
        stale: true,
        resetReason: frame.reason,
      },
    }
  }
  return applyDelta({ state, frame })
}

const decodeFrame = (input: unknown): InspectorWatchFrameType =>
  Schema.decodeUnknownSync(InspectorWatchFrame)(input)

const messageFromError = (error: unknown): string =>
  error instanceof Error ? error.message : 'Inspector transport failed'

/** Lazy external-store facade consumed by React. */
export interface ExplorerProjectionStore {
  readonly getSnapshot: () => ExplorerProjection
  readonly subscribe: (listener: () => void) => () => void
  readonly reconnect: () => void
  readonly clearHistory: () => Promise<void>
  readonly dispose: () => void
}

/**
 * Keeps clear-induced frames invisible until both the command succeeds and its
 * Reset/Snapshot boundary arrives. Contiguous later deltas advance this staged
 * projection without allowing buffered pre-clear state back into the UI.
 */
interface ClearBarrier {
  succeeded: boolean
  resetSeen: boolean
  needsRecovery: boolean
  staged: ExplorerProjection | undefined
}

/** Creates the lazy, useSyncExternalStore-compatible live client projection. */
export const createExplorerProjectionStore = (client: ExplorerClient): ExplorerProjectionStore => {
  let state = initialExplorerProjection
  let generation = 0
  let iterator: AsyncIterator<unknown> | undefined
  const listeners = new Set<() => void>()
  let clearBarrier: ClearBarrier | undefined

  const publish = (next: ExplorerProjection): void => {
    state = next
    for (const listener of listeners) listener()
  }

  const finishClearBarrier = (): boolean => {
    const barrier = clearBarrier
    if (barrier?.succeeded !== true || barrier.staged === undefined) return false
    clearBarrier = undefined
    publish(barrier.staged)
    return true
  }

  const markRecovering = (reason: RecoveryReason): void =>
    publish({
      ...state,
      connection: { _tag: 'recovering', reason },
      stale: true,
      resetReason: reason,
    })

  const loadSnapshot = async (run: number): Promise<boolean> => {
    try {
      const frame = decodeFrame(await client.getSnapshot())
      if (run !== generation) return false
      if (frame._tag !== 'Snapshot') {
        markRecovering('malformed-frame')
        return false
      }
      publish({ ...projectionFromSnapshot(frame), resetReason: state.resetReason })
      return true
    } catch (error) {
      if (run === generation) {
        publish({
          ...state,
          connection: { _tag: 'error', message: messageFromError(error) },
          stale: true,
        })
      }
      return false
    }
  }

  const recoverClearBarrier = async ({
    barrier,
    runGeneration,
  }: {
    readonly barrier: ClearBarrier
    readonly runGeneration: number
  }): Promise<void> => {
    if (barrier.succeeded === false || barrier.needsRecovery === false) return
    await loadSnapshot(runGeneration)
    if (clearBarrier === barrier) clearBarrier = undefined
  }

  const run = async (runGeneration: number): Promise<void> => {
    if ((await loadSnapshot(runGeneration)) === false) return

    try {
      const iterable = client.watch(state.revision)
      iterator = iterable[Symbol.asyncIterator]()
      // eslint-disable-next-line no-unmodified-loop-condition -- generation is changed by subscription teardown and reconnect callbacks.
      while (runGeneration === generation) {
        // eslint-disable-next-line no-await-in-loop -- AsyncIterable frames must be consumed and projected serially.
        const next = await iterator.next()
        if (next.done === true || runGeneration !== generation) break

        let frame: InspectorWatchFrameType
        try {
          frame = decodeFrame(next.value)
        } catch {
          if (clearBarrier !== undefined) {
            clearBarrier.needsRecovery = true
            clearBarrier.staged = undefined
            // eslint-disable-next-line no-await-in-loop -- recovery must complete before another wire frame is consumed.
            await recoverClearBarrier({ barrier: clearBarrier, runGeneration })
            continue
          }
          markRecovering('malformed-frame')
          // eslint-disable-next-line no-await-in-loop -- snapshot recovery is an ordered projection barrier.
          if ((await loadSnapshot(runGeneration)) === false) return
          continue
        }

        const barrier = clearBarrier
        if (barrier !== undefined) {
          if (frame._tag === 'Reset') {
            if (frame.reason === 'cleared') {
              barrier.resetSeen = true
              barrier.staged = undefined
              publish({
                ...state,
                connection: { _tag: 'recovering', reason: 'cleared' },
                stale: true,
                resetReason: 'cleared',
              })
            } else if (barrier.resetSeen === true) {
              barrier.needsRecovery = true
              barrier.staged = undefined
            }
          } else if (frame._tag === 'Snapshot' && barrier.resetSeen === true) {
            barrier.staged = {
              ...projectionFromSnapshot(frame),
              resetReason: 'cleared',
            }
            finishClearBarrier()
          } else if (frame._tag === 'Delta' && barrier.staged !== undefined) {
            const staged = applyDelta({ state: barrier.staged, frame })
            if (staged._tag === 'applied') {
              barrier.staged = {
                ...staged.projection,
                resetReason: 'cleared',
              }
              finishClearBarrier()
            } else {
              barrier.needsRecovery = true
              barrier.staged = undefined
            }
          }
          // eslint-disable-next-line no-await-in-loop -- clear recovery serializes subsequent frames behind the snapshot.
          await recoverClearBarrier({ barrier, runGeneration })
          continue
        }

        const result = reduceFrame({ state, frame })
        if (result._tag === 'recover') {
          markRecovering(result.reason)
          // eslint-disable-next-line no-await-in-loop -- revision recovery must finish before applying another delta.
          if ((await loadSnapshot(runGeneration)) === false) return
        } else {
          publish(result.projection)
        }
      }
      if (runGeneration === generation) {
        publish({
          ...state,
          connection: { _tag: 'disconnected', message: 'Inspector watch ended' },
        })
      }
    } catch (error) {
      if (runGeneration === generation) {
        publish({
          ...state,
          connection: { _tag: 'disconnected', message: messageFromError(error) },
        })
      }
    }
  }

  const stop = (): void => {
    generation += 1
    const current = iterator
    iterator = undefined
    void current?.return?.()
  }

  const start = (): void => {
    if (clearBarrier !== undefined && clearBarrier.succeeded === false) return
    clearBarrier = undefined
    stop()
    publish({ ...state, connection: { _tag: 'loading' }, stale: true })
    const runGeneration = generation
    void run(runGeneration)
  }

  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      if (listeners.size === 1) start()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) stop()
      }
    },
    reconnect: start,
    clearHistory: async () => {
      const barrier: ClearBarrier = {
        succeeded: false,
        resetSeen: false,
        needsRecovery: false,
        staged: undefined,
      }
      clearBarrier = barrier
      markRecovering('cleared')
      try {
        await client.clearHistory()
        if (clearBarrier !== barrier) return
        barrier.succeeded = true
        if (finishClearBarrier() === true) return
        await recoverClearBarrier({ barrier, runGeneration: generation })
      } catch (error) {
        if (clearBarrier === barrier) clearBarrier = undefined
        publish({
          ...state,
          connection: { _tag: 'error', message: messageFromError(error) },
          stale: true,
        })
        throw error
      }
    },
    dispose: stop,
  }
}
