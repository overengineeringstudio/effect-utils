/**
 * Tests for viewport hook and context.
 */

import React from 'react'
import { describe, it, expect } from 'vitest'

import { Box, Text, useViewport, ViewportProvider, renderToLines } from '../../src/mod.tsx'

describe('useViewport', () => {
  it('provides default viewport when no provider', async () => {
    let capturedViewport: { columns: number; rows: number } | null = null

    const TestComponent = () => {
      capturedViewport = useViewport()
      return <Text>Test</Text>
    }

    await renderToLines({ element: <TestComponent />, options: { width: 80 } })

    expect(capturedViewport).toEqual({ columns: 80, rows: 24 })
  })

  it('provides viewport from provider', async () => {
    let capturedViewport: { columns: number; rows: number } | null = null

    const TestComponent = () => {
      capturedViewport = useViewport()
      return <Text>Test</Text>
    }

    await renderToLines({
      element: (
        <ViewportProvider viewport={{ columns: 120, rows: 40 }}>
          <TestComponent />
        </ViewportProvider>
      ),
      options: { width: 80 },
    })

    expect(capturedViewport).toEqual({ columns: 120, rows: 40 })
  })

  it('allows components to adapt to viewport', async () => {
    const AdaptiveList = ({ items }: { items: string[] }) => {
      const { rows } = useViewport()
      const maxItems = Math.max(1, rows - 2) // Leave room for header/footer
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
        <ViewportProvider viewport={{ columns: 80, rows: 5 }}>
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
        <ViewportProvider viewport={{ columns: 80, rows: 20 }}>
          <AdaptiveList items={items} />
        </ViewportProvider>
      ),
      options: { width: 80 },
    })

    expect(largeLines.some((l: string) => l.includes('more'))).toBe(false)
  })
})
