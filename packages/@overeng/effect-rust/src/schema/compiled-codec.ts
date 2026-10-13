import { Predicate, Schema, SchemaAST, SchemaIssue } from 'effect'

import { makeOptionalOmitter } from './value-codec.ts'

type Walk = (value: unknown) => unknown
const options = { onExcessProperty: 'error' } as const

/** Compile admitted containers while retaining Effect leaves and native issue structure. */
export const makeCompiledCodec = ({
  ast,
  direction,
  reference,
  omitOptional = false,
}: {
  ast: SchemaAST.AST
  direction: 'decode' | 'encode'
  reference: Walk
  omitOptional?: boolean
}): Walk => {
  const seen = new Map<SchemaAST.AST, Walk>()
  const compile = (node: SchemaAST.AST): Walk => {
    const cached = seen.get(node)
    if (cached !== undefined) return cached
    const schema = Schema.make<Schema.Codec<unknown>>(node)
    const parser =
      direction === 'decode'
        ? Schema.decodeUnknownSync(schema, options)
        : Schema.encodeUnknownSync(schema, options)
    const omit = omitOptional
      ? makeOptionalOmitter(SchemaAST.toEncoded(node))
      : (value: unknown) => value
    const fallback: Walk = node === ast ? reference : (value) => omit(parser(value))
    let implementation: Walk = fallback
    const run: Walk = (value) => implementation(value)
    seen.set(node, run)
    const issueAst = direction === 'decode' ? node : SchemaAST.flip(node)
    const fail = (issue: SchemaIssue.Issue): never => {
      throw new Schema.SchemaError(issue)
    }
    const at = (key: PropertyKey, input: unknown, visit: Walk, item: unknown): unknown => {
      try {
        return visit(item)
      } catch (cause) {
        if (cause instanceof Schema.SchemaError === false) throw cause
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
        implementation = (value) => {
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
        }
      } else if (node._tag === 'Arrays' && node.elements.length === 0 && node.rest.length === 1) {
        const item = compile(node.rest[0]!)
        implementation = (value) => {
          if (Array.isArray(value) === false) return fallback(value)
          const out = new Array<unknown>(value.length)
          for (let index = 0; index < value.length; index++)
            out[index] = at(index, value, item, value[index])
          return out
        }
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
        let select: ((value: unknown) => Walk | undefined) | undefined
        if (
          node.types.length === 2 &&
          nullish !== undefined &&
          effective !== undefined &&
          other !== undefined
        ) {
          const nullishRun = compile(nullish)
          const otherRun = compile(other)
          const tag = effective._tag
          const runtimeType = tag.toLowerCase()
          const hasDiscriminator =
            effective._tag === 'Objects' &&
            effective.propertySignatures.some(
              (field) =>
                field.type._tag === 'Literal' && SchemaAST.isOptional(field.type) === false,
            )
          if (
            (tag === 'Objects' && hasDiscriminator === false) ||
            tag === 'Arrays' ||
            tag === 'String' ||
            tag === 'Number' ||
            tag === 'Boolean' ||
            tag === 'BigInt' ||
            tag === 'Suspend'
          ) {
            select = (value) => {
              if (nullish._tag === 'Null' ? value === null : value === undefined) return nullishRun
              // Effect treats a suspended union member as a runtime-type fallback.
              if (tag === 'Suspend') return otherRun
              const matches =
                tag === 'Objects'
                  ? typeof value === 'object' && value !== null && Array.isArray(value) === false
                  : tag === 'Arrays'
                    ? Array.isArray(value)
                    : typeof value === runtimeType
              return matches ? otherRun : undefined
            }
          }
        } else {
          const members = node.types.map((type) => {
            const candidate =
              direction === 'decode' ? SchemaAST.toEncoded(type) : SchemaAST.toType(type)
            if (candidate._tag !== 'Objects') return undefined
            const tags = candidate.propertySignatures.filter(
              (field) =>
                field.type._tag === 'Literal' && SchemaAST.isOptional(field.type) === false,
            )
            const field = tags[0]
            if (tags.length !== 1 || field?.type._tag !== 'Literal') return undefined
            return { key: field.name, literal: field.type.literal, run: compile(type) }
          })
          const first = members[0]
          if (
            first !== undefined &&
            members.every((member) => member !== undefined && member.key === first.key)
          ) {
            const byTag = new Map(members.map((member) => [member!.literal, member!.run]))
            if (byTag.size === members.length) {
              select = (value) => {
                if (Predicate.isObjectKeyword(value) === false) return undefined
                const present =
                  first.key === '__proto__' ? Object.hasOwn(value, first.key) : first.key in value
                return present ? byTag.get(Reflect.get(value, first.key)) : undefined
              }
            }
          }
        }
        if (select !== undefined) {
          const choose = select
          implementation = (value) => {
            const member = choose(value)
            if (member === undefined)
              return fail(new SchemaIssue.AnyOf(issueAst, [], value, options))
            try {
              return member(value)
            } catch (cause) {
              if (cause instanceof Schema.SchemaError === false) throw cause
              return fail(new SchemaIssue.AnyOf(issueAst, [cause.issue], value, options))
            }
          }
        } else if (node.types.every((type) => type._tag === 'Suspend')) {
          // Suspended alternatives are all candidates in Effect's declaration order.
          const members = node.types.map(compile)
          implementation = (value) => {
            let issues: Array<SchemaIssue.Issue> | undefined
            for (const member of members) {
              try {
                return member(value)
              } catch (cause) {
                if (cause instanceof Schema.SchemaError === false) throw cause
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
  return compile(ast)
}
