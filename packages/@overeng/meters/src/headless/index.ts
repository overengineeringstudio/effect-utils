/** Headless sessions use the same inert factory and scoped acquisition as other readers. */
export { makeMeters } from '../session/index.ts'
export type { Meters, Platform } from '../session/index.ts'
export type { Headless, Snapshot, Measurement } from './internal.ts'
export {
  CompleteData,
  PartialData,
  IncompleteReason,
  SettlementFrames,
  MeasureResult,
  MeasureError,
} from './internal.ts'
