import { Effect, Schema, SchemaAST, SchemaIssue, SchemaParser, SchemaTransformation } from 'effect'

import { lower } from '../compiler/lower.ts'
import { tagKeys } from './discriminator.ts'
import { canonicalJson, parseJson } from './json.ts'
import { isTimestampAST, validTimestampMillis } from './timestamp.ts'
import { decode as decodeSchema, encode as encodeSchema, prepare } from './validation.ts'

export { canonicalJson, parseJson, JsonError } from './json.ts'
export { tagKeys } from './discriminator.ts'

/** Derives only admitted leaves; metadata never makes an arbitrary transformation portable. */
export const valueCodec = <TSchema extends Schema.ConstraintCodec<unknown>>(
  schema: TSchema,
): Schema.Codec<TSchema['Type'], unknown> => {
  lower({ Value: schema }, 'contract-json')
  const seen = new Map<SchemaAST.AST, SchemaAST.AST>()
  const visit = (ast: SchemaAST.AST): SchemaAST.AST => {
    const cached = seen.get(ast)
    if (cached !== undefined) return cached
    let output = ast
    if (ast._tag === 'BigInt') {
      output = Schema.make<Schema.Codec<string>>(
        withKeyContext({
          ast: Schema.String.check(
            Schema.makeFilter<string>((value) => /^(0|-?[1-9][0-9]*)$/.test(value), {
              expected: 'canonical decimal integer',
            }),
          ).ast,
          context: ast.context,
        }),
      ).pipe(Schema.decodeTo(Schema.BigIntFromString), Schema.decodeTo(Schema.make(ast))).ast
    } else if (isTimestampAST(ast) === true) {
      output = Schema.make<Schema.Codec<string>>(
        withKeyContext({
          ast: Schema.String.check(
            Schema.makeFilter(validTimestampMillis, {
              expected: 'RFC3339 with explicit offset and exact millisecond precision',
            }),
          ).ast,
          context: ast.context,
        }),
      ).pipe(Schema.decodeTo(Schema.DateTimeUtcFromString), Schema.decodeTo(Schema.make(ast))).ast
    } else if (ast._tag === 'Suspend') {
      // Keep suspension lazy so recursive ASTs do not expand during derivation.
      output = new SchemaAST.Suspend(
        () => visit(ast.thunk()),
        ast.annotations,
        ast.checks,
        ast.encoding,
        ast.context,
      )
    } else if (ast._tag === 'Arrays') {
      output = new SchemaAST.Arrays(
        ast.isMutable,
        ast.elements.map(visit),
        ast.rest.map(visit),
        ast.annotations,
        ast.checks,
        ast.encoding,
        ast.context,
        ast.encodingChecks,
      )
    } else if (ast._tag === 'Objects') {
      output = new SchemaAST.Objects(
        ast.propertySignatures.map(
          (field) => new SchemaAST.PropertySignature(field.name, visit(field.type)),
        ),
        ast.indexSignatures.map(
          (field) => new SchemaAST.IndexSignature(visit(field.parameter), visit(field.type)),
        ),
        ast.annotations,
        ast.checks,
        ast.encoding,
        ast.context,
        ast.encodingChecks,
      )
    } else if (ast._tag === 'Union') {
      output = new SchemaAST.Union(
        ast.types.map(visit),
        ast.options,
        ast.annotations,
        ast.checks,
        ast.encoding,
        ast.context,
        ast.encodingChecks,
      )
    }
    // Public key combinators restore optional/mutable contexts through encoding links.
    // Constructor defaults on these transformed leaves have already been rejected by lower.
    if (ast._tag === 'BigInt' || isTimestampAST(ast) === true)
      output = withKeyContext({ ast: output, context: ast.context })
    seen.set(ast, output)
    return output
  }
  // Every replacement keeps the authored Type and its checks; only Encoded changes.
  return Schema.make<Schema.Codec<TSchema['Type'], unknown>>(visit(schema.ast))
}

const withKeyContext = ({
  ast,
  context,
}: {
  ast: SchemaAST.AST
  context: SchemaAST.Context | undefined
}): SchemaAST.AST => {
  if (context === undefined) return ast
  let contextual = Schema.make<Schema.Top>(ast)
  if (context.isOptional === true) contextual = Schema.optionalKey(contextual)
  if (context.isMutable === true) contextual = Schema.mutableKey(contextual)
  if (context.annotations !== undefined) contextual = contextual.annotateKey(context.annotations)
  return contextual.ast
}

/** Omit undefined only for optional object properties, after successful schema encoding. */
const omitOptionalUndefined = ({
  ast,
  value,
  depth = 0,
}: {
  ast: SchemaAST.AST
  value: unknown
  depth?: number
}): unknown => {
  if (depth > 128) return value
  if (ast._tag === 'Suspend') return omitOptionalUndefined({ ast: ast.thunk(), value, depth })
  if (ast._tag === 'Union') {
    const member = ast.types.find((candidate) => Schema.is(Schema.make(candidate))(value))
    return member === undefined ? value : omitOptionalUndefined({ ast: member, value, depth })
  }
  if (
    ast._tag === 'Arrays' &&
    Array.isArray(value) === true &&
    ast.elements.length === 0 &&
    ast.rest.length === 1
  )
    return value.map((item) =>
      omitOptionalUndefined({ ast: ast.rest[0]!, value: item, depth: depth + 1 }),
    )
  if (
    ast._tag !== 'Objects' ||
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) === true
  )
    return value
  const fields = new Map(ast.propertySignatures.map((field) => [String(field.name), field.type]))
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const field = fields.get(key)
    if (item === undefined && field !== undefined && SchemaAST.isOptional(field) === true) continue
    const target =
      field ??
      ast.indexSignatures.find((signature) => Schema.is(Schema.make(signature.parameter))(key))
        ?.type
    Object.defineProperty(output, key, {
      value:
        target === undefined
          ? item
          : omitOptionalUndefined({ ast: target, value: item, depth: depth + 1 }),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return output
}

const jsonEffect = <TValue>(run: () => TValue): Effect.Effect<TValue, SchemaIssue.Issue> =>
  Effect.try({
    try: run,
    catch: (cause) =>
      new SchemaIssue.InvalidValue({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  })

/** Ordinary Effect string codec, preserving the exact authored domain type. */
export const codec = <TSchema extends Schema.ConstraintCodec<unknown>>(
  schema: TSchema,
): Schema.Codec<TSchema['Type'], string> => {
  const values = valueCodec(schema)
  const decodeValue = SchemaParser.decodeUnknownEffect(values, { onExcessProperty: 'error' })
  const encodeValue = SchemaParser.encodeUnknownEffect(values, { onExcessProperty: 'error' })
  const encodedAST = SchemaAST.toEncoded(values.ast)
  const keys = tagKeys(schema.ast)
  const domain = Schema.declare<TSchema['Type']>(Schema.is(Schema.toType(schema)))
  return Schema.String.pipe(
    Schema.decodeTo(
      domain,
      SchemaTransformation.transformEffect({
        decode: (text) =>
          Effect.flatMap(
            jsonEffect(() => parseJson(text)),
            (input) => decodeValue(prepare({ ast: values.ast, input })),
          ),
        encode: (value) =>
          Effect.flatMap(
            encodeValue(prepare({ ast: SchemaAST.toType(values.ast), input: value })),
            (encoded) =>
              jsonEffect(() =>
                canonicalJson(omitOptionalUndefined({ ast: encodedAST, value: encoded }), keys),
              ),
          ),
      }),
    ),
  )
}

/** Strict decoded JSON value boundary, for host bridges that already parse JSON. */
export const decodeValue = <TSchema extends Schema.ConstraintCodec<unknown>>(schema: TSchema) =>
  decodeSchema(valueCodec(schema))

/** Strict encoded JSON value boundary, with schema-aware optional undefined omission. */
export const encodeValue = <TSchema extends Schema.ConstraintCodec<unknown>>(schema: TSchema) => {
  const values = valueCodec(schema)
  const encoder = encodeSchema(values)
  const encodedAST = SchemaAST.toEncoded(values.ast)
  return (value: TSchema['Type']): unknown =>
    omitOptionalUndefined({ ast: encodedAST, value: encoder(value) })
}

/** Synchronous convenience using the same ordinary Effect codec. */
export const decode = <TSchema extends Schema.ConstraintCodec<unknown>>(schema: TSchema) =>
  Schema.decodeUnknownSync(codec(schema))
/** Synchronous canonical output using the same ordinary Effect codec. */
export const encode = <TSchema extends Schema.ConstraintCodec<unknown>>(schema: TSchema) =>
  Schema.encodeSync(codec(schema))
