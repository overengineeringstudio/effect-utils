/**
 * @overeng/tui-react
 *
 * React renderer for inline terminal UI with log interleaving.
 *
 * @example
 * ```tsx
 * import { createRoot, Box, Text, Static, Spinner } from '@overeng/tui-react'
 *
 * const App = () => {
 *   const [logs, setLogs] = useState<string[]>([])
 *
 *   return (
 *     <>
 *       <Static items={logs}>
 *         {(log, i) => <Text key={i} dim>{log}</Text>}
 *       </Static>
 *       <Box flexDirection="row">
 *         <Spinner />
 *         <Text> Processing...</Text>
 *       </Box>
 *     </>
 *   )
 * }
 *
 * const root = createRoot(process.stdout)
 * root.render(<App />)
 * ```
 */

// Re-export tui-core utilities
export { type Terminal, type TerminalLike, createTerminal } from '@overeng/tui-core'

// Root API
export { createRoot, type Root } from './root.ts'
export { renderToString, renderToLines, type RenderToStringOptions } from './renderToString.ts'

// Components
export { Box, type BoxProps } from './components/Box.tsx'
export { Text, type TextProps } from './components/Text.tsx'
export { Static, type StaticProps } from './components/Static.tsx'
export { Spinner, type SpinnerProps, type SpinnerType, spinnerFrames } from './components/Spinner.tsx'
export { TaskList, type TaskListProps, type TaskItem, type TaskStatus } from './components/TaskList.tsx'

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

// Effect integration (optional - requires effect peer dependency)
export { TuiRenderer, type TuiRendererService } from './effect/TuiRenderer.ts'
export {
  useSubscriptionRef,
  useStream,
  RuntimeContext,
  RuntimeProvider,
  useRuntime,
  useEffectCallback,
  RefRegistryContext,
  RefRegistryProvider,
  useRegistryRef,
  createRefRegistry,
  type RefRegistry,
} from './effect/hooks.tsx'
