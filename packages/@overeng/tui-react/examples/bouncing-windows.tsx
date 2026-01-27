/**
 * Bouncing Windows - DVD screensaver style window manager simulation.
 *
 * Windows bounce around the terminal with fake system stats inside.
 *
 * Usage:
 *   npx tsx examples/bouncing-windows.tsx [count]
 *
 * Examples:
 *   npx tsx examples/bouncing-windows.tsx       # Single window
 *   npx tsx examples/bouncing-windows.tsx 3     # Three windows
 *   npx tsx examples/bouncing-windows.tsx 7     # Chaos mode!
 */

import React, { useState, useEffect } from 'react'
import { createRoot, Box, Text } from '../src/mod.ts'

// =============================================================================
// Types
// =============================================================================

interface Window {
  id: number
  x: number
  y: number
  vx: number
  vy: number
  width: number
  height: number
  title: string
  color: Color
  stats: Stats
}

interface Stats {
  cpu: number
  mem: number
  disk: number
  net: number
}

type Color = 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan'

// =============================================================================
// Constants
// =============================================================================

const COLORS: Color[] = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan']
const TITLES = ['System', 'Monitor', 'Stats', 'Dashboard', 'Metrics', 'Status']
const FRAME_MS = 80 // ~12fps
const WIN_WIDTH = 22
const WIN_HEIGHT = 8

// Dynamic terminal size
const getTermSize = () => ({
  width: (process.stdout.columns || 80) - 2,
  height: (process.stdout.rows || 24) - 4,
})

// =============================================================================
// Helpers
// =============================================================================

const randomBetween = (min: number, max: number) => Math.random() * (max - min) + min

const createWindow = (id: number, count: number): Window => {
  const { width, height } = getTermSize()
  // Spread windows out initially
  const startX = (id * (width / count)) % Math.max(1, width - WIN_WIDTH)
  const startY = (id * 3) % Math.max(1, height - WIN_HEIGHT)
  
  return {
    id,
    x: startX,
    y: startY,
    vx: randomBetween(0.8, 2.0) * (Math.random() > 0.5 ? 1 : -1),
    vy: randomBetween(0.4, 1.0) * (Math.random() > 0.5 ? 1 : -1),
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
    title: TITLES[id % TITLES.length] ?? 'Window',
    color: COLORS[id % COLORS.length] ?? 'cyan',
    stats: {
      cpu: Math.random() * 100,
      mem: Math.random() * 100,
      disk: Math.random() * 100,
      net: Math.random() * 1000,
    },
  }
}

const updateWindow = (win: Window, termWidth: number, termHeight: number): Window => {
  let { x, y, vx, vy } = win

  // Move
  x += vx
  y += vy

  // Bounce off edges
  if (x <= 0) { x = 0; vx = Math.abs(vx) }
  if (x + WIN_WIDTH >= termWidth) { x = termWidth - WIN_WIDTH; vx = -Math.abs(vx) }
  if (y <= 0) { y = 0; vy = Math.abs(vy) }
  if (y + WIN_HEIGHT >= termHeight) { y = termHeight - WIN_HEIGHT; vy = -Math.abs(vy) }

  // Drift stats
  const stats = {
    cpu: Math.max(0, Math.min(100, win.stats.cpu + randomBetween(-3, 3))),
    mem: Math.max(0, Math.min(100, win.stats.mem + randomBetween(-2, 2))),
    disk: Math.max(0, Math.min(100, win.stats.disk + randomBetween(-1, 1))),
    net: Math.max(0, Math.min(1000, win.stats.net + randomBetween(-30, 30))),
  }

  return { ...win, x, y, vx, vy, stats }
}

// =============================================================================
// Canvas rendering (with color support)
// =============================================================================

interface Cell {
  char: string
  color: Color | null
}

const renderWindowToCanvas = (canvas: Cell[][], win: Window, canvasWidth: number) => {
  const x = Math.floor(win.x)
  const y = Math.floor(win.y)
  const { width, height, title, stats, color } = win
  const innerW = width - 2

  // Build window lines
  const lines = [
    '┌' + '─'.repeat(innerW) + '┐',
    '│' + ` ${title} `.padEnd(innerW, '─') + '│',
    '├' + '─'.repeat(innerW) + '┤',
    '│' + formatStat('CPU', stats.cpu, innerW) + '│',
    '│' + formatStat('MEM', stats.mem, innerW) + '│',
    '│' + formatStat('DSK', stats.disk, innerW) + '│',
    '│' + ` NET ${(stats.net/100).toFixed(1).padStart(5)}Mb`.padEnd(innerW) + '│',
    '└' + '─'.repeat(innerW) + '┘',
  ]

  // Draw to canvas with color
  for (let row = 0; row < Math.min(lines.length, height); row++) {
    const line = lines[row]!
    const canvasY = y + row
    if (canvasY < 0 || canvasY >= canvas.length) continue
    
    for (let col = 0; col < line.length; col++) {
      const canvasX = x + col
      if (canvasX < 0 || canvasX >= canvasWidth) continue
      canvas[canvasY]![canvasX] = { char: line[col]!, color }
    }
  }
}

const formatStat = (label: string, value: number, width: number): string => {
  const barW = width - 7 // label(3) + space + pct(3)
  const filled = Math.round((value / 100) * barW)
  const bar = '█'.repeat(filled) + '░'.repeat(barW - filled)
  return `${label} ${bar}${Math.round(value).toString().padStart(3)}`
}

const createCanvas = (width: number, height: number): Cell[][] => {
  return Array.from({ length: height }, () => 
    Array.from({ length: width }, () => ({ char: ' ', color: null }))
  )
}

// =============================================================================
// Components
// =============================================================================

const CanvasRenderer = ({ windows, width, height }: { windows: Window[]; width: number; height: number }) => {
  // Create fresh canvas
  const canvas = createCanvas(width, height)
  
  // Draw each window (last = on top)
  for (const win of windows) {
    renderWindowToCanvas(canvas, win, width)
  }

  // Convert canvas to colored lines
  const renderedLines = canvas.map((row, rowIdx) => {
    const segments: React.ReactNode[] = []
    let currentColor: Color | null = null
    let currentText = ''

    for (let col = 0; col < row.length; col++) {
      const cell = row[col]!
      if (cell.color !== currentColor) {
        // Flush current segment
        if (currentText) {
          segments.push(
            currentColor 
              ? <Text key={`${rowIdx}-${segments.length}`} color={currentColor}>{currentText}</Text>
              : <Text key={`${rowIdx}-${segments.length}`}>{currentText}</Text>
          )
        }
        currentColor = cell.color
        currentText = cell.char
      } else {
        currentText += cell.char
      }
    }
    // Flush final segment
    if (currentText) {
      segments.push(
        currentColor 
          ? <Text key={`${rowIdx}-${segments.length}`} color={currentColor}>{currentText}</Text>
          : <Text key={`${rowIdx}-${segments.length}`}>{currentText}</Text>
      )
    }

    return <Box key={rowIdx} flexDirection="row">{segments}</Box>
  })

  return <Box>{renderedLines}</Box>
}

const App = ({ windowCount }: { windowCount: number }) => {
  const [termSize, setTermSize] = useState(getTermSize)
  const [windows, setWindows] = useState<Window[]>(() =>
    Array.from({ length: windowCount }, (_, i) => createWindow(i, windowCount))
  )
  const [frame, setFrame] = useState(0)

  // Handle terminal resize
  useEffect(() => {
    const handleResize = () => {
      setTermSize(getTermSize())
    }
    process.stdout.on('resize', handleResize)
    return () => { process.stdout.off('resize', handleResize) }
  }, [])

  // Animation loop
  useEffect(() => {
    const interval = setInterval(() => {
      const { width, height } = getTermSize()
      setWindows(prev => prev.map(w => updateWindow(w, width, height)))
      setFrame(f => f + 1)
    }, FRAME_MS)

    return () => clearInterval(interval)
  }, [])

  return (
    <Box>
      <Box flexDirection="row">
        <Text bold color="cyan">Bouncing Windows</Text>
        <Text dim> │ {windowCount} window{windowCount > 1 ? 's' : ''}</Text>
        <Text dim> │ Frame: {frame}</Text>
        <Text dim> │ {termSize.width}x{termSize.height}</Text>
        <Text dim> │ Ctrl+C to exit</Text>
      </Box>
      <Text dim>{'─'.repeat(termSize.width)}</Text>
      <CanvasRenderer windows={windows} width={termSize.width} height={termSize.height} />
      <Text dim>{'─'.repeat(termSize.width)}</Text>
    </Box>
  )
}

// =============================================================================
// Main
// =============================================================================

const windowCount = Math.min(Math.max(parseInt(process.argv[2] ?? '1', 10) || 1, 1), 6)

const root = createRoot(process.stdout)
root.render(<App windowCount={windowCount} />)

setTimeout(() => {
  root.unmount()
  console.log('\n👋 Demo ended.')
  process.exit(0)
}, 60000)
