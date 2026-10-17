import { describe, expect, it } from 'vitest'

import { renderNmdFile } from '@overeng/notion-md'

import { Heading1, Paragraph, Toggle } from '../components/blocks.ts'
import { renderToNotionMarkdown } from './render-to-notion-markdown.ts'

describe('renderToNotionMarkdown -> notion-md composition', () => {
  it('composes the projected body into an .nmd envelope without reverse coupling', () => {
    const Instructions = () => (
      <>
        <Heading1>Blocky instructions</Heading1>
        <Toggle blockKey="deploy" title="Deploy">
          <Paragraph>Run the audited deploy command.</Paragraph>
        </Toggle>
      </>
    )
    const { body, diagnostics } = renderToNotionMarkdown(<Instructions />)
    expect(diagnostics).toEqual([])
    const file = renderNmdFile({
      frontmatter: {
        notion_md: {
          version: 2,
          api_version: '2026-03-11',
          object: 'page',
          source: 'local',
          page_id: null,
          parent: { _tag: 'workspace' },
          page: {
            title: 'Blocky instructions',
            icon: null,
            cover: null,
            in_trash: false,
            is_locked: false,
          },
          properties: {},
        },
      },
      body,
    })
    expect(file).toMatchInlineSnapshot(`
      "---
      {
        "notion_md": {
          "version": 2,
          "api_version": "2026-03-11",
          "object": "page",
          "source": "local",
          "page_id": null,
          "parent": {
            "_tag": "workspace"
          },
          "page": {
            "title": "Blocky instructions",
            "icon": null,
            "cover": null,
            "in_trash": false,
            "is_locked": false
          },
          "properties": {}
        }
      }
      ---

      # Blocky instructions

      <details>
      <summary>Deploy</summary>

      Run the audited deploy command.

      </details>
      "
    `)
  })
})
