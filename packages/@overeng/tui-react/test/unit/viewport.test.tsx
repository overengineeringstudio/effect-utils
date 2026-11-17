/**
 * Tests for viewport hook and context.
 */

import React from 'react'
import { describe, it, expect } from 'vitest'

import {
  Box,
  Text,
  useViewport,
  ViewportProvider,
  renderToLines,
  type Viewport,
} from '../../src/mod.tsx'

describe('useViewport', () => {
  it('provides an unbounded viewport for string rendering', async () => {
    let capturedViewport: Viewport | null = null

    const TestComponent = () => {
      capturedViewport = useViewport()
      return <Text>Test</Text>
    }

    await renderToLines({ element: <TestComponent />, options: { width: 80 } })

    expect(capturedViewport).toEqual({ _tag: 'unbounded', columns: 80 })
  })

  it('provides viewport from provider', async () => {
    let capturedViewport: Viewport | null = null

    const TestComponent = () => {
      capturedViewport = useViewport()
      return <Text>Test</Text>
    }

    await renderToLines({
      element: (
        <ViewportProvider viewport={{ _tag: 'bounded', columns: 120, rows: 40 }}>
          <TestComponent />
        </ViewportProvider>
      ),
      options: { width: 80 },
    })

    expect(capturedViewport).toEqual({ _tag: 'bounded', columns: 120, rows: 40 })
  })

  it('allows components to adapt to viewport', async () => {
    const AdaptiveList = ({ items }: { items: string[] }) => {
      const viewport = useViewport()
      const maxItems = viewport._tag === 'bounded' ? Math.max(1, viewport.rows - 2) : items.length
      const visible = items.slice(0, maxItems)
      const hidden = items.length - visible.length

      return (
        <Box flexDirection="column">
          {visible.map((item) => (
            <Text key={item}>{item}</Text>
          ))}
          {hidden > 0 && <Text dim>... {hidden} more</Text>}
        </Box>
      )
    }

    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']

    // With small viewport, should truncate
    const smallLines = await renderToLines({
      element: (
        <ViewportProvider viewport={{ _tag: 'bounded', columns: 80, rows: 5 }}>
          <AdaptiveList items={items} />
        </ViewportProvider>
      ),
      options: { width: 80 },
    })

    expect(smallLines.length).toBeLessThanOrEqual(5)
    expect(smallLines.some((l: string) => l.includes('more'))).toBe(true)

    // With large viewport, should show all
    const largeLines = await renderToLines({
      element: (
        <ViewportProvider viewport={{ _tag: 'bounded', columns: 80, rows: 20 }}>
          <AdaptiveList items={items} />
        </ViewportProvider>
      ),
      options: { width: 80 },
    })

    expect(largeLines.some((l: string) => l.includes('more'))).toBe(false)

    const allItems = Array.from({ length: 120 }, (_, i) => `item-${i}`)
    const unboundedLines = await renderToLines({ element: <AdaptiveList items={allItems} /> })
    expect(unboundedLines).toEqual(allItems)
  })
})
