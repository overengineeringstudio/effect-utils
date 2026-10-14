import { Cause, Exit, Predicate, Schema, SchemaAST, SchemaIssue } from 'effect'

import { makeOptionalOmitter } from './value-codec.ts'

type Walk = (value: unknown) => unknown
const options = { onExcessProperty: 'error' } as const
const runtimeTypeOf = (value: unknown) =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value

// Private failures distinguish parser rejection from user code throwing SchemaError.
class ParseFailure {
  readonly issue: SchemaIssue.Issue
  constructor(issue: SchemaIssue.Issue) {
    this.issue = issue
  }
}
class DefectFailure {
  readonly cause: Cause.Cause<unknown>
  constructor(cause: Cause.Cause<unknown>) {
    this.cause = cause
  }
}
const protect =
  (walk: Walk): Walk =>
  (value) => {
    try {
      return walk(value)
    } catch (cause) {
      if (cause instanceof ParseFailure || cause instanceof DefectFailure) throw cause
      throw new DefectFailure(Cause.die(cause))
    }
  }

/** Compile admitted containers while retaining Effect leaves and native issue structure. */
export const makeCompiledCodec = ({
  ast,
  direction,
  omitOptional = false,
}: {
  ast: SchemaAST.AST
  direction: 'decode' | 'encode'
  omitOptional?: boolean
}): Walk => {
  const seen = new Map<SchemaAST.AST, Walk>()
  const compile = (node: SchemaAST.AST): Walk => {
    const cached = seen.get(node)
    if (cached !== undefined) return cached
    const schema = Schema.make<Schema.Codec<unknown>>(node)
    const parser =
      direction === 'decode'
        ? Schema.decodeUnknownExit(schema, options)
        : Schema.encodeUnknownExit(schema, options)
    const omit = omitOptional
      ? makeOptionalOmitter(SchemaAST.toEncoded(node))
      : (value: unknown) => value
    const fallback: Walk = (value) => {
      const exit = parser(value)
      if (Exit.isSuccess(exit)) return omit(exit.value)
      let issue: SchemaIssue.Issue | undefined
      for (const reason of exit.cause.reasons) {
        if (Cause.isFailReason(reason) === false || Schema.isSchemaError(reason.error) === false)
          throw new DefectFailure(exit.cause)
        issue ??= reason.error.issue
      }
      if (issue === undefined) throw new DefectFailure(exit.cause)
      throw new ParseFailure(issue)
    }
    let implementation: Walk = fallback
    const run: Walk = (value) => implementation(value)
    seen.set(node, run)
    const issueAst = direction === 'decode' ? node : SchemaAST.flip(node)
    const fail = (issue: SchemaIssue.Issue): never => {
      throw new ParseFailure(issue)
    }
    const at = (key: PropertyKey, input: unknown, visit: Walk, item: unknown): unknown => {
      try {
        return visit(item)
      } catch (cause) {
        if (cause instanceof ParseFailure === false) throw cause
        return fail(
          new SchemaIssue.Composite(
            issueAst,
            [new SchemaIssue.Pointer([key], cause.issue)],
            input,
            options,
          ),
        )
      }
    }
    // Transformations, checked containers and record keys remain interpreter-owned.
    if (node.encoding === undefined && node.checks === undefined) {
      if (node._tag === 'Suspend') {
        let inner: Walk | undefined
        implementation = (value) => (inner ??= compile(node.thunk()))(value)
      } else if (
        node._tag === 'Objects' &&
        node.indexSignatures.length === 0 &&
        node.propertySignatures.length > 0
      ) {
        const fields = node.propertySignatures.map((field) => ({
          name: field.name,
          type: field.type,
          optional: SchemaAST.isOptional(field.type),
          run: compile(field.type),
        }))
        const keys = new Set(
          fields.map((field) => (typeof field.name === 'number' ? String(field.name) : field.name)),
        )
        implementation = protect((value) => {
          if (typeof value !== 'object' || value === null || Array.isArray(value) === true)
            return fallback(value)
          // Exactly Effect's local ordering and own-enumerable symbol policy.
          for (const key of Reflect.ownKeys(value)) {
            if (keys.has(key) === false && Object.prototype.propertyIsEnumerable.call(value, key)) {
              return fail(
                new SchemaIssue.Composite(
                  issueAst,
                  [
                    new SchemaIssue.Pointer(
                      [key],
                      new SchemaIssue.UnexpectedKey(issueAst, Reflect.get(value, key), options),
                    ),
                  ],
                  value,
                  options,
                ),
              )
            }
          }
          const out: Record<PropertyKey, unknown> = {}
          for (const field of fields) {
            const present =
              field.name === '__proto__' ? Object.hasOwn(value, field.name) : field.name in value
            if (present === false) {
              if (field.optional === false)
                return fail(
                  new SchemaIssue.Composite(
                    issueAst,
                    [
                      new SchemaIssue.Pointer(
                        [field.name],
                        new SchemaIssue.MissingKey(field.type.context?.annotations),
                      ),
                    ],
                    value,
                    options,
                  ),
                )
              continue
            }
            const item = at(field.name, value, field.run, Reflect.get(value, field.name))
            if (omitOptional === true && field.optional === true && item === undefined) continue
            if (field.name === '__proto__') {
              Object.defineProperty(out, field.name, {
                value: item,
                enumerable: true,
                writable: true,
                configurable: true,
              })
            } else {
              out[field.name] = item
            }
          }
          return out
        })
      } else if (node._tag === 'Arrays' && node.elements.length === 0 && node.rest.length === 1) {
        const item = compile(node.rest[0]!)
        implementation = protect((value) => {
          if (Array.isArray(value) === false) return fallback(value)
          const length = value.length
          const out = new Array<unknown>(length)
          for (let index = 0; index < length; index++)
            out[index] = at(index, value, item, value[index])
          return out
        })
      } else if (
        node._tag === 'Union' &&
        node.options?.mode !== 'oneOf' &&
        issueAst._tag === 'Union'
      ) {
        const nullish = node.types.find((type) => type._tag === 'Null' || type._tag === 'Undefined')
        const other = node.types.find((type) => type !== nullish)
        const effective =
          other === undefined
            ? undefined
            : direction === 'decode'
              ? SchemaAST.toEncoded(other)
              : SchemaAST.toType(other)
        let select: ((value: unknown) => ReadonlyArray<Walk>) | undefined
        if (
          node.types.length === 2 &&
          nullish !== undefined &&
          effective !== undefined &&
          other !== undefined &&
          other.encoding === undefined &&
          nullish.encoding === undefined
        ) {
          const nullishRun = compile(nullish)
          const otherRun = compile(other)
          const tag = effective._tag
          const runtimeType = tag.toLowerCase()
          const nullishCandidates = node.types.map(compile)
          const nullishOnly = [nullishRun]
          const otherOnly = [otherRun]
          const empty: ReadonlyArray<Walk> = []
          const hasDiscriminator =
            effective._tag === 'Objects' &&
            effective.propertySignatures.some(
              (field) =>
                field.type._tag === 'Literal' && SchemaAST.isOptional(field.type) === false,
            )
          if (
            (tag === 'Objects' &&
              effective.propertySignatures.length + effective.indexSignatures.length > 0 &&
              hasDiscriminator === false) ||
            (tag === 'Arrays' && effective.elements.length === 0 && effective.rest.length === 1) ||
            tag === 'String' ||
            tag === 'Number' ||
            tag === 'Boolean' ||
            tag === 'BigInt' ||
            tag === 'Suspend'
          ) {
            select = (value) => {
              const actual = runtimeTypeOf(value)
              if (nullish._tag === 'Null' ? value === null : value === undefined)
                return tag === 'Suspend' ? nullishCandidates : nullishOnly
              // Effect treats a suspended union member as a runtime-type fallback.
              if (tag === 'Suspend') return otherOnly
              const matches =
                tag === 'Objects'
                  ? actual === 'object'
                  : tag === 'Arrays'
                    ? actual === 'array'
                    : actual === runtimeType
              return matches ? otherOnly : empty
            }
          }
        } else {
          const members = node.types.map((type) => {
            if (type.encoding !== undefined) return undefined
            const candidate =
              direction === 'decode' ? SchemaAST.toEncoded(type) : SchemaAST.toType(type)
            if (candidate._tag !== 'Objects') return undefined
            const tags = candidate.propertySignatures.filter(
              (field) =>
                field.type._tag === 'Literal' && SchemaAST.isOptional(field.type) === false,
            )
            const field = tags[0]
            if (tags.length !== 1 || field?.type._tag !== 'Literal') return undefined
            if (type._tag !== 'Objects') return undefined
            const source = type.propertySignatures.find((property) => property.name === field.name)
            if (source?.type.encoding !== undefined) return undefined
            return { key: field.name, literal: field.type.literal, runs: [compile(type)] }
          })
          const first = members[0]
          if (
            first !== undefined &&
            members.every((member) => member !== undefined && member.key === first.key)
          ) {
            const byTag = new Map(members.map((member) => [member!.literal, member!.runs]))
            if (byTag.size === members.length) {
              const empty: ReadonlyArray<Walk> = []
              select = (value) => {
                if (Predicate.isObjectKeyword(value) === false) return empty
                const present =
                  first.key === '__proto__' ? Object.hasOwn(value, first.key) : first.key in value
                return present ? (byTag.get(Reflect.get(value, first.key)) ?? empty) : empty
              }
            }
          }
        }
        if (
          select === undefined &&
          node.types.length > 0 &&
          node.types.every((type) => type._tag === 'Suspend')
        ) {
          // Suspended alternatives are all candidates in Effect's declaration order.
          const members = node.types.map(compile)
          select = (value) => {
            // Classification can itself throw for a revoked proxy, before parsing.
            runtimeTypeOf(value)
            return members
          }
        }
        if (select !== undefined) {
          const choose = select
          implementation = (value) => {
            let issues: Array<SchemaIssue.Issue> | undefined
            for (const member of choose(value)) {
              try {
                return member(value)
              } catch (cause) {
                if (cause instanceof ParseFailure === false) throw cause
                ;(issues ??= []).push(cause.issue)
              }
            }
            return fail(new SchemaIssue.AnyOf(issueAst, issues ?? [], value, options))
          }
        }
      }
    }
    return run
  }
  const root = compile(ast)
  return (value) => {
    try {
      return root(value)
    } catch (cause) {
      if (cause instanceof ParseFailure) throw new Schema.SchemaError(cause.issue)
      if (cause instanceof DefectFailure)
        throw new Error('Sync adapter can only throw schema errors', { cause: cause.cause })
      throw cause
    }
  }
}
