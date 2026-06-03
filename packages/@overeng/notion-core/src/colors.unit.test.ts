import { describe, expect, it } from 'vitest'

import {
  isNoticonColor,
  isNotionColor,
  isSelectColor,
  NOTICON_COLORS,
  NOTION_COLORS,
  SELECT_COLORS,
} from './colors.ts'

describe('Notion color literals', () => {
  it('exports the rich text color tuple including background colors', () => {
    expect(NOTION_COLORS).toEqual([
      'default',
      'gray',
      'brown',
      'orange',
      'yellow',
      'green',
      'blue',
      'purple',
      'pink',
      'red',
      'gray_background',
      'brown_background',
      'orange_background',
      'yellow_background',
      'green_background',
      'blue_background',
      'purple_background',
      'pink_background',
      'red_background',
    ])
    expect(isNotionColor('purple_background')).toBe(true)
    expect(isNotionColor('lightgray')).toBe(false)
  })

  it('exports the select color tuple without background colors', () => {
    expect(SELECT_COLORS).toEqual([
      'default',
      'gray',
      'brown',
      'orange',
      'yellow',
      'green',
      'blue',
      'purple',
      'pink',
      'red',
    ])
    expect(isSelectColor('blue')).toBe(true)
    expect(isSelectColor('blue_background')).toBe(false)
  })

  it('exports the noticon color tuple with lightgray and without default', () => {
    expect(NOTICON_COLORS).toEqual([
      'gray',
      'lightgray',
      'brown',
      'yellow',
      'orange',
      'green',
      'blue',
      'purple',
      'pink',
      'red',
    ])
    expect(isNoticonColor('lightgray')).toBe(true)
    expect(isNoticonColor('default')).toBe(false)
  })
})
