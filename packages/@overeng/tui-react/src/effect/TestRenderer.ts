/**
 * TestRenderer - Test utility for snapshot testing TUI components
 *
 * Provides a simple API for rendering TUI components and capturing output
 * for assertions and snapshot testing.
 *
 * @example
 * ```typescript
 * import { TestRenderer } from '@overeng/tui-react'
 * import { SubscriptionRef, Effect } from 'effect'
 *
 * test('deploy view renders correctly', async () => {
 *   const renderer = TestRenderer.create({ columns: 80, rows: 24 })
 *   const stateRef = await Effect.runPromise(
 *     SubscriptionRef.make({ _tag: 'Progress', services: [...] })
 *   )
 *
 *   await renderer.render(<DeployView stateRef={stateRef} />)
 *
 *   expect(renderer.toText()).toContain('Deploying')
 *   expect(renderer.toText()).toMatchSnapshot()
 * })
 * ```
 */

import type { ReactElement } from 'react'

import { renderToString, renderToLines } from '../renderToString.ts'

// =============================================================================
// Types
// =============================================================================

/**
 * Options for creating a TestRenderer.
 */
export interface TestRendererOptions {
  /**
   * Terminal width (columns) for layout calculation.
   * @default 80
   */
  columns?: number

  /**
   * Terminal height (rows) for viewport context.
   * @default 24
   */
  rows?: number

  /**
   * Strip ANSI escape codes from output.
   * @default false
   */
  stripAnsi?: boolean
}

/**
 * Result of a render operation.
 */
export interface RenderResult {
  /** Plain text output (ANSI stripped) */
  text: string

  /** ANSI-formatted output */
  ansi: string

  /** Individual lines (ANSI-formatted) */
  lines: string[]

  /** Individual lines (plain text) */
  textLines: string[]
}

// =============================================================================
// ANSI Stripping
// =============================================================================

/**
 * Regex to match ANSI escape sequences.
 * Handles:
 * - CSI sequences (colors, styles, cursor movement)
 * - OSC sequences (hyperlinks, titles)
 * - Simple escape sequences
 */
const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\x1b[=>]/g

/**
 * Strip ANSI escape codes from a string.
 */
export const stripAnsi = (str: string): string => str.replace(ANSI_REGEX, '')

// =============================================================================
// TestRenderer Class
// =============================================================================

/**
 * Test renderer for TUI components.
 *
 * Provides methods to render React elements and capture output for testing.
 */
export class TestRenderer {
  private options: Required<TestRendererOptions>
  private lastResult: RenderResult | null = null

  private constructor(options: TestRendererOptions = {}) {
    this.options = {
      columns: options.columns ?? 80,
      rows: options.rows ?? 24,
      stripAnsi: options.stripAnsi ?? false,
    }
  }

  /**
   * Create a new TestRenderer instance.
   *
   * @param options - Renderer options
   * @returns TestRenderer instance
   *
   * @example
   * ```typescript
   * const renderer = TestRenderer.create({ columns: 100, rows: 30 })
   * ```
   */
  static create(options: TestRendererOptions = {}): TestRenderer {
    return new TestRenderer(options)
  }

  /**
   * Render a React element and capture the output.
   *
   * @param element - React element to render
   * @returns Promise that resolves when rendering is complete
   *
   * @example
   * ```typescript
   * await renderer.render(<MyComponent prop="value" />)
   * ```
   */
  async render(element: ReactElement): Promise<void> {
    const ansi = await renderToString(element, { width: this.options.columns })
    const lines = await renderToLines(element, { width: this.options.columns })
    const text = stripAnsi(ansi)
    const textLines = lines.map(stripAnsi)

    this.lastResult = {
      text,
      ansi,
      lines,
      textLines,
    }
  }

  /**
   * Get the plain text output (ANSI codes stripped).
   *
   * @returns Plain text output
   * @throws Error if render() hasn't been called
   *
   * @example
   * ```typescript
   * expect(renderer.toText()).toContain('Success')
   * ```
   */
  toText(): string {
    this.ensureRendered()
    return this.lastResult!.text
  }

  /**
   * Get the ANSI-formatted output.
   *
   * @returns ANSI-formatted output
   * @throws Error if render() hasn't been called
   *
   * @example
   * ```typescript
   * expect(renderer.toAnsi()).toContain('\x1b[32m') // green color
   * ```
   */
  toAnsi(): string {
    this.ensureRendered()
    return this.lastResult!.ansi
  }

  /**
   * Get output as an array of lines (ANSI-formatted).
   *
   * @returns Array of lines
   * @throws Error if render() hasn't been called
   */
  toLines(): string[] {
    this.ensureRendered()
    return this.lastResult!.lines
  }

  /**
   * Get output as an array of plain text lines.
   *
   * @returns Array of plain text lines
   * @throws Error if render() hasn't been called
   */
  toTextLines(): string[] {
    this.ensureRendered()
    return this.lastResult!.textLines
  }

  /**
   * Get the full render result object.
   *
   * @returns Render result with text, ansi, lines, and textLines
   * @throws Error if render() hasn't been called
   */
  getResult(): RenderResult {
    this.ensureRendered()
    return this.lastResult!
  }

  /**
   * Check if a string is present in the output.
   *
   * @param str - String to search for
   * @param options - Search options (ansi: search in ANSI output, text: search in plain text)
   * @returns true if string is found
   */
  contains({ str, options = {} }: { str: string; options?: { ansi?: boolean } }): boolean {
    this.ensureRendered()
    const source = options.ansi ? this.lastResult!.ansi : this.lastResult!.text
    return source.includes(str)
  }

  /**
   * Get the number of lines in the output.
   *
   * @returns Number of lines
   */
  lineCount(): number {
    this.ensureRendered()
    return this.lastResult!.lines.length
  }

  /**
   * Get a specific line by index.
   *
   * @param index - Line index (0-based)
   * @param options - Options (ansi: return ANSI-formatted, text: return plain text)
   * @returns Line content or undefined if out of bounds
   */
  getLine({ index, options = {} }: { index: number; options?: { ansi?: boolean } }):
    | string
    | undefined {
    this.ensureRendered()
    const lines = options.ansi ? this.lastResult!.lines : this.lastResult!.textLines
    return lines[index]
  }

  /**
   * Clear the last render result.
   */
  clear(): void {
    this.lastResult = null
  }

  /**
   * Get the configured viewport dimensions.
   */
  getViewport(): { columns: number; rows: number } {
    return {
      columns: this.options.columns,
      rows: this.options.rows,
    }
  }

  /**
   * Ensure render() has been called.
   */
  private ensureRendered(): void {
    if (!this.lastResult) {
      throw new Error('TestRenderer: No render result. Call render() first.')
    }
  }
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Render a React element and return the plain text output.
 *
 * @param element - React element to render
 * @param options - Render options
 * @returns Promise that resolves to plain text output
 *
 * @example
 * ```typescript
 * const text = await renderToText({ element: <MyComponent /> })
 * expect(text).toContain('Hello')
 * ```
 */
export const renderToText = async ({
  element,
  options = {},
}: {
  element: ReactElement
  options?: TestRendererOptions
}): Promise<string> => {
  const renderer = TestRenderer.create(options)
  await renderer.render(element)
  return renderer.toText()
}

/**
 * Render a React element and return the ANSI-formatted output.
 *
 * @param element - React element to render
 * @param options - Render options
 * @returns Promise that resolves to ANSI-formatted output
 *
 * @example
 * ```typescript
 * const ansi = await renderToAnsi({ element: <MyComponent /> })
 * expect(ansi).toContain('\x1b[32m') // green
 * ```
 */
export const renderToAnsi = async ({
  element,
  options = {},
}: {
  element: ReactElement
  options?: TestRendererOptions
}): Promise<string> => {
  const renderer = TestRenderer.create(options)
  await renderer.render(element)
  return renderer.toAnsi()
}
