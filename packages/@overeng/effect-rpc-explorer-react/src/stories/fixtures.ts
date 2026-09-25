import type {
  ExplorerEvent,
  InspectorSnapshotFrame,
  InspectorWatchFrame,
  NormalizedValue,
  RecordState,
  RequestIdentity,
  RpcDescriptorWire,
  RpcRecord,
} from '@overeng/effect-rpc-explorer'

import type { ExplorerClient } from '../projection.ts'

/** Stable wall-clock sample shared by deterministic stories. */
export const fixtureNow = 1_795_027_210_000
const baseWallClock = fixtureNow - 12_000

const requestSchema = {
  title: 'Project lookup request',
  description: 'A bounded diagnostic projection of the lookup request.',
  type: 'object',
  properties: {
    projectId: {
      title: 'Project ID',
      description: 'Stable identifier of the requested project.',
      type: 'string',
      examples: ['prj_fixture'],
    },
  },
  required: ['projectId'],
}

const resultSchema = {
  title: 'Project lookup result',
  description: 'Fields returned by the project lookup.',
  type: 'object',
  properties: {
    visible: { title: 'Display name', type: 'string', description: 'Public project name.' },
    secret: { title: 'Credential', type: 'string', description: 'Redacted by capture policy.' },
  },
  required: ['visible'],
}

const failureSchema = {
  title: 'Lookup failure',
  type: 'object',
  properties: {
    code: { title: 'Failure code', type: 'string', examples: ['NotFound'] },
    detail: { title: 'Failure detail', type: 'string' },
  },
  required: ['code'],
}

const channel = ({
  projection = 'bestEffort',
  schema = requestSchema,
}: {
  projection?: 'bestEffort' | 'unavailable'
  schema?: Readonly<Record<string, unknown>>
} = {}) => ({
  projection,
  schema: projection === 'unavailable' ? undefined : schema,
  warning: projection === 'unavailable' ? 'Schema annotations could not be projected' : undefined,
})

/** Wire descriptors shared by deterministic lifecycle fixtures. */
export const descriptors: ReadonlyArray<RpcDescriptorWire> = [
  {
    descriptorId: 'rpc:projects.lookup',
    key: 'projects.lookup',
    tag: 'LookupProject',
    kind: 'unary',
    observe: 'include',
    channels: {
      requestPayload: channel(),
      success: channel({ schema: resultSchema }),
      typedFailure: channel({ schema: failureSchema }),
      defect: { projection: 'unavailable', schema: undefined, warning: undefined },
      streamElement: channel({ projection: 'unavailable' }),
      streamError: channel({ projection: 'unavailable' }),
      headers: channel({
        schema: {
          title: 'Request headers',
          type: 'object',
          additionalProperties: { type: 'string' },
        },
      }),
    },
    terminal: channel({ schema: { title: 'Terminal signal', type: 'null' } }),
  },
  {
    descriptorId: 'rpc:events.subscribe',
    key: 'events.subscribe',
    tag: 'SubscribeEvents',
    kind: 'stream',
    observe: 'include',
    channels: {
      requestPayload: channel(),
      success: channel({ projection: 'unavailable' }),
      typedFailure: channel({ projection: 'unavailable' }),
      defect: channel({ projection: 'unavailable' }),
      streamElement: channel({
        schema: {
          title: 'Subscribed event',
          type: 'object',
          properties: { eventId: { title: 'Event ID', type: 'string' } },
        },
      }),
      streamError: channel({ schema: { title: 'Subscription failure', type: 'string' } }),
      headers: channel({
        schema: {
          title: 'Request headers',
          type: 'object',
          additionalProperties: { type: 'string' },
        },
      }),
    },
    terminal: channel({ schema: { title: 'Terminal signal', type: 'null' } }),
  },
]

const identity = ({
  index,
  observerSide = 'client',
}: {
  readonly index: number
  readonly observerSide?: 'client' | 'server'
}): RequestIdentity => ({
  observerSide,
  connectionId: `conn-${observerSide}-fixture`,
  direction: observerSide === 'client' ? 'clientToServer' : 'serverToClient',
  requestId:
    index % 2 === 0 ? { _tag: 'Number', value: index } : { _tag: 'String', value: `req-${index}` },
})

const at = (offsetMillis: number) => ({
  monotonicNanos: String(8_000_000_000n + BigInt(offsetMillis) * 1_000_000n),
  wallClockMillis: baseWallClock + offsetMillis,
})

const lifecycleStates: ReadonlyArray<RecordState> = [
  'sending',
  'sent',
  'awaiting',
  'streaming',
  'cancellationRequested',
  'sendFailed',
  'succeeded',
  'failed',
  'defect',
  'interrupted',
  'uncertain',
  'notificationSent',
]

const isActive = (state: RecordState): boolean =>
  state === 'sending' ||
  state === 'sent' ||
  state === 'awaiting' ||
  state === 'streaming' ||
  state === 'cancellationRequested'

const requestEvents: ReadonlyArray<ExplorerEvent> = lifecycleStates.map((state, index) => ({
  _tag: 'RequestObserved',
  eventId: index + 1,
  revision: index + 1,
  at: at(index * 700),
  request: identity({ index: index + 1, observerSide: index % 3 === 0 ? 'server' : 'client' }),
  descriptorId: state === 'streaming' ? 'rpc:events.subscribe' : 'rpc:projects.lookup',
  notification: state === 'notificationSent',
  observations:
    index === 0
      ? [
          {
            channel: 'requestPayload',
            outcome: { _tag: 'Captured', mode: 'reveal', source: 'schema' },
            captured: {
              _tag: 'Object',
              value: { projectId: { _tag: 'String', value: 'prj_fixture' } },
            },
          },
        ]
      : [],
}))

// oxlint-disable-next-line oxc/no-map-spread -- Each iteration constructs an immutable fixture with exact optional trace semantics.
const records = lifecycleStates.map(
  (state, index): RpcRecord => ({
    key: identity({ index: index + 1, observerSide: index % 3 === 0 ? 'server' : 'client' }),
    descriptorId: state === 'streaming' ? 'rpc:events.subscribe' : 'rpc:projects.lookup',
    state,
    notification: state === 'notificationSent',
    startedAt: at(index * 700),
    lastAt: at(index * 700 + (isActive(state) === true ? 400 : 1_250)),
    ...(index % 3 === 1
      ? {
          trace: {
            traceId: `4bf92f3577b34da6a3ce929d0e0e47${String(index).padStart(2, '0')}`,
            spanId: `00f067aa0ba902${String(index).padStart(2, '0')}`,
            sampled: true,
          },
        }
      : {}),
    send: state === 'sendFailed' ? 'failed' : state === 'sending' ? 'attempted' : 'sent',
    chunkEnvelopes: state === 'streaming' ? 4 : 0,
    streamValues: state === 'streaming' ? 17 : 0,
    retainedStreamValues: state === 'streaming' ? 8 : 0,
    events: [index + 1],
    evidence:
      state === 'uncertain'
        ? [{ _tag: 'ConnectionFault', faultId: 'fault-fixture-1', fault: 'disconnect' }]
        : state === 'streaming'
          ? [{ _tag: 'ValuesTruncated', count: 9 }]
          : [],
  }),
)

const normalizedSafetyValue: NormalizedValue = {
  _tag: 'Object',
  value: {
    visible: { _tag: 'String', value: 'normalized text' },
    secret: { _tag: 'Redacted', label: 'credential' },
    custom: { _tag: 'Unsupported', type: 'CustomClass' },
    deep: {
      _tag: 'Truncated',
      reason: 'depth',
      retained: { _tag: 'String', value: 'bounded prefix' },
    },
    bytes: { _tag: 'Bytes', base64: 'AQIDBA==', byteLength: 4 },
  },
}

const safetyRequest = identity({ index: 101 })
/** Content-safety events spanning omitted, faulted, revealed, and redacted channels. */
export const safetyEvents: ReadonlyArray<ExplorerEvent> = [
  {
    _tag: 'RequestObserved',
    eventId: 101,
    revision: 101,
    at: at(9_000),
    request: safetyRequest,
    descriptorId: 'rpc:projects.lookup',
    notification: false,
    observations: [
      { channel: 'requestPayload', outcome: { _tag: 'Omitted', source: 'default' } },
      { channel: 'headers', outcome: { _tag: 'PolicyFault', source: 'host', fault: 'transform' } },
      {
        channel: 'success',
        outcome: { _tag: 'Captured', mode: 'reveal', source: 'schema' },
        captured: normalizedSafetyValue,
      },
      {
        channel: 'typedFailure',
        outcome: { _tag: 'Captured', mode: 'redact', source: 'rpc' },
        captured: {
          _tag: 'Object',
          value: {
            code: { _tag: 'String', value: 'PROJECT_HIDDEN' },
            detail: { _tag: 'Redacted' },
          },
        },
      },
    ],
  },
]

/** Completed record used by content-safety stories. */
export const safetyRecord: RpcRecord = {
  key: safetyRequest,
  descriptorId: 'rpc:projects.lookup',
  state: 'succeeded',
  notification: false,
  startedAt: at(9_000),
  lastAt: at(9_720),
  trace: { traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7', sampled: true },
  send: 'sent',
  chunkEnvelopes: 0,
  streamValues: 0,
  retainedStreamValues: 0,
  events: [101],
  evidence: [],
}

/** Full deterministic lifecycle snapshot. */
export const lifecycleSnapshot: InspectorSnapshotFrame = {
  _tag: 'Snapshot',
  protocolVersion: 'rpc-explorer.v1',
  instanceId: 'fixture-instance-lifecycle',
  revision: 120,
  descriptors,
  active: records.filter((record) => isActive(record.state) === true),
  completed: [...records.filter((record) => isActive(record.state) === false), safetyRecord],
  events: [...requestEvents, ...safetyEvents],
  counters: {
    activeEvicted: 0,
    completedEvicted: 3,
    streamValuesTruncated: 9,
    subscriberResets: 1,
  },
}

/** Empty connected inspector snapshot. */
export const emptySnapshot: InspectorSnapshotFrame = {
  _tag: 'Snapshot',
  protocolVersion: 'rpc-explorer.v1',
  instanceId: 'fixture-instance-empty',
  revision: 0,
  descriptors,
  active: [],
  completed: [],
  events: [],
  counters: {
    activeEvicted: 0,
    completedEvicted: 0,
    streamValuesTruncated: 0,
    subscriberResets: 0,
  },
}

/** Snapshot containing every policy-safe content outcome. */
export const safetySnapshot: InspectorSnapshotFrame = {
  ...lifecycleSnapshot,
  instanceId: 'fixture-instance-safety',
  revision: 121,
  active: [],
  completed: [safetyRecord],
  events: safetyEvents,
}

/** Large snapshot used to prove collection virtualization. */
export const denseSnapshot: InspectorSnapshotFrame = {
  ...lifecycleSnapshot,
  instanceId: 'fixture-instance-dense',
  revision: 200,
  active: Array.from({ length: 24 }, (_, index) => ({
    ...records[index % 5]!,
    key: identity({ index: index + 200 }),
    events: [],
  })),
  completed: Array.from({ length: 180 }, (_, index) => ({
    ...records[6 + (index % 6)]!,
    key: identity({ index: index + 400, observerSide: index % 2 === 0 ? 'client' : 'server' }),
    events: [],
  })),
  events: [],
}

class FixtureExplorerClient implements ExplorerClient {
  readonly #frames: Array<InspectorWatchFrame>
  readonly #waiters: Array<(frame: InspectorWatchFrame) => void> = []
  #snapshot: InspectorSnapshotFrame
  readonly #clearSnapshot: InspectorSnapshotFrame | undefined

  constructor({
    snapshot,
    frames = [],
    clearSnapshot,
  }: {
    readonly snapshot: InspectorSnapshotFrame
    readonly frames?: ReadonlyArray<InspectorWatchFrame>
    readonly clearSnapshot?: InspectorSnapshotFrame
  }) {
    this.#snapshot = snapshot
    this.#frames = [...frames]
    this.#clearSnapshot = clearSnapshot
  }

  getSnapshot = async (): Promise<unknown> => this.#snapshot

  watch = async function* (this: FixtureExplorerClient): AsyncIterable<unknown> {
    while (true) {
      if (this.#frames.length > 0) {
        const frame = this.#frames.shift()
        if (frame !== undefined) yield frame
        continue
      }
      const { promise, resolve } = Promise.withResolvers<InspectorWatchFrame>()
      this.#waiters.push(resolve)
      // eslint-disable-next-line no-await-in-loop -- the fixture models a serial AsyncIterable transport.
      const frame = await promise
      yield frame
    }
  }

  clearHistory = async (): Promise<unknown> => {
    const next = this.#clearSnapshot
    if (next === undefined) return { clearedRevision: this.#snapshot.revision }
    this.#snapshot = next
    this.push({
      _tag: 'Reset',
      protocolVersion: 'rpc-explorer.v1',
      reason: 'cleared',
      revision: next.revision,
    })
    this.push(next)
    return { clearedRevision: next.revision }
  }

  push = (frame: InspectorWatchFrame): void => {
    const waiter = this.#waiters.shift()
    if (waiter === undefined) this.#frames.push(frame)
    else waiter(frame)
  }
}

/** Creates a static fixture client whose watch waits indefinitely. */
export const makeFixtureClient = (snapshot: InspectorSnapshotFrame): ExplorerClient =>
  new FixtureExplorerClient({ snapshot })

const liveActive = records.find((record) => record.state === 'streaming')!
const liveUpdated = {
  ...liveActive,
  chunkEnvelopes: 5,
  streamValues: 20,
  retainedStreamValues: 8,
  evidence: [{ _tag: 'ValuesTruncated', count: 12 }] as const,
}
const clearSnapshot: InspectorSnapshotFrame = {
  ...emptySnapshot,
  instanceId: 'fixture-instance-live',
  revision: 3,
  active: [liveUpdated],
  counters: { ...emptySnapshot.counters, subscriberResets: 1 },
}

/** Deterministic frame-driven bridge. The real core-store bridge is supplied by integration wiring. */
export const makeLiveFixtureClient = (): ExplorerClient =>
  new FixtureExplorerClient({
    snapshot: {
      ...emptySnapshot,
      instanceId: 'fixture-instance-live',
      revision: 1,
      active: [liveActive],
      completed: [{ ...safetyRecord, events: [] }],
    },
    frames: [
      {
        _tag: 'Delta',
        protocolVersion: 'rpc-explorer.v1',
        fromRevision: 1,
        toRevision: 2,
        operations: [{ _tag: 'UpsertRecord', bucket: 'active', record: liveUpdated }],
      },
    ],
    clearSnapshot,
  })
