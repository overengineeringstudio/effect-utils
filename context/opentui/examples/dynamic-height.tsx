/**
 * Dynamic height TUI demonstrating terminal dimension handling.
 *
 * Key patterns:
 * - Get dimensions from renderer (not process.stdout)
 * - Listen for resize events
 * - Use explicit height prop on boxes
 *
 * Run: bun examples/dynamic-height.tsx
 */
import { createCliRenderer, type CliRenderer } from '@opentui/core'
import { createRoot } from '@opentui/react'
import { useState, useEffect, createContext, useContext } from 'react'

/** Context to pass renderer to components */
const RendererContext = createContext<CliRenderer | null>(null)

/** Hook to get reactive terminal dimensions from renderer */
const useTerminalDimensions = () => {
  const renderer = useContext(RendererContext)
  const [dimensions, setDimensions] = useState({
    width: renderer?.width ?? 80,
    height: renderer?.height ?? 24,
  })

  useEffect(() => {
    if (!renderer) return

    const handleResize = () => {
      setDimensions({ width: renderer.width, height: renderer.height })
    }

    // Cast needed: CliRenderer extends EventEmitter but types don't expose it
    ;(renderer as unknown as NodeJS.EventEmitter).on('resize', handleResize)

    return () => {
      ;(renderer as unknown as NodeJS.EventEmitter).off('resize', handleResize)
    }
  }, [renderer])

  return dimensions
}

/** Example list component that fills available height */
const DynamicList = ({ maxItems }: { maxItems: number }) => {
  const items = Array.from({ length: 50 }, (_, i) => `Item ${i + 1}`)
  const visibleItems = items.slice(0, maxItems)
  const hasMore = items.length > maxItems

  return (
    <box flexDirection="column" borderStyle="single" height={maxItems + 2}>
      {visibleItems.map((item, idx) => (
        <text key={idx} fg={idx % 2 === 0 ? 'white' : 'gray'}>
          {item}
        </text>
      ))}
      {hasMore && <text fg="yellow">... {items.length - maxItems} more items</text>}
    </box>
  )
}

const App = () => {
  const { width, height } = useTerminalDimensions()

  // Calculate available height for list
  // Fixed UI: header(1) + padding(2) + footer(1) = 4 lines
  const fixedUi = 4
  const listHeight = Math.max(5, height - fixedUi)

  return (
    <box flexDirection="column" padding={1}>
      <text fg="cyan">
        <b>
          Dynamic Height Example ({width}x{height})
        </b>
      </text>

      <DynamicList maxItems={listHeight} />

      <text fg="gray">Resize terminal to see list adjust. Press Ctrl+C to exit.</text>
    </box>
  )
}

const main = async () => {
  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  const root = createRoot(renderer)

  root.render(
    <RendererContext.Provider value={renderer}>
      <App />
    </RendererContext.Provider>,
  )

  await new Promise(() => {})
}

main().catch(console.error)
