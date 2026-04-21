import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import * as Host from '../components/mod.ts'
import { buildCandidateTree } from '../renderer/sync-diff.ts'
import * as Web from '../web/mod.ts'
import { notionPageDemos } from './page-demos.tsx'

const ROOT = '00000000-0000-4000-8000-000000000001'

describe('shared notion page demos', () => {
  for (const demo of notionPageDemos) {
    it(`${demo.slug} renders through both web and host surfaces`, () => {
      const webMarkup = renderToStaticMarkup(demo.render(Web))
      const hostTree = buildCandidateTree(demo.render(Host), ROOT)

      expect(webMarkup.length).toBeGreaterThan(100)
      expect(hostTree.children.length).toBeGreaterThan(0)
    })
  }
})
