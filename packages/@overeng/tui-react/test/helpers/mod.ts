/**
 * Test helpers for @overeng/tui-react.
 *
 * Two testing approaches are provided:
 *
 * ## Layer 2: MockTerminal (Fast)
 *
 * For quick component tests. Captures writes without interpreting ANSI.
 *
 * ```ts
 * import { createMockTerminal } from './helpers/mod.ts'
 *
 * const terminal = createMockTerminal()
 * renderer.render(['Hello'])
 * expect(terminal.getPlainOutput()).toContain('Hello')
 * ```
 *
 * ## Layer 3: VirtualTerminal (Accurate)
 *
 * For integration tests. Uses xterm.js to interpret ANSI codes.
 *
 * ```ts
 * import { createVirtualTerminal } from './helpers/mod.ts'
 *
 * const terminal = createVirtualTerminal()
 * renderer.render(['Hello'])
 * await terminal.flush()
 * expect(terminal.getVisibleLines()).toEqual(['Hello'])
 * ```
 */

// Layer 2: Fast mock terminal (Ink-style)
export { MockTerminal, createMockTerminal, stripAnsi } from './mock-terminal.ts'

// Layer 3: Accurate virtual terminal (xterm.js)
export { VirtualTerminal, createVirtualTerminal } from './virtual-terminal.ts'
