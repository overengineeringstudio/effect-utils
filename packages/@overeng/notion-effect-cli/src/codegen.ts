import type {
  DatabaseInfo,
  NotionPropertyType,
  PropertyInfo,
  PropertyTransformConfig,
} from './introspect.ts'

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
  /** Generate a typed database API wrapper */
  readonly includeApi?: boolean
  /** Explicit schema name override (included in header if different from database name) */
  readonly schemaNameOverride?: string
}

/** Options for generating schema code */
export interface GenerateSchemaCodeOptions {
  /** Database info from introspection */
  readonly dbInfo: DatabaseInfo
  /** Name for the generated schema */
  readonly schemaName: string
  /** Additional generation options */
  readonly options?: GenerateOptions
}

/** Options for generating API code */
export interface GenerateApiCodeOptions {
  /** Database info from introspection */
  readonly dbInfo: DatabaseInfo
  /** Name for the generated schema */
  readonly schemaName: string
  /** Additional generation options */
  readonly options?: GenerateOptions
}

// -----------------------------------------------------------------------------
// Transform Mappings
// -----------------------------------------------------------------------------

/** Available transforms for each property type */
export const PROPERTY_TRANSFORMS: Record<NotionPropertyType, readonly string[]> = {
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
export const DEFAULT_TRANSFORMS: Record<NotionPropertyType, string> = {
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

/** Property type to transform namespace mapping (read) */
export const PROPERTY_TRANSFORM_NAMESPACES: Partial<Record<NotionPropertyType, string>> = {
  title: 'Title',
  rich_text: 'RichTextProp',
  number: 'Num',
  select: 'Select',
  multi_select: 'MultiSelect',
  status: 'Status',
  date: 'DateProp',
  people: 'People',
  files: 'Files',
  checkbox: 'Checkbox',
  url: 'Url',
  email: 'Email',
  phone_number: 'PhoneNumber',
  formula: 'Formula',
  relation: 'Relation',
  created_time: 'CreatedTime',
  created_by: 'CreatedBy',
  last_edited_time: 'LastEditedTime',
  last_edited_by: 'LastEditedBy',
  unique_id: 'UniqueId',
}

/** Property type to write transform method mapping */
const WRITE_TRANSFORM_METHODS: Partial<Record<NotionPropertyType, string>> = {
  title: 'fromString',
  rich_text: 'fromString',
  number: 'fromNumber',
  select: 'fromName',
  multi_select: 'fromNames',
  status: 'fromName',
  date: 'fromStart',
  people: 'fromIds',
  files: 'fromUrls',
  checkbox: 'fromBoolean',
  url: 'fromString',
  email: 'fromString',
  phone_number: 'fromString',
  relation: 'fromIds',
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
  const namespace = PROPERTY_TRANSFORM_NAMESPACES[property.type]
  if (!namespace) {
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

  return `${namespace}.${transform}`
}

/**
 * Generate the write schema field expression for a property
 */
const generateWritePropertyField = (property: PropertyInfo): string | null => {
  if (READ_ONLY_PROPERTIES.has(property.type)) {
    return null
  }

  const namespace = PROPERTY_TRANSFORM_NAMESPACES[property.type]
  const writeMethod = WRITE_TRANSFORM_METHODS[property.type]

  if (!namespace || !writeMethod) {
    return null
  }

  return `${namespace}.Write.${writeMethod}`
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
): { typeName: string; code: string } | null => {
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
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((o) => sanitizeLiteralValue(o.name))
    .join(', ')

  const descPart = property.description
    ? `,\n  description: ${toSingleQuotedStringLiteral(property.description)},`
    : ''
  const code = `export const ${typeName} = Schema.Literal(${literals}).annotations({
  identifier: '${typeName}'${descPart}
})
export type ${typeName} = typeof ${typeName}.Type`

  return { typeName, code }
}

const parseGenerateOptions = (
  options: GenerateOptions | undefined,
): Required<Pick<GenerateOptions, 'includeWrite' | 'typedOptions' | 'includeApi'>> & {
  transforms: PropertyTransformConfig
  generatorVersion?: string
  schemaNameOverride?: string
} => {
  if (!options) {
    return {
      includeWrite: false,
      typedOptions: false,
      includeApi: false,
      transforms: {},
    }
  }

  return {
    includeWrite: options.includeWrite ?? false,
    typedOptions: options.typedOptions ?? false,
    includeApi: options.includeApi ?? false,
    transforms: options.transforms ?? {},
    ...(options.generatorVersion !== undefined
      ? { generatorVersion: options.generatorVersion }
      : {}),
    ...(options.schemaNameOverride !== undefined
      ? { schemaNameOverride: options.schemaNameOverride }
      : {}),
  }
}

/**
 * Format a value for the config comment line.
 * Uses unquoted keys where possible for readability.
 */
const formatConfigValue = (value: unknown): string => {
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value)
  }
  if (typeof value === 'string') {
    // Quote strings that need it (contain spaces, special chars, etc.)
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
      return value
    }
    return JSON.stringify(value)
  }
  if (typeof value === 'object' && value !== null) {
    if (Array.isArray(value)) {
      return `[${value.map(formatConfigValue).join(', ')}]`
    }
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => {
        const key = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k) ? k : JSON.stringify(k)
        return `${key}: ${formatConfigValue(v)}`
      })
    return `{ ${entries.join(', ')} }`
  }
  return String(value)
}

/**
 * Generate the @config comment line with generation options.
 */
const generateConfigComment = (options: {
  includeWrite: boolean
  typedOptions: boolean
  includeApi: boolean
  transforms: PropertyTransformConfig
  schemaNameOverride: string | undefined
}): string => {
  const config: Record<string, unknown> = {}

  if (options.schemaNameOverride !== undefined) {
    config.name = options.schemaNameOverride
  }
  if (options.includeWrite) {
    config.includeWrite = true
  }
  if (options.typedOptions) {
    config.typedOptions = true
  }
  if (options.includeApi) {
    config.includeApi = true
  }
  if (Object.keys(options.transforms).length > 0) {
    config.transforms = options.transforms
  }

  if (Object.keys(config).length === 0) {
    return ''
  }

  return `// @config ${formatConfigValue(config)}`
}

// -----------------------------------------------------------------------------
// Main Code Generation
// -----------------------------------------------------------------------------

/**
 * Generate TypeScript code for an Effect schema from database info.
 */
// oxlint-disable-next-line eslint(func-style), eslint(max-params) -- public API with established signature
export function generateSchemaCode(
  dbInfo: DatabaseInfo,
  schemaName: string,
  options?: GenerateOptions,
): string {
  const { includeWrite, typedOptions, transforms, generatorVersion, schemaNameOverride } =
    parseGenerateOptions(options)

  const pascalName = toTopLevelIdentifier(schemaName)

  // Collect required imports (transform namespaces only - write schemas are nested)
  const requiredNamespaces = new Set<string>()

  for (const prop of dbInfo.properties) {
    const namespace = PROPERTY_TRANSFORM_NAMESPACES[prop.type]
    if (namespace) {
      requiredNamespaces.add(namespace)
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
  const sortedImports = Array.from(requiredNamespaces).toSorted()

  // Generate read property fields
  const readPropertyFields = dbInfo.properties
    .map((prop) => {
      const key = sanitizePropertyKey(prop.name)
      const field = generatePropertyField(prop, transforms)
      // Add JSDoc comment if description is available
      const jsdoc = prop.description ? `  /** ${sanitizeLineComment(prop.description)} */\n` : ''
      return `${jsdoc}  ${key}: ${field},`
    })
    .join('\n')

  // Generate write property fields (excluding read-only)
  const writePropertyFields = includeWrite
    ? dbInfo.properties
        .map((prop) => {
          const writeField = generateWritePropertyField(prop)
          if (!writeField) return null
          const key = sanitizePropertyKey(prop.name)
          // Add JSDoc comment if description is available
          const jsdoc = prop.description
            ? `  /** ${sanitizeLineComment(prop.description)} */\n`
            : ''
          return `${jsdoc}  ${key}: ${writeField},`
        })
        .filter(Boolean)
        .join('\n')
    : ''

  // Build the config comment
  const configComment = generateConfigComment({
    includeWrite,
    typedOptions,
    includeApi: options?.includeApi ?? false,
    transforms,
    schemaNameOverride,
  })

  // Build the code
  const lines: string[] = [
    `// Generated by notion-effect-schema-gen${generatorVersion ? ` v${generatorVersion}` : ''}`,
    `// Database: ${dbInfo.name}`,
    `// ID: ${dbInfo.id}`,
    `// URL: ${dbInfo.url}`,
    ...(configComment ? [configComment] : []),
    ``,
    `import { Schema } from 'effect'`,
  ]

  if (sortedImports.length > 0) {
    lines.push(`import {`)
    for (const imp of sortedImports) {
      lines.push(`  ${imp},`)
    }
    lines.push(`} from '@overeng/notion-effect-schema'`)
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
  lines.push(`}).annotations({`)
  lines.push(`  identifier: '${pascalName}PageProperties',`)
  lines.push(`  description: 'Read schema for ${dbInfo.name} database pages',`)
  lines.push(`})`)
  lines.push(``)
  lines.push(`export type ${pascalName}PageProperties = typeof ${pascalName}PageProperties.Type`)

  // Runtime validation helpers for read schema
  lines.push(``)
  lines.push(`/**`)
  lines.push(` * Decode properties from unknown data (throws on failure).`)
  lines.push(` */`)
  lines.push(
    `export const decode${pascalName}Properties = Schema.decodeUnknownSync(${pascalName}PageProperties)`,
  )
  lines.push(``)
  lines.push(`/**`)
  lines.push(` * Decode properties from unknown data (returns Effect).`)
  lines.push(` */`)
  lines.push(
    `export const decode${pascalName}PropertiesEffect = Schema.decodeUnknown(${pascalName}PageProperties)`,
  )

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
    lines.push(`}).annotations({`)
    lines.push(`  identifier: '${pascalName}PageWrite',`)
    lines.push(`  description: 'Write schema for ${dbInfo.name} database pages',`)
    lines.push(`})`)
    lines.push(``)
    lines.push(`export type ${pascalName}PageWrite = typeof ${pascalName}PageWrite.Type`)

    // Runtime validation helpers for write schema
    lines.push(``)
    lines.push(`/**`)
    lines.push(` * Decode write data from simple types (throws on failure).`)
    lines.push(` */`)
    lines.push(
      `export const decode${pascalName}Write = Schema.decodeUnknownSync(${pascalName}PageWrite)`,
    )
    lines.push(``)
    lines.push(`/**`)
    lines.push(` * Decode write data from simple types (returns Effect).`)
    lines.push(` */`)
    lines.push(
      `export const decode${pascalName}WriteEffect = Schema.decodeUnknown(${pascalName}PageWrite)`,
    )
    lines.push(``)
    lines.push(`/**`)
    lines.push(` * Encode write data back to simple types (throws on failure).`)
    lines.push(` */`)
    lines.push(`export const encode${pascalName}Write = Schema.encodeSync(${pascalName}PageWrite)`)
    lines.push(``)
    lines.push(`/**`)
    lines.push(` * Encode write data back to simple types (returns Effect).`)
    lines.push(` */`)
    lines.push(
      `export const encode${pascalName}WriteEffect = Schema.encode(${pascalName}PageWrite)`,
    )
  }

  lines.push(``)

  return lines.join('\n')
}

/** Get available transforms for a property type */
export const getAvailableTransforms = (propertyType: string): readonly string[] => {
  const isNotionPropertyType = (u: string): u is NotionPropertyType =>
    Object.hasOwn(PROPERTY_TRANSFORMS, u)

  if (isNotionPropertyType(propertyType)) {
    return PROPERTY_TRANSFORMS[propertyType]
  }
  return ['raw']
}

/** Get the default transform for a property type */
export const getDefaultTransform = (propertyType: string): string => {
  const isNotionPropertyType = (u: string): u is NotionPropertyType =>
    Object.hasOwn(DEFAULT_TRANSFORMS, u)

  if (isNotionPropertyType(propertyType)) {
    return DEFAULT_TRANSFORMS[propertyType]
  }
  return 'raw'
}

/** Check if a property type is read-only */
export const isReadOnlyProperty = (propertyType: string): boolean =>
  READ_ONLY_PROPERTIES.has(propertyType)

// -----------------------------------------------------------------------------
// API Code Generation
// -----------------------------------------------------------------------------

/**
 * Generate TypeScript code for a typed database API wrapper.
 *
 * This generates functions like `query`, `get`, `create`, `update` that
 * have the database ID and schema baked in.
 */
// oxlint-disable-next-line eslint(func-style), eslint(max-params) -- public API with established signature
export function generateApiCode(
  dbInfo: DatabaseInfo,
  schemaName: string,
  options?: GenerateOptions,
): string {
  const { includeWrite, typedOptions, transforms, generatorVersion, schemaNameOverride } =
    parseGenerateOptions(options)

  const pascalName = toTopLevelIdentifier(schemaName)
  const schemaFileName = `./${pascalName.charAt(0).toLowerCase()}${pascalName.slice(1)}.ts`

  // Build the config comment (same options as schema file, always includes includeApi: true)
  const configComment = generateConfigComment({
    includeWrite,
    typedOptions,
    includeApi: true,
    transforms,
    schemaNameOverride,
  })

  const lines: string[] = [
    `// Generated by notion-effect-schema-gen${generatorVersion ? ` v${generatorVersion}` : ''}`,
    `// Database API wrapper for: ${dbInfo.name}`,
    `// ID: ${dbInfo.id}`,
    `// URL: ${dbInfo.url}`,
    ...(configComment ? [configComment] : []),
    ``,
    `import { NotionDatabases, NotionPages, type TypedPage } from '@overeng/notion-effect-client'`,
    `import { Stream } from 'effect'`,
    `import { ${pascalName}PageProperties${includeWrite ? `, ${pascalName}PageWrite, encode${pascalName}Write` : ''} } from '${schemaFileName}'`,
    ``,
    `/** Database ID for ${dbInfo.name} */`,
    `const DATABASE_ID = '${dbInfo.id}'`,
    ``,
    `// -----------------------------------------------------------------------------`,
    `// Query`,
    `// -----------------------------------------------------------------------------`,
    ``,
    `/** Query options */`,
    `export interface QueryOptions {`,
    `  readonly filter?: Record<string, unknown>`,
    `  readonly sorts?: ReadonlyArray<{`,
    `    readonly property?: string`,
    `    readonly timestamp?: 'created_time' | 'last_edited_time'`,
    `    readonly direction: 'ascending' | 'descending'`,
    `  }>`,
    `  readonly pageSize?: number`,
    `}`,
    ``,
    `/**`,
    ` * Query pages from the ${dbInfo.name} database.`,
    ` *`,
    ` * Returns a stream of typed pages with automatic pagination.`,
    ` */`,
    `export const query = (options?: QueryOptions) =>`,
    `  NotionDatabases.queryStream({`,
    `    databaseId: DATABASE_ID,`,
    `    schema: ${pascalName}PageProperties,`,
    `    ...options,`,
    `  })`,
    ``,
    `/**`,
    ` * Query pages and collect all results.`,
    ` */`,
    `export const queryAll = (options?: QueryOptions) =>`,
    `  query(options).pipe(Stream.runCollect)`,
    ``,
    `// -----------------------------------------------------------------------------`,
    `// Get`,
    `// -----------------------------------------------------------------------------`,
    ``,
    `/**`,
    ` * Get a single page by ID.`,
    ` */`,
    `export const get = (pageId: string) =>`,
    `  NotionPages.retrieve({`,
    `    pageId,`,
    `    schema: ${pascalName}PageProperties,`,
    `  })`,
    ``,
    `export type ${pascalName}Page = TypedPage<typeof ${pascalName}PageProperties.Type>`,
  ]

  // Add create/update if write schema is enabled
  if (includeWrite) {
    lines.push(``)
    lines.push(`// -----------------------------------------------------------------------------`)
    lines.push(`// Create`)
    lines.push(`// -----------------------------------------------------------------------------`)
    lines.push(``)
    lines.push(`/**`)
    lines.push(` * Create a new page in the ${dbInfo.name} database.`)
    lines.push(` */`)
    lines.push(`export const create = (properties: typeof ${pascalName}PageWrite.Type) =>`)
    lines.push(`  NotionPages.create({`)
    lines.push(`    parent: { type: 'database_id', database_id: DATABASE_ID },`)
    lines.push(`    properties: encode${pascalName}Write(properties),`)
    lines.push(`  })`)
    lines.push(``)
    lines.push(`// -----------------------------------------------------------------------------`)
    lines.push(`// Update`)
    lines.push(`// -----------------------------------------------------------------------------`)
    lines.push(``)
    lines.push(`/**`)
    lines.push(` * Update an existing page.`)
    lines.push(` */`)
    lines.push(`export const update = (`)
    lines.push(`  pageId: string,`)
    lines.push(`  properties: Partial<typeof ${pascalName}PageWrite.Type>,`)
    lines.push(`) =>`)
    lines.push(`  NotionPages.update({`)
    lines.push(`    pageId,`)
    lines.push(
      `    properties: encode${pascalName}Write(properties as typeof ${pascalName}PageWrite.Type),`,
    )
    lines.push(`  })`)
  }

  lines.push(``)
  lines.push(`// -----------------------------------------------------------------------------`)
  lines.push(`// Archive`)
  lines.push(`// -----------------------------------------------------------------------------`)
  lines.push(``)
  lines.push(`/**`)
  lines.push(` * Archive (soft-delete) a page.`)
  lines.push(` */`)
  lines.push(`export const archive = (pageId: string) =>`)
  lines.push(`  NotionPages.archive({ pageId })`)
  lines.push(``)

  return lines.join('\n')
}
