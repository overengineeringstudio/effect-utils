/**
 * Spinner component - animated loading indicator.
 *
 * @example
 * ```tsx
 * <Box flexDirection="row">
 *   <Spinner />
 *   <Text> Loading...</Text>
 * </Box>
 * ```
 */

import type { ReactNode } from 'react'

/** Spinner animation types */
export type SpinnerType = 'dots' | 'line' | 'arc'

/** Spinner frames for each type */
export const spinnerFrames: Record<SpinnerType, readonly string[]> = {
  dots: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  line: ['-', '\\', '|', '/'],
  arc: ['◜', '◠', '◝', '◞', '◡', '◟'],
}

/** Spinner component props */
export interface SpinnerProps {
  /** Spinner animation type. Default: 'dots' */
  type?: SpinnerType | undefined
}

/**
 * Spinner component for loading indication.
 *
 * Uses state to animate through frames.
 */
export const Spinner = (_props: SpinnerProps): ReactNode => {
  // Placeholder: actual implementation will use useEffect for animation
  return null
}
