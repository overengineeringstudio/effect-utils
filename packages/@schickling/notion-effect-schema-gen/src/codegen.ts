import type { DatabaseInfo, PropertyInfo, PropertyTransformConfig } from './introspect.ts'

// -----------------------------------------------------------------------------
// Transform Mappings
// -----------------------------------------------------------------------------

/** Available transforms for each property type */
export const PROPERTY_TRANSFORMS: Record<string, readonly string[]> = {
  title: ['raw', 'asString'],
  rich_text: ['raw', 'asString'],
  number: ['raw', 'asNumber', 'asOption'],
  select: ['raw', 'asOption', 'asString'],
  multi_select: ['raw', 'asStrings'],
  status: ['raw', 'asOption', 'asString'],
  date: ['raw', 'asDate', 'asOption'],
  people: ['raw', 'asIds'],
  files: ['raw', 'asUrls'],
  checkbox: ['raw', 'asBoolean'],
  url: ['raw', 'asString', 'asOption'],
  email: ['raw', 'asString', 'asOption'],
  phone_number: ['raw', 'asString', 'asOption'],
  formula: ['raw'],
  relation: ['raw', 'asIds'],
  rollup: ['raw'],
  created_time: ['raw', 'asDate'],
  created_by: ['raw'],
  last_edited_time: ['raw', 'asDate'],
  last_edited_by: ['raw'],
  unique_id: ['raw'],
  verification: ['raw'],
  button: ['raw'],
} as const

/** Default transform for each property type */
const DEFAULT_TRANSFORMS: Record<string, string> = {
  title: 'asString',
  rich_text: 'asString',
  number: 'asNumber',
  select: 'asOption',
  multi_select: 'asStrings',
  status: 'asOption',
  date: 'asOption',
  people: 'asIds',
  files: 'asUrls',
  checkbox: 'asBoolean',
  url: 'asOption',
  email: 'asOption',
  phone_number: 'asOption',
  formula: 'raw',
  relation: 'asIds',
  rollup: 'raw',
  created_time: 'asDate',
  created_by: 'raw',
  last_edited_time: 'asDate',
  last_edited_by: 'raw',
  unique_id: 'raw',
  verification: 'raw',
  button: 'raw',
}

/** Property type to schema import mapping */
const PROPERTY_SCHEMA_IMPORTS: Record<string, string> = {
  title: 'TitleProperty',
  rich_text: 'RichTextProperty',
  number: 'NumberProperty',
  select: 'SelectProperty',
  multi_select: 'MultiSelectProperty',
  status: 'StatusProperty',
  date: 'DateProperty',
  people: 'PeopleProperty',
  files: 'FilesProperty',
  checkbox: 'CheckboxProperty',
  url: 'UrlProperty',
  email: 'EmailProperty',
  phone_number: 'PhoneNumberProperty',
  formula: 'FormulaProperty',
  relation: 'RelationProperty',
  rollup: 'RollupProperty',
  created_time: 'CreatedTimeProperty',
  created_by: 'CreatedByProperty',
  last_edited_time: 'LastEditedTimeProperty',
  last_edited_by: 'LastEditedByProperty',
  unique_id: 'UniqueIdProperty',
}

// -----------------------------------------------------------------------------
// Code Generation
// -----------------------------------------------------------------------------

/**
 * Convert a string to PascalCase
 */
function toPascalCase(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('')
}

/**
 * Sanitize a property name for use as a TypeScript key
 */
function sanitizePropertyKey(name: string): string {
  // If it's a valid identifier, use it as-is
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) {
    return name
  }
  // Otherwise, quote it
  return `'${name.replace(/'/g, "\\'")}'`
}

/**
 * Generate the schema field expression for a property
 */
function generatePropertyField(
  property: PropertyInfo,
  transformConfig: PropertyTransformConfig,
): string {
  const schemaName = PROPERTY_SCHEMA_IMPORTS[property.type]
  if (!schemaName) {
    // Unknown property type - use Schema.Unknown
    return 'Schema.Unknown'
  }

  // Determine which transform to use
  const configuredTransform = transformConfig[property.name]
  const availableTransforms = PROPERTY_TRANSFORMS[property.type] ?? ['raw']

  let transform: string
  if (configuredTransform && availableTransforms.includes(configuredTransform)) {
    transform = configuredTransform
  } else if (configuredTransform) {
    // Configured transform is not available for this type - fall back to default
    transform = DEFAULT_TRANSFORMS[property.type] ?? 'raw'
  } else {
    transform = DEFAULT_TRANSFORMS[property.type] ?? 'raw'
  }

  return `${schemaName}.${transform}`
}

/**
 * Generate TypeScript code for an Effect schema from database info.
 */
export function generateSchemaCode(
  dbInfo: DatabaseInfo,
  schemaName: string,
  transformConfig: PropertyTransformConfig = {},
): string {
  const pascalName = toPascalCase(schemaName)

  // Collect required imports
  const imports = new Set<string>()
  for (const prop of dbInfo.properties) {
    const schemaImport = PROPERTY_SCHEMA_IMPORTS[prop.type]
    if (schemaImport) {
      imports.add(schemaImport)
    }
  }

  // Sort imports alphabetically
  const sortedImports = Array.from(imports).sort()

  // Generate property fields
  const propertyFields = dbInfo.properties
    .map((prop) => {
      const key = sanitizePropertyKey(prop.name)
      const field = generatePropertyField(prop, transformConfig)
      const comment = prop.description ? ` // ${prop.description}` : ''
      return `  ${key}: ${field},${comment}`
    })
    .join('\n')

  // Build the code
  const lines: string[] = [
    `// Generated by notion-effect-schema-gen`,
    `// Database: ${dbInfo.name}`,
    `// ID: ${dbInfo.id}`,
    `// URL: ${dbInfo.url}`,
    `// Generated at: ${new Date().toISOString()}`,
    ``,
    `import { Schema } from 'effect'`,
  ]

  if (sortedImports.length > 0) {
    lines.push(`import {`)
    for (const imp of sortedImports) {
      lines.push(`  ${imp},`)
    }
    lines.push(`} from '@schickling/notion-effect-schema'`)
  }

  lines.push(``)
  lines.push(`/**`)
  lines.push(` * Schema for pages in the "${dbInfo.name}" database.`)
  lines.push(` */`)
  lines.push(`export const ${pascalName}PageProperties = Schema.Struct({`)
  lines.push(propertyFields)
  lines.push(`})`)
  lines.push(``)
  lines.push(`export type ${pascalName}PageProperties = typeof ${pascalName}PageProperties.Type`)
  lines.push(``)

  return lines.join('\n')
}

/**
 * Get available transforms for a property type
 */
export function getAvailableTransforms(propertyType: string): readonly string[] {
  return PROPERTY_TRANSFORMS[propertyType] ?? ['raw']
}

/**
 * Get the default transform for a property type
 */
export function getDefaultTransform(propertyType: string): string {
  return DEFAULT_TRANSFORMS[propertyType] ?? 'raw'
}
