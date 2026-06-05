import { describe, expect, it } from 'vitest'

import {
  composePushBody,
  pageUrl,
  parentRelPathFor,
  slugForRelPath,
  splitFrontmatter,
} from './subtree.ts'

describe('slugForRelPath', () => {
  it('derives stable slugs from the directory path', () => {
    expect(slugForRelPath('index.nmd')).toBe('index')
    expect(slugForRelPath('overview.nmd')).toBe('overview')
    expect(slugForRelPath('guides/index.nmd')).toBe('guides')
    expect(slugForRelPath('guides/getting-started.nmd')).toBe('guides/getting-started')
  })
})

describe('parentRelPathFor', () => {
  it('maps the directory hierarchy onto parent pages', () => {
    expect(parentRelPathFor('index.nmd')).toBeUndefined()
    expect(parentRelPathFor('overview.nmd')).toBe('index.nmd')
    expect(parentRelPathFor('guides/index.nmd')).toBe('index.nmd')
    expect(parentRelPathFor('guides/getting-started.nmd')).toBe('guides/index.nmd')
  })
})

describe('splitFrontmatter', () => {
  it('reads title + durable notion_page_id and strips the block', () => {
    const parsed = splitFrontmatter(
      '---\ntitle: My Page\nnotion_page_id: abc-123\n---\n\n# My Page\n\nBody.\n',
    )
    expect(parsed.title).toBe('My Page')
    expect(parsed.pageId).toBe('abc-123')
    expect(parsed.body).toBe('# My Page\n\nBody.\n')
  })

  it('treats a file without frontmatter as pure body', () => {
    const parsed = splitFrontmatter('# Bare\n\nNo frontmatter.\n')
    expect(parsed.title).toBeUndefined()
    expect(parsed.pageId).toBeUndefined()
    expect(parsed.body).toBe('# Bare\n\nNo frontmatter.\n')
  })
})

describe('composePushBody', () => {
  it('appends one blank-line-separated block anchor per child', () => {
    const body = composePushBody({
      resolvedBody: '# Root\n\nIntro.\n',
      children: [
        { title: 'Overview', pageId: '111' },
        { title: 'API', pageId: '222' },
      ],
    })
    // anchors MUST be blank-line-separated or Notion lazily merges them into
    // one block and trashes all but the first child.
    expect(body).toBe(
      `# Root\n\nIntro.\n\n<page url="${pageUrl('111')}">Overview</page>\n\n<page url="${pageUrl('222')}">API</page>\n`,
    )
  })

  it('leaves a childless body untouched (no trailing anchors)', () => {
    expect(composePushBody({ resolvedBody: '# Leaf\n\nText.\n', children: [] })).toBe(
      '# Leaf\n\nText.\n',
    )
  })
})

describe('pageUrl', () => {
  it('emits the app.notion.com/p form proven to resolve to a live link', () => {
    expect(pageUrl('376e3d41-f4a3-8136-b0ac-fc0c917cbb4a')).toBe(
      'https://app.notion.com/p/376e3d41f4a38136b0acfc0c917cbb4a',
    )
  })
})
