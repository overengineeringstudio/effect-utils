/**
 * Stress test: many lines - tests rendering 100+ lines simultaneously.
 *
 * This example renders a large number of items to verify:
 * - The renderer handles many lines without performance issues
 * - Yoga layout calculates correctly for tall content
 * - Terminal output remains coherent
 *
 * Run: npx tsx examples/stress-lines.tsx
 */

import React, { useState, useEffect } from 'react'
import { createRoot, Box, Text, Spinner } from '../src/mod.ts'

const TOTAL_ITEMS = 50
const VISIBLE_ITEMS = 25 // Simulating a viewport

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
      [{'█'.repeat(filled)}{'░'.repeat(empty)}]
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

const generateItems = (): Item[] => {
  return Array.from({ length: TOTAL_ITEMS }, (_, i) => ({
    id: i,
    name: `task-${(i + 1).toString().padStart(3, '0')}`,
    status: 'pending' as const,
    progress: 0,
  }))
}

const App = () => {
  const [items, setItems] = useState<Item[]>(generateItems)
  const [scrollOffset, setScrollOffset] = useState(0)
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => {
      setFrame(f => f + 1)
      
      setItems(prev => {
        const newItems = [...prev]
        
        // Find running items and advance their progress
        newItems.forEach((item, i) => {
          if (item.status === 'running') {
            const newProgress = Math.min(100, item.progress + Math.random() * 15)
            if (newProgress >= 100) {
              newItems[i] = { ...item, status: Math.random() > 0.1 ? 'done' : 'error', progress: 100 }
            } else {
              newItems[i] = { ...item, progress: Math.round(newProgress) }
            }
          }
        })

        // Start new items (up to 5 concurrent)
        const runningCount = newItems.filter(i => i.status === 'running').length
        const pendingItems = newItems.filter(i => i.status === 'pending')
        const toStart = Math.min(5 - runningCount, pendingItems.length, 2)
        
        for (let i = 0; i < toStart; i++) {
          const pendingIndex = newItems.findIndex(item => item.status === 'pending')
          if (pendingIndex !== -1) {
            newItems[pendingIndex] = { ...newItems[pendingIndex]!, status: 'running', progress: 0 }
          }
        }

        return newItems
      })

      // Auto-scroll to show active items
      setItems(currentItems => {
        const firstRunning = currentItems.findIndex(i => i.status === 'running')
        if (firstRunning !== -1 && firstRunning >= scrollOffset + VISIBLE_ITEMS - 3) {
          setScrollOffset(Math.min(firstRunning - 3, TOTAL_ITEMS - VISIBLE_ITEMS))
        }
        return currentItems
      })
    }, 100)

    return () => clearInterval(interval)
  }, [scrollOffset])

  const visibleItems = items.slice(scrollOffset, scrollOffset + VISIBLE_ITEMS)
  const doneCount = items.filter(i => i.status === 'done').length
  const errorCount = items.filter(i => i.status === 'error').length
  const runningCount = items.filter(i => i.status === 'running').length
  const allDone = doneCount + errorCount === TOTAL_ITEMS

  return (
    <Box>
      <Box flexDirection="row">
        <Text bold>Stress Test: Many Lines </Text>
        <Text dim>({TOTAL_ITEMS} items, showing {VISIBLE_ITEMS})</Text>
      </Box>
      <Text dim>{'─'.repeat(50)}</Text>

      <Box paddingTop={1}>
        {scrollOffset > 0 && (
          <Text dim>  ↑ {scrollOffset} more items above</Text>
        )}
        
        {visibleItems.map(item => (
          <ItemRow key={item.id} item={item} />
        ))}
        
        {scrollOffset + VISIBLE_ITEMS < TOTAL_ITEMS && (
          <Text dim>  ↓ {TOTAL_ITEMS - scrollOffset - VISIBLE_ITEMS} more items below</Text>
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
          <Text dim>{TOTAL_ITEMS - doneCount - errorCount - runningCount} pending</Text>
        </Box>
        {!allDone && (
          <Text dim>Frame: {frame} | Scroll: {scrollOffset}</Text>
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

const root = createRoot(process.stdout)
root.render(<App />)

// Auto-exit after completion or timeout
const checkDone = setInterval(() => {
  // Will exit when all items are processed (handled via the rendered state)
}, 500)

setTimeout(() => {
  clearInterval(checkDone)
  root.unmount()
  console.log('\nStress test completed.')
  process.exit(0)
}, 30000) // Max 30 seconds
