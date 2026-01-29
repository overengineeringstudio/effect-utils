/**
 * Stress test: rapid updates - tests differential rendering at high frequency.
 *
 * This example updates a counter at ~60fps to verify:
 * - The renderer can handle rapid state changes
 * - Differential rendering minimizes terminal writes
 * - No visual flickering occurs
 */

import React, { useState, useEffect } from 'react'

import { Box, Text, Spinner } from '../mod.ts'

export interface StressRapidExampleProps {
  /** Target FPS for the animation (default: 60) */
  targetFps?: number
  /** Speed multiplier for the animation (default: 1) */
  speed?: number
}

/**
 * Rapid update stress test with animated counters and progress bars.
 */
export const StressRapidExample = ({ targetFps = 60, speed = 1 }: StressRapidExampleProps = {}) => {
  const [frame, setFrame] = useState(0)
  const [fps, setFps] = useState(0)

  useEffect(() => {
    const frameInterval = 1000 / targetFps / speed

    let lastFpsUpdate = Date.now()
    let framesSinceLastFpsUpdate = 0

    const interval = setInterval(() => {
      setFrame((f) => f + 1)
      framesSinceLastFpsUpdate++

      // Calculate actual FPS every second
      const now = Date.now()
      if (now - lastFpsUpdate >= 1000) {
        setFps(Math.round((framesSinceLastFpsUpdate * 1000) / (now - lastFpsUpdate)))
        framesSinceLastFpsUpdate = 0
        lastFpsUpdate = now
      }
    }, frameInterval)

    return () => clearInterval(interval)
  }, [targetFps, speed])

  // Animated progress bar
  const barWidth = 30
  const progress = (frame % 100) / 100
  const filledWidth = Math.round(progress * barWidth)
  const emptyWidth = barWidth - filledWidth
  const progressBar = '█'.repeat(filledWidth) + '░'.repeat(emptyWidth)

  // Bouncing dot animation
  const bounceWidth = 20
  const bouncePos = Math.abs((frame % (bounceWidth * 2)) - bounceWidth)
  const bounceLine = ' '.repeat(bouncePos) + '●' + ' '.repeat(bounceWidth - bouncePos)

  // Color cycling
  const colors = ['red', 'yellow', 'green', 'cyan', 'blue', 'magenta'] as const
  const colorIndex = Math.floor(frame / 10) % colors.length
  const currentColor = colors[colorIndex]

  return (
    <Box>
      <Text bold>Stress Test: Rapid Updates ({targetFps}fps target)</Text>
      <Text dim>─────────────────────────────────────────</Text>

      <Box paddingTop={1}>
        <Box flexDirection="row">
          <Spinner />
          <Text> Frame: </Text>
          <Text bold color="cyan">
            {frame.toString().padStart(6, ' ')}
          </Text>
        </Box>

        <Box flexDirection="row">
          <Text> Actual FPS: </Text>
          <Text bold color={fps >= 55 ? 'green' : fps >= 30 ? 'yellow' : 'red'}>
            {fps.toString().padStart(3, ' ')}
          </Text>
        </Box>
      </Box>

      <Box paddingTop={1}>
        <Text>
          Progress: [{progressBar}]{' '}
          {Math.round(progress * 100)
            .toString()
            .padStart(3, ' ')}
          %
        </Text>
      </Box>

      <Box paddingTop={1}>
        <Text>Bounce: |{bounceLine}|</Text>
      </Box>

      <Box paddingTop={1}>
        <Text>Color: </Text>
        <Text color={currentColor} bold>
          {currentColor?.toUpperCase()}
        </Text>
      </Box>

      <Box paddingTop={1}>
        <Text dim>Running for {Math.floor(frame / targetFps)} seconds...</Text>
      </Box>
    </Box>
  )
}
