import { describe, expect, it } from '@effect/vitest'

import { stripChildAnchors } from './hash.ts'

describe('stripChildAnchors', () => {
  it('drops anchor lines and collapses the blank-line gap they leave', () => {
    // The previously divergent case: a `<page>` anchor between two paragraphs.
    // The single (rich) definition collapses the resulting `\n\n\n` to `\n\n`,
    // so the stripped body is stable whether or not an anchor sat between blocks.
    const body = 'Para A\n\n<page url="https://app.notion.com/p/x">Child</page>\n\nPara B\n'
    expect(stripChildAnchors(body)).toBe('Para A\n\nPara B\n')
  })

  it('removes a trailing anchor block without leaving trailing blanks', () => {
    const body = 'Body text\n\n<page url="https://app.notion.com/p/x">Child</page>\n'
    expect(stripChildAnchors(body)).toBe('Body text\n')
  })

  it('leaves an anchor-free body unchanged aside from line-ending normalize', () => {
    expect(stripChildAnchors('- a\n- b\n')).toBe('- a\n- b\n')
  })
})
