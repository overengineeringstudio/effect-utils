import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import * as Host from '../components/mod.ts'
import { buildCandidateTree } from '../renderer/sync-diff.ts'
import * as Web from '../web/mod.ts'
import {
  storybookChildPagesByParent,
  storybookRootPages,
  storybookSyncPages,
} from './storybook-sync-catalog.tsx'

const ROOT = '00000000-0000-4000-8000-000000000001'

describe('storybook sync catalog', () => {
  it('keeps the top-level category order aligned with Storybook', () => {
    expect(storybookRootPages.map((page) => page.title)).toEqual([
      'Blocks',
      'Inline',
      'Media & Layout',
      'Pages',
      'Demo',
    ])
  })

  it('keeps the Demo child-page order aligned with Storybook', () => {
    expect(
      (storybookChildPagesByParent.get('category-demo') ?? []).map((page) => page.title),
    ).toEqual([
      '00 — Features Index',
      '01 — Basic Blocks',
      '06 — Bookmarks',
      '04 — Code Blocks',
      '03 — Color Rainbow',
      '09 — Column Layouts',
      '07 — Links',
      '02 — Lists',
      '08 — Math & Equations',
      '17 — Modern · Breadcrumb',
      '18 — Modern · Child DB & Page',
      '19 — Modern · Color Palette',
      '12 — Modern · Column Widths',
      '15 — Modern · File Upload',
      '16 — Modern · Link Preview',
      '14 — Modern · Meeting Notes',
      '13 — Modern · Synced Blocks',
      '11 — Modern · Tabs',
      '10 — Placeholders (v0.2)',
      '05 — Table of Contents',
    ])
  })

  for (const page of storybookSyncPages) {
    const render = page.render
    if (render === undefined) continue
    it(`${page.slug} renders through both web and host surfaces`, () => {
      const webMarkup = renderToStaticMarkup(render(Web))
      const hostTree = buildCandidateTree(render(Host), ROOT)

      expect(webMarkup.length).toBeGreaterThan(100)
      expect(hostTree.children.length).toBeGreaterThan(0)
    })
  }
})
