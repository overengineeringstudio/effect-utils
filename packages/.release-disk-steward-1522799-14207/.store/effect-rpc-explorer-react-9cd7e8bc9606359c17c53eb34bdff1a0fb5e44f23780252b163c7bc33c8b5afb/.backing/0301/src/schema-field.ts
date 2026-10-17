/** Inert JSON Schema metadata lookup; never decodes captured values. */
export { schemaFieldMetadata, schemaFieldTitle, schemaObject, schemaProperties, schemaText }
export type { SchemaFieldMetadata, SchemaObject }

type SchemaObject = Readonly<Record<string, unknown>>
interface SchemaFieldMetadata {
  readonly title: string | undefined
  readonly description: string | undefined
  readonly examples: ReadonlyArray<unknown>
  readonly required: boolean | undefined
}

const schemaObject = (value: unknown): SchemaObject | undefined =>
  value !== null && typeof value === 'object' && Array.isArray(value) === false
    ? (value as SchemaObject)
    : undefined

const schemaText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const schemaProperties = (schema: SchemaObject): ReadonlyArray<readonly [string, SchemaObject]> =>
  Object.entries(schemaObject(schema.properties) ?? {}).flatMap(([key, value]) => {
    const field = schemaObject(value)
    return field === undefined ? [] : [[key, field] as const]
  })

const schemaFieldMetadata = ({
  document,
  path,
}: {
  document: unknown
  path: ReadonlyArray<string>
}): SchemaFieldMetadata | undefined => {
  const root = schemaObject(document)
  if (root === undefined) return undefined
  const definitions = schemaObject(root.$defs)
  const resolve = (schema: SchemaObject | undefined): SchemaObject | undefined => {
    const reference = schemaText(schema?.$ref)
    return reference?.startsWith('#/$defs/') === true
      ? (schemaObject(definitions?.[reference.slice('#/$defs/'.length)]) ?? schema)
      : schema
  }
  let current = resolve(schemaObject(root.schema) ?? root)
  let required: boolean | undefined
  for (const segment of path) {
    if (current === undefined) return undefined
    const property = schemaObject(schemaObject(current.properties)?.[segment])
    required =
      property === undefined
        ? undefined
        : Array.isArray(current.required) === true && current.required.includes(segment)
    current = resolve(
      property ??
        (Array.isArray(current.items) === false ? schemaObject(current.items) : undefined),
    )
  }
  if (current === undefined) return undefined
  return {
    title: schemaText(current.title),
    description: schemaText(current.description),
    examples: Array.isArray(current.examples) === true ? current.examples : [],
    required,
  }
}

const schemaFieldTitle = (args: {
  document: unknown
  path: ReadonlyArray<string>
}): string | undefined => schemaFieldMetadata(args)?.title
