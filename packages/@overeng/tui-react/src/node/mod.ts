/**
 * @overeng/tui-react/node
 *
 * Node.js-specific exports for TUI React CLI integration.
 *
 * This entry point contains code that depends on Node.js built-in modules
 * (`node:fs`, etc.) and should NOT be imported in browser/Storybook contexts.
 *
 * For browser-safe exports, use `@overeng/tui-react` instead.
 *
 * @example
 * ```typescript
 * import { outputOption, outputModeLayer, runTuiMain } from '@overeng/tui-react/node'
 * ```
 *
 * @module
 */

// Node.js environment detection (requires node:fs)
export {
  stdoutFdType,
  isAgentEnv,
  detectOutputMode,
  detectLayer,
  viewOutputStreamStdoutLayer,
  viewOutputStreamStderrLayer,
} from '../effect/OutputMode.node.ts'

// Effect CLI integration (requires node:fs transitively via detectOutputMode)
export {
  outputOption,
  outputModeLayer,
  tuiRuntimeLayer,
  resolveOutputMode,
  runTuiMain,
  defaultFormatError,
  compactFormatError,
  OUTPUT_MODE_VALUES,
  type OutputModeValue,
  type RunTuiMainOptions,
  type TuiRuntime,
} from '../effect/cli.tsx'

// Synchronous fd writers for the result/data channel. These bypass
// `console.*` and the Effect logger, so they survive `LogCapture` in
// progressive React modes and forced process exit with a slow pipe reader.
export { writeStdoutSync, writeStdoutLineSync } from '../effect/stdout.node.ts'
