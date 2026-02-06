/**
 * @overeng/tui-react
 *
 * React renderer for inline terminal UI with log interleaving.
 *
 * @example
 * ```tsx
 * import { createTuiApp, Box, Text } from '@overeng/tui-react'
 *
 * // 1. Define the app
 * const CounterApp = createTuiApp({
 *   stateSchema: CounterState,
 *   actionSchema: CounterAction,
 *   initial: { count: 0 },
 *   reducer: counterReducer,
 * })
 *
 * // 2. View uses app-scoped hooks (types inferred!)
 * const CounterView = () => {
 *   const state = CounterApp.useState()
 *   return <Box><Text>Count: {state.count}</Text></Box>
 * }
 *
 * // 3. Run with Effect
 * const program = Effect.gen(function* () {
 *   const tui = yield* CounterApp.run(<CounterView />)
 *   tui.dispatch({ _tag: 'Increment' })
 * }).pipe(Effect.scoped, Effect.provide(progressiveVisualLayer))
 * ```
 */

// Re-export tui-core utilities
export { type Terminal, type TerminalLike, createTerminal } from '@overeng/tui-core'

// Terminal symbols
export {
  // From tui-core
  symbolDefs,
  type SymbolDef,
  type SymbolDefs,
  type Symbols,
  resolveSymbols,
  unicodeSymbols,
  asciiSymbols,
} from '@overeng/tui-core'

// React hook for symbols
export { useSymbols } from './hooks/useSymbols.tsx'

// Root API
export { createRoot, type Root, type CreateRootOptions, type UnmountOptions } from './root.tsx'

// Re-export ExitMode from tui-core
export { type ExitMode } from '@overeng/tui-core'

// Viewport hook
export {
  useViewport,
  ViewportProvider,
  type Viewport,
  type ViewportProviderProps,
} from './hooks/useViewport.tsx'

// Text truncation utilities
export { truncateText, getTextWidth, type TruncateOptions } from './truncate.ts'

export { renderToString, renderToLines, type RenderToStringOptions } from './renderToString.ts'

// Components
export { Box, type BoxProps } from './components/Box.tsx'
export { Text, type TextProps } from './components/Text.tsx'
export { Static, type StaticProps } from './components/Static.tsx'
export {
  Spinner,
  type SpinnerProps,
  type SpinnerType,
  spinnerFrames,
  spinnerStaticChars,
} from './components/Spinner.tsx'

// Render Config (for CI/Log output)
export {
  type RenderConfig,
  RenderConfigProvider,
  useRenderConfig,
  ttyRenderConfig,
  ciRenderConfig,
  ciPlainRenderConfig,
  pipeRenderConfig,
  logRenderConfig,
  altScreenRenderConfig,
  isAnimated,
  hasColors,
  stripAnsi,
} from './effect/OutputMode.tsx'
export {
  TaskList,
  type TaskListProps,
  TaskItemSchema,
  TaskStatusSchema,
  type TaskItem,
  type TaskStatus,
} from './components/TaskList.tsx'

// Internal types (for advanced use)
export type {
  TuiNode,
  TuiElement,
  TuiBoxElement,
  TuiTextElement,
  TuiStaticElement,
  TuiTextNode,
  TextStyle,
} from './reconciler/types.ts'

// =============================================================================
// Effect Integration - Atom-based state management
// =============================================================================

export {
  // React hooks for atoms
  useAtomValue,
  useAtom,
  useAtomSet,
  useAtomMount,
  useAtomRefresh,
  useAtomSuspense,
  useAtomSubscribe,
  useAtomInitialValues,
  RegistryProvider,
  RegistryContext,
  // TUI-specific utilities
  createReducerAtoms,
} from './effect/hooks.tsx'

// =============================================================================
// Effect CLI Integration - Output Modes
// =============================================================================

export {
  // Types
  OutputModeTag,
  type OutputMode,
  type ReactOutputMode,
  type JsonOutputMode,
  // Presets
  tty,
  ci,
  ciPlain,
  pipe,
  log,
  altScreen,
  json,
  ndjson,
  // Environment helpers (browser-safe)
  isTTY,
  isNonTTY,
  // Type guards
  isReact,
  isJson,
  isProgressive,
  isFinal,
  isAlternate,
  getRenderConfig,
  // Layers
  layer,
  ttyLayer,
  ciLayer,
  ciPlainLayer,
  pipeLayer,
  logLayer,
  altScreenLayer,
  jsonLayer,
  ndjsonLayer,
} from './effect/OutputMode.tsx'

// =============================================================================
// TuiApp - Main API
// =============================================================================

export {
  createTuiApp,
  run,
  isTuiApp,
  TuiAppTypeId,
  tuiAppConfig,
  deriveOutputSchema,
  type TuiApp,
  type TuiAppConfig,
  type TuiAppApi,
  type TuiAppRunOptions,
  type TuiOutput,
  type TuiOutputSuccess,
  type TuiOutputFailure,
  type OutputCause,
  type OutputCauseEncoded,
  type UnmountOptions as TuiAppUnmountOptions,
  // TUI-specific atom hook (works around multiple React instance issues)
  useTuiAtomValue,
  TuiRegistryContext,
} from './effect/TuiApp.tsx'

// =============================================================================
// TuiRenderer - Low-level Effect Service (for direct React rendering)
// =============================================================================

export { TuiRenderer, type TuiRendererService } from './effect/TuiRenderer.ts'

// =============================================================================
// Error Handling (for JSON mode)
// =============================================================================

export {
  CommandError,
  ValidationError,
  RuntimeError,
  CancelledError,
  type CommandError as CommandErrorType,
  type ValidationError as ValidationErrorType,
  type RuntimeError as RuntimeErrorType,
  type CancelledError as CancelledErrorType,
  validationError,
  runtimeError,
  cancelledError,
  outputJsonError,
  toCommandError,
  withJsonErrors,
  runWithJsonErrors,
} from './effect/errors.tsx'

// =============================================================================
// Test Utilities
// =============================================================================

export {
  runTestCommand,
  createTestTuiState,
  captureConsole,
  assertJsonMatchesSchema,
  createMockView,
  modeFromTag,
  testModeLayer,
  type RunTestCommandOptions,
  type TestCommandResult,
  type CaptureOptions,
} from './effect/testing.tsx'

export {
  TestRenderer,
  renderToText as renderComponentToText,
  renderToAnsi as renderComponentToAnsi,
  type TestRendererOptions,
  type RenderResult,
} from './effect/TestRenderer.ts'

// =============================================================================
// Event Schemas (for bidirectional communication)
// =============================================================================

export {
  // Schemas
  KeyEvent,
  ResizeEvent,
  FocusEvent,
  MouseEvent,
  MouseButton,
  InputEvent,
  // Types
  type KeyEvent as KeyEventType,
  type ResizeEvent as ResizeEventType,
  type FocusEvent as FocusEventType,
  type MouseEvent as MouseEventType,
  type MouseButton as MouseButtonType,
  type InputEvent as InputEventType,
  type KeyEventEncoded,
  type ResizeEventEncoded,
  type FocusEventEncoded,
  type MouseEventEncoded,
  type InputEventEncoded,
  // Constructors
  keyEvent,
  resizeEvent,
  focusEvent,
  mouseEvent,
  // Type guards
  isKeyEvent,
  isResizeEvent,
  isFocusEvent,
  isMouseEvent,
  // Key helpers
  isKey,
  isCtrlC,
  isCtrlD,
  isEscape,
  isEnter,
  isArrowKey,
} from './effect/events.ts'

// =============================================================================
// Terminal Input Handling
// =============================================================================

export {
  createTerminalInput,
  parseKeyInput,
  supportsRawMode,
  createTerminalResize,
  getTerminalDimensions,
  isOutputTTY,
  type TerminalInput,
  type TerminalInputOptions,
  type TerminalResize,
} from './effect/TerminalInput.ts'

// =============================================================================
// OpenTUI Integration (alternate screen mode - requires Bun)
// =============================================================================

export {
  useOpenTuiRenderer,
  isOpenTuiAvailable,
  type OpenTuiRenderer,
  type OpenTuiRendererOptions,
} from './effect/OpenTuiRenderer.ts'

// =============================================================================
// TUI Logger - bridges Effect logging to TUI Static region
// =============================================================================

export {
  createTuiLogger,
  useTuiLogs,
  TuiLoggerService,
  TuiLoggerServiceLayer,
  formatLogEntry,
  getLogLevelColor,
  type TuiLogEntry,
  type TuiLoggerOptions,
  type TuiLoggerResult,
} from './effect/TuiLogger.ts'

// =============================================================================
// Log Capture - automatic capture of logs in progressive modes
// =============================================================================

export {
  useCapturedLogs,
  CapturedLogsProvider,
  createLogCapture,
  type LogCaptureHandle,
  type LogCaptureResult,
} from './effect/LogCapture.ts'

// =============================================================================
// Effect CLI Integration
// =============================================================================
// Node.js-specific CLI exports (outputOption, outputModeLayer, runTuiMain, etc.)
// have been moved to '@overeng/tui-react/node' to keep this entry point
// browser-safe for Storybook and other browser environments.
