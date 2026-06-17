/**
 * Tests for the `/sk-cli-design` CLI-output kit.
 *
 * Renders each component to string across output modes:
 * - `ci`  — colors on, unicode on  (assert ANSI + unicode glyphs)
 * - `log` — colors off (ANSI stripped via toText), unicode on (assert plain)
 * - ascii — `NO_UNICODE` equivalent (unicode off), assert `✓` → `+`
 *
 * Color is honored by the renderer (always emits ANSI); plain modes strip it at
 * the seam (`toText`). Unicode/ascii is honored via `RenderConfigProvider`,
 * mirroring how `useSymbols` derives its variant.
 */

import type { ReactElement } from 'react'
import React from 'react'
import { describe, expect, test } from 'vitest'

import {
  ciRenderConfig,
  CommandOutput,
  DetailSections,
  type DetailSection,
  logRenderConfig,
  ProblemList,
  type ProblemItem,
  RenderConfigProvider,
  SeverityBadge,
  StatusGlyph,
  SummaryLine,
  type TaskItem,
  TestRenderer,
} from '../../src/mod.tsx'

/** Wrap an element with a fixed RenderConfig so useSymbols/useRenderConfig resolve. */
const withConfig = (element: ReactElement, config = ciRenderConfig): ReactElement => (
  <RenderConfigProvider config={config}>{element}</RenderConfigProvider>
)

/** Render to ANSI (colors) — for ci-mode assertions. */
const renderAnsi = async (element: ReactElement, config = ciRenderConfig): Promise<string> => {
  const renderer = TestRenderer.create()
  await renderer.render(withConfig(element, config))
  return renderer.toAnsi()
}

/** Render to plain text (ANSI stripped) — for log-mode assertions. */
const renderText = async (element: ReactElement, config = logRenderConfig): Promise<string> => {
  const renderer = TestRenderer.create()
  await renderer.render(withConfig(element, config))
  return renderer.toText()
}

/** Unicode-off config (NO_UNICODE / ascii fallback). */
const asciiConfig = { ...logRenderConfig, unicode: false }

const conflict: ProblemItem = {
  severity: 'critical',
  name: 'notes/planning.nmd',
  status: 'blocked',
  details: 'remote body changed since the last clean pull',
  context: 'conflict artifact: notes/planning.nmd.roughdraft.md',
  fixes: ['notion-md status notes/planning.nmd', 'notion-md sync notes/planning.nmd'],
  skips: ['notion-md sync notes/planning.nmd --force'],
}

const guarded: ProblemItem = {
  severity: 'warning',
  name: 'docs/research.nmd',
  status: 'guarded',
  details: 'page contains unsupported Notion blocks',
  fixes: ['pull latest page state'],
}

const sections: readonly DetailSection[] = [
  {
    title: 'unknown-blocks',
    items: ['synced_block 1', 'equation 1', 'link_preview 2', 'pdf 1', 'bookmark 1'],
    more: 3,
  },
  { title: 'policy', items: ['non-destructive write refused until intent is explicit'] },
]

const stages: readonly TaskItem[] = [
  { id: 'pull', label: 'Pull remote', status: 'success' },
  { id: 'merge', label: 'Merge body', status: 'active', message: 'merging…' },
  { id: 'push', label: 'Push', status: 'pending' },
]

describe('SeverityBadge', () => {
  test('renders CRITICAL with red background ANSI (ci)', async () => {
    const ansi = await renderAnsi(<SeverityBadge severity="critical" />)
    expect(ansi).toContain('CRITICAL')
    expect(ansi).toContain('41') // red background
  })

  test('renders WARNING as plain text in log mode', async () => {
    const text = await renderText(<SeverityBadge severity="warning" />)
    expect(text).toBe('WARNING')
  })
})

describe('ProblemList', () => {
  test('renders name/status/details, context, fix and skip lines (log)', async () => {
    const text = await renderText(<ProblemList items={[conflict]} />)
    expect(text).toMatchInlineSnapshot(`
      "  notes/planning.nmd blocked remote body changed since the last clean pull
          conflict artifact: notes/planning.nmd.roughdraft.md
          fix: notion-md status notes/planning.nmd
          fix: notion-md sync notes/planning.nmd
          skip: notion-md sync notes/planning.nmd --force"
    `)
  })

  test('colors fix: lines cyan in ci mode', async () => {
    const ansi = await renderAnsi(<ProblemList items={[conflict]} />)
    expect(ansi).toContain('36') // cyan fg
    expect(ansi).toContain('fix: notion-md status notes/planning.nmd')
  })

  test('renders nothing when empty', async () => {
    const text = await renderText(<ProblemList items={[]} />)
    expect(text).toBe('')
  })

  test('separates multiple items with one blank line (log)', async () => {
    const text = await renderText(<ProblemList items={[guarded, guarded]} />)
    expect(text).toMatchInlineSnapshot(`
      "  docs/research.nmd guarded page contains unsupported Notion blocks
          fix: pull latest page state

        docs/research.nmd guarded page contains unsupported Notion blocks
          fix: pull latest page state"
    `)
  })
})

describe('DetailSections', () => {
  test('caps at 5 items and shows + N more (log)', async () => {
    const text = await renderText(<DetailSections sections={sections} />)
    expect(text).toMatchInlineSnapshot(`
      "  unknown-blocks(8):
          synced_block 1
          equation 1
          link_preview 2
          pdf 1
          bookmark 1
          + 3 more
        policy(1):
          non-destructive write refused until intent is explicit"
    `)
  })

  test('omits empty sections', async () => {
    const text = await renderText(<DetailSections sections={[{ title: 'empty', items: [] }]} />)
    expect(text).toBe('')
  })
})

describe('SummaryLine', () => {
  test('joins parts with · (unicode)', async () => {
    const text = await renderText(<SummaryLine parts={['1 file', '1 guarded edit', '8 blocks']} />)
    expect(text).toBe('1 file · 1 guarded edit · 8 blocks')
  })

  test('falls back to . separator under NO_UNICODE', async () => {
    const text = await renderText(<SummaryLine parts={['a', 'b']} />, asciiConfig)
    expect(text).toBe('a . b')
  })

  test('renders nothing when empty', async () => {
    const text = await renderText(<SummaryLine parts={[]} />)
    expect(text).toBe('')
  })
})

describe('StatusGlyph', () => {
  test('maps each kind to its unicode glyph', async () => {
    expect(await renderText(<StatusGlyph kind="modified" />)).toBe('*')
    expect(await renderText(<StatusGlyph kind="diverged" />)).toBe('↕')
    expect(await renderText(<StatusGlyph kind="ok" />)).toBe('✓')
    expect(await renderText(<StatusGlyph kind="error" />)).toBe('✗')
  })

  test('falls back to ascii under NO_UNICODE (✓ → +, ✗ → x, ↕ → ^v)', async () => {
    expect(await renderText(<StatusGlyph kind="ok" />, asciiConfig)).toBe('+')
    expect(await renderText(<StatusGlyph kind="error" />, asciiConfig)).toBe('x')
    expect(await renderText(<StatusGlyph kind="diverged" />, asciiConfig)).toBe('^v')
    expect(await renderText(<StatusGlyph kind="modified" />, asciiConfig)).toBe('*')
  })
})

describe('CommandOutput', () => {
  test('assembles context → CRITICAL → WARNING → separator → sections → summary (log)', async () => {
    const text = await renderText(
      <CommandOutput
        context="notion-md sync · docs/research.nmd"
        problems={[conflict, guarded]}
        sections={sections}
        summary={['1 file', '1 guarded edit']}
      />,
    )
    expect(text).toMatchInlineSnapshot(`
      "notion-md sync · docs/research.nmd

      CRITICAL

        notes/planning.nmd blocked remote body changed since the last clean pull
          conflict artifact: notes/planning.nmd.roughdraft.md
          fix: notion-md status notes/planning.nmd
          fix: notion-md sync notes/planning.nmd
          skip: notion-md sync notes/planning.nmd --force

      WARNING

        docs/research.nmd guarded page contains unsupported Notion blocks
          fix: pull latest page state

      ───

        unknown-blocks(8):
          synced_block 1
          equation 1
          link_preview 2
          pdf 1
          bookmark 1
          + 3 more
        policy(1):
          non-destructive write refused until intent is explicit

      1 file · 1 guarded edit"
    `)
  })

  test('omits problem badges and separator when there are no problems', async () => {
    const text = await renderText(
      <CommandOutput
        context="notion-md status · demo/showcase.nmd"
        problems={[]}
        sections={[{ title: 'state', items: ['body clean', 'frontmatter clean'] }]}
        summary={['1 file', '0 edits']}
      />,
    )
    expect(text).toMatchInlineSnapshot(`
      "notion-md status · demo/showcase.nmd

        state(2):
          body clean
          frontmatter clean

      1 file · 0 edits"
    `)
  })

  test('renders stages when provided (log)', async () => {
    const text = await renderText(
      <CommandOutput problems={[]} sections={[]} stages={stages} summary={['3 stages']} />,
    )
    expect(text).toContain('Pull remote')
    expect(text).toContain('Merge body')
    expect(text).toContain('3 stages')
  })

  test('emits ANSI color codes in ci mode', async () => {
    const ansi = await renderAnsi(
      <CommandOutput context="ctx" problems={[conflict]} sections={sections} summary={['x']} />,
    )
    expect(ansi).toContain('41') // CRITICAL red bg
    expect(ansi).toContain('36') // cyan fix:
  })
})
