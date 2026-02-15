/**
 * Spinner component - animated loading indicator.
 *
 * Adapts to RenderConfig context:
 * - **animation: true**: Shows animated spinner frames
 * - **animation: false**: Shows a fixed character (for CI/log output)
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

import { useRenderConfig } from '../effect/OutputMode.tsx'
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

/** Static characters for each spinner type (used in CI/log mode) */
export const spinnerStaticChars: Record<SpinnerType, string> = {
  dots: '⠿',
  line: '*',
  arc: '◉',
  bounce: '⠿',
  bar: '█',
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
  /** Static character to use in non-animated modes. Overrides default. */
  staticChar?: string | undefined
}

/**
 * Spinner component for loading indication.
 *
 * Uses state to animate through frames when animation is enabled.
 * Shows a static character in CI/log mode.
 */
export const Spinner = (props: SpinnerProps): ReactNode => {
  const { type = 'dots', color = 'cyan', staticChar } = props
  const frames = spinnerFrames[type]
  const interval = spinnerIntervals[type]
  const renderConfig = useRenderConfig()

  const [frameIndex, setFrameIndex] = useState(0)

  // Only animate when animation is enabled
  useEffect(() => {
    if (renderConfig.animation === false) return

    const timer = setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % frames.length)
    }, interval)

    return () => clearInterval(timer)
  }, [frames.length, interval, renderConfig.animation])

  // In static mode (animation: false), show a fixed character
  if (renderConfig.animation === false) {
    const char = staticChar ?? spinnerStaticChars[type]
    return Text({ color: renderConfig.colors === true ? color : undefined, children: char })
  }

  // In animated mode, show the current frame
  return Text({ color, children: frames[frameIndex] })
}
