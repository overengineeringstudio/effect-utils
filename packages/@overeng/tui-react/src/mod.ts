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

// Root API
export { createRoot, type Root, type CreateRootOptions, type UnmountOptions } from './root.ts'

// Re-export ExitMode from tui-core
export { type ExitMode } from '@overeng/tui-core'

// Viewport hook
export {
  useViewport,
  ViewportProvider,
  type Viewport,
  type ViewportProviderProps,
} from './hooks/useViewport.tsx'
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
} from './components/Spinner.tsx'
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
// Effect Integration - Low-level hooks
// =============================================================================

export {
  useSubscriptionRef,
  useStream,
  RuntimeContext,
  RuntimeProvider,
  useRuntime,
  useEffectCallback,
} from './effect/hooks.tsx'

// =============================================================================
// Effect CLI Integration - Output Modes
// =============================================================================

export {
  OutputModeTag,
  type OutputMode,
  progressiveVisual,
  progressiveVisualAlternate,
  finalVisual,
  finalJson,
  progressiveJson,
  fromFlags,
  fromFlagsWithTTY,
  detect as detectOutputMode,
  isTTY,
  isNonTTY,
  isVisual,
  isJson,
  isProgressive,
  isFinal,
  layer as outputModeLayer,
  progressiveVisualLayer,
  progressiveVisualAlternateLayer,
  finalVisualLayer,
  finalJsonLayer,
  progressiveJsonLayer,
  detectLayer,
  fromFlagsLayer,
} from './effect/OutputMode.ts'

// =============================================================================
// TuiApp - Main API
// =============================================================================

export {
  createTuiApp,
  tuiAppConfig,
  type TuiApp,
  type TuiAppConfig,
  type TuiAppApi,
  type UnmountOptions as TuiAppUnmountOptions,
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
} from './effect/errors.ts'

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
} from './effect/testing.ts'

export {
  TestRenderer,
  stripAnsi,
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
// Effect CLI Integration
// =============================================================================

export {
  jsonOption,
  streamOption,
  outputModeOptions,
  outputModeLayerFromFlags,
  outputModeLayerFromFlagsWithTTY,
  type OutputModeFlags,
} from './effect/cli.ts'

// =============================================================================
// Universal Components (renderer-agnostic)
// =============================================================================

export * as Universal from './universal/mod.ts'
