import { Schema, SchemaAST } from 'effect'

import { lower } from '../compiler/lower.ts'
import { scalarString } from './json.ts'
import { isTimestampAST, validTimestampMillis } from './timestamp.ts'

/** Derives only admitted leaves; metadata never makes an arbitrary transformation portable. */
export const makeValueCodec = <TSchema extends Schema.ConstraintCodec<unknown>>({
  schema,
  transport,
}: {
  schema: TSchema
  transport: 'json' | 'direct'
}): Schema.Codec<TSchema['Type'], unknown> => {
  lower({ Value: schema }, transport)
  const seen = new Map<SchemaAST.AST, SchemaAST.AST>()
  const visit = (ast: SchemaAST.AST): SchemaAST.AST => {
    const cached = seen.get(ast)
    if (cached !== undefined) return cached
    let output = ast
    if (ast._tag === 'String' && transport === 'direct') {
      output = Schema.make<Schema.Codec<string>>(ast).check(
        Schema.makeFilter(scalarString, { expected: 'Unicode scalar string' }),
      ).ast
    } else if (ast._tag === 'BigInt' && transport === 'json') {
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
      output =
        transport === 'json'
          ? Schema.make<Schema.Codec<string>>(
              withKeyContext({
                ast: Schema.String.check(
                  Schema.makeFilter(validTimestampMillis, {
                    expected: 'RFC3339 with explicit offset and exact millisecond precision',
                  }),
                ).ast,
                context: ast.context,
              }),
            ).pipe(Schema.decodeTo(Schema.DateTimeUtcFromString), Schema.decodeTo(Schema.make(ast)))
              .ast
          : Schema.make<Schema.Codec<number>>(
              withKeyContext({
                ast: Schema.Int.check(
                  Schema.isBetween({ minimum: -62167219200000, maximum: 253402300799999 }),
                ).ast,
                context: ast.context,
              }),
            ).pipe(Schema.decodeTo(Schema.DateTimeUtcFromMillis), Schema.decodeTo(Schema.make(ast)))
              .ast
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

const identity = (value: unknown): unknown => value

/** Prepare omission and union selection once, not once per field per call. */
export const makeOptionalOmitter = (root: SchemaAST.AST): ((value: unknown) => unknown) => {
  const seen = new Map<SchemaAST.AST, (value: unknown) => unknown>()
  const compile = (ast: SchemaAST.AST): ((value: unknown) => unknown) => {
    const cached = seen.get(ast)
    if (cached !== undefined) return cached
    let implementation: (value: unknown) => unknown = identity
    const run = (value: unknown): unknown => implementation(value)
    seen.set(ast, run)
    if (ast._tag === 'Suspend') {
      let inner: ((value: unknown) => unknown) | undefined
      implementation = (value) => (inner ??= compile(ast.thunk()))(value)
    } else if (ast._tag === 'Union') {
      const members = ast.types.map((type) => ({
        is: Schema.is(Schema.make(type)),
        omit: compile(type),
      }))
      implementation = (value) => members.find((member) => member.is(value))?.omit(value) ?? value
    } else if (ast._tag === 'Arrays' && ast.elements.length === 0 && ast.rest.length === 1) {
      const omit = compile(ast.rest[0]!)
      implementation = (value) => (Array.isArray(value) === true ? value.map(omit) : value)
    } else if (ast._tag === 'Objects') {
      const fields = new Map(
        ast.propertySignatures.map((field) => [
          String(field.name),
          { optional: SchemaAST.isOptional(field.type), omit: compile(field.type) },
        ]),
      )
      const indexes = ast.indexSignatures.map((signature) => ({
        is: Schema.is(Schema.make(signature.parameter)),
        omit: compile(signature.type),
      }))
      implementation = (value) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value) === true)
          return value
        const output: Record<string, unknown> = {}
        for (const [key, item] of Object.entries(value)) {
          const field = fields.get(key)
          if (item === undefined && field?.optional === true) continue
          const omit = field?.omit ?? indexes.find((index) => index.is(key))?.omit
          Object.defineProperty(output, key, {
            value: omit === undefined ? item : omit(item),
            enumerable: true,
            writable: true,
            configurable: true,
          })
        }
        return output
      }
    }
    return run
  }
  return compile(root)
}
