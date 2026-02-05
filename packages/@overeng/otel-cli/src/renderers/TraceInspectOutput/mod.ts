/**
 * TraceInspect output module
 *
 * Re-exports all components for the trace inspect command renderer.
 */

export {
  InspectAction,
  InspectState,
  createInitialInspectState,
  inspectReducer,
  type ProcessedSpan,
} from './schema.ts'
export { InspectApp } from './app.ts'
export { InspectView, type InspectViewProps } from './view.tsx'
