import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Heading2, Paragraph, Toggle } from './blocks.tsx'

describe('<Toggle> defaultOpen', () => {
  it('renders <details> without `open` by default', () => {
    const html = renderToStaticMarkup(
      <Toggle title="title">
        <Paragraph>body</Paragraph>
      </Toggle>,
    )
    expect(html).toContain('<details')
    expect(html).not.toMatch(/<details[^>]*\sopen/)
  })

  it('renders <details open> when defaultOpen is true', () => {
    const html = renderToStaticMarkup(
      <Toggle title="title" defaultOpen>
        <Paragraph>body</Paragraph>
      </Toggle>,
    )
    expect(html).toMatch(/<details[^>]*\sopen/)
  })
})

describe('toggleable heading body passthrough', () => {
  it('renders the heading tag inside <summary> and the body inside <details>', () => {
    const html = renderToStaticMarkup(
      <Heading2 toggleable body={<Paragraph>nested body</Paragraph>}>
        Section
      </Heading2>,
    )
    expect(html).toContain('<details')
    expect(html).toContain('<summary>')
    expect(html).toContain('<h2')
    expect(html).toContain('Section')
    expect(html).toContain('nested body')
  })

  it('honors defaultOpen on toggleable headings', () => {
    const html = renderToStaticMarkup(
      <Heading2 toggleable defaultOpen body={<Paragraph>body</Paragraph>}>
        Section
      </Heading2>,
    )
    expect(html).toMatch(/<details[^>]*\sopen/)
  })

  it('ignores body on non-toggleable headings', () => {
    const html = renderToStaticMarkup(
      <Heading2 body={<Paragraph>should not render</Paragraph>}>Section</Heading2>,
    )
    expect(html).not.toContain('should not render')
    expect(html).not.toContain('<details')
  })
})
