import type { Schema, SchemaAST } from 'effect'

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Preserve native checks rather than lowering through JSON Schema: Effect's
 * JSON projection can weaken UTF-16 length bounds and omit regexp flags.
 * Unsupported checks fail generation instead of silently weakening the authority.
 */
const compileCheck = (check: SchemaAST.Check<unknown>): string => {
  if (check._tag === 'FilterGroup') return check.checks.map(compileCheck).join(' && ')
  const representation = check.annotations?.representation
  if (!isObject(representation)) throw new Error('Validator check has no representation')
  const { id, payload } = representation
  if (id === 'effect/schema/isFinite') return 'Number.isFinite(v)'
  if (id === 'effect/schema/isInt') return 'Number.isInteger(v)'
  if (!isObject(payload)) throw new Error(`Unsupported validator check: ${id}`)
  if (id === 'effect/schema/isPattern' && typeof payload.source === 'string' && typeof payload.flags === 'string')
    return `${new RegExp(payload.source, payload.flags).toString()}.test(v)`
  if (id === 'effect/schema/isMinLength' && typeof payload.minLength === 'number') return `v.length >= ${payload.minLength}`
  if (id === 'effect/schema/isMaxLength' && typeof payload.maxLength === 'number') return `v.length <= ${payload.maxLength}`
  const bounds: Record<string, readonly [string, string]> = {
    'effect/schema/isGreaterThan': ['exclusiveMinimum', '>'],
    'effect/schema/isGreaterThanOrEqualTo': ['minimum', '>='],
    'effect/schema/isLessThan': ['exclusiveMaximum', '<'],
    'effect/schema/isLessThanOrEqualTo': ['maximum', '<='],
  }
  const bound = typeof id === 'string' ? bounds[id] : undefined
  if (bound !== undefined && typeof payload[bound[0]] === 'number') return `v ${bound[1]} ${payload[bound[0]]}`
  if (id === 'effect/schema/isBetween' && typeof payload.minimum === 'number' && typeof payload.maximum === 'number')
    return `v >= ${payload.minimum} && v <= ${payload.maximum}`
  throw new Error(`Unsupported validator check: ${id}`)
}

const compileValidator = (ast: SchemaAST.AST): string => {
  if (ast.encoding !== undefined) throw new Error(`Unsupported validator transformation: ${ast._tag}`)
  let predicate: string
  switch (ast._tag) {
    case 'String': predicate = "typeof v === 'string'"; break
    case 'Number': predicate = "typeof v === 'number' && Number.isFinite(v)"; break
    case 'Boolean': predicate = "typeof v === 'boolean'"; break
    case 'Null': predicate = 'v === null'; break
    case 'Undefined': predicate = 'v === undefined'; break
    case 'Unknown': predicate = 'true'; break
    case 'Literal':
      if (typeof ast.literal === 'bigint') throw new Error('Unsupported bigint JSON literal')
      predicate = `v === ${JSON.stringify(ast.literal)}`
      break
    case 'Union': {
      const members = ast.types.map((member) => `(${compileValidator(member)})(v)`)
      predicate = ast.options?.mode === 'oneOf'
        ? `[${members.join(', ')}].filter(Boolean).length === 1`
        : `(${members.join(' || ')})`
      break
    }
    case 'Arrays':
      if (ast.elements.length !== 0 || ast.rest.length !== 1) throw new Error('Unsupported validator tuple')
      predicate = `Array.isArray(v) && v.every(${compileValidator(ast.rest[0]!)})`
      break
    case 'Objects': {
      if (ast.indexSignatures.length > 1) throw new Error('Unsupported overlapping validator index signatures')
      const names = ast.propertySignatures.map(({ name }) => {
        if (typeof name === 'symbol') throw new Error('Unsupported symbol JSON property')
        return String(name)
      })
      const fields = ast.propertySignatures.map(({ name, type }) =>
        `(Object.hasOwn(v, ${JSON.stringify(String(name))}) ? (${compileValidator(type)})(v[${JSON.stringify(String(name))}]) : ${type.context?.isOptional === true})`)
      const index = ast.indexSignatures[0]
      const extra = index === undefined
        ? `Object.keys(v).every((k) => ${JSON.stringify(names)}.includes(k))`
        : `Object.entries(v).every(([k, value]) => ${JSON.stringify(names)}.includes(k) || ((${compileValidator(index.parameter)})(k) && (${compileValidator(index.type)})(value)))`
      predicate = `v !== null && typeof v === 'object' && !Array.isArray(v) && ${[...fields, extra].join(' && ')}`
      break
    }
    default: throw new Error(`Unsupported validator schema node: ${ast._tag}`)
  }
  const checks = ast.checks?.map(compileCheck) ?? []
  return `(v) => ${[predicate, ...checks].map((part) => `(${part})`).join(' && ')}`
}

/** Emits one strict, dependency-free JS declaration derived from an Effect record authority. */
export const renderJsonSchemaValidator = (name: string, schema: Schema.Constraint): string => {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) throw new Error(`Invalid validator declaration name: ${name}`)
  return `const ${name} = ${compileValidator(schema.ast)}`
}
