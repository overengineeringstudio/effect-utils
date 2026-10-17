/**
 * Migration invariant for the `notion_datasource.*` seam (breaking rename, approved). Locks:
 *
 * 1. The seam derives the DISJOINT `notion_datasource` namespace (NOT `notion`, which would collide
 *    with notion-effect-client) — the whole reason for the rename.
 * 2. Catalog ↔ runtime completeness: every `notion_datasource.*` key the runtime span bag can emit
 *    is catalogued in the seam, and vice versa; the ONLY runtime-bag keys absent from the catalog
 *    are the runtime-only `span.label` and the foreign `agent.iteration.id` (which is an `agent`
 *    namespace key, so it can be neither an own doc-only attr nor a resolvable `refExternal`).
 * 3. `spanAttrKeys` is the single source: `observability.ts`'s runtime encoder is keyed by it.
 */
import { describe, expect, it } from 'vitest'

import { fragment } from '@overeng/otel-contract/registry'

import notionDatasourceContract, { spanAttrKeys } from './notion-datasource.contract.ts'
import { notionDatasourceSpanAttributes, spanAttr } from './observability.ts'

const RUNTIME_ONLY_OR_FOREIGN = new Set<string>(['span.label', 'agent.iteration.id'])

describe('notion_datasource seam migration invariant', () => {
  it('derives the disjoint `notion_datasource` namespace (not `notion`)', () => {
    expect(notionDatasourceContract.namespace).toBe('notion_datasource')
  })

  it('re-exports `spanAttrKeys` as the runtime `spanAttr` SSOT', () => {
    expect(spanAttr).toBe(spanAttrKeys)
  })

  it('catalogs exactly the emitted `notion_datasource.*` keys (minus runtime-only/foreign)', () => {
    const catalogued = fragment(notionDatasourceContract)
      .attributes.map((a) => a.id)
      .toSorted()
    const expected = Object.values(spanAttrKeys)
      .filter((key) => RUNTIME_ONLY_OR_FOREIGN.has(key) === false)
      .toSorted()
    expect(catalogued).toEqual(expected)
    // Every catalogued key is namespaced (disjoint from notion-effect-client's `notion.*`).
    for (const id of catalogued) expect(id.startsWith('notion_datasource.')).toBe(true)
  })

  it('runtime span bag ↔ seam keys (completeness incl. runtime-only span.label + foreign agent.iteration.id)', () => {
    expect([...notionDatasourceSpanAttributes.keys].toSorted()).toEqual(
      Object.values(spanAttrKeys).toSorted(),
    )
  })

  it('emits NO legacy `notion.datasource.*` key (old bare-namespace keys stopped)', () => {
    for (const key of Object.values(spanAttrKeys)) {
      expect(key.startsWith('notion.datasource.')).toBe(false)
    }
  })
})
