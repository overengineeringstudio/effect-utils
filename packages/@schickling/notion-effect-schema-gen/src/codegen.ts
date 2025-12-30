import type { DatabaseInfo, PropertyInfo, PropertyTransformConfig } from './introspect.ts'

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Options for code generation */
export interface GenerateOptions {
  /** Include Write schemas for creating/updating pages */
  readonly includeWrite?: boolean
  /** Generate typed literal unions for select/status options */
  readonly typedOptions?: boolean
  /** Property-specific transform configuration */
  readonly transforms?: PropertyTransformConfig
  /** Version of the generator CLI/package (included in generated header comment) */
  readonly generatorVersion?: string
}

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

/** Property type to schema import mapping (read) */
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

/** Property type to write schema import mapping */
const WRITE_SCHEMA_IMPORTS: Record<string, string> = {
  title: 'TitleWriteFromString',
  rich_text: 'RichTextWriteFromString',
  number: 'NumberWriteFromNumber',
  select: 'SelectWriteFromName',
  multi_select: 'MultiSelectWriteFromNames',
  status: 'StatusWriteFromName',
  date: 'DateWriteFromStart',
  people: 'PeopleWriteFromIds',
  files: 'FilesWriteFromUrls',
  checkbox: 'CheckboxWriteFromBoolean',
  url: 'UrlWriteFromString',
  email: 'EmailWriteFromString',
  phone_number: 'PhoneNumberWriteFromString',
  relation: 'RelationWriteFromIds',
}

/** Read-only property types (cannot be written) */
const READ_ONLY_PROPERTIES = new Set([
  'formula',
  'rollup',
  'created_time',
  'created_by',
  'last_edited_time',
  'last_edited_by',
  'unique_id',
  'verification',
  'button',
])

// -----------------------------------------------------------------------------
// Code Generation Helpers
// -----------------------------------------------------------------------------

/**
 * Convert a string to PascalCase, preserving existing casing for already-cased words.
 * Examples:
 * - "my-test-database" -> "MyTestDatabase"
 * - "TestDatabase" -> "TestDatabase" (preserved)
 * - "my test DB" -> "MyTestDb"
 */
const toPascalCase = (str: string): string => {
  // Split on non-alphanumeric characters
  const words = str.split(/[^a-zA-Z0-9]+/).filter(Boolean)

  return words
    .map((word) => {
      // If word is all uppercase and longer than 1 char, treat as acronym
      if (word.length > 1 && word === word.toUpperCase()) {
        return word.charAt(0) + word.slice(1).toLowerCase()
      }
      // If word already starts with uppercase, preserve it (likely already PascalCase)
      if (word.charAt(0) === word.charAt(0).toUpperCase() && word.length > 1) {
        return word
      }
      // Otherwise, capitalize first letter
      return word.charAt(0).toUpperCase() + word.slice(1)
    })
    .join('')
}

/**
 * Sanitize a property name for use as a TypeScript key
 */
const sanitizePropertyKey = (name: string): string => {
  // If it's a valid identifier, use it as-is
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) {
    return name
  }
  // Otherwise, quote it
  return toSingleQuotedStringLiteral(name)
}

/**
 * Sanitize an option name for use in a Schema.Literal
 */
const sanitizeLiteralValue = (name: string): string => {
  return toSingleQuotedStringLiteral(name)
}

const toSingleQuotedStringLiteral = (value: string): string => {
  const json = JSON.stringify(value)
  const inner = json.slice(1, -1)
  return `'${inner.replace(/'/g, "\\'")}'`
}

const sanitizeLineComment = (comment: string): string =>
  comment.replaceAll('\r\n', ' ').replaceAll('\n', ' ').replaceAll('\r', ' ')

/**
 * Generate a valid TypeScript identifier from a property name
 */
const toIdentifier = (name: string): string => {
  return toPascalCase(name).replace(/[^a-zA-Z0-9_$]/g, '')
}

const toTopLevelIdentifier = (name: string): string => {
  const identifier = toIdentifier(name)
  if (/^[a-zA-Z_$]/.test(identifier)) {
    return identifier
  }
  return `_${identifier}`
}

/**
 * Generate the schema field expression for a property (read)
 */
const generatePropertyField = (
  property: PropertyInfo,
  transformConfig: PropertyTransformConfig,
): string => {
  const schemaName = PROPERTY_SCHEMA_IMPORTS[property.type]
  if (!schemaName) {
    return 'Schema.Unknown'
  }

  const configuredTransform = transformConfig[property.name]
  const availableTransforms = PROPERTY_TRANSFORMS[property.type] ?? ['raw']

  let transform: string
  if (configuredTransform && availableTransforms.includes(configuredTransform)) {
    transform = configuredTransform
  } else {
    transform = DEFAULT_TRANSFORMS[property.type] ?? 'raw'
  }

  return `${schemaName}.${transform}`
}

/**
 * Generate the write schema field expression for a property
 */
const generateWritePropertyField = (property: PropertyInfo): string | null => {
  if (READ_ONLY_PROPERTIES.has(property.type)) {
    return null
  }

  const writeSchema = WRITE_SCHEMA_IMPORTS[property.type]
  if (!writeSchema) {
    return null
  }

  return writeSchema
}

// -----------------------------------------------------------------------------
// Typed Options Generation
// -----------------------------------------------------------------------------

/**
 * Generate typed literal union for select/multi_select/status options
 */
const generateTypedOptions = (
  property: PropertyInfo,
  pascalName: string,
): { typeName: string; code: string } | null {
  let options: readonly { name: string }[] | undefined

  if (property.type === 'select' && property.select?.options) {
    options = property.select.options
  } else if (property.type === 'multi_select' && property.multi_select?.options) {
    options = property.multi_select.options
  } else if (property.type === 'status' && property.status?.options) {
    options = property.status.options
  }

  if (!options || options.length === 0) {
    return null
  }

  const propIdentifier = toIdentifier(property.name)
  const typeName = `${pascalName}${propIdentifier}Option`

  const literals = options
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((o) => sanitizeLiteralValue(o.name))
    .join(', ')

  const code = `export const ${typeName} = Schema.Literal(${literals})\nexport type ${typeName} = typeof ${typeName}.Type`

  return { typeName, code }
}

const parseGenerateOptions = (
  transformConfigOrOptions: PropertyTransformConfig | GenerateOptions | undefined,
): Required<Pick<GenerateOptions, 'includeWrite' | 'typedOptions'>> &
  Pick<GenerateOptions, 'generatorVersion'> & { transforms: PropertyTransformConfig } => {
  if (!transformConfigOrOptions) {
    return {
      includeWrite: false,
      typedOptions: false,
      transforms: {},
      generatorVersion: undefined,
    }
  }

  const values = Object.values(transformConfigOrOptions)
  const looksLikeOptions = values.some((v) => typeof v !== 'string')

  if (looksLikeOptions) {
    const options = transformConfigOrOptions as GenerateOptions
    return {
      includeWrite: options.includeWrite ?? false,
      typedOptions: options.typedOptions ?? false,
      transforms: options.transforms ?? {},
      generatorVersion: options.generatorVersion,
    }
  }

  return {
    includeWrite: false,
    typedOptions: false,
    transforms: transformConfigOrOptions as PropertyTransformConfig,
    generatorVersion: undefined,
  }
}

// -----------------------------------------------------------------------------
// Main Code Generation
// -----------------------------------------------------------------------------

/**
 * Generate TypeScript code for an Effect schema from database info.
 */
export function generateSchemaCode(
  dbInfo: DatabaseInfo,
  schemaName: string,
  transformConfigOrOptions: PropertyTransformConfig | GenerateOptions = {},
): string {
  const { includeWrite, typedOptions, transforms, generatorVersion } =
    parseGenerateOptions(transformConfigOrOptions)

  const pascalName = toTopLevelIdentifier(schemaName)

  // Collect required imports
  const readImports = new Set<string>()
  const writeImports = new Set<string>()

  for (const prop of dbInfo.properties) {
    const schemaImport = PROPERTY_SCHEMA_IMPORTS[prop.type]
    if (schemaImport) {
      readImports.add(schemaImport)
    }

    if (includeWrite) {
      const writeImport = WRITE_SCHEMA_IMPORTS[prop.type]
      if (writeImport) {
        writeImports.add(writeImport)
      }
    }
  }

  // Generate typed options if enabled
  const typedOptionsDefs: Array<{ property: PropertyInfo; typeName: string; code: string }> = []
  if (typedOptions) {
    for (const prop of dbInfo.properties) {
      const result = generateTypedOptions(prop, pascalName)
      if (result) {
        typedOptionsDefs.push({ property: prop, ...result })
      }
    }
  }

  // Sort imports alphabetically
  const allImports = new Set([...readImports, ...writeImports])
  const sortedImports = Array.from(allImports).sort()

  // Generate read property fields
  const readPropertyFields = dbInfo.properties
    .map((prop) => {
      const key = sanitizePropertyKey(prop.name)
      const field = generatePropertyField(prop, transforms)
      const comment = prop.description ? ` // ${sanitizeLineComment(prop.description)}` : ''
      return `  ${key}: ${field},${comment}`
    })
    .join('\n')

  // Generate write property fields (excluding read-only)
  const writePropertyFields = includeWrite
    ? dbInfo.properties
        .map((prop) => {
          const writeField = generateWritePropertyField(prop)
          if (!writeField) return null
          const key = sanitizePropertyKey(prop.name)
          return `  ${key}: ${writeField},`
        })
        .filter(Boolean)
        .join('\n')
    : ''

  // Build the code
  const lines: string[] = [
    `// Generated by notion-effect-schema-gen${generatorVersion ? ` v${generatorVersion}` : ''}`,
    `// Database: ${dbInfo.name}`,
    `// ID: ${dbInfo.id}`,
    `// URL: ${dbInfo.url}`,
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

  // Add typed options definitions
  if (typedOptionsDefs.length > 0) {
    lines.push(``)
    lines.push(`// -----------------------------------------------------------------------------`)
    lines.push(`// Typed Options`)
    lines.push(`// -----------------------------------------------------------------------------`)
    lines.push(``)
    for (const def of typedOptionsDefs) {
      lines.push(`/** Options for "${def.property.name}" property */`)
      lines.push(def.code)
      lines.push(``)
    }
  }

  // Read schema
  lines.push(``)
  lines.push(`// -----------------------------------------------------------------------------`)
  lines.push(`// Read Schema`)
  lines.push(`// -----------------------------------------------------------------------------`)
  lines.push(``)
  lines.push(`/**`)
  lines.push(` * Schema for reading pages from the "${dbInfo.name}" database.`)
  lines.push(` */`)
  lines.push(`export const ${pascalName}PageProperties = Schema.Struct({`)
  lines.push(readPropertyFields)
  lines.push(`})`)
  lines.push(``)
  lines.push(`export type ${pascalName}PageProperties = typeof ${pascalName}PageProperties.Type`)

  // Write schema (if enabled)
  if (includeWrite && writePropertyFields) {
    lines.push(``)
    lines.push(`// -----------------------------------------------------------------------------`)
    lines.push(`// Write Schema`)
    lines.push(`// -----------------------------------------------------------------------------`)
    lines.push(``)
    lines.push(`/**`)
    lines.push(` * Schema for creating/updating pages in the "${dbInfo.name}" database.`)
    lines.push(` * Note: Read-only properties (formula, rollup, created_time, etc.) are excluded.`)
    lines.push(` */`)
    lines.push(`export const ${pascalName}PageWrite = Schema.Struct({`)
    lines.push(writePropertyFields)
    lines.push(`})`)
    lines.push(``)
    lines.push(`export type ${pascalName}PageWrite = typeof ${pascalName}PageWrite.Type`)
  }

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

/**
 * Check if a property type is read-only
 */
export function isReadOnlyProperty(propertyType: string): boolean {
  return READ_ONLY_PROPERTIES.has(propertyType)
}
