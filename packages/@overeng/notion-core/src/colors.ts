export const NOTION_COLORS = [
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
] as const

export type NotionColor = (typeof NOTION_COLORS)[number]

export const SELECT_COLORS = [
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
] as const

export type SelectColor = (typeof SELECT_COLORS)[number]

export const NOTICON_COLORS = [
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
] as const

export type NoticonColor = (typeof NOTICON_COLORS)[number]

const includesLiteral = <TValue extends string>(
  values: readonly TValue[],
  value: string,
): value is TValue => (values as readonly string[]).includes(value)

export const isNotionColor = (value: string): value is NotionColor =>
  includesLiteral(NOTION_COLORS, value)

export const isSelectColor = (value: string): value is SelectColor =>
  includesLiteral(SELECT_COLORS, value)

export const isNoticonColor = (value: string): value is NoticonColor =>
  includesLiteral(NOTICON_COLORS, value)
