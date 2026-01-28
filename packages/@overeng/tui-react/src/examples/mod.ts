/**
 * Shared example components for @overeng/tui-react.
 *
 * These components are used by:
 * - Storybook stories (visual documentation)
 * - Terminal demos (interactive testing)
 *
 * @example
 * ```tsx
 * // In a story
 * import { TextColorsExample } from '../examples/mod.ts'
 * export const AllColors: Story = { render: () => <TextColorsExample /> }
 *
 * // In a terminal demo
 * import { TextColorsExample } from '../src/examples/mod.ts'
 * root.render(<TextColorsExample />)
 * ```
 */

// Text examples
export { TextColorsExample } from './text-colors.tsx'
export { TextStylesExample } from './text-styles.tsx'

// Box examples
export { BoxBasicExample } from './box-basic.tsx'
export { BoxNestedExample } from './box-nested.tsx'
export { BoxComplexLayoutExample } from './box-complex-layout.tsx'

// TaskList examples
export { TaskListBasicExample } from './task-list-basic.tsx'
export { TaskListAllStatesExample } from './task-list-all-states.tsx'
export { TaskListWithSummaryExample } from './task-list-with-summary.tsx'

// Spinner examples
export { SpinnerBasicExample } from './spinner-basic.tsx'
export { SpinnerAllTypesExample } from './spinner-all-types.tsx'

// Interactive/animated examples (for terminal demos and Storybook)
export { SyncSimulationExample, type SyncSimulationProps, type SyncState, type SyncPhase } from './sync-simulation.tsx'
export { LogsAboveProgressExample, type LogsAboveProgressExampleProps } from './logs-above-progress.tsx'
export { ProgressListExample, type ProgressListExampleProps } from './progress-list.tsx'
export { SyncDeepSimulationExample, type SyncDeepSimulationExampleProps, type SyncDeepState, type SyncDeepPhase } from './sync-deep-simulation.tsx'

// Stress test examples
export { StressRapidExample, type StressRapidExampleProps } from './stress-rapid.tsx'
export { StressLinesExample, type StressLinesExampleProps } from './stress-lines.tsx'

// Fun demos
export { BouncingWindowsExample, type BouncingWindowsExampleProps } from './bouncing-windows.tsx'
