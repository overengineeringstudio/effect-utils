/**
 * Regression: `NotionBlocks.*` wrapper spans were collapsed so a trivial
 * block op no longer emits a redundant middle span. The expected span
 * catalog for a `retrieve` is {caller outer span} → `NotionHttp.GET` →
 * `http.client`, not {outer} → `NotionBlocks.retrieve` → `NotionHttp.GET`
 * → `http.client`.
 *
 * Static check: asserts the source file carries no `Effect.fn('NotionBlocks.*')`
 * wrapper nor any `Effect.withSpan('NotionBlocks.*')`. Static-only because
 * spinning up the @effect/platform tracer to capture span parentage in a
 * unit test is heavier than the bug surface merits.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const blocksSource = readFileSync(fileURLToPath(new URL('./blocks.ts', import.meta.url)), 'utf8')

describe('blocks span catalog', () => {
  it('emits no `NotionBlocks.*` wrapper span via Effect.fn', () => {
    // Matches Effect.fn('NotionBlocks.anything')(...)
    const matches = blocksSource.match(/Effect\.fn\(['"]NotionBlocks\.[^'"]+['"]\)/g) ?? []
    expect(matches).toEqual([])
  })

  it('emits no `NotionBlocks.*` wrapper span via Effect.withSpan', () => {
    const matches = blocksSource.match(/Effect\.withSpan\(['"]NotionBlocks\.[^'"]+['"]/g) ?? []
    expect(matches).toEqual([])
  })
})
