import { Atom } from '@effect-atom/atom'
import React, { useMemo } from 'react'

import { Box, Text, useTuiAtomValue } from '../../src/mod.ts'
import type { AppState, Window, Color } from './schema.ts'

export const BouncingWindowsView = ({ stateAtom }: { stateAtom: Atom.Atom<AppState> }) => {
  const tagAtom = useMemo(() => Atom.map(stateAtom, (s) => s._tag), [stateAtom])
  const tag = useTuiAtomValue(tagAtom)

  switch (tag) {
    case 'Running':
      return <RunningView stateAtom={stateAtom} />
    case 'Finished':
      return <FinishedView stateAtom={stateAtom} />
    case 'Interrupted':
      return <InterruptedView stateAtom={stateAtom} />
  }
}

// =============================================================================
// Internal Types and Helpers
// =============================================================================

interface Cell {
  char: string
  color: Color | null
}

function formatStat({
  label,
  value,
  width,
}: {
  label: string
  value: number
  width: number
}): string {
  const barW = width - 7
  const filled = Math.round((value / 100) * barW)
  const bar = '█'.repeat(filled) + '░'.repeat(barW - filled)
  return `${label} ${bar}${Math.round(value).toString().padStart(3)}`
}

function renderWindowToCanvas({
  canvas,
  win,
  canvasWidth,
}: {
  canvas: Cell[][]
  win: Window
  canvasWidth: number
}) {
  const x = Math.floor(win.x)
  const y = Math.floor(win.y)
  const { width, height, title, stats, color } = win
  const innerW = width - 2

  const lines = [
    '┌' + '─'.repeat(innerW) + '┐',
    '│' + ` ${title} `.padEnd(innerW, '─') + '│',
    '├' + '─'.repeat(innerW) + '┤',
    '│' + formatStat({ label: 'CPU', value: stats.cpu, width: innerW }) + '│',
    '│' + formatStat({ label: 'MEM', value: stats.mem, width: innerW }) + '│',
    '│' + formatStat({ label: 'DSK', value: stats.disk, width: innerW }) + '│',
    '│' + ` NET ${(stats.net / 100).toFixed(1).padStart(5)}Mb`.padEnd(innerW) + '│',
    '└' + '─'.repeat(innerW) + '┘',
  ]

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

function createCanvas({ width, height }: { width: number; height: number }): Cell[][] {
  return Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({ char: ' ', color: null })),
  )
}

// =============================================================================
// Internal Components
// =============================================================================

function CanvasRenderer({
  windows,
  width,
  height,
}: {
  windows: readonly Window[]
  width: number
  height: number
}) {
  const canvas = createCanvas({ width, height })

  for (const win of windows) {
    renderWindowToCanvas({ canvas, win, canvasWidth: width })
  }

  const renderedLines = canvas.map((row, rowIdx) => {
    const segments: React.ReactNode[] = []
    let currentColor: Color | null = null
    let currentText = ''

    for (let col = 0; col < row.length; col++) {
      const cell = row[col]!
      if (cell.color !== currentColor) {
        if (currentText) {
          segments.push(
            currentColor ? (
              <Text key={`${rowIdx}-${segments.length}`} color={currentColor}>
                {currentText}
              </Text>
            ) : (
              <Text key={`${rowIdx}-${segments.length}`}>{currentText}</Text>
            ),
          )
        }
        currentColor = cell.color
        currentText = cell.char
      } else {
        currentText += cell.char
      }
    }
    if (currentText) {
      segments.push(
        currentColor ? (
          <Text key={`${rowIdx}-${segments.length}`} color={currentColor}>
            {currentText}
          </Text>
        ) : (
          <Text key={`${rowIdx}-${segments.length}`}>{currentText}</Text>
        ),
      )
    }

    return (
      <Box key={rowIdx} flexDirection="row">
        {segments}
      </Box>
    )
  })

  return <Box>{renderedLines}</Box>
}

function RunningView({ stateAtom }: { stateAtom: Atom.Atom<AppState> }) {
  const state = useTuiAtomValue(stateAtom)
  if (state._tag !== 'Running') return null
  return (
    <Box>
      <Box flexDirection="row">
        <Text bold color="cyan">
          Bouncing Windows
        </Text>
        <Text dim>
          {' '}
          │ {state.windows.length} window{state.windows.length > 1 ? 's' : ''}
        </Text>
        <Text dim> │ Frame: {state.frame}</Text>
        <Text dim>
          {' '}
          │ {state.termWidth}x{state.termHeight}
        </Text>
        <Text dim> │ Ctrl+C to exit</Text>
      </Box>
      <Text dim>{'─'.repeat(state.termWidth)}</Text>
      <CanvasRenderer windows={state.windows} width={state.termWidth} height={state.termHeight} />
      <Text dim>{'─'.repeat(state.termWidth)}</Text>
    </Box>
  )
}

function FinishedView({ stateAtom }: { stateAtom: Atom.Atom<AppState> }) {
  const state = useTuiAtomValue(stateAtom)
  if (state._tag !== 'Finished') return null
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="green">
        Bouncing Windows - Finished
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row">
          <Text>Total Frames: </Text>
          <Text bold>{state.totalFrames}</Text>
        </Box>
        <Box flexDirection="row">
          <Text>Windows: </Text>
          <Text bold>{state.windowCount}</Text>
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text dim>Demo completed after reaching the time limit.</Text>
      </Box>
    </Box>
  )
}

function InterruptedView({ stateAtom }: { stateAtom: Atom.Atom<AppState> }) {
  const state = useTuiAtomValue(stateAtom)
  if (state._tag !== 'Interrupted') return null
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="yellow">
        Bouncing Windows - Interrupted
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row">
          <Text>Frames rendered: </Text>
          <Text bold>{state.frame}</Text>
        </Box>
        <Box flexDirection="row">
          <Text>Windows: </Text>
          <Text bold>{state.windowCount}</Text>
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text dim>Demo was cancelled by user (Ctrl+C).</Text>
      </Box>
    </Box>
  )
}
