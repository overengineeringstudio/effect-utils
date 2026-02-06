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
  isPiped,
  isRedirectedToFile,
  isAgentEnv,
  detectOutputMode,
  detectLayer,
} from '../effect/OutputMode.node.ts'

// Effect CLI integration (requires node:fs transitively via detectOutputMode)
export {
  outputOption,
  outputModeLayer,
  resolveOutputMode,
  runTuiMain,
  OUTPUT_MODE_VALUES,
  type OutputModeValue,
  type RunTuiMainOptions,
  type TuiRuntime,
} from '../effect/cli.tsx'
