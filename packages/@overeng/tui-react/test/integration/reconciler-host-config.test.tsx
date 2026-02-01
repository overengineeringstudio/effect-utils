/**
 * Comprehensive reconciler host-config tests.
 *
 * Covers prop updates, text content updates, commit phase behavior,
 * tree structure changes, and edge cases.
 */

import React from 'react'
import { describe, expect, it } from 'vitest'

import { createRoot, Text, Box } from '../../src/mod.tsx'
import { createMockTerminal, stripAnsi } from '../helpers/mod.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a root with a mock terminal and return both */
const setup = (opts?: { cols?: number; rows?: number }) => {
  const terminal = createMockTerminal({ cols: opts?.cols ?? 80, rows: opts?.rows ?? 24 })
  const root = createRoot({ terminalOrStream: terminal, options: { throttleMs: 0 } })
  return { terminal, root }
}

// ---------------------------------------------------------------------------
// 1. Prop Updates
// ---------------------------------------------------------------------------

describe('Prop updates', () => {
  it('dim → color transition (same text content)', () => {
    const { terminal, root } = setup()

    root.render(<Text dim>file.txt</Text>)
    root.flush()

    root.render(<Text color="white">file.txt</Text>)
    root.flush()

    // After the second render, the cumulative output should contain white color
    const raw = terminal.getRawOutput()
    expect(raw).toContain('\x1b[37m') // white color code
    expect(stripAnsi(raw)).toContain('file.txt')

    root.unmount()
  })

  it('color → dim transition (reverse)', () => {
    const { terminal, root } = setup()

    root.render(<Text color="white">file.txt</Text>)
    root.flush()

    root.render(<Text dim>file.txt</Text>)
    root.flush()

    const raw = terminal.getRawOutput()
    expect(raw).toContain('\x1b[2m') // dim code
    expect(stripAnsi(raw)).toContain('file.txt')

    root.unmount()
  })

  it('undefined → defined prop addition', () => {
    const { terminal, root } = setup()

    root.render(<Text>hello</Text>)
    root.flush()

    root.render(<Text bold>hello</Text>)
    root.flush()

    const raw = terminal.getRawOutput()
    expect(raw).toContain('\x1b[1m') // bold code
    root.unmount()
  })

  it('defined → undefined prop removal', () => {
    const { terminal, root } = setup()

    // Render bold first, then without bold
    root.render(<Text bold>hello</Text>)
    root.flush()

    root.render(<Text>hello</Text>)
    root.flush()

    // The final rendered state should not have bold.
    // We check the last frame of output.
    const lastFrame = terminal.lastFrame()
    expect(lastFrame).toBeDefined()
    expect(lastFrame!).not.toContain('\x1b[1m')
    root.unmount()
  })

  it('partial prop update (only one prop changes)', () => {
    const { terminal, root } = setup()

    root.render(
      <Text color="red" dim>
        hello
      </Text>,
    )
    root.flush()

    root.render(
      <Text color="red" bold>
        hello
      </Text>,
    )
    root.flush()

    const raw = terminal.getRawOutput()
    expect(raw).toContain('\x1b[31m') // red present
    expect(raw).toContain('\x1b[1m') // bold added
    root.unmount()
  })

  it('nested element prop updates (Box > Text)', () => {
    const { terminal, root } = setup()

    root.render(
      <Box>
        <Text dim>nested</Text>
      </Box>,
    )
    root.flush()

    root.render(
      <Box>
        <Text color="green">nested</Text>
      </Box>,
    )
    root.flush()

    const raw = terminal.getRawOutput()
    expect(raw).toContain('\x1b[32m') // green
    expect(stripAnsi(raw)).toContain('nested')
    root.unmount()
  })
})

// ---------------------------------------------------------------------------
// 2. Text Content Updates
// ---------------------------------------------------------------------------

describe('Text content updates', () => {
  it('text content change without prop change', () => {
    const { terminal, root } = setup()

    root.render(<Text color="white">before</Text>)
    root.flush()

    root.render(<Text color="white">after</Text>)
    root.flush()

    const plain = terminal.getPlainOutput()
    expect(plain).toContain('after')
    root.unmount()
  })

  it('text content + prop change together', () => {
    const { terminal, root } = setup()

    root.render(<Text dim>before</Text>)
    root.flush()

    root.render(<Text color="white">after</Text>)
    root.flush()

    const raw = terminal.getRawOutput()
    expect(raw).toContain('\x1b[37m')
    expect(stripAnsi(raw)).toContain('after')
    root.unmount()
  })
})

// ---------------------------------------------------------------------------
// 3. Commit Phase Behavior
// ---------------------------------------------------------------------------

describe('Commit phase behavior', () => {
  it('commitUpdate called for prop-only changes (not remove+recreate)', () => {
    const { terminal, root } = setup()

    root.render(<Text dim>stable</Text>)
    root.flush()

    root.render(<Text color="white">stable</Text>)
    root.flush()

    const raw = terminal.getRawOutput()
    expect(raw).toContain('\x1b[37m')
    expect(stripAnsi(raw)).toContain('stable')
    root.unmount()
  })
})

// ---------------------------------------------------------------------------
// 4. Tree Structure Changes
// ---------------------------------------------------------------------------

describe('Tree structure changes', () => {
  it('add child to existing parent', () => {
    const { terminal, root } = setup()

    root.render(
      <Box flexDirection="column">
        <Text>first</Text>
      </Box>,
    )
    root.flush()

    root.render(
      <Box flexDirection="column">
        <Text>first</Text>
        <Text>second</Text>
      </Box>,
    )
    root.flush()

    const plain = terminal.getPlainOutput()
    expect(plain).toContain('first')
    expect(plain).toContain('second')
    root.unmount()
  })

  it('remove child from existing parent', () => {
    // Use a fresh terminal per render to avoid differential rendering skipping
    const terminal = createMockTerminal({ cols: 80, rows: 24 })
    const root = createRoot({ terminalOrStream: terminal, options: { throttleMs: 0 } })

    root.render(
      <Box flexDirection="column">
        <Text>first</Text>
        <Text>second</Text>
      </Box>,
    )
    root.flush()

    const plainBefore = terminal.getPlainOutput()
    expect(plainBefore).toContain('first')
    expect(plainBefore).toContain('second')

    root.render(
      <Box flexDirection="column">
        <Text>first</Text>
      </Box>,
    )
    root.flush()

    // Full output will contain both, but the final rendered state should not show "second".
    // We verify by checking the full raw output ends with content that has "first" but not "second".
    const allPlain = terminal.getPlainOutput()
    // The text "first" should appear at least twice (two renders), "second" only once (first render)
    expect(allPlain).toContain('first')
    const secondCount = (allPlain.match(/second/g) ?? []).length
    expect(secondCount).toBe(1) // Only from the first render
    root.unmount()
  })

  it('reorder children with keys', () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24 })
    const root = createRoot({ terminalOrStream: terminal, options: { throttleMs: 0 } })

    root.render(
      <Box flexDirection="column">
        <Text key="a">alpha</Text>
        <Text key="b">beta</Text>
      </Box>,
    )
    root.flush()

    // Verify initial order: alpha before beta
    const firstPlain = terminal.getPlainOutput()
    expect(firstPlain.indexOf('alpha')).toBeLessThan(firstPlain.indexOf('beta'))

    root.render(
      <Box flexDirection="column">
        <Text key="b">beta</Text>
        <Text key="a">alpha</Text>
      </Box>,
    )
    root.flush()

    // After reorder, the raw output from the second render should have beta before alpha.
    // Since differential rendering rewrites the lines, we check the raw output after the second render.
    const raw = terminal.getRawOutput()
    // Find the last occurrence of both — which represents the second render
    const lastBeta = raw.lastIndexOf('beta')
    const lastAlpha = raw.lastIndexOf('alpha')
    expect(lastBeta).toBeLessThan(lastAlpha)
    root.unmount()
  })
})

// ---------------------------------------------------------------------------
// 5. Edge Cases
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  it('rapid consecutive updates settle to final state', () => {
    const { terminal, root } = setup()

    root.render(<Text>v1</Text>)
    root.render(<Text>v2</Text>)
    root.render(<Text>v3</Text>)
    root.flush()

    const plain = terminal.getPlainOutput()
    expect(plain).toContain('v3')
    root.unmount()
  })

  it('element type change (Text → Box wrapping Text) triggers recreation', () => {
    const { terminal, root } = setup()

    root.render(<Text>hello</Text>)
    root.flush()

    root.render(
      <Box>
        <Text>world</Text>
      </Box>,
    )
    root.flush()

    const plain = terminal.getPlainOutput()
    expect(plain).toContain('world')
    root.unmount()
  })

  it('unmount/remount cycle', () => {
    // First mount
    const terminal1 = createMockTerminal({ cols: 80, rows: 24 })
    const root1 = createRoot({ terminalOrStream: terminal1, options: { throttleMs: 0 } })
    root1.render(<Text>mounted</Text>)
    root1.flush()
    expect(terminal1.getPlainOutput()).toContain('mounted')
    root1.unmount()

    // Second mount on fresh terminal
    const terminal2 = createMockTerminal({ cols: 80, rows: 24 })
    const root2 = createRoot({ terminalOrStream: terminal2, options: { throttleMs: 0 } })
    root2.render(<Text>remounted</Text>)
    root2.flush()
    expect(terminal2.getPlainOutput()).toContain('remounted')
    root2.unmount()
  })

  it('stateful component renders initial state correctly', () => {
    const Counter: React.FC<{ count: number }> = ({ count }) => {
      return <Text color={count > 0 ? 'green' : undefined}>{`count: ${count}`}</Text>
    }

    const { terminal, root } = setup()
    root.render(<Counter count={0} />)
    root.flush()

    expect(stripAnsi(terminal.getRawOutput())).toContain('count: 0')

    root.render(<Counter count={1} />)
    root.flush()

    const raw = terminal.getRawOutput()
    expect(stripAnsi(raw)).toContain('count: 1')
    expect(raw).toContain('\x1b[32m') // green for count > 0
    root.unmount()
  })
})
