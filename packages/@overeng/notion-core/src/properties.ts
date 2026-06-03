export const NOTION_PROPERTY_TYPES = [
  'title',
  'rich_text',
  'number',
  'checkbox',
  'date',
  'select',
  'multi_select',
  'status',
  'relation',
  'people',
  'files',
  'email',
  'url',
  'phone_number',
  'formula',
  'rollup',
  'created_time',
  'created_by',
  'last_edited_time',
  'last_edited_by',
  'unique_id',
  'verification',
  'button',
] as const

export type NotionPropertyType = (typeof NOTION_PROPERTY_TYPES)[number]

export const PROPERTY_WRITE_CLASSES = ['writable', 'computed', 'unsupported'] as const

export type PropertyWriteClass = (typeof PROPERTY_WRITE_CLASSES)[number]

const includesLiteral = <TValue extends string>(
  values: readonly TValue[],
  value: string,
): value is TValue => (values as readonly string[]).includes(value)

export const isNotionPropertyType = (value: string): value is NotionPropertyType =>
  includesLiteral(NOTION_PROPERTY_TYPES, value)

export const isPropertyWriteClass = (value: string): value is PropertyWriteClass =>
  includesLiteral(PROPERTY_WRITE_CLASSES, value)

/**
 * Classify a Notion property type by how it may be written back.
 *
 * Computed properties cannot be written. Known unsupported and unknown property
 * types are deliberately fail-closed.
 */
export const propertyWriteClassFromType = (propertyType: string): PropertyWriteClass => {
  switch (propertyType) {
    case 'formula':
    case 'rollup':
    case 'created_time':
    case 'created_by':
    case 'last_edited_time':
    case 'last_edited_by':
    case 'unique_id':
    case 'verification':
      return 'computed'
    case 'title':
    case 'rich_text':
    case 'number':
    case 'checkbox':
    case 'date':
    case 'select':
    case 'multi_select':
    case 'status':
    case 'email':
    case 'url':
    case 'phone_number':
    case 'relation':
    case 'people':
    case 'files':
      return 'writable'
    default:
      return 'unsupported'
  }
}
