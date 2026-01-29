/**
 * Tests for createRoot options (throttling, output limits).
 */

import React from 'react'
import { describe, it, expect } from 'vitest'

import { createRoot, Box, Text } from '../../src/mod.ts'
import { createMockTerminal } from '../helpers/mock-terminal.ts'

describe('createRoot options', () => {
  describe('maxDynamicLines', () => {
    it('truncates output when exceeding limit', async () => {
      const terminal = createMockTerminal()
      const root = createRoot(terminal, { maxDynamicLines: 5, throttleMs: 0 })

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
      const root = createRoot(terminal, { maxDynamicLines: 20, throttleMs: 0 })

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

  describe('throttleMs', () => {
    it('throttles rapid renders', async () => {
      const terminal = createMockTerminal()
      const root = createRoot(terminal, { throttleMs: 100 })

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
      const root = createRoot(terminal, { throttleMs: 20 })

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
      const root = createRoot(terminal)

      expect(root.viewport).toEqual({ columns: 120, rows: 40 })

      root.unmount()
    })

    it('uses default dimensions when not specified', () => {
      const terminal = createMockTerminal()
      const root = createRoot(terminal)

      expect(root.viewport).toEqual({ columns: 80, rows: 24 })

      root.unmount()
    })
  })
})
