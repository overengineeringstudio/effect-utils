/** Platform-independent meters contracts and scoped sessions. */
export { makeSeries, makeSeriesStore } from './series/index.ts'
export type {
  Cadence,
  UnavailableReason,
  Sample,
  Unit,
  Series,
  NumberValue,
  StatusValue,
  Retention,
  SeriesView,
  SeriesSnapshot,
  SeriesWriter,
  SeriesStore,
} from './series/index.ts'
export { makeMeters, makeSource, runInterval } from './session/index.ts'
export type {
  Meters,
  Platform,
  FrameTick,
  FrameClock,
  ClockStopped,
  Source,
  SourceRegistration,
  SourceError,
  SourceEvidence,
  Calibration,
  FpsValue,
  FrameStats,
} from './session/index.ts'
export {
  counterToken,
  gaugeToken,
  makeInstrumentation,
  instrumentationEvidence,
  counterSource,
  gaugeSource,
} from './instrumentation/index.ts'
export type {
  CounterToken,
  GaugeToken,
  Counter,
  Gauge,
  Instrumentation,
} from './instrumentation/index.ts'
export type {
  Headless,
  Snapshot,
  MeasureHandle,
  CompleteData,
  PartialData,
  IncompleteReason,
  MeasureResult,
  MeasureError,
} from './headless/index.ts'
