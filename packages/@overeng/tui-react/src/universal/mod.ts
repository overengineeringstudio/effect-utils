/**
 * Universal Components for TUI React
 *
 * Renderer-agnostic components that work across inline (tui-react)
 * and alternate screen (OpenTUI) modes.
 *
 * @example Basic usage
 * ```tsx
 * import { Universal } from '@overeng/tui-react'
 *
 * const { AutoAdapterProvider, Box, Text, Spinner } = Universal
 *
 * const App = () => (
 *   <AutoAdapterProvider>
 *     <Box>
 *       <Spinner label="Loading..." />
 *       <Text color="green">Ready!</Text>
 *     </Box>
 *   </AutoAdapterProvider>
 * )
 * ```
 *
 * @example Conditional rendering
 * ```tsx
 * import { Universal } from '@overeng/tui-react'
 *
 * const { IfCapability, ScrollBox, Box } = Universal
 *
 * const LogViewer = ({ logs }) => (
 *   <IfCapability
 *     capability="scroll"
 *     fallback={<Box>{logs.slice(-10).map(...)}</Box>}
 *   >
 *     <ScrollBox height={20}>{logs.map(...)}</ScrollBox>
 *   </IfCapability>
 * )
 * ```
 *
 * @module
 */

// Types
export type {
  UniversalBoxProps,
  UniversalTextProps,
  UniversalSpinnerProps,
  UniversalStaticProps,
  UniversalScrollBoxProps,
  UniversalInputProps,
  RendererCapabilities,
  ComponentAdapter,
  IfCapabilityProps,
} from './types.ts'

export { InlineCapabilities, AlternateCapabilities } from './types.ts'

// Context and hooks
export {
  AdapterProvider,
  AutoAdapterProvider,
  useAdapter,
  useCapability,
  useCapabilities,
  type AdapterProviderProps,
  type AutoAdapterProviderProps,
} from './context.tsx'

// Universal components
export {
  Box,
  Text,
  Spinner,
  Static,
  ScrollBox,
  Input,
  // Conditional rendering
  IfCapability,
  IfStatic,
  IfScroll,
  IfInput,
  IfFullScreen,
  // Utility components
  Divider,
  Spacer,
  Badge,
  type DividerProps,
  type SpacerProps,
  type BadgeProps,
} from './components.tsx'

// Adapters
export { createInlineAdapter } from './adapters/inline.tsx'
