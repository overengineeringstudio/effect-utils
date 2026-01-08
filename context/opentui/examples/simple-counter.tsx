/**
 * Simple counter TUI demonstrating basic OpenTUI + React patterns.
 *
 * Run: bun examples/simple-counter.tsx
 */
import { createCliRenderer } from '@opentui/core'
import { createRoot } from '@opentui/react'
import { useState, useEffect } from 'react'

const Counter = () => {
  const [count, setCount] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => {
      setCount((c) => c + 1)
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  return (
    <box flexDirection="column" padding={1}>
      <text fg="cyan">
        <b>OpenTUI Counter Example</b>
      </text>
      <text>Count: {count}</text>
      <text fg="gray">Press Ctrl+C to exit</text>
    </box>
  )
}

const main = async () => {
  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  const root = createRoot(renderer)

  root.render(<Counter />)

  // Keep process alive
  await new Promise(() => {})
}

main().catch(console.error)
