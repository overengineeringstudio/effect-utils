import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  BulletedListItem,
  Column,
  Heading2,
  NumberedListItem,
  Page,
  Paragraph,
  Toggle,
} from './blocks.tsx'

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

describe('list-item colors', () => {
  const items = [
    <BulletedListItem key="bullet" color="red">
      bullet
    </BulletedListItem>,
    <BulletedListItem key="background" color="gray_background">
      background
    </BulletedListItem>,
    <BulletedListItem key="plain-bullet">plain bullet</BulletedListItem>,
    <NumberedListItem key="number" color="blue">
      number
    </NumberedListItem>,
    <NumberedListItem key="plain-number">plain number</NumberedListItem>,
  ]

  const expectColors = (html: string) => {
    expect(html).toContain('<li class="notion-red">bullet</li>')
    expect(html).toContain('<li class="notion-gray_background">background</li>')
    expect(html).toContain('<li>plain bullet</li>')
    expect(html).toContain('<li class="notion-blue">number</li>')
    expect(html).toContain('<li>plain number</li>')
  }

  it('preserves colors on standalone list items', () => {
    expectColors(renderToStaticMarkup(items))
  })

  it.each([Page, Column])('preserves colors when grouping list items in %s', (Container) => {
    const html = renderToStaticMarkup(<Container>{items}</Container>)
    expectColors(html)
    expect(html.match(/<ul /g)).toHaveLength(1)
    expect(html.match(/<ol /g)).toHaveLength(1)
  })
})
