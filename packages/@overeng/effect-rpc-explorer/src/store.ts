import { Duration } from 'effect'

import type {
  ChannelObservation,
  DeltaFrame,
  DeltaOperation,
  ExplorerBounds,
  ExplorerEvent,
  ExplorerEventInput,
  NormalizedValue,
  RecordEvidence,
  RecordState,
  RequestIdentity,
  RetentionCounters,
  RpcRecord,
  SnapshotFrame,
  Timestamp,
  TraceContext,
  WatchFrame,
} from './model.ts'
import { UnknownDescriptorId } from './model.ts'

const protocolVersion = 'rpc-explorer.v1' as const

type RecordBucket = 'active' | 'completed'
type ResetReason = 'behind' | 'overflow' | 'cleared'

interface RetainedDelta {
  readonly frame: DeltaFrame
  readonly atMillis: number
}

interface SubscriberState {
  readonly frames: Array<WatchFrame>
  closed: boolean
  readonly onFrames?: (() => void) | undefined
}

/** Bounded watch handle; draining transfers queued frames to the caller. */
export interface ExplorerSubscription {
  readonly drain: () => ReadonlyArray<WatchFrame>
  readonly close: () => void
}

/** In-memory single-writer model API exposed to observer and inspector adapters. */
export interface ExplorerStore {
  readonly dispatch: (input: ExplorerEventInput) => ExplorerEvent | undefined
  readonly snapshot: () => SnapshotFrame
  readonly watch: (options?: {
    readonly afterRevision?: number
    readonly onFrames?: () => void
  }) => ExplorerSubscription
  readonly clearHistory: () => number
}

/** Stable identity, bounds, and optional content-free retention telemetry for a store. */
export interface MakeExplorerStoreOptions {
  readonly instanceId: string
  readonly bounds: ExplorerBounds
  readonly onDeltaEvicted?: ((count: number) => void) | undefined
}

const cloneTimestamp = (timestamp: Timestamp): Timestamp => ({ ...timestamp })

const cloneRequestIdentity = (identity: RequestIdentity): RequestIdentity => ({
  ...identity,
  requestId: { ...identity.requestId },
})

const cloneTraceContext = (trace: TraceContext): TraceContext => ({ ...trace })

const cloneNormalizedValue = (value: NormalizedValue): NormalizedValue => {
  switch (value._tag) {
    case 'Null':
      return { _tag: 'Null' }
    case 'Boolean':
    case 'Number':
    case 'String':
    case 'BigInt':
    case 'Bytes':
    case 'Redacted':
    case 'Unsupported':
      return { ...value }
    case 'Array':
      return { _tag: 'Array', value: value.value.map(cloneNormalizedValue) }
    case 'Object': {
      const cloned: Record<string, NormalizedValue> = {}
      for (const key of Object.keys(value.value)) {
        Object.defineProperty(cloned, key, {
          value: cloneNormalizedValue(value.value[key]!),
          enumerable: true,
          configurable: false,
          writable: false,
        })
      }
      return { _tag: 'Object', value: cloned }
    }
    case 'Truncated':
      return value.retained === undefined
        ? { _tag: 'Truncated', reason: value.reason }
        : {
            _tag: 'Truncated',
            reason: value.reason,
            retained: cloneNormalizedValue(value.retained),
          }
  }
}

const cloneObservation = (observation: ChannelObservation): ChannelObservation => {
  if ('captured' in observation) {
    return {
      channel: observation.channel,
      outcome: { ...observation.outcome },
      captured: cloneNormalizedValue(observation.captured),
    }
  }
  switch (observation.outcome._tag) {
    case 'Omitted':
      return {
        channel: observation.channel,
        outcome: { _tag: 'Omitted', source: observation.outcome.source },
      }
    case 'PolicyFault':
      return {
        channel: observation.channel,
        outcome: {
          _tag: 'PolicyFault',
          source: observation.outcome.source,
          fault: observation.outcome.fault,
        },
      }
  }
}

const cloneEventInput = (input: ExplorerEventInput): ExplorerEventInput => {
  switch (input._tag) {
    case 'RequestObserved':
      return {
        ...input,
        at: cloneTimestamp(input.at),
        request: cloneRequestIdentity(input.request),
        ...(input.trace === undefined ? {} : { trace: cloneTraceContext(input.trace) }),
        observations: input.observations.map(cloneObservation),
      }
    case 'TerminalObserved':
      return {
        ...input,
        at: cloneTimestamp(input.at),
        request: cloneRequestIdentity(input.request),
        observations: input.observations.map(cloneObservation),
      }
    case 'ChunkObserved':
      return {
        ...input,
        at: cloneTimestamp(input.at),
        request: cloneRequestIdentity(input.request),
        values: input.values.map(cloneObservation),
      }
    case 'SendAttempted':
    case 'SendSucceeded':
    case 'SendFailed':
    case 'AckObserved':
    case 'InterruptObserved':
      return {
        ...input,
        at: cloneTimestamp(input.at),
        request: cloneRequestIdentity(input.request),
      }
    case 'ConnectionFault':
      return { ...input, at: cloneTimestamp(input.at) }
  }
}

const cloneExplorerEvent = (event: ExplorerEvent): ExplorerEvent => {
  switch (event._tag) {
    case 'RequestObserved':
      return {
        ...event,
        at: cloneTimestamp(event.at),
        request: cloneRequestIdentity(event.request),
        ...(event.trace === undefined ? {} : { trace: cloneTraceContext(event.trace) }),
        observations: event.observations.map(cloneObservation),
      }
    case 'TerminalObserved':
      return {
        ...event,
        at: cloneTimestamp(event.at),
        request: cloneRequestIdentity(event.request),
        observations: event.observations.map(cloneObservation),
      }
    case 'ChunkObserved':
      return {
        ...event,
        at: cloneTimestamp(event.at),
        request: cloneRequestIdentity(event.request),
        values: event.values.map(cloneObservation),
      }
    case 'SendAttempted':
    case 'SendSucceeded':
    case 'SendFailed':
    case 'AckObserved':
    case 'InterruptObserved':
    case 'LateEvent':
      return {
        ...event,
        at: cloneTimestamp(event.at),
        request: cloneRequestIdentity(event.request),
      }
    case 'ConnectionFault':
      return { ...event, at: cloneTimestamp(event.at) }
  }
}

const cloneRecordEvidence = (evidence: RecordEvidence): RecordEvidence => ({ ...evidence })

const coalesceValuesTruncatedEvidence = ({
  evidence,
  count,
}: {
  readonly evidence: ReadonlyArray<RecordEvidence>
  readonly count: number
}): ReadonlyArray<RecordEvidence> => {
  const retained: Array<RecordEvidence> = []
  let total = count
  for (const item of evidence) {
    if (item._tag === 'ValuesTruncated') total += item.count
    else retained.push(item)
  }
  retained.push({ _tag: 'ValuesTruncated', count: total })
  return retained
}

const cloneRpcRecord = (record: RpcRecord): RpcRecord => ({
  ...record,
  key: cloneRequestIdentity(record.key),
  startedAt: cloneTimestamp(record.startedAt),
  lastAt: cloneTimestamp(record.lastAt),
  ...(record.trace === undefined ? {} : { trace: cloneTraceContext(record.trace) }),
  events: [...record.events],
  evidence: record.evidence.map(cloneRecordEvidence),
})

const cloneCounters = (counters: RetentionCounters): RetentionCounters => ({ ...counters })

const cloneDeltaOperation = (operation: DeltaOperation): DeltaOperation => {
  switch (operation._tag) {
    case 'UpsertRecord':
      return { ...operation, record: cloneRpcRecord(operation.record) }
    case 'RemoveRecord':
      return { ...operation, key: cloneRequestIdentity(operation.key) }
    case 'AppendEvent':
      return { ...operation, event: cloneExplorerEvent(operation.event) }
    case 'RemoveEvent':
      return { ...operation }
    case 'CountersChanged':
      return { ...operation, counters: cloneCounters(operation.counters) }
  }
}

const cloneDeltaFrame = (frame: DeltaFrame): DeltaFrame => ({
  ...frame,
  operations: frame.operations.map(cloneDeltaOperation),
})

const identityKey = (identity: RequestIdentity): string =>
  JSON.stringify([
    identity.observerSide,
    identity.connectionId,
    identity.direction,
    identity.requestId._tag,
    identity.requestId.value,
  ])

// oxlint-disable-next-line overeng/named-args -- Comparator callbacks have a fixed positional signature.
const compareIdentity = (left: RequestIdentity, right: RequestIdentity): number => {
  const leftKey = identityKey(left)
  const rightKey = identityKey(right)
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
}

// oxlint-disable-next-line overeng/named-args -- Comparator callbacks have a fixed positional signature.
const compareTimestamp = (left: Timestamp, right: Timestamp): number => {
  const leftNanos = BigInt(left.monotonicNanos)
  const rightNanos = BigInt(right.monotonicNanos)
  return leftNanos < rightNanos ? -1 : leftNanos > rightNanos ? 1 : 0
}

// oxlint-disable-next-line overeng/named-args -- Array comparator callbacks have a fixed positional signature.
const compareRecordStart = (left: RpcRecord, right: RpcRecord): number => {
  const byTime = compareTimestamp(left.startedAt, right.startedAt)
  return byTime === 0 ? compareIdentity(left.key, right.key) : byTime
}

// oxlint-disable-next-line overeng/named-args -- Array comparator callbacks have a fixed positional signature.
const compareRecordCompletion = (left: RpcRecord, right: RpcRecord): number => {
  const byTime = compareTimestamp(left.lastAt, right.lastAt)
  return byTime === 0 ? compareIdentity(left.key, right.key) : byTime
}

const isTerminalState = (state: RecordState): boolean => {
  switch (state) {
    case 'sendFailed':
    case 'succeeded':
    case 'failed':
    case 'defect':
    case 'interrupted':
    case 'uncertain':
    case 'notificationSent':
      return true
    case 'sending':
    case 'sent':
    case 'awaiting':
    case 'streaming':
    case 'cancellationRequested':
      return false
  }
}

const stateForTerminal = (
  outcome: 'success' | 'typedFailure' | 'defect' | 'interrupted',
): RecordState => {
  switch (outcome) {
    case 'success':
      return 'succeeded'
    case 'typedFailure':
      return 'failed'
    case 'defect':
      return 'defect'
    case 'interrupted':
      return 'interrupted'
  }
}

const materializeEvent = ({
  input,
  eventId,
  revision,
}: {
  readonly input: ExplorerEventInput
  readonly eventId: number
  readonly revision: number
}): ExplorerEvent => {
  switch (input._tag) {
    case 'RequestObserved':
      return { ...input, eventId, revision }
    case 'SendAttempted':
      return { ...input, eventId, revision }
    case 'SendSucceeded':
      return { ...input, eventId, revision }
    case 'SendFailed':
      return { ...input, eventId, revision }
    case 'ChunkObserved':
      return { ...input, eventId, revision }
    case 'AckObserved':
      return { ...input, eventId, revision }
    case 'InterruptObserved':
      return { ...input, eventId, revision }
    case 'TerminalObserved':
      return { ...input, eventId, revision }
    case 'ConnectionFault':
      return { ...input, eventId, revision }
  }
}

const recordOperation = ({
  bucket,
  record,
}: {
  readonly bucket: RecordBucket
  readonly record: RpcRecord
}): DeltaOperation => ({
  _tag: 'UpsertRecord',
  bucket,
  record,
})

/** Creates a deterministic bounded store with atomic snapshot/watch registration. */
export const makeExplorerStore = ({
  instanceId,
  bounds,
  onDeltaEvicted,
}: MakeExplorerStoreOptions): ExplorerStore => {
  let revision = 0
  let nextEventId = 1
  const active = new Map<string, RpcRecord>()
  const completed = new Map<string, RpcRecord>()
  const events = new Map<number, ExplorerEvent>()
  const standaloneEventIds: Array<number> = []
  let deltas: Array<RetainedDelta> = []
  const subscribers = new Set<SubscriberState>()
  let counters: RetentionCounters = {
    activeEvicted: 0,
    completedEvicted: 0,
    streamValuesTruncated: 0,
    subscriberResets: 0,
  }

  const snapshot = (): SnapshotFrame => ({
    _tag: 'Snapshot',
    protocolVersion,
    instanceId,
    revision,
    active: [...active.values()].toSorted(compareRecordStart).map(cloneRpcRecord),
    completed: [...completed.values()].toSorted(compareRecordCompletion).map(cloneRpcRecord),
    events: [...events.values()]
      .toSorted((left, right) => left.eventId - right.eventId)
      .map(cloneExplorerEvent),
    counters: cloneCounters(counters),
  })

  const resetPrefix = (reason: ResetReason): ReadonlyArray<WatchFrame> => [
    {
      _tag: 'Reset',
      protocolVersion,
      reason,
      revision,
    },
    snapshot(),
  ]

  const setRecord = ({
    bucket,
    record,
    operations,
  }: {
    readonly bucket: RecordBucket
    readonly record: RpcRecord
    readonly operations: Array<DeltaOperation>
  }): void => {
    const key = identityKey(record.key)
    // A record's event history and the replay needed to reconstruct it share one finite depth.
    const boundedRecord =
      record.events.length <= bounds.deltas.maxCount
        ? record
        : {
            ...record,
            events: record.events.slice(Math.max(0, record.events.length - bounds.deltas.maxCount)),
          }
    if (bucket === 'active') active.set(key, boundedRecord)
    else completed.set(key, boundedRecord)
    operations.push(recordOperation({ bucket, record: boundedRecord }))
  }

  const removeRecord = ({
    bucket,
    record,
    operations,
  }: {
    readonly bucket: RecordBucket
    readonly record: RpcRecord
    readonly operations: Array<DeltaOperation>
  }): void => {
    if (bucket === 'active') active.delete(identityKey(record.key))
    else completed.delete(identityKey(record.key))
    operations.push({ _tag: 'RemoveRecord', bucket, key: record.key })
  }

  const referencedEventIds = (): Set<number> => {
    const referenced = new Set<number>(standaloneEventIds)
    for (const record of active.values()) {
      for (const eventId of record.events) referenced.add(eventId)
    }
    for (const record of completed.values()) {
      for (const eventId of record.events) referenced.add(eventId)
    }
    return referenced
  }

  const removeUnreferencedEvents = (operations: Array<DeltaOperation>): void => {
    const referenced = referencedEventIds()
    for (const eventId of events.keys()) {
      if (referenced.has(eventId) === true) continue
      events.delete(eventId)
      operations.push({ _tag: 'RemoveEvent', eventId })
    }
  }

  const enforceActiveBounds = ({
    now,
    operations,
  }: {
    readonly now: Timestamp
    readonly operations: Array<DeltaOperation>
  }): void => {
    const ordered = [...active.values()].toSorted(compareRecordStart)
    const victims = new Map<
      string,
      { readonly record: RpcRecord; readonly reason: 'count' | 'age' }
    >()

    // Age is idle time since the last observed event, not time since start, so
    // long-lived healthy streams stay active while silent records still expire
    // (decision 0006).
    for (const record of ordered) {
      if (
        now.wallClockMillis - record.lastAt.wallClockMillis >
        Duration.toMillis(bounds.active.maxAge)
      ) {
        victims.set(identityKey(record.key), { record, reason: 'age' })
      }
    }

    const survivors = ordered.filter((record) => victims.has(identityKey(record.key)) === false)
    const excess = Math.max(0, survivors.length - bounds.active.maxCount)
    for (const record of survivors.slice(0, excess)) {
      victims.set(identityKey(record.key), { record, reason: 'count' })
    }

    for (const { record, reason } of victims.values()) {
      removeRecord({ bucket: 'active', record, operations })
      const expired: RpcRecord = {
        ...record,
        state: 'uncertain',
        lastAt: now,
        evidence: [...record.evidence, { _tag: 'RetentionExpired', reason }],
      }
      setRecord({ bucket: 'completed', record: expired, operations })
      counters = {
        activeEvicted: counters.activeEvicted + 1,
        completedEvicted: counters.completedEvicted,
        streamValuesTruncated: counters.streamValuesTruncated,
        subscriberResets: counters.subscriberResets,
      }
    }
  }

  const enforceStandaloneBounds = ({
    now,
    operations,
  }: {
    readonly now: Timestamp
    readonly operations: Array<DeltaOperation>
  }): void => {
    const retained: Array<number> = []
    for (const eventId of standaloneEventIds) {
      const event = events.get(eventId)
      if (
        event !== undefined &&
        now.wallClockMillis - event.at.wallClockMillis <= Duration.toMillis(bounds.completed.maxAge)
      ) {
        retained.push(eventId)
      }
    }
    const bounded = retained.slice(Math.max(0, retained.length - bounds.completed.maxCount))
    standaloneEventIds.splice(0, standaloneEventIds.length, ...bounded)
    removeUnreferencedEvents(operations)
  }

  const enforceCompletedBounds = ({
    now,
    operations,
  }: {
    readonly now: Timestamp
    readonly operations: Array<DeltaOperation>
  }): void => {
    const ordered = [...completed.values()].toSorted(compareRecordCompletion)
    const victims = new Map<string, RpcRecord>()
    for (const record of ordered) {
      if (
        now.wallClockMillis - record.lastAt.wallClockMillis >
        Duration.toMillis(bounds.completed.maxAge)
      ) {
        victims.set(identityKey(record.key), record)
      }
    }
    const survivors = ordered.filter((record) => victims.has(identityKey(record.key)) === false)
    const excess = Math.max(0, survivors.length - bounds.completed.maxCount)
    for (const record of survivors.slice(0, excess)) victims.set(identityKey(record.key), record)

    for (const record of victims.values()) {
      removeRecord({ bucket: 'completed', record, operations })
      counters = {
        activeEvicted: counters.activeEvicted,
        completedEvicted: counters.completedEvicted + 1,
        streamValuesTruncated: counters.streamValuesTruncated,
        subscriberResets: counters.subscriberResets,
      }
    }
    enforceStandaloneBounds({ now, operations })
    removeUnreferencedEvents(operations)
  }

  const retainDelta = ({
    frame,
    atMillis,
  }: {
    readonly frame: DeltaFrame
    readonly atMillis: number
  }): void => {
    const countBeforeTrim = deltas.length + 1
    deltas.push({ frame, atMillis })
    deltas = deltas.filter(
      (entry) => atMillis - entry.atMillis <= Duration.toMillis(bounds.deltas.maxAge),
    )
    if (deltas.length > bounds.deltas.maxCount) {
      deltas = deltas.slice(deltas.length - bounds.deltas.maxCount)
    }
    const evicted = countBeforeTrim - deltas.length
    if (evicted > 0 && onDeltaEvicted !== undefined) {
      try {
        onDeltaEvicted(evicted)
      } catch {
        // Retention telemetry is observational and cannot change application mutation semantics.
      }
    }
  }

  const completeMutation = ({
    fromRevision,
    atMillis,
    operations,
    reset,
  }: {
    readonly fromRevision: number
    readonly atMillis: number
    readonly operations: Array<DeltaOperation>
    readonly reset?: 'cleared' | undefined
  }): DeltaFrame => {
    const overflowing = [...subscribers].filter(
      (subscriber) =>
        subscriber.closed === false &&
        reset === undefined &&
        subscriber.frames.length + 1 > Math.max(2, bounds.subscriberQueue),
    )
    if (overflowing.length > 0) {
      counters = {
        activeEvicted: counters.activeEvicted,
        completedEvicted: counters.completedEvicted,
        streamValuesTruncated: counters.streamValuesTruncated,
        subscriberResets: counters.subscriberResets + overflowing.length,
      }
      operations.push({ _tag: 'CountersChanged', counters })
    }

    const frame: DeltaFrame = {
      _tag: 'Delta',
      protocolVersion,
      fromRevision,
      toRevision: revision,
      operations,
    }
    retainDelta({ frame, atMillis })

    for (const subscriber of subscribers) {
      if (subscriber.closed === true) continue
      if (reset === 'cleared') {
        subscriber.frames.splice(0, subscriber.frames.length, ...resetPrefix('cleared'))
      } else if (overflowing.includes(subscriber) === true) {
        subscriber.frames.splice(0, subscriber.frames.length, ...resetPrefix('overflow'))
      } else {
        subscriber.frames.push(cloneDeltaFrame(frame))
      }
      try {
        subscriber.onFrames?.()
      } catch {
        /* A failed inspector notification cannot interrupt application observation. */
      }
    }
    return frame
  }

  const dispatch = (unsafeInput: ExplorerEventInput): ExplorerEvent | undefined => {
    const input = cloneEventInput(unsafeInput)
    const fromRevision = revision
    const eventId = nextEventId

    if (input._tag === 'RequestObserved') {
      const key = identityKey(input.request)
      if (active.has(key) === true) return undefined

      const operations: Array<DeltaOperation> = []
      const prior = completed.get(key)
      if (prior !== undefined) {
        removeRecord({ bucket: 'completed', record: prior, operations })
      }

      revision += 1
      nextEventId += 1
      const event = materializeEvent({ input, eventId, revision })
      events.set(eventId, event)
      operations.push({ _tag: 'AppendEvent', event })
      const record: RpcRecord = {
        key: input.request,
        descriptorId: input.descriptorId,
        state: 'awaiting',
        notification: input.notification,
        startedAt: input.at,
        lastAt: input.at,
        ...(input.trace === undefined ? {} : { trace: input.trace }),
        send: 'unobserved',
        chunkEnvelopes: 0,
        streamValues: 0,
        retainedStreamValues: 0,
        events: [eventId],
        evidence: input.descriptorId === UnknownDescriptorId ? [{ _tag: 'UnknownDescriptor' }] : [],
      }
      setRecord({ bucket: 'active', record, operations })
      enforceActiveBounds({ now: input.at, operations })
      enforceCompletedBounds({ now: input.at, operations })
      operations.push({ _tag: 'CountersChanged', counters })
      completeMutation({
        fromRevision,
        atMillis: input.at.wallClockMillis,
        operations,
      })
      return cloneExplorerEvent(event)
    }

    if (input._tag === 'ConnectionFault') {
      const operations: Array<DeltaOperation> = []
      revision += 1
      nextEventId += 1
      const event = materializeEvent({ input, eventId, revision })
      events.set(eventId, event)
      standaloneEventIds.push(eventId)
      operations.push({ _tag: 'AppendEvent', event })

      for (const record of active.values()) {
        if (record.key.connectionId !== input.connectionId) continue
        removeRecord({ bucket: 'active', record, operations })
        const uncertain: RpcRecord = {
          ...record,
          state: 'uncertain',
          lastAt: input.at,
          events: [...record.events, eventId],
          evidence: [
            ...record.evidence,
            { _tag: 'ConnectionFault', faultId: input.faultId, fault: input.fault },
          ],
        }
        setRecord({ bucket: 'completed', record: uncertain, operations })
      }

      enforceActiveBounds({ now: input.at, operations })
      enforceCompletedBounds({ now: input.at, operations })
      operations.push({ _tag: 'CountersChanged', counters })
      completeMutation({
        fromRevision,
        atMillis: input.at.wallClockMillis,
        operations,
      })
      return cloneExplorerEvent(event)
    }

    const key = identityKey(input.request)
    const current = active.get(key)
    if (current === undefined) {
      if (input._tag !== 'TerminalObserved') return undefined
      const priorTerminal = completed.get(key)
      if (priorTerminal === undefined || isTerminalState(priorTerminal.state) === false) {
        return undefined
      }

      const operations: Array<DeltaOperation> = []
      revision += 1
      nextEventId += 1
      const event: ExplorerEvent = {
        _tag: 'LateEvent',
        eventId,
        revision,
        at: input.at,
        request: input.request,
        eventTag: 'TerminalObserved',
      }
      events.set(eventId, event)
      operations.push({ _tag: 'AppendEvent', event })
      const updated: RpcRecord = {
        ...priorTerminal,
        lastAt: input.at,
        events: [...priorTerminal.events, eventId],
        evidence: [...priorTerminal.evidence, { _tag: 'LateEvent', eventTag: 'TerminalObserved' }],
      }
      setRecord({ bucket: 'completed', record: updated, operations })
      enforceCompletedBounds({ now: input.at, operations })
      operations.push({ _tag: 'CountersChanged', counters })
      completeMutation({
        fromRevision,
        atMillis: input.at.wallClockMillis,
        operations,
      })
      return cloneExplorerEvent(event)
    }

    revision += 1
    nextEventId += 1
    const operations: Array<DeltaOperation> = []
    let retainedInput = input
    let updated: RpcRecord

    switch (input._tag) {
      case 'SendAttempted':
        updated = {
          ...current,
          state: 'sending',
          send: 'attempted',
          lastAt: input.at,
          events: [...current.events, eventId],
        }
        break
      case 'SendSucceeded':
        updated = {
          ...current,
          state: current.notification === true ? 'notificationSent' : 'sent',
          send: 'sent',
          lastAt: input.at,
          events: [...current.events, eventId],
        }
        break
      case 'SendFailed':
        updated = {
          ...current,
          state: 'sendFailed',
          send: 'failed',
          lastAt: input.at,
          events: [...current.events, eventId],
        }
        break
      case 'ChunkObserved': {
        const capacity = Math.max(0, bounds.streamValuesPerRecord - current.retainedStreamValues)
        const values = input.values.slice(0, Math.min(capacity, input.valueCount))
        const truncated = Math.max(0, input.valueCount - values.length)
        retainedInput = { ...input, values }
        updated = {
          ...current,
          state: 'streaming',
          lastAt: input.at,
          chunkEnvelopes: current.chunkEnvelopes + 1,
          streamValues: current.streamValues + input.valueCount,
          retainedStreamValues: current.retainedStreamValues + values.length,
          events: [...current.events, eventId],
          evidence:
            truncated === 0
              ? current.evidence
              : coalesceValuesTruncatedEvidence({
                  evidence: current.evidence,
                  count: truncated,
                }),
        }
        if (truncated > 0) {
          counters = {
            activeEvicted: counters.activeEvicted,
            completedEvicted: counters.completedEvicted,
            streamValuesTruncated: counters.streamValuesTruncated + truncated,
            subscriberResets: counters.subscriberResets,
          }
        }
        break
      }
      case 'AckObserved':
        updated = { ...current, lastAt: input.at, events: [...current.events, eventId] }
        break
      case 'InterruptObserved':
        updated = {
          ...current,
          state: 'cancellationRequested',
          lastAt: input.at,
          events: [...current.events, eventId],
        }
        break
      case 'TerminalObserved':
        updated = {
          ...current,
          state: stateForTerminal(input.outcome),
          lastAt: input.at,
          events: [...current.events, eventId],
        }
        break
    }

    const event = materializeEvent({ input: retainedInput, eventId, revision })
    events.set(eventId, event)
    operations.push({ _tag: 'AppendEvent', event })
    if (isTerminalState(updated.state) === true) {
      removeRecord({ bucket: 'active', record: current, operations })
      setRecord({ bucket: 'completed', record: updated, operations })
    } else {
      setRecord({ bucket: 'active', record: updated, operations })
    }

    enforceActiveBounds({ now: input.at, operations })
    enforceCompletedBounds({ now: input.at, operations })
    operations.push({ _tag: 'CountersChanged', counters })
    completeMutation({
      fromRevision,
      atMillis: input.at.wallClockMillis,
      operations,
    })
    return cloneExplorerEvent(event)
  }

  const watch = ({
    afterRevision,
    onFrames,
  }: {
    readonly afterRevision?: number
    readonly onFrames?: () => void
  } = {}): ExplorerSubscription => {
    const subscriber: SubscriberState = { frames: [], closed: false, onFrames }
    subscribers.add(subscriber)

    if (afterRevision === undefined) {
      subscriber.frames.push(snapshot())
    } else if (afterRevision === revision) {
      // The empty replay prefix is valid; future mutations begin at this revision.
    } else {
      const replay = deltas
        .map((entry) => entry.frame)
        .filter((frame) => frame.toRevision > afterRevision)
      let expected = afterRevision
      const contiguous =
        replay.length > 0 &&
        replay.every((frame) => {
          if (frame.fromRevision !== expected) return false
          expected = frame.toRevision
          return true
        }) === true
      if (contiguous === true && expected === revision) {
        if (replay.length <= Math.max(2, bounds.subscriberQueue)) {
          subscriber.frames.push(...replay.map(cloneDeltaFrame))
        } else {
          subscriber.frames.push(...resetPrefix('overflow'))
        }
      } else {
        subscriber.frames.push(...resetPrefix('behind'))
      }
    }

    return {
      drain: (): ReadonlyArray<WatchFrame> => subscriber.frames.splice(0),
      close: (): void => {
        if (subscriber.closed === true) return
        subscriber.closed = true
        subscriber.frames.splice(0)
        subscribers.delete(subscriber)
      },
    }
  }

  const clearHistory = (): number => {
    const fromRevision = revision
    const operations: Array<DeltaOperation> = []
    const now = Math.max(
      0,
      ...[...active.values(), ...completed.values()].map((record) => record.lastAt.wallClockMillis),
    )

    for (const record of completed.values()) {
      removeRecord({ bucket: 'completed', record, operations })
    }
    standaloneEventIds.splice(0)
    removeUnreferencedEvents(operations)
    deltas = []
    revision += 1
    operations.push({ _tag: 'CountersChanged', counters })
    completeMutation({
      fromRevision,
      atMillis: now,
      operations,
      reset: 'cleared',
    })
    return revision
  }

  return { dispatch, snapshot, watch, clearHistory }
}
