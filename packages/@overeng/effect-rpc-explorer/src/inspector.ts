import { Effect, type Layer, Queue, Schema, Stream } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'

import type { DescriptorSet } from './descriptor-set.ts'
import type { RpcDescriptor } from './descriptor.ts'
import { RpcExplorerObserve } from './descriptor.ts'
import {
  DeltaFrame,
  ExplorerEvent,
  ProtocolVersion,
  ResetFrame,
  RetentionCounters,
  RpcRecord,
} from './model.ts'
import type { SnapshotFrame } from './model.ts'
import type { ExplorerStore } from './store.ts'

const DescriptorChannelWire = Schema.Struct({
  schema: Schema.optionalKey(Schema.Unknown),
  projection: Schema.Literals(['available', 'unavailable', 'bestEffort']),
  warning: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
}).annotate({ identifier: 'RpcExplorer.DescriptorChannelWire' })

/** Serializable descriptor shape; live Schema and Context references never cross the wire. */
export const RpcDescriptorWire = Schema.Struct({
  descriptorId: Schema.NonEmptyString,
  key: Schema.NonEmptyString,
  tag: Schema.String,
  title: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  deprecated: Schema.optionalKey(Schema.Boolean),
  kind: Schema.Literals(['unary', 'stream']),
  observe: Schema.Literals(['include', 'exclude']),
  channels: Schema.Struct({
    requestPayload: DescriptorChannelWire,
    success: DescriptorChannelWire,
    typedFailure: DescriptorChannelWire,
    defect: DescriptorChannelWire,
    streamElement: DescriptorChannelWire,
    streamError: DescriptorChannelWire,
    headers: DescriptorChannelWire,
  }),
  terminal: DescriptorChannelWire,
}).annotate({ identifier: 'RpcExplorer.RpcDescriptorWire' })
export type RpcDescriptorWire = typeof RpcDescriptorWire.Type

/** Snapshot returned by inspector RPCs, enriched with the group's wire descriptors. */
export const InspectorSnapshotFrame = Schema.TaggedStruct('Snapshot', {
  protocolVersion: ProtocolVersion,
  instanceId: Schema.NonEmptyString,
  revision: Schema.Natural,
  descriptorRevision: Schema.Natural,
  descriptors: Schema.Array(RpcDescriptorWire),
  active: Schema.Array(RpcRecord),
  completed: Schema.Array(RpcRecord),
  events: Schema.Array(ExplorerEvent),
  counters: RetentionCounters,
}).annotate({ identifier: 'RpcExplorer.InspectorSnapshotFrame' })
export type InspectorSnapshotFrame = typeof InspectorSnapshotFrame.Type

/** Inspector stream frame schema used by both RPC serialization and NDJSON encoding. */
export const InspectorWatchFrame = Schema.Union([
  InspectorSnapshotFrame,
  DeltaFrame,
  ResetFrame,
]).annotate({ identifier: 'RpcExplorer.InspectorWatchFrame' })
export type InspectorWatchFrame = typeof InspectorWatchFrame.Type

/** Revision returned after completed diagnostic history is cleared. */
export const ClearHistoryResult = Schema.Struct({
  clearedRevision: Schema.Natural,
}).annotate({ identifier: 'RpcExplorer.ClearHistoryResult' })
export type ClearHistoryResult = typeof ClearHistoryResult.Type

/** Returns the current inspector snapshot. */
export const GetSnapshot = Rpc.make('RpcExplorer.GetSnapshot', {
  payload: {},
  success: InspectorSnapshotFrame,
}).annotate(RpcExplorerObserve, false)

/**
 * Streams an atomic snapshot/replay prefix followed by future store frames. A descriptor-set
 * change, or a `descriptorRevision` older than the current one, adds a fresh Snapshot.
 */
export const Watch = Rpc.make('RpcExplorer.Watch', {
  payload: {
    afterRevision: Schema.optionalKey(Schema.Natural),
    descriptorRevision: Schema.optionalKey(Schema.Natural),
  },
  success: InspectorWatchFrame,
  stream: true,
}).annotate(RpcExplorerObserve, false)

/** Clears completed diagnostic history while preserving active records. */
export const ClearHistory = Rpc.make('RpcExplorer.ClearHistory', {
  payload: {},
  success: ClearHistoryResult,
}).annotate(RpcExplorerObserve, false)

/** Public self-inspection RPC group. Every operation opts out of explorer observation. */
export const InspectorRpcGroup = RpcGroup.make(GetSnapshot, Watch, ClearHistory)

const watchFrameJson = Schema.fromJsonString(InspectorWatchFrame)

/** Guards the only protocol major this inspector can safely apply. */
export const isSupportedInspectorProtocolVersion = (
  protocolVersion: unknown,
): protocolVersion is ProtocolVersion => protocolVersion === 'rpc-explorer.v1'

/** Encodes exactly one schema-validated watch frame followed by one LF. */
export const encodeWatchFrameNdjson = (frame: InspectorWatchFrame): string =>
  `${Schema.encodeSync(watchFrameJson)(frame)}\n`

const toWireDescriptor = (descriptor: RpcDescriptor): RpcDescriptorWire => ({
  descriptorId: descriptor.descriptorId,
  key: descriptor.key,
  tag: descriptor.tag,
  ...(descriptor.title === undefined ? {} : { title: descriptor.title }),
  ...(descriptor.summary === undefined ? {} : { summary: descriptor.summary }),
  ...(descriptor.description === undefined ? {} : { description: descriptor.description }),
  ...(descriptor.deprecated === undefined ? {} : { deprecated: descriptor.deprecated }),
  kind: descriptor.kind,
  observe: descriptor.observe,
  channels: descriptor.channels,
  terminal: descriptor.terminal,
})

interface WireDescriptorSet {
  readonly revision: number
  readonly descriptors: ReadonlyArray<RpcDescriptorWire>
}

/** Projects each descriptor-set revision onto the wire once, however many viewers read it. */
const makeWireDescriptors = (descriptors: DescriptorSet): (() => WireDescriptorSet) => {
  let cached: { readonly source: object; readonly wire: WireDescriptorSet } | undefined
  return () => {
    const current = descriptors.current()
    if (cached?.source !== current) {
      cached = {
        source: current,
        wire: {
          revision: current.revision,
          descriptors: current.descriptors.map(toWireDescriptor),
        },
      }
    }
    return cached.wire
  }
}

const withDescriptors = ({
  snapshot,
  descriptors,
}: {
  readonly snapshot: SnapshotFrame
  readonly descriptors: WireDescriptorSet
}): InspectorSnapshotFrame => ({
  ...snapshot,
  descriptorRevision: descriptors.revision,
  descriptors: descriptors.descriptors,
})

const watchStore = ({
  store,
  descriptors,
  afterRevision,
  descriptorRevision,
}: {
  readonly store: ExplorerStore
  readonly descriptors: DescriptorSet
  readonly afterRevision?: number | undefined
  readonly descriptorRevision?: number | undefined
}): Stream.Stream<InspectorWatchFrame> =>
  Stream.unwrap(
    Effect.gen(function* () {
      // A single pending signal is sufficient: draining transfers every queued frame.
      const signal = yield* Queue.dropping<void>(1)
      const wireDescriptors = makeWireDescriptors(descriptors)
      const subscription = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const onFrames = (): void => {
            Queue.offerUnsafe(signal, undefined)
          }
          const unsubscribe = descriptors.subscribe(onFrames)
          const watch = store.watch(
            afterRevision === undefined ? { onFrames } : { afterRevision, onFrames },
          )
          return {
            drain: watch.drain,
            close: () => {
              unsubscribe()
              watch.close()
            },
          }
        }),
        (current) =>
          Effect.sync(() => current.close()).pipe(
            Effect.andThen(Queue.shutdown(signal)),
            Effect.asVoid,
          ),
      )
      // Store frames drained together are contiguous up to the store's current revision, so a
      // Snapshot synthesized right after draining neither skips nor repeats a later Delta.
      let sentDescriptorRevision = descriptorRevision ?? wireDescriptors().revision
      const drain = (): ReadonlyArray<InspectorWatchFrame> => {
        const current = wireDescriptors()
        const frames: Array<InspectorWatchFrame> = subscription.drain().map((frame) => {
          if (frame._tag !== 'Snapshot') return frame
          sentDescriptorRevision = current.revision
          return withDescriptors({ snapshot: frame, descriptors: current })
        })
        if (sentDescriptorRevision !== current.revision) {
          sentDescriptorRevision = current.revision
          frames.push(withDescriptors({ snapshot: store.snapshot(), descriptors: current }))
        }
        return frames
      }

      return Stream.concat(
        Stream.fromIterable(drain()),
        Stream.fromQueue(signal).pipe(Stream.flatMap(() => Stream.fromIterable(drain()))),
      )
    }),
  )

/** Store and logical RPC descriptor set bound to an inspector implementation. */
export interface MakeInspectorGroupOptions {
  readonly store: ExplorerStore
  readonly descriptors: DescriptorSet
}

/** Public inspector declarations and their server handler layer. */
export interface InspectorGroup {
  readonly group: typeof InspectorRpcGroup
  readonly layer: Layer.Layer<Rpc.ToHandler<RpcGroup.Rpcs<typeof InspectorRpcGroup>>>
}

/** Binds the public inspector group to one bounded explorer store. */
export const makeInspectorGroup = ({
  store,
  descriptors,
}: MakeInspectorGroupOptions): InspectorGroup => {
  const wireDescriptors = makeWireDescriptors(descriptors)
  const layer = InspectorRpcGroup.toLayer(
    InspectorRpcGroup.of({
      'RpcExplorer.GetSnapshot': () =>
        Effect.sync(() =>
          withDescriptors({ snapshot: store.snapshot(), descriptors: wireDescriptors() }),
        ),
      'RpcExplorer.Watch': ({ afterRevision, descriptorRevision }) =>
        watchStore({ store, descriptors, afterRevision, descriptorRevision }),
      'RpcExplorer.ClearHistory': () =>
        Effect.sync(() => ({ clearedRevision: store.clearHistory() })),
    }),
  )

  return { group: InspectorRpcGroup, layer }
}
