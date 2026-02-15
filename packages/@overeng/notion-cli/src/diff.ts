import { DEFAULT_TRANSFORMS, NOTION_SCHEMA_TRANSFORM_KEYS } from './codegen.ts'
import type { DatabaseInfo, NotionPropertyType } from './introspect.ts'

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Parsed property from a generated schema file */
export interface ParsedProperty {
  readonly name: string
  readonly transformKey: string
}

/** Parsed schema information from a generated file */
export interface ParsedSchema {
  readonly databaseId: string | undefined
  readonly databaseName: string | undefined
  readonly properties: readonly ParsedProperty[]
  readonly readSchemaFound: boolean
}

/** A single property difference */
export interface PropertyDiff {
  readonly name: string
  readonly type: 'added' | 'removed' | 'type_changed'
  readonly live?: {
    readonly type: NotionPropertyType
    readonly transform: string
  }
  readonly generated?: { readonly transformKey: string }
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

/** Map NotionSchema transform keys back to property types (derived from codegen mappings) */
const TRANSFORM_KEY_TO_TYPE: Record<string, NotionPropertyType> = Object.fromEntries(
  Object.entries(NOTION_SCHEMA_TRANSFORM_KEYS).flatMap(([propertyType, transforms]) =>
    transforms !== undefined ? Object.values(transforms).map((key) => [key, propertyType]) : [],
  ),
) as Record<string, NotionPropertyType>

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
  let readSchemaFound = false

  // Extract database ID from header comment
  for (const line of lines) {
    const idMatch = line.match(/^\/\/\s*ID:\s*(.+)$/)
    if (idMatch?.[1] !== undefined) {
      databaseId = idMatch[1].trim()
    }
    const nameMatch = line.match(/^\/\/\s*Database:\s*(.+)$/)
    if (nameMatch?.[1] !== undefined) {
      databaseName = nameMatch[1].trim()
    }
  }

  // Find the Read Schema section and extract properties
  let inReadSchema = false
  let braceDepth = 0
  let hasOpened = false

  for (const line of lines) {
    // Look for the start of the read schema struct
    if (inReadSchema === false && /PageProperties\s*=\s*Schema\.Struct\s*\(/.test(line) === true) {
      inReadSchema = true
      braceDepth = 0
      hasOpened = false
    }

    if (inReadSchema === true) {
      // Track brace depth
      for (const char of line) {
        if (char === '{') braceDepth++
        if (char === '}') braceDepth--
      }

      if (hasOpened === false && braceDepth > 0) {
        hasOpened = true
        readSchemaFound = true
      }

      // Stop when we close the struct
      if (hasOpened === true && braceDepth === 0) {
        inReadSchema = false
        break
      }

      // Parse property line
      // Matches: PropertyName: NotionSchema.transformKey,
      // Or: 'Property Name': NotionSchema.transformKey,
      if (hasOpened === false) {
        continue
      }

      const propMatch = line.match(
        /^\s*(?:'([^']+)'|"([^"]+)"|([a-zA-Z_$][a-zA-Z0-9_$]*))\s*:\s*NotionSchema\.([a-zA-Z0-9_]+)(?:\([^)]*\))?(?:\.pipe\(([^)]*)\))?\s*,/,
      )
      if (propMatch !== null) {
        const name = propMatch[1] ?? propMatch[2] ?? propMatch[3]
        const baseKey = propMatch[4]
        const pipeContent = propMatch[5]
        if (name !== undefined && baseKey !== undefined) {
          let transformKey = baseKey
          if (pipeContent?.includes('NotionSchema.asName') === true) {
            transformKey = `${baseKey}.asName`
          } else if (pipeContent?.includes('NotionSchema.asNames') === true) {
            transformKey = `${baseKey}.asNames`
          } else if (pipeContent?.includes('NotionSchema.asNullable') === true) {
            transformKey = `${baseKey}.asNullable`
          }
          properties.push({ name, transformKey })
        }
      }
    }
  }

  return { databaseId, databaseName, properties, readSchemaFound }
}

/** Options for computing the diff between live and generated schemas. */
export interface ComputeDiffOptions {
  readonly live: DatabaseInfo
  readonly generated: ParsedSchema
}

/**
 * Compute the diff between live database schema and a parsed generated file.
 */
export const computeDiff = ({ live, generated }: ComputeDiffOptions): DiffResult => {
  const databaseIdMatch = generated.databaseId === live.id

  const propertyDiffs: PropertyDiff[] = []
  const optionsDiffs: OptionsDiff[] = []

  // Create lookup maps
  const liveByName = new Map(live.properties.map((p) => [p.name, p]))
  const generatedByName = new Map(generated.properties.map((p) => [p.name, p]))

  // Check for added properties (in live but not in generated)
  for (const liveProp of live.properties) {
    const genProp = generatedByName.get(liveProp.name)
    if (genProp === undefined) {
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
    if (liveProp === undefined) {
      propertyDiffs.push({
        name: genProp.name,
        type: 'removed',
        generated: { transformKey: genProp.transformKey },
      })
    }
  }

  // Check for changed properties
  for (const liveProp of live.properties) {
    const genProp = generatedByName.get(liveProp.name)
    if (genProp === undefined) continue

    const liveType = TRANSFORM_KEY_TO_TYPE[genProp.transformKey]

    // Type changed
    if (liveType !== undefined && liveType !== liveProp.type) {
      const expectedTransform = DEFAULT_TRANSFORMS[liveProp.type] ?? 'raw'
      propertyDiffs.push({
        name: liveProp.name,
        type: 'type_changed',
        live: { type: liveProp.type, transform: expectedTransform },
        generated: { transformKey: genProp.transformKey },
      })
    }

    // Note: Options comparison is not implemented yet as it would require
    // parsing the typed options from the generated file.
  }

  return {
    databaseIdMatch,
    properties: propertyDiffs,
    options: optionsDiffs,
  }
}

/** Options for formatting a diff result as human-readable output. */
export interface FormatDiffOptions {
  readonly diff: DiffResult
  readonly databaseId: string
  readonly filePath: string
}

/**
 * Format a diff result as human-readable output lines.
 */
export const formatDiff = ({ diff, databaseId, filePath }: FormatDiffOptions): string[] => {
  const lines: string[] = []

  lines.push(`Comparing database ${databaseId} with ${filePath}`)
  lines.push('')

  if (diff.databaseIdMatch === true) {
    lines.push('Database ID matches')
  } else {
    lines.push('WARNING: Database ID does not match!')
  }

  const hasChanges =
    diff.databaseIdMatch === false || diff.properties.length > 0 || diff.options.length > 0

  if (hasChanges === false) {
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

  if (diff.databaseIdMatch === false) {
    lines.push('  ! database ID mismatch')
  }

  for (const prop of added) {
    lines.push(`  + ${prop.name} (${prop.live?.type}) - new property in Notion`)
  }

  for (const prop of removed) {
    const type = TRANSFORM_KEY_TO_TYPE[prop.generated?.transformKey ?? ''] ?? 'unknown'
    lines.push(`  - ${prop.name} (${type}) - removed from Notion`)
  }

  for (const prop of typeChanged) {
    const oldType = TRANSFORM_KEY_TO_TYPE[prop.generated?.transformKey ?? ''] ?? 'unknown'
    lines.push(`  ~ ${prop.name}: type changed (${oldType} -> ${prop.live?.type})`)
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
  if (diff.databaseIdMatch === false) counts.push('database id mismatch')
  if (added.length > 0) counts.push(`${added.length} added`)
  if (removed.length > 0) counts.push(`${removed.length} removed`)
  if (typeChanged.length > 0) counts.push(`${typeChanged.length} type changed`)
  if (diff.options.length > 0) counts.push(`${diff.options.length} options changed`)
  lines.push(`Summary: ${counts.join(', ')}`)

  return lines
}

/**
 * Check if the diff result has any differences.
 */
export const hasDifferences = (diff: DiffResult): boolean =>
  !diff.databaseIdMatch || diff.properties.length > 0 || diff.options.length > 0
