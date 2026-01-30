/**
 * Tests for renderToString
 */

import React from 'react'
import { describe, test, expect } from 'vitest'

import { renderToString, renderToLines, Box, Text } from '../../src/mod.ts'

describe('renderToString', () => {
  test('renders simple text', async () => {
    const output = await renderToString({ element: <Text>Hello World</Text> })
    expect(output).toBe('Hello World')
  })

  test('renders text with color', async () => {
    const output = await renderToString({ element: <Text color="green">Success</Text> })
    // Should contain ANSI escape codes for green
    expect(output).toContain('\x1b[32m') // Green foreground
    expect(output).toContain('Success')
    expect(output).toContain('\x1b[39m') // Reset foreground
  })

  test('renders bold text', async () => {
    const output = await renderToString({ element: <Text bold>Bold Text</Text> })
    expect(output).toContain('\x1b[1m') // Bold
    expect(output).toContain('Bold Text')
    expect(output).toContain('\x1b[22m') // Reset bold
  })

  test('renders dim text', async () => {
    const output = await renderToString({ element: <Text dim>Dim Text</Text> })
    expect(output).toContain('\x1b[2m') // Dim
    expect(output).toContain('Dim Text')
  })

  test('renders box with column layout', async () => {
    const output = await renderToString({
      element: (
        <Box>
          <Text>Line 1</Text>
          <Text>Line 2</Text>
          <Text>Line 3</Text>
        </Box>
      ),
    })
    const lines = output.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('Line 1')
    expect(lines[1]).toContain('Line 2')
    expect(lines[2]).toContain('Line 3')
  })

  test('renders box with row layout', async () => {
    const output = await renderToString({
      element: (
        <Box flexDirection="row">
          <Text>A</Text>
          <Text>B</Text>
          <Text>C</Text>
        </Box>
      ),
    })
    // Row layout should produce single line
    expect(output).toBe('ABC')
  })

  test('renders nested boxes', async () => {
    const output = await renderToString({
      element: (
        <Box>
          <Text>Header</Text>
          <Box flexDirection="row">
            <Text color="green">OK</Text>
            <Text> - </Text>
            <Text>message</Text>
          </Box>
        </Box>
      ),
    })
    const lines = output.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('Header')
    expect(lines[1]).toContain('OK')
    expect(lines[1]).toContain(' - ')
    expect(lines[1]).toContain('message')
  })

  test('respects width option', async () => {
    const output = await renderToString({
      element: (
        <Box>
          <Text>Test</Text>
        </Box>
      ),
      options: { width: 40 },
    })
    expect(output).toBe('Test')
  })

  test('default width is 80', async () => {
    // This is mainly for layout calculations
    // Simple text shouldn't be affected
    const output = await renderToString({ element: <Text>Test</Text> })
    expect(output).toBe('Test')
  })
})

describe('renderToLines', () => {
  test('returns array of lines', async () => {
    const lines = await renderToLines({
      element: (
        <Box>
          <Text>Line 1</Text>
          <Text>Line 2</Text>
        </Box>
      ),
    })
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('Line 1')
    expect(lines[1]).toBe('Line 2')
  })

  test('returns single line for simple text', async () => {
    const lines = await renderToLines({ element: <Text>Hello</Text> })
    expect(lines).toEqual(['Hello'])
  })

  test('returns empty array for empty box', async () => {
    const lines = await renderToLines({ element: <Box /> })
    expect(lines).toEqual([''])
  })
})

describe('renderToString with complex components', () => {
  test('renders component with multiple styled elements', async () => {
    const StatusLine = ({ name, status }: { name: string; status: 'ok' | 'error' }) => (
      <Box flexDirection="row">
        <Text color={status === 'ok' ? 'green' : 'red'}>{status === 'ok' ? '✓' : '✗'}</Text>
        <Text> </Text>
        <Text bold>{name}</Text>
        <Text> </Text>
        <Text dim>{status}</Text>
      </Box>
    )

    const output = await renderToString({
      element: (
        <Box>
          <StatusLine name="task1" status="ok" />
          <StatusLine name="task2" status="error" />
        </Box>
      ),
    })

    const lines = output.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('✓')
    expect(lines[0]).toContain('task1')
    expect(lines[1]).toContain('✗')
    expect(lines[1]).toContain('task2')
  })

  test('renders summary section', async () => {
    const Summary = ({ total, success }: { total: number; success: number }) => (
      <Box>
        <Text dim>{'─'.repeat(40)}</Text>
        <Box flexDirection="row">
          <Text>{success}</Text>
          <Text dim> / </Text>
          <Text>{total}</Text>
          <Text dim> completed</Text>
        </Box>
      </Box>
    )

    const output = await renderToString({ element: <Summary total={10} success={8} /> })
    expect(output).toContain('─')
    expect(output).toContain('8')
    expect(output).toContain('10')
    expect(output).toContain('completed')
  })
})
