import type { DatabaseInfo, NotionPropertyType } from './introspect.ts'

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Parsed property from a generated schema file */
export interface ParsedProperty {
  readonly name: string
  readonly namespace: string
  readonly transform: string
}

/** Parsed schema information from a generated file */
export interface ParsedSchema {
  readonly databaseId: string | undefined
  readonly databaseName: string | undefined
  readonly properties: readonly ParsedProperty[]
}

/** A single property difference */
export interface PropertyDiff {
  readonly name: string
  readonly type: 'added' | 'removed' | 'type_changed' | 'transform_changed'
  readonly live?: { readonly type: NotionPropertyType; readonly transform: string }
  readonly generated?: { readonly namespace: string; readonly transform: string }
}

/** Options difference for select/multi_select/status properties */
export interface OptionsDiff {
  readonly name: string
  readonly added: readonly string[]
  readonly removed: readonly string[]
}

/** Complete diff result */
export interface DiffResult {
  readonly databaseIdMatch: boolean
  readonly properties: readonly PropertyDiff[]
  readonly options: readonly OptionsDiff[]
}

// -----------------------------------------------------------------------------
// Namespace Mappings
// -----------------------------------------------------------------------------

/** Map namespace names back to property types */
const NAMESPACE_TO_TYPE: Record<string, NotionPropertyType> = {
  Title: 'title',
  RichTextProp: 'rich_text',
  Num: 'number',
  Select: 'select',
  MultiSelect: 'multi_select',
  Status: 'status',
  DateProp: 'date',
  People: 'people',
  Files: 'files',
  Checkbox: 'checkbox',
  Url: 'url',
  Email: 'email',
  PhoneNumber: 'phone_number',
  Formula: 'formula',
  Relation: 'relation',
  CreatedTime: 'created_time',
  CreatedBy: 'created_by',
  LastEditedTime: 'last_edited_time',
  LastEditedBy: 'last_edited_by',
  UniqueId: 'unique_id',
}

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

// -----------------------------------------------------------------------------
// Parsing
// -----------------------------------------------------------------------------

/**
 * Parse a generated schema file to extract property information.
 */
export const parseGeneratedFile = (content: string): ParsedSchema => {
  const lines = content.split('\n')

  let databaseId: string | undefined
  let databaseName: string | undefined
  const properties: ParsedProperty[] = []

  // Extract database ID from header comment
  for (const line of lines) {
    const idMatch = line.match(/^\/\/\s*ID:\s*(.+)$/)
    if (idMatch?.[1]) {
      databaseId = idMatch[1].trim()
    }
    const nameMatch = line.match(/^\/\/\s*Database:\s*(.+)$/)
    if (nameMatch?.[1]) {
      databaseName = nameMatch[1].trim()
    }
  }

  // Find the Read Schema section and extract properties
  let inReadSchema = false
  let braceDepth = 0

  for (const line of lines) {
    // Look for the start of the read schema struct
    if (line.includes('PageProperties = Schema.Struct({')) {
      inReadSchema = true
      braceDepth = 1
      continue
    }

    if (inReadSchema) {
      // Track brace depth
      for (const char of line) {
        if (char === '{') braceDepth++
        if (char === '}') braceDepth--
      }

      // Stop when we close the struct
      if (braceDepth === 0) {
        inReadSchema = false
        break
      }

      // Parse property line
      // Matches: PropertyName: Namespace.transform,
      // Or: 'Property Name': Namespace.transform,
      const propMatch = line.match(
        /^\s*(?:'([^']+)'|"([^"]+)"|([a-zA-Z_$][a-zA-Z0-9_$]*))\s*:\s*([A-Za-z]+)\.([a-zA-Z]+)\s*,/,
      )
      if (propMatch) {
        const name = propMatch[1] ?? propMatch[2] ?? propMatch[3]
        const namespace = propMatch[4]
        const transform = propMatch[5]
        if (name && namespace && transform) {
          properties.push({ name, namespace, transform })
        }
      }
    }
  }

  return { databaseId, databaseName, properties }
}

/**
 * Compute the diff between live database schema and a parsed generated file.
 */
export const computeDiff = (live: DatabaseInfo, generated: ParsedSchema): DiffResult => {
  const databaseIdMatch = generated.databaseId === live.id

  const propertyDiffs: PropertyDiff[] = []
  const optionsDiffs: OptionsDiff[] = []

  // Create lookup maps
  const liveByName = new Map(live.properties.map((p) => [p.name, p]))
  const generatedByName = new Map(generated.properties.map((p) => [p.name, p]))

  // Check for added properties (in live but not in generated)
  for (const liveProp of live.properties) {
    const genProp = generatedByName.get(liveProp.name)
    if (!genProp) {
      const expectedTransform = DEFAULT_TRANSFORMS[liveProp.type] ?? 'raw'
      propertyDiffs.push({
        name: liveProp.name,
        type: 'added',
        live: { type: liveProp.type, transform: expectedTransform },
      })
    }
  }

  // Check for removed properties (in generated but not in live)
  for (const genProp of generated.properties) {
    const liveProp = liveByName.get(genProp.name)
    if (!liveProp) {
      propertyDiffs.push({
        name: genProp.name,
        type: 'removed',
        generated: { namespace: genProp.namespace, transform: genProp.transform },
      })
    }
  }

  // Check for changed properties
  for (const liveProp of live.properties) {
    const genProp = generatedByName.get(liveProp.name)
    if (!genProp) continue

    const liveType = NAMESPACE_TO_TYPE[genProp.namespace]

    // Type changed
    if (liveType && liveType !== liveProp.type) {
      const expectedTransform = DEFAULT_TRANSFORMS[liveProp.type] ?? 'raw'
      propertyDiffs.push({
        name: liveProp.name,
        type: 'type_changed',
        live: { type: liveProp.type, transform: expectedTransform },
        generated: { namespace: genProp.namespace, transform: genProp.transform },
      })
    }

    // Note: We don't flag transform changes since transforms are intentional choices
    // by the user. We could add this as an opt-in feature later.

    // Note: Options comparison is not implemented yet as it would require
    // parsing the typed options from the generated file.
  }

  return {
    databaseIdMatch,
    properties: propertyDiffs,
    options: optionsDiffs,
  }
}

/**
 * Format a diff result as human-readable output lines.
 */
export const formatDiff = (diff: DiffResult, databaseId: string, filePath: string): string[] => {
  const lines: string[] = []

  lines.push(`Comparing database ${databaseId} with ${filePath}`)
  lines.push('')

  if (diff.databaseIdMatch) {
    lines.push('Database ID matches')
  } else {
    lines.push('WARNING: Database ID does not match!')
  }

  const hasChanges = diff.properties.length > 0 || diff.options.length > 0

  if (!hasChanges) {
    lines.push('')
    lines.push('No differences found')
    return lines
  }

  lines.push('')
  lines.push('Changes detected:')

  // Group by change type
  const added = diff.properties.filter((p) => p.type === 'added')
  const removed = diff.properties.filter((p) => p.type === 'removed')
  const typeChanged = diff.properties.filter((p) => p.type === 'type_changed')
  const transformChanged = diff.properties.filter((p) => p.type === 'transform_changed')

  for (const prop of added) {
    lines.push(`  + ${prop.name} (${prop.live?.type}) - new property in Notion`)
  }

  for (const prop of removed) {
    const type = NAMESPACE_TO_TYPE[prop.generated?.namespace ?? ''] ?? 'unknown'
    lines.push(`  - ${prop.name} (${type}) - removed from Notion`)
  }

  for (const prop of typeChanged) {
    const oldType = NAMESPACE_TO_TYPE[prop.generated?.namespace ?? ''] ?? 'unknown'
    lines.push(`  ~ ${prop.name}: type changed (${oldType} -> ${prop.live?.type})`)
  }

  for (const prop of transformChanged) {
    lines.push(
      `  ~ ${prop.name}: transform changed (${prop.generated?.transform} -> ${prop.live?.transform})`,
    )
  }

  for (const opt of diff.options) {
    lines.push(`  ~ ${opt.name}: options changed`)
    for (const added of opt.added) {
      lines.push(`      + ${added}`)
    }
    for (const removed of opt.removed) {
      lines.push(`      - ${removed}`)
    }
  }

  lines.push('')
  const counts: string[] = []
  if (added.length > 0) counts.push(`${added.length} added`)
  if (removed.length > 0) counts.push(`${removed.length} removed`)
  if (typeChanged.length > 0) counts.push(`${typeChanged.length} type changed`)
  if (transformChanged.length > 0) counts.push(`${transformChanged.length} transform changed`)
  if (diff.options.length > 0) counts.push(`${diff.options.length} options changed`)
  lines.push(`Summary: ${counts.join(', ')}`)

  return lines
}

/**
 * Check if the diff result has any differences.
 */
export const hasDifferences = (diff: DiffResult): boolean =>
  diff.properties.length > 0 || diff.options.length > 0
