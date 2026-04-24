import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ChildPage, LinkToPage } from '../web/blocks.tsx'
import { Mention } from '../web/inline.tsx'
import { NotionUrlProviderProvider, useNotionUrl } from './url-provider.ts'

/**
 * `useNotionUrl` is trivial enough that we exercise it indirectly through the
 * three web-mirror consumers rather than mounting the hook standalone. This
 * keeps the tests close to the shape the public API actually expresses.
 */

const Probe = ({ pageId, blockId }: { pageId: string; blockId?: string }) => {
  const ref = blockId === undefined ? { pageId } : { pageId, blockId }
  const url = useNotionUrl(ref)
  return <span>{url ?? 'no-url'}</span>
}

describe('useNotionUrl', () => {
  it('returns undefined when no provider is mounted', () => {
    const html = renderToStaticMarkup(<Probe pageId="p1" />)
    expect(html).toContain('no-url')
  })

  it('returns the resolved URL when the provider resolves', () => {
    const html = renderToStaticMarkup(
      <NotionUrlProviderProvider value={{ resolve: ({ pageId }) => `/pages/${pageId}` }}>
        <Probe pageId="p1" />
      </NotionUrlProviderProvider>,
    )
    expect(html).toContain('/pages/p1')
  })

  it('returns undefined when the provider resolves to undefined', () => {
    const html = renderToStaticMarkup(
      <NotionUrlProviderProvider value={{ resolve: () => undefined }}>
        <Probe pageId="p1" />
      </NotionUrlProviderProvider>,
    )
    expect(html).toContain('no-url')
  })

  it('passes blockId through to the resolver', () => {
    const html = renderToStaticMarkup(
      <NotionUrlProviderProvider
        value={{
          resolve: ({ pageId, blockId }) =>
            blockId === undefined ? `/p/${pageId}` : `/p/${pageId}#${blockId}`,
        }}
      >
        <Probe pageId="p1" blockId="b9" />
      </NotionUrlProviderProvider>,
    )
    expect(html).toContain('/p/p1#b9')
  })
})

describe('web consumers honor NotionUrlProvider', () => {
  it('ChildPage renders href="#" without a provider', () => {
    const html = renderToStaticMarkup(<ChildPage blockKey="p1" title="Sub" />)
    expect(html).toContain('href="#"')
  })

  it('ChildPage uses resolved URL when provider resolves', () => {
    const html = renderToStaticMarkup(
      <NotionUrlProviderProvider value={{ resolve: ({ pageId }) => `/x/${pageId}` }}>
        <ChildPage blockKey="p1" title="Sub" />
      </NotionUrlProviderProvider>,
    )
    expect(html).toContain('href="/x/p1"')
  })

  it('LinkToPage uses resolved URL when provider resolves', () => {
    const html = renderToStaticMarkup(
      <NotionUrlProviderProvider value={{ resolve: ({ pageId }) => `/y/${pageId}` }}>
        <LinkToPage pageId="abc" />
      </NotionUrlProviderProvider>,
    )
    expect(html).toContain('href="/y/abc"')
  })

  it('LinkToPage falls back to fragment anchor without a provider', () => {
    const html = renderToStaticMarkup(<LinkToPage pageId="abc" />)
    expect(html).toContain('href="#abc"')
  })

  it('page Mention renders as an anchor when the provider resolves', () => {
    const html = renderToStaticMarkup(
      <NotionUrlProviderProvider value={{ resolve: ({ pageId }) => `/z/${pageId}` }}>
        <Mention mention={{ page: { id: 'pg9' } }} plainText="@Launch" />
      </NotionUrlProviderProvider>,
    )
    expect(html).toContain('href="/z/pg9"')
    expect(html).toContain('@Launch')
  })

  it('user/date Mentions are not resolved through NotionUrlProvider', () => {
    const html = renderToStaticMarkup(
      <NotionUrlProviderProvider value={{ resolve: () => '/should-not-be-used' }}>
        <Mention mention={{ user: { id: 'u1' } }} plainText="@priya" />
        <Mention mention={{ date: { start: '2026-01-01' } }} plainText="@date" />
      </NotionUrlProviderProvider>,
    )
    expect(html).not.toContain('/should-not-be-used')
  })
})
