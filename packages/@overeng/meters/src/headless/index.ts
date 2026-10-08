/** Headless sessions use the same inert factory and scoped acquisition as other readers. */
export { makeMeters } from '../session/index.ts'
export type { Meters, Platform } from '../session/index.ts'
export type {
  Headless,
  Snapshot,
  MeasureHandle,
  CompleteData,
  PartialData,
  IncompleteReason,
  MeasureResult,
  MeasureError,
} from './internal.ts'
