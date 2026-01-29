/**
 * Stress test: many lines - tests rendering 50+ items simultaneously.
 *
 * This example renders a large number of items to verify:
 * - The renderer handles many lines without performance issues
 * - Yoga layout calculates correctly for tall content
 */

import React, { useState, useEffect } from 'react'

import { Box, Text, Spinner } from '../mod.ts'

interface Item {
  id: number
  name: string
  status: 'pending' | 'running' | 'done' | 'error'
  progress: number
}

const StatusIcon = ({ status }: { status: Item['status'] }) => {
  switch (status) {
    case 'pending':
      return <Text dim>○</Text>
    case 'running':
      return <Spinner />
    case 'done':
      return <Text color="green">✓</Text>
    case 'error':
      return <Text color="red">✗</Text>
  }
}

const ProgressBar = ({ progress, width = 10 }: { progress: number; width?: number }) => {
  const filled = Math.round((progress / 100) * width)
  const empty = width - filled
  return (
    <Text dim>
      [{'█'.repeat(filled)}
      {'░'.repeat(empty)}]
    </Text>
  )
}

const ItemRow = ({ item }: { item: Item }) => (
  <Box flexDirection="row">
    <StatusIcon status={item.status} />
    <Text> </Text>
    <Text
      color={item.status === 'done' ? 'green' : item.status === 'error' ? 'red' : undefined}
      dim={item.status === 'pending'}
    >
      {item.name.padEnd(20, ' ')}
    </Text>
    {item.status === 'running' && (
      <>
        <Text> </Text>
        <ProgressBar progress={item.progress} />
        <Text dim> {item.progress.toString().padStart(3, ' ')}%</Text>
      </>
    )}
  </Box>
)

export interface StressLinesExampleProps {
  /** Total number of items to process (default: 50) */
  totalItems?: number
  /** Number of visible items in viewport (default: 25) */
  visibleItems?: number
  /** Speed multiplier for the simulation (default: 1) */
  speed?: number
}

/**
 * Many lines stress test with auto-scrolling viewport.
 */
export const StressLinesExample = ({
  totalItems = 50,
  visibleItems = 25,
  speed = 1,
}: StressLinesExampleProps = {}) => {
  const [items, setItems] = useState<Item[]>(() =>
    Array.from({ length: totalItems }, (_, i) => ({
      id: i,
      name: `task-${(i + 1).toString().padStart(3, '0')}`,
      status: 'pending' as const,
      progress: 0,
    })),
  )
  const [scrollOffset, setScrollOffset] = useState(0)
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => {
      setFrame((f) => f + 1)

      setItems((prev) => {
        const newItems = [...prev]

        // Find running items and advance their progress
        newItems.forEach((item, i) => {
          if (item.status === 'running') {
            const newProgress = Math.min(100, item.progress + Math.random() * 15)
            if (newProgress >= 100) {
              newItems[i] = {
                ...item,
                status: Math.random() > 0.1 ? 'done' : 'error',
                progress: 100,
              }
            } else {
              newItems[i] = { ...item, progress: Math.round(newProgress) }
            }
          }
        })

        // Start new items (up to 5 concurrent)
        const runningCount = newItems.filter((i) => i.status === 'running').length
        const toStart = Math.min(5 - runningCount, 2)

        for (let i = 0; i < toStart; i++) {
          const pendingIndex = newItems.findIndex((item) => item.status === 'pending')
          if (pendingIndex !== -1) {
            newItems[pendingIndex] = { ...newItems[pendingIndex]!, status: 'running', progress: 0 }
          }
        }

        return newItems
      })

      // Auto-scroll to show active items
      setItems((currentItems) => {
        const firstRunning = currentItems.findIndex((i) => i.status === 'running')
        if (firstRunning !== -1 && firstRunning >= scrollOffset + visibleItems - 3) {
          setScrollOffset(Math.min(firstRunning - 3, totalItems - visibleItems))
        }
        return currentItems
      })
    }, 100 / speed)

    return () => clearInterval(interval)
  }, [scrollOffset, speed, totalItems, visibleItems])

  const visibleItemsList = items.slice(scrollOffset, scrollOffset + visibleItems)
  const doneCount = items.filter((i) => i.status === 'done').length
  const errorCount = items.filter((i) => i.status === 'error').length
  const runningCount = items.filter((i) => i.status === 'running').length
  const allDone = doneCount + errorCount === totalItems

  return (
    <Box>
      <Box flexDirection="row">
        <Text bold>Stress Test: Many Lines </Text>
        <Text dim>
          ({totalItems} items, showing {visibleItems})
        </Text>
      </Box>
      <Text dim>{'─'.repeat(50)}</Text>

      <Box paddingTop={1}>
        {scrollOffset > 0 && <Text dim> ↑ {scrollOffset} more items above</Text>}

        {visibleItemsList.map((item) => (
          <ItemRow key={item.id} item={item} />
        ))}

        {scrollOffset + visibleItems < totalItems && (
          <Text dim> ↓ {totalItems - scrollOffset - visibleItems} more items below</Text>
        )}
      </Box>

      <Box paddingTop={1}>
        <Text dim>{'─'.repeat(50)}</Text>
        <Box flexDirection="row">
          <Text>Status: </Text>
          <Text color="green">{doneCount} done</Text>
          <Text>, </Text>
          {errorCount > 0 && (
            <>
              <Text color="red">{errorCount} failed</Text>
              <Text>, </Text>
            </>
          )}
          <Text color="cyan">{runningCount} running</Text>
          <Text>, </Text>
          <Text dim>{totalItems - doneCount - errorCount - runningCount} pending</Text>
        </Box>
        {!allDone && (
          <Text dim>
            Frame: {frame} | Scroll: {scrollOffset}
          </Text>
        )}
        {allDone && (
          <Text color={errorCount > 0 ? 'yellow' : 'green'} bold>
            All tasks completed! ({errorCount} errors)
          </Text>
        )}
      </Box>
    </Box>
  )
}
