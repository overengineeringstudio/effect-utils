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

// Root API (placeholder - will be implemented in Phase 1)
export { createRoot, type Root } from './root.ts'

// Components (placeholders - will be implemented in Phase 1)
export { Box, type BoxProps } from './components/Box.tsx'
export { Text, type TextProps } from './components/Text.tsx'
export { Static, type StaticProps } from './components/Static.tsx'
export { Spinner, type SpinnerProps } from './components/Spinner.tsx'

// Hooks (placeholders - will be implemented in Phase 3)
// export { useAtom } from './hooks/useAtom.ts'
// export { useLogs } from './hooks/useLogs.ts'

// Effect integration (placeholder - will be implemented in Phase 3)
// export { TuiRenderer, TuiRendererLive } from './effect/TuiRenderer.ts'
