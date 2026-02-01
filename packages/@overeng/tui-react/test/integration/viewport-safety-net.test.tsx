/**
 * Integration tests for the viewport safety net using VirtualTerminal.
 *
 * These tests verify that the safety net in createRoot correctly prevents
 * terminal scrolling by limiting dynamic content when static lines consume
 * viewport space, and that all rendered lines (including the overflow
 * indicator) are horizontally truncated to prevent soft wrapping.
 *
 * Uses xterm.js headless (via VirtualTerminal) for faithful terminal simulation
 * including actual soft wrapping and scrolling behavior.
 */

import React from 'react'
import { describe, expect, it } from 'vitest'

import { createRoot } from '../../src/root.tsx'
import { Box } from '../../src/components/Box.tsx'
import { Text } from '../../src/components/Text.tsx'
import { Static } from '../../src/components/Static.tsx'
import { createVirtualTerminal } from '../helpers/mod.ts'

describe('Viewport safety net (VirtualTerminal)', () => {
  describe('vertical: static lines reduce dynamic budget', () => {
    it('limits dynamic lines when static lines consume viewport space', async () => {
      // 10-row terminal. 5 static lines should leave room for at most 4 dynamic lines
      // (rows - 1 - staticCount = 10 - 1 - 5 = 4).
      const terminal = createVirtualTerminal({ cols: 60, rows: 10 })
      const root = createRoot({
        terminalOrStream: terminal,
        options: { throttleMs: 0, maxDynamicLines: 100 },
      })

      const logs = ['Log A', 'Log B', 'Log C', 'Log D', 'Log E']
      const items = Array.from({ length: 8 }, (_, i) => `item-${i}`)

      root.render(
        <Box>
          <Static items={logs}>{(log) => <Text key={log}>{log}</Text>}</Static>
          <Box flexDirection="column">
            {items.map((item) => (
              <Text key={item}>{item}</Text>
            ))}
          </Box>
        </Box>,
      )
      root.flush()
      await terminal.flush()

      const lines = terminal.getVisibleLines()
      const cursor = terminal.getCursor()

      // Static lines should appear at the top
      expect(lines[0]).toBe('Log A')
      expect(lines[4]).toBe('Log E')

      // Dynamic region should be truncated — not all 8 items should appear
      const allContent = lines.join('\n')
      expect(allContent).toContain('item-0')
      expect(allContent).not.toContain('item-7')
      expect(allContent).toMatch(/more line/)

      // Cursor should be within the viewport (no scrolling occurred)
      expect(cursor.y).toBeLessThan(terminal.rows)

      root.unmount()
      terminal.dispose()
    })

    it('does not truncate when static + dynamic fit within viewport', async () => {
      // 20-row terminal. 3 static + 5 dynamic = 8 lines, well within limit.
      const terminal = createVirtualTerminal({ cols: 60, rows: 20 })
      const root = createRoot({
        terminalOrStream: terminal,
        options: { throttleMs: 0, maxDynamicLines: 100 },
      })

      const logs = ['Log A', 'Log B', 'Log C']
      const items = ['one', 'two', 'three', 'four', 'five']

      root.render(
        <Box>
          <Static items={logs}>{(log) => <Text key={log}>{log}</Text>}</Static>
          <Box flexDirection="column">
            {items.map((item) => (
              <Text key={item}>Item {item}</Text>
            ))}
          </Box>
        </Box>,
      )
      root.flush()
      await terminal.flush()

      const lines = terminal.getVisibleLines()
      const allContent = lines.join('\n')

      expect(allContent).toContain('Item five')
      expect(allContent).not.toMatch(/more line/)

      root.unmount()
      terminal.dispose()
    })

    it('handles differential updates correctly after static content', async () => {
      // Simulate what genie does: render progress, then update to complete.
      // The static lines from the first render should be accounted for.
      const terminal = createVirtualTerminal({ cols: 60, rows: 12 })
      const root = createRoot({
        terminalOrStream: terminal,
        options: { throttleMs: 0, maxDynamicLines: 100 },
      })

      // Phase 1: render with some static logs + dynamic progress
      const logs = ['Processing started', 'Config loaded', 'Discovering files']

      root.render(
        <Box>
          <Static items={logs}>{(log) => <Text key={log}>[INFO] {log}</Text>}</Static>
          <Box flexDirection="column">
            <Text>Generating 0/10</Text>
            {Array.from({ length: 10 }, (_, i) => (
              <Text key={i}>  ○ file-{i}.json</Text>
            ))}
          </Box>
        </Box>,
      )
      root.flush()
      await terminal.flush()

      const linesAfterPhase1 = terminal.getVisibleLines()
      const cursor1 = terminal.getCursor()

      // 3 static + dynamic should not exceed viewport
      // Dynamic budget: 12 - 1 - 3 = 8. We have 11 dynamic lines (header + 10 files).
      // So dynamic should be truncated to 8 (7 + overflow indicator)
      expect(linesAfterPhase1.join('\n')).toMatch(/more line/)
      expect(cursor1.y).toBeLessThan(terminal.rows)

      // Phase 2: update dynamic content (simulating completion)
      root.render(
        <Box>
          <Static items={logs}>{(log) => <Text key={log}>[INFO] {log}</Text>}</Static>
          <Box flexDirection="column">
            <Text>Complete</Text>
            {Array.from({ length: 10 }, (_, i) => (
              <Text key={i}>  ✓ file-{i}.json</Text>
            ))}
          </Box>
        </Box>,
      )
      root.flush()
      await terminal.flush()

      const linesAfterPhase2 = terminal.getVisibleLines()
      const cursor2 = terminal.getCursor()

      // Should still be within viewport after differential update
      expect(cursor2.y).toBeLessThan(terminal.rows)
      expect(linesAfterPhase2.join('\n')).toContain('Complete')

      root.unmount()
      terminal.dispose()
    })
  })

  describe('horizontal: overflow indicator must not soft-wrap', () => {
    it('truncates the overflow indicator to terminal width', async () => {
      // 15-col terminal. The overflow message "... 17 more lines" is 18 chars,
      // which would soft-wrap without horizontal truncation.
      const terminal = createVirtualTerminal({ cols: 15, rows: 6 })
      const root = createRoot({
        terminalOrStream: terminal,
        options: { throttleMs: 0, maxDynamicLines: 100 },
      })

      const items = Array.from({ length: 20 }, (_, i) => `i${i}`)

      root.render(
        <Box flexDirection="column">
          {items.map((item) => (
            <Text key={item}>{item}</Text>
          ))}
        </Box>,
      )
      root.flush()
      await terminal.flush()

      const lines = terminal.getVisibleLines()

      // The overflow indicator should be present but truncated
      const overflowLine = lines.find((l) => l.includes('...'))
      expect(overflowLine).toBeDefined()
      // It must fit within terminal width (no soft wrap into next row)
      expect(overflowLine!.length).toBeLessThanOrEqual(15)

      // Verify correct line count — no ghost lines from wrapping.
      // With 6 rows, effective max = 6-1 = 5 dynamic lines.
      // That means 4 content lines + 1 overflow indicator = 5 lines.
      // The visible lines should be exactly that (no extra lines from wrapping).
      expect(lines.length).toBeLessThanOrEqual(5)

      root.unmount()
      terminal.dispose()
    })

    it('all rendered lines fit within terminal width', async () => {
      // 25-col terminal with long content that gets truncated.
      const terminal = createVirtualTerminal({ cols: 25, rows: 8 })
      const root = createRoot({
        terminalOrStream: terminal,
        options: { throttleMs: 0, maxDynamicLines: 100 },
      })

      const items = Array.from({ length: 15 }, (_, i) => `packages/@overeng/long-package-name-${i}/package.json`)

      root.render(
        <Box flexDirection="column">
          {items.map((item) => (
            <Text key={item}>{item}</Text>
          ))}
        </Box>,
      )
      root.flush()
      await terminal.flush()

      const lines = terminal.getVisibleLines()

      // Every visible line must fit within terminal width.
      // If any line soft-wrapped, it would appear as an extra row in the viewport.
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(25)
      }

      // Total visible lines should match expected dynamic limit (rows-1 = 7)
      expect(lines.length).toBeLessThanOrEqual(7)

      root.unmount()
      terminal.dispose()
    })
  })
})
