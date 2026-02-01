/**
 * Tests for createRoot options (throttling, output limits).
 */

import React from 'react'
import { describe, it, expect } from 'vitest'

import { createRoot } from '../../src/root.tsx'
import { Box } from '../../src/components/Box.tsx'
import { Text } from '../../src/components/Text.tsx'
import { Static } from '../../src/components/Static.tsx'
import { createMockTerminal } from '../helpers/mock-terminal.ts'

describe('createRoot options', () => {
  describe('maxDynamicLines', () => {
    it('truncates output when exceeding limit', async () => {
      const terminal = createMockTerminal()
      const root = createRoot({
        terminalOrStream: terminal,
        options: { maxDynamicLines: 5, throttleMs: 0 },
      })

      // Render 10 lines
      const items = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
      root.render(
        <Box flexDirection="column">
          {items.map((item) => (
            <Text key={item}>Line {item}</Text>
          ))}
        </Box>,
      )

      // Wait for render
      await new Promise((resolve) => setTimeout(resolve, 50))

      const output = terminal.getPlainOutput()

      // Should contain truncation message
      expect(output).toContain('more line')

      // Should not contain all lines (some were truncated)
      expect(output).not.toContain('Line ten')

      root.unmount()
    })

    it('does not truncate when within limit', async () => {
      const terminal = createMockTerminal()
      const root = createRoot({
        terminalOrStream: terminal,
        options: { maxDynamicLines: 20, throttleMs: 0 },
      })

      const items = ['one', 'two', 'three', 'four', 'five']
      root.render(
        <Box flexDirection="column">
          {items.map((item) => (
            <Text key={item}>Line {item}</Text>
          ))}
        </Box>,
      )

      await new Promise((resolve) => setTimeout(resolve, 50))

      const output = terminal.getPlainOutput()
      expect(output).not.toContain('more line')
      expect(output).toContain('Line five')

      root.unmount()
    })
  })

  describe('vertical safety net with static lines', () => {
    it('accounts for static lines when enforcing viewport height limit', async () => {
      // Terminal with 10 rows. With static lines taking up space,
      // the dynamic region should be limited to (rows - 1 - staticLineCount).
      const terminal = createMockTerminal({ cols: 80, rows: 10 })
      const root = createRoot({
        terminalOrStream: terminal,
        options: { maxDynamicLines: 100, throttleMs: 0 },
      })

      // Render with 5 static log lines + 8 dynamic lines.
      // Total would be 13 lines, but terminal only has 10 rows.
      // Safety net should limit dynamic lines to (10 - 1 - 5) = 4 lines.
      const logs = ['Log 1', 'Log 2', 'Log 3', 'Log 4', 'Log 5']
      const items = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']

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

      const output = terminal.getPlainOutput()

      // The dynamic region should be truncated because static lines consume viewport space
      expect(output).toContain('more line')

      // Last dynamic item should NOT appear (truncated)
      expect(output).not.toContain('Item eight')

      root.unmount()
    })

    it('does not truncate dynamic region when static + dynamic fit within viewport', async () => {
      // Terminal with 20 rows. 3 static + 5 dynamic = 8 lines, well within limit.
      const terminal = createMockTerminal({ cols: 80, rows: 20 })
      const root = createRoot({
        terminalOrStream: terminal,
        options: { maxDynamicLines: 100, throttleMs: 0 },
      })

      const logs = ['Log 1', 'Log 2', 'Log 3']
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

      const output = terminal.getPlainOutput()
      expect(output).not.toContain('more line')
      expect(output).toContain('Item five')

      root.unmount()
    })
  })

  describe('horizontal truncation of overflow indicator', () => {
    it('truncates the "... N more lines" indicator to terminal width', async () => {
      // Very narrow terminal (10 cols) where "... 18 more lines" (18 chars) would soft-wrap
      const terminal = createMockTerminal({ cols: 10, rows: 5 })
      const root = createRoot({
        terminalOrStream: terminal,
        options: { maxDynamicLines: 3, throttleMs: 0 },
      })

      // Render enough lines to trigger vertical truncation with large hidden count
      const items = Array.from({ length: 20 }, (_, i) => `item-${i}`)
      root.render(
        <Box flexDirection="column">
          {items.map((item) => (
            <Text key={item}>{item}</Text>
          ))}
        </Box>,
      )

      await new Promise((resolve) => setTimeout(resolve, 50))

      const output = terminal.getPlainOutput()
      // The overflow indicator should be present (possibly truncated itself)
      expect(output).toMatch(/\.\.\..*mo/)

      // Every line in the output should fit within terminal width (10 cols).
      // The overflow indicator "... 18 more lines" is 18 chars which exceeds 10 cols.
      // It must be truncated to prevent soft-wrapping.
      const rawOutput = terminal.getRawOutput()
      const renderedLines = rawOutput.split('\r\n').filter((l) => l.length > 0)
      for (const line of renderedLines) {
        // Strip ANSI codes and measure visible width
        const plain = line.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\[\?[0-9;]*[a-zA-Z]/g, '')
        expect(plain.length).toBeLessThanOrEqual(10)
      }

      root.unmount()
    })
  })

  describe('throttleMs', () => {
    it('throttles rapid renders', async () => {
      const terminal = createMockTerminal()
      const root = createRoot({ terminalOrStream: terminal, options: { throttleMs: 100 } })

      // Trigger many rapid renders
      for (let i = 0; i < 10; i++) {
        root.render(<Text>Render {i}</Text>)
      }

      // Wait a bit - should not have rendered all 10 times
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Frames should be less than 10 due to throttling
      expect(terminal.frames.length).toBeLessThan(10)

      root.unmount()
    })

    it('eventually renders the last state after throttle period', async () => {
      const terminal = createMockTerminal()
      const root = createRoot({ terminalOrStream: terminal, options: { throttleMs: 20 } })

      // Trigger renders
      root.render(<Text>First</Text>)
      root.render(<Text>Second</Text>)
      root.render(<Text>Third</Text>)

      // Wait for throttle to complete
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Should have rendered the final state
      const output = terminal.getPlainOutput()
      expect(output).toContain('Third')

      root.unmount()
    })
  })

  describe('viewport', () => {
    it('exposes current viewport dimensions', () => {
      const terminal = createMockTerminal({ cols: 120, rows: 40 })
      const root = createRoot({ terminalOrStream: terminal })

      expect(root.viewport).toEqual({ columns: 120, rows: 40 })

      root.unmount()
    })

    it('uses default dimensions when not specified', () => {
      const terminal = createMockTerminal()
      const root = createRoot({ terminalOrStream: terminal })

      expect(root.viewport).toEqual({ columns: 80, rows: 24 })

      root.unmount()
    })
  })
})
