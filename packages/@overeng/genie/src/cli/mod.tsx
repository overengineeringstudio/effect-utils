/**
 * Genie CLI Module
 *
 * TUI components and state management for genie CLI output.
 */

// Schema and state
export {
  GenieState,
  GenieAction,
  GenieFile,
  GenieFileStatus,
  GeniePhase,
  GenieMode,
  GenieSummary,
  genieReducer,
  createInitialGenieState,
} from './schema.ts'

// TuiApp
export { GenieApp } from './app.ts'

// View components
export { GenieView, GenieConnectedView } from './view.tsx'
