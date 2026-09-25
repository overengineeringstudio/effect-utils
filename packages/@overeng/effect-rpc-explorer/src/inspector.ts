import { Effect, type Layer, Queue, Schema, Stream } from 'effect'
import { Rpc, RpcGroup } from 'effect/unstable/rpc'

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
import type { SnapshotFrame, WatchFrame } from './model.ts'
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

/** Streams an atomic snapshot/replay prefix followed by future store frames. */
export const Watch = Rpc.make('RpcExplorer.Watch', {
  payload: { afterRevision: Schema.optionalKey(Schema.Natural) },
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
  kind: descriptor.kind,
  observe: descriptor.observe,
  channels: descriptor.channels,
  terminal: descriptor.terminal,
})

const withDescriptors = ({
  snapshot,
  descriptors,
}: {
  readonly snapshot: SnapshotFrame
  readonly descriptors: ReadonlyArray<RpcDescriptorWire>
}): InspectorSnapshotFrame => ({ ...snapshot, descriptors })

const toInspectorFrame = ({
  frame,
  descriptors,
}: {
  readonly frame: WatchFrame
  readonly descriptors: ReadonlyArray<RpcDescriptorWire>
}): InspectorWatchFrame =>
  frame._tag === 'Snapshot' ? withDescriptors({ snapshot: frame, descriptors }) : frame

const watchStore = ({
  store,
  descriptors,
  afterRevision,
}: {
  readonly store: ExplorerStore
  readonly descriptors: ReadonlyArray<RpcDescriptorWire>
  readonly afterRevision?: number | undefined
}): Stream.Stream<InspectorWatchFrame> =>
  Stream.unwrap(
    Effect.gen(function* () {
      // A single pending signal is sufficient: draining transfers every queued frame.
      const signal = yield* Queue.dropping<void>(1)
      const subscription = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const onFrames = (): void => {
            Queue.offerUnsafe(signal, undefined)
          }
          return store.watch(
            afterRevision === undefined ? { onFrames } : { afterRevision, onFrames },
          )
        }),
        (current) =>
          Effect.sync(() => current.close()).pipe(
            Effect.andThen(Queue.shutdown(signal)),
            Effect.asVoid,
          ),
      )
      const drain = (): ReadonlyArray<InspectorWatchFrame> =>
        subscription.drain().map((frame) => toInspectorFrame({ frame, descriptors }))

      return Stream.concat(
        Stream.fromIterable(drain()),
        Stream.fromQueue(signal).pipe(Stream.flatMap(() => Stream.fromIterable(drain()))),
      )
    }),
  )

/** Store and logical RPC descriptors bound to an inspector implementation. */
export interface MakeInspectorGroupOptions {
  readonly store: ExplorerStore
  readonly descriptors: ReadonlyArray<RpcDescriptor>
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
  const wireDescriptors = descriptors.map(toWireDescriptor)
  const layer = InspectorRpcGroup.toLayer(
    InspectorRpcGroup.of({
      'RpcExplorer.GetSnapshot': () =>
        Effect.sync(() =>
          withDescriptors({ snapshot: store.snapshot(), descriptors: wireDescriptors }),
        ),
      'RpcExplorer.Watch': ({ afterRevision }) =>
        watchStore({ store, descriptors: wireDescriptors, afterRevision }),
      'RpcExplorer.ClearHistory': () =>
        Effect.sync(() => ({ clearedRevision: store.clearHistory() })),
    }),
  )

  return { group: InspectorRpcGroup, layer }
}
