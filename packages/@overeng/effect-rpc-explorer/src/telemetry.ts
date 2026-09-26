import { Effect, Schema, Tracer } from 'effect'
import type { Scope } from 'effect'

import { OtelAttr, OtelMetric, OtelSpan } from '@overeng/otel-contract'

import { CaptureChannels } from './model.ts'
import type { CaptureChannel, Direction, ObserverSide, TraceContext } from './model.ts'

/** Closed lifecycle categories permitted on metrics and fault spans. */
export const ExplorerTelemetryEventKinds = [
  'RequestObserved',
  'SendAttempted',
  'SendSucceeded',
  'SendFailed',
  'ChunkObserved',
  'AckObserved',
  'InterruptObserved',
  'TerminalObserved',
  'ConnectionFault',
  'LateEvent',
] as const
/** Lifecycle category admitted after runtime allowlist validation. */
export type ExplorerTelemetryEventKind = (typeof ExplorerTelemetryEventKinds)[number]

/** Closed reasons for content-free loss accounting. */
export const ExplorerTelemetryDropReasons = [
  'policyOmitted',
  'policyFault',
  'normalizationLimit',
  'streamLimit',
  'activeRetention',
  'completedRetention',
  'deltaRetention',
] as const
/** Loss category admitted after runtime allowlist validation. */
export type ExplorerTelemetryDropReason = (typeof ExplorerTelemetryDropReasons)[number]

/** Closed result classes; raw normalization errors never become labels. */
export const ExplorerTelemetryNormalizationOutcomes = ['success', 'failure'] as const
/** Content-free result of one normalization attempt. */
export type ExplorerTelemetryNormalizationOutcome =
  (typeof ExplorerTelemetryNormalizationOutcomes)[number]

/** Pipeline stages that may report a rare internal invariant fault. */
export const ExplorerTelemetryFaultKinds = [
  'observer',
  'normalization',
  'store',
  'subscriber',
] as const
/** Stage in which an internal invariant failed. */
export type ExplorerTelemetryFaultKind = (typeof ExplorerTelemetryFaultKinds)[number]

/** Reset causes intentionally excluding user-controlled details. */
export const ExplorerTelemetryResetReasons = ['behind', 'overflow', 'cleared'] as const
/** Cause of a subscriber reset metric. */
export type ExplorerTelemetryResetReason = (typeof ExplorerTelemetryResetReasons)[number]

const observerSides = ['client', 'server'] as const satisfies ReadonlyArray<ObserverSide>
const directions = ['clientToServer', 'serverToClient'] as const satisfies ReadonlyArray<Direction>

/** Fixed dimensions for one admitted lifecycle event. */
export interface ExplorerEventMetricAttributes {
  readonly eventKind: ExplorerTelemetryEventKind
  readonly observerSide: ObserverSide
  readonly direction: Direction
}

/** Fixed dimensions for one discarded observation or retained item. */
export interface ExplorerDropMetricAttributes {
  readonly reason: ExplorerTelemetryDropReason
  readonly captureChannel?: CaptureChannel
}

/** Signed change to the active-record population. */
export interface ExplorerActiveMetricUpdate {
  readonly observerSide: ObserverSide
  readonly direction: Direction
  readonly delta: number
}

/** Safe duration sample measured only after raw content is discarded. */
export interface ExplorerNormalizationMetricRecord {
  readonly outcome: ExplorerTelemetryNormalizationOutcome
  readonly captureChannel: CaptureChannel
  readonly durationSeconds: number
}

/** Fixed reason for a subscriber reset. */
export interface ExplorerSubscriberResetMetricAttributes {
  readonly reason: ExplorerTelemetryResetReason
}

/** Closed invariant classification with an optional validated trace link. */
export interface ExplorerInvariantFault {
  readonly faultKind: ExplorerTelemetryFaultKind
  readonly observerSide: ObserverSide
  readonly eventKind: ExplorerTelemetryEventKind
  readonly trace?: TraceContext
}

/** Point-in-time record counts supplied to the observable callback. */
export interface ExplorerRetainedCounts {
  readonly active: number
  readonly completed: number
}

/** One fixed-label observation produced for the host meter callback. */
export interface ExplorerRetainedGaugeObservation {
  readonly value: number
  readonly attributes: {
    readonly 'rpc.explorer.record.kind': 'active' | 'completed'
  }
}

/** Host capability for the callback-based instrument Effect does not expose. */
export interface ExplorerRetainedGaugeRegistration {
  readonly name: 'rpc.explorer.retained'
  readonly instrument: 'observableGauge'
  readonly description: string
  readonly observe: () => ReadonlyArray<ExplorerRetainedGaugeObservation>
}

/** One validated seconds sample passed to the host histogram. */
export interface ExplorerNormalizationHistogramMeasurement {
  readonly value: number
  readonly attributes: {
    readonly 'rpc.explorer.normalization.outcome': ExplorerTelemetryNormalizationOutcome
    readonly 'rpc.explorer.capture.channel': CaptureChannel
  }
}

/** Exact histogram metadata the host must preserve when binding its meter. */
export interface ExplorerNormalizationHistogramRegistration {
  readonly name: 'rpc.explorer.normalization.duration'
  readonly instrument: 'histogram'
  readonly unit: 's'
  readonly description: string
  readonly boundaries: ReadonlyArray<number>
}

/** Host recorder returned after exact histogram registration. */
export type ExplorerNormalizationHistogramRecorder = (
  measurement: ExplorerNormalizationHistogramMeasurement,
) => void

/** Host meter capabilities and the count reader needed by this scoped instance. */
export interface ExplorerTelemetryOptions {
  readonly readRetainedCounts: () => ExplorerRetainedCounts
  readonly registerRetainedGauge: (registration: ExplorerRetainedGaugeRegistration) => () => void
  readonly registerNormalizationHistogram: (
    registration: ExplorerNormalizationHistogramRegistration,
  ) => ExplorerNormalizationHistogramRecorder
}

/** Setup failure identifying the instrument the host could not register. */
export class ExplorerTelemetryRegistrationError extends Schema.TaggedError<ExplorerTelemetryRegistrationError>()(
  'ExplorerTelemetryRegistrationError',
  {
    instrument: Schema.Literals(['retained', 'normalizationDuration']),
  },
) {}

/** Best-effort operations safe to invoke from explorer observation paths. */
export interface ExplorerTelemetry {
  readonly event: (attributes: ExplorerEventMetricAttributes) => Effect.Effect<void>
  readonly drop: (attributes: ExplorerDropMetricAttributes) => Effect.Effect<void>
  readonly activeDelta: (update: ExplorerActiveMetricUpdate) => Effect.Effect<void>
  readonly normalizationDuration: (record: ExplorerNormalizationMetricRecord) => Effect.Effect<void>
  readonly subscriberReset: (
    attributes: ExplorerSubscriberResetMetricAttributes,
  ) => Effect.Effect<void>
  readonly invariantFault: (fault: ExplorerInvariantFault) => Effect.Effect<void>
}

const eventLabels = Schema.Struct({
  'rpc.explorer.event.kind': Schema.Literals(ExplorerTelemetryEventKinds),
  'rpc.explorer.observer.side': Schema.Literals(observerSides),
  'rpc.explorer.direction': Schema.Literals(directions),
})
const dropLabels = Schema.Struct({
  'rpc.explorer.drop.reason': Schema.Literals(ExplorerTelemetryDropReasons),
  'rpc.explorer.capture.channel': Schema.optional(Schema.Literals(CaptureChannels)).pipe(
    OtelAttr.cardinality('bounded'),
  ),
})
const activeLabels = Schema.Struct({
  'rpc.explorer.observer.side': Schema.Literals(observerSides),
  'rpc.explorer.direction': Schema.Literals(directions),
})
const resetLabels = Schema.Struct({
  'rpc.explorer.reset.reason': Schema.Literals(ExplorerTelemetryResetReasons),
})

const eventsMetric = OtelMetric.effect.counter(
  OtelMetric.counter({
    name: 'rpc.explorer.events',
    incremental: true,
    description: 'Explorer lifecycle events admitted to the ordered model.',
    labels: eventLabels,
  }),
)
const droppedMetric = OtelMetric.effect.counter(
  OtelMetric.counter({
    name: 'rpc.explorer.dropped',
    incremental: true,
    description: 'Explorer observations or retained data discarded by a bounded rule.',
    labels: dropLabels,
  }),
)
const activeMetric = OtelMetric.effect.counter(
  OtelMetric.counter({
    name: 'rpc.explorer.active',
    description: 'Change in currently active explorer records.',
    labels: activeLabels,
  }),
)
const subscriberResetsMetric = OtelMetric.effect.counter(
  OtelMetric.counter({
    name: 'rpc.explorer.subscriber.resets',
    description: 'Explorer subscriber resets by bounded reason.',
    labels: resetLabels,
    incremental: true,
  }),
)

const faultSpan = OtelSpan.defineSync({
  name: 'rpc.explorer.pipeline.fault',
  root: true,
  schema: Schema.Struct({
    'span.label': Schema.Literal('rpc explorer fault').pipe(OtelAttr.spanLabel()),
    'rpc.explorer.fault.kind': Schema.Literals(ExplorerTelemetryFaultKinds),
    'rpc.explorer.observer.side': Schema.Literals(observerSides),
    'rpc.explorer.event.kind': Schema.Literals(ExplorerTelemetryEventKinds),
  }),
})
const normalizationHistogramRegistration: ExplorerNormalizationHistogramRegistration = {
  name: 'rpc.explorer.normalization.duration',
  instrument: 'histogram',
  unit: 's',
  description: 'Explorer normalization duration in seconds after raw content is discarded.',
  boundaries: [0.00001, 0.00005, 0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
}

const memberValue = <TValue extends string>({
  values,
  value,
}: {
  readonly values: ReadonlyArray<TValue>
  readonly value: unknown
}): TValue | undefined => {
  if (typeof value !== 'string') return undefined
  return values.find((candidate) => candidate === value)
}

const exactRecord = ({
  value,
  required,
  optional = [],
}: {
  readonly value: unknown
  readonly required: ReadonlyArray<string>
  readonly optional?: ReadonlyArray<string>
}): Readonly<Record<string, unknown>> | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value) === true) return undefined
  const keys = Reflect.ownKeys(value)
  if (
    keys.some(
      (key) =>
        typeof key !== 'string' ||
        (required.includes(key) === false && optional.includes(key) === false),
    ) === true ||
    required.some((key) => Object.hasOwn(value, key) === false) === true
  ) {
    return undefined
  }
  return value as Readonly<Record<string, unknown>>
}

const bestEffort = <TError>(make: () => Effect.Effect<void, TError>): Effect.Effect<void> =>
  Effect.suspend(make).pipe(Effect.ignoreCause)

const eventAttributes = (value: unknown): typeof eventLabels.Type | undefined => {
  const input = exactRecord({ value, required: ['eventKind', 'observerSide', 'direction'] })
  if (input === undefined) return undefined
  const eventKind = memberValue({
    values: ExplorerTelemetryEventKinds,
    value: input.eventKind,
  })
  const observerSide = memberValue({ values: observerSides, value: input.observerSide })
  const direction = memberValue({ values: directions, value: input.direction })
  if (eventKind === undefined || observerSide === undefined || direction === undefined) {
    return undefined
  }
  return {
    'rpc.explorer.event.kind': eventKind,
    'rpc.explorer.observer.side': observerSide,
    'rpc.explorer.direction': direction,
  }
}

const dropAttributes = (value: unknown): typeof dropLabels.Type | undefined => {
  const input = exactRecord({ value, required: ['reason'], optional: ['captureChannel'] })
  if (input === undefined) return undefined
  const reason = memberValue({ values: ExplorerTelemetryDropReasons, value: input.reason })
  if (reason === undefined) return undefined
  if (Object.hasOwn(input, 'captureChannel') === false) {
    return { 'rpc.explorer.drop.reason': reason }
  }
  const captureChannel = memberValue({
    values: CaptureChannels,
    value: input.captureChannel,
  })
  if (captureChannel === undefined) return undefined
  return {
    'rpc.explorer.drop.reason': reason,
    'rpc.explorer.capture.channel': captureChannel,
  }
}

const activeUpdate = (
  value: unknown,
): { readonly attributes: typeof activeLabels.Type; readonly delta: number } | undefined => {
  const input = exactRecord({ value, required: ['observerSide', 'direction', 'delta'] })
  if (input === undefined) return undefined
  const observerSide = memberValue({ values: observerSides, value: input.observerSide })
  const direction = memberValue({ values: directions, value: input.direction })
  if (
    observerSide === undefined ||
    direction === undefined ||
    typeof input.delta !== 'number' ||
    Number.isSafeInteger(input.delta) === false
  ) {
    return undefined
  }
  return {
    attributes: {
      'rpc.explorer.observer.side': observerSide,
      'rpc.explorer.direction': direction,
    },
    delta: input.delta,
  }
}

const normalizationRecord = (
  value: unknown,
):
  | {
      readonly attributes: ExplorerNormalizationHistogramMeasurement['attributes']
      readonly durationSeconds: number
    }
  | undefined => {
  const input = exactRecord({ value, required: ['outcome', 'captureChannel', 'durationSeconds'] })
  if (input === undefined) return undefined
  const outcome = memberValue({
    values: ExplorerTelemetryNormalizationOutcomes,
    value: input.outcome,
  })
  const captureChannel = memberValue({
    values: CaptureChannels,
    value: input.captureChannel,
  })
  if (
    outcome === undefined ||
    captureChannel === undefined ||
    typeof input.durationSeconds !== 'number' ||
    Number.isFinite(input.durationSeconds) === false ||
    input.durationSeconds < 0
  ) {
    return undefined
  }
  return {
    attributes: {
      'rpc.explorer.normalization.outcome': outcome,
      'rpc.explorer.capture.channel': captureChannel,
    },
    durationSeconds: input.durationSeconds,
  }
}

const resetAttributes = (value: unknown): typeof resetLabels.Type | undefined => {
  const input = exactRecord({ value, required: ['reason'] })
  if (input === undefined) return undefined
  const reason = memberValue({ values: ExplorerTelemetryResetReasons, value: input.reason })
  return reason === undefined ? undefined : { 'rpc.explorer.reset.reason': reason }
}

const traceLink = (value: unknown): Tracer.SpanLink | undefined => {
  const trace = exactRecord({ value, required: ['traceId', 'spanId'], optional: ['sampled'] })
  if (
    trace === undefined ||
    typeof trace.traceId !== 'string' ||
    /^[0-9a-f]{32}$/i.test(trace.traceId) === false ||
    /^0{32}$/.test(trace.traceId) === true ||
    typeof trace.spanId !== 'string' ||
    /^[0-9a-f]{16}$/i.test(trace.spanId) === false ||
    /^0{16}$/.test(trace.spanId) === true ||
    (Object.hasOwn(trace, 'sampled') === true && typeof trace.sampled !== 'boolean')
  ) {
    return undefined
  }
  return {
    span: Tracer.externalSpan({
      traceId: trace.traceId,
      spanId: trace.spanId,
      ...(typeof trace.sampled === 'boolean' ? { sampled: trace.sampled } : {}),
    }),
    attributes: {},
  }
}

const faultOptions = (
  value: unknown,
):
  | {
      readonly attributes: typeof faultSpan.attributes.schema.Type
      readonly links: ReadonlyArray<Tracer.SpanLink>
    }
  | undefined => {
  const fault = exactRecord({
    value,
    required: ['faultKind', 'observerSide', 'eventKind'],
    optional: ['trace'],
  })
  if (fault === undefined) return undefined
  const faultKind = memberValue({
    values: ExplorerTelemetryFaultKinds,
    value: fault.faultKind,
  })
  const observerSide = memberValue({ values: observerSides, value: fault.observerSide })
  const eventKind = memberValue({
    values: ExplorerTelemetryEventKinds,
    value: fault.eventKind,
  })
  if (faultKind === undefined || observerSide === undefined || eventKind === undefined) {
    return undefined
  }
  const link = Object.hasOwn(fault, 'trace') === true ? traceLink(fault.trace) : undefined
  return {
    attributes: {
      'span.label': 'rpc explorer fault',
      'rpc.explorer.fault.kind': faultKind,
      'rpc.explorer.observer.side': observerSide,
      'rpc.explorer.event.kind': eventKind,
    },
    links: link === undefined ? [] : [link],
  }
}

const retainedGaugeRegistration = (
  readCounts: () => ExplorerRetainedCounts,
): ExplorerRetainedGaugeRegistration => ({
  name: 'rpc.explorer.retained',
  instrument: 'observableGauge',
  description: 'Explorer records currently retained in each bounded record bucket.',
  observe: () => {
    try {
      const counts = exactRecord({ value: readCounts(), required: ['active', 'completed'] })
      if (
        counts === undefined ||
        typeof counts.active !== 'number' ||
        Number.isSafeInteger(counts.active) === false ||
        counts.active < 0 ||
        typeof counts.completed !== 'number' ||
        Number.isSafeInteger(counts.completed) === false ||
        counts.completed < 0
      ) {
        return []
      }
      return [
        {
          value: counts.active,
          attributes: { 'rpc.explorer.record.kind': 'active' },
        },
        {
          value: counts.completed,
          attributes: { 'rpc.explorer.record.kind': 'completed' },
        },
      ]
    } catch {
      return []
    }
  },
})

/**
 * Attribute objects are admitted as a whole: an unknown key rejects the update instead of being
 * forwarded, so user-controlled fields can never become accidental telemetry dimensions.
 */
const makeTelemetry = (
  recordNormalizationHistogram: ExplorerNormalizationHistogramRecorder,
): ExplorerTelemetry => ({
  event: (input) =>
    bestEffort(() => {
      const attributes = eventAttributes(input)
      return attributes === undefined ? Effect.void : eventsMetric.increment(attributes)
    }),
  drop: (input) =>
    bestEffort(() => {
      const attributes = dropAttributes(input)
      return attributes === undefined ? Effect.void : droppedMetric.increment(attributes)
    }),
  activeDelta: (input) =>
    bestEffort(() => {
      const update = activeUpdate(input)
      return update === undefined
        ? Effect.void
        : activeMetric.incrementBy({ labels: update.attributes, amount: update.delta })
    }),
  normalizationDuration: (input) =>
    bestEffort(() => {
      const record = normalizationRecord(input)
      return record === undefined
        ? Effect.void
        : Effect.sync(() =>
            recordNormalizationHistogram({
              value: record.durationSeconds,
              attributes: record.attributes,
            }),
          )
    }),
  subscriberReset: (input) =>
    bestEffort(() => {
      const attributes = resetAttributes(input)
      return attributes === undefined ? Effect.void : subscriberResetsMetric.increment(attributes)
    }),
  invariantFault: (input) =>
    bestEffort(() => {
      const options = faultOptions(input)
      if (options === undefined) return Effect.void
      const span = OtelSpan.with({
        span: faultSpan,
        attributes: options.attributes,
        effect: Effect.void,
      })
      return options.links.length === 0
        ? span
        : Effect.linkSpans(
            span,
            options.links.map((link) => link.span),
          )
    }),
})

/** Registers host-only instruments in scope and returns guarded recording operations. */
export const makeExplorerTelemetry = (
  options: ExplorerTelemetryOptions,
): Effect.Effect<ExplorerTelemetry, ExplorerTelemetryRegistrationError, Scope.Scope> =>
  Effect.gen(function* () {
    yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          options.registerRetainedGauge(retainedGaugeRegistration(options.readRetainedCounts)),
        catch: () => new ExplorerTelemetryRegistrationError({ instrument: 'retained' }),
      }),
      (unregisterRetainedGauge) => bestEffort(() => Effect.sync(unregisterRetainedGauge)),
    )
    const recordNormalizationHistogram = yield* Effect.try({
      try: () => options.registerNormalizationHistogram(normalizationHistogramRegistration),
      catch: () => new ExplorerTelemetryRegistrationError({ instrument: 'normalizationDuration' }),
    })
    return makeTelemetry(recordNormalizationHistogram)
  })
