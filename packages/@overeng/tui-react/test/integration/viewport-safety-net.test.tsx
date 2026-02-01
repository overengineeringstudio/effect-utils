/**
 * Integration tests for the viewport safety net using VirtualTerminal.
 *
 * Verifies that createRoot prevents terminal scrolling by constraining
 * yoga layout height and clipping rendered output. Uses xterm.js headless
 * for faithful terminal simulation.
 */

import React from 'react'
import { describe, expect, it } from 'vitest'

import { Box } from '../../src/components/Box.tsx'
import { Static } from '../../src/components/Static.tsx'
import { Text } from '../../src/components/Text.tsx'
import { createRoot } from '../../src/root.tsx'
import { createVirtualTerminal } from '../helpers/mod.ts'

describe('Viewport safety net (VirtualTerminal)', () => {
  describe('vertical: yoga height constraint clips output', () => {
    it('clips dynamic lines when content exceeds viewport', async () => {
      // 10-row terminal. 5 static lines → dynamic budget = 10 - 1 - 5 = 4.
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

      // Static lines at top
      expect(lines[0]).toBe('Log A')
      expect(lines[4]).toBe('Log E')

      // Dynamic region clipped to budget — early items visible, later ones clipped
      const allContent = lines.join('\n')
      expect(allContent).toContain('item-0')
      expect(allContent).not.toContain('item-7')

      // No scrolling
      expect(cursor.y).toBeLessThan(terminal.rows)
      expect(terminal.hasScrolled()).toBe(false)

      root.unmount()
      terminal.dispose()
    })

    it('does not truncate when static + dynamic fit within viewport', async () => {
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

      const allContent = terminal.getVisibleLines().join('\n')
      expect(allContent).toContain('Item five')
      expect(terminal.hasScrolled()).toBe(false)

      root.unmount()
      terminal.dispose()
    })

    it('handles differential updates correctly after static content', async () => {
      const terminal = createVirtualTerminal({ cols: 60, rows: 12 })
      const root = createRoot({
        terminalOrStream: terminal,
        options: { throttleMs: 0, maxDynamicLines: 100 },
      })

      const logs = ['Processing started', 'Config loaded', 'Discovering files']

      // Phase 1: 3 static + 11 dynamic (header + 10 files). Budget = 12-1-3 = 8.
      root.render(
        <Box>
          <Static items={logs}>{(log) => <Text key={log}>[INFO] {log}</Text>}</Static>
          <Box flexDirection="column">
            <Text>Generating 0/10</Text>
            {Array.from({ length: 10 }, (_, i) => (
              <Text key={i}> ○ file-{i}.json</Text>
            ))}
          </Box>
        </Box>,
      )
      root.flush()
      await terminal.flush()

      // Dynamic content clipped to budget, no scrolling
      expect(terminal.getCursor().y).toBeLessThan(terminal.rows)
      expect(terminal.hasScrolled()).toBe(false)

      // Phase 2: update dynamic content
      root.render(
        <Box>
          <Static items={logs}>{(log) => <Text key={log}>[INFO] {log}</Text>}</Static>
          <Box flexDirection="column">
            <Text>Complete</Text>
            {Array.from({ length: 10 }, (_, i) => (
              <Text key={i}> ✓ file-{i}.json</Text>
            ))}
          </Box>
        </Box>,
      )
      root.flush()
      await terminal.flush()

      // Still within viewport after differential update
      expect(terminal.getCursor().y).toBeLessThan(terminal.rows)
      expect(terminal.hasScrolled()).toBe(false)
      expect(terminal.getVisibleLines().join('\n')).toContain('Complete')

      root.unmount()
      terminal.dispose()
    })
  })

  describe('horizontal: lines must not soft-wrap', () => {
    it('all rendered lines fit within terminal width', async () => {
      const terminal = createVirtualTerminal({ cols: 25, rows: 8 })
      const root = createRoot({
        terminalOrStream: terminal,
        options: { throttleMs: 0, maxDynamicLines: 100 },
      })

      const items = Array.from(
        { length: 15 },
        (_, i) => `packages/@overeng/long-package-name-${i}/package.json`,
      )

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
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(25)
      }
      expect(lines.length).toBeLessThanOrEqual(7)
      expect(terminal.hasScrolled()).toBe(false)

      root.unmount()
      terminal.dispose()
    })
  })
})
