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

import { useState, useEffect, type ReactNode } from 'react'
import { Text } from './Text.tsx'

/** Spinner animation types */
export type SpinnerType = 'dots' | 'line' | 'arc' | 'bounce' | 'bar'

/** Spinner frames for each type */
export const spinnerFrames: Record<SpinnerType, readonly string[]> = {
  dots: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  line: ['-', '\\', '|', '/'],
  arc: ['◜', '◠', '◝', '◞', '◡', '◟'],
  bounce: ['⠁', '⠂', '⠄', '⠂'],
  bar: ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█', '▉', '▊', '▋', '▌', '▍', '▎'],
}

/** Frame intervals (ms) for each type */
const spinnerIntervals: Record<SpinnerType, number> = {
  dots: 80,
  line: 100,
  arc: 100,
  bounce: 120,
  bar: 80,
}

import type { Color } from '@overeng/tui-core'

/** Spinner component props */
export interface SpinnerProps {
  /** Spinner animation type. Default: 'dots' */
  type?: SpinnerType | undefined
  /** Spinner color. Default: 'cyan' */
  color?: Color | undefined
}

/**
 * Spinner component for loading indication.
 *
 * Uses state to animate through frames.
 */
export const Spinner = (props: SpinnerProps): ReactNode => {
  const { type = 'dots', color = 'cyan' } = props
  const frames = spinnerFrames[type]
  const interval = spinnerIntervals[type]
  
  const [frameIndex, setFrameIndex] = useState(0)
  
  useEffect(() => {
    const timer = setInterval(() => {
      setFrameIndex(prev => (prev + 1) % frames.length)
    }, interval)
    
    return () => clearInterval(timer)
  }, [frames.length, interval])
  
  return Text({ color, children: frames[frameIndex] })
}
