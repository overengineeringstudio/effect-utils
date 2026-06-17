/** Full block/text color palette, including the `*_background` highlight variants. */
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

/** Union of the full block/text color palette. */
export type NotionColor = (typeof NOTION_COLORS)[number]

/** Solid-only palette accepted by select/multi-select/status options (no backgrounds). */
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

/** Union of the select/multi-select/status option colors. */
export type SelectColor = (typeof SELECT_COLORS)[number]

/** Icon (noticon) color palette; includes `lightgray` and omits the background variants. */
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

/** Union of the icon (noticon) palette colors. */
export type NoticonColor = (typeof NOTICON_COLORS)[number]

const includesLiteral = <TValue extends string>(
  values: readonly TValue[],
  value: string,
): value is TValue => (values as readonly string[]).includes(value)

/** Narrowing guard for a value in the full block/text color palette. */
export const isNotionColor = (value: string): value is NotionColor =>
  includesLiteral(NOTION_COLORS, value)

/** Narrowing guard for a select/multi-select/status option color. */
export const isSelectColor = (value: string): value is SelectColor =>
  includesLiteral(SELECT_COLORS, value)

/** Narrowing guard for an icon (noticon) palette color. */
export const isNoticonColor = (value: string): value is NoticonColor =>
  includesLiteral(NOTICON_COLORS, value)
