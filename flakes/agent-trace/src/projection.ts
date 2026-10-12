import { Schema, SchemaAST as AST } from 'effect'

import { validateBinding, type Binding } from './bindings.ts'
import {
  AgentTraceV2,
  PublicIdentity,
  PublicSessionLookup,
  annotations,
  auditAnnotations,
  strict,
  type Audience,
} from './schema.ts'
/** Portable generated traversal plan for audience coarsening and medium restriction. */
export type Plan =
  | { readonly kind: 'leaf'; readonly operation?: 'short-session' | 'strip-host' }
  | { readonly kind: 'object'; readonly fields: Readonly<Record<string, Plan>> }
/** Lowers the annotated semantic AST into an audience or historical binding contract. */
export const lowerView = ({
  audience,
  binding,
}: {
  audience: Audience
  binding?: Binding | undefined
}): { schema: Schema.Top; plan: Plan } => {
  auditAnnotations(AgentTraceV2.ast)
  if (binding) validateBinding(binding)
  const lower = ({
    ast,
    path,
  }: {
    ast: AST.AST
    path: string
  }): { schema: Schema.Top; plan: Plan } | undefined => {
    const a = annotations(ast)
    if (
      a['x-sensitivity'] !== 'public' &&
      (audience === 'public-minimal' || a['x-sensitivity'] !== 'internal')
    )
      return undefined
    let schema: Schema.Top, plan: Plan
    if (AST.isObjects(ast)) {
      const children = ast.propertySignatures.flatMap((p) => {
        const key = String(p.name),
          child = lower({ ast: p.type, path: path ? `${path}.${key}` : key })
        return child ? [[key, child] as const] : []
      })
      if (!children.length && path && binding) return undefined
      schema = Schema.Struct(
        Object.fromEntries(children.map(([key, child]) => [key, child.schema])),
      )
      if (!binding && ast.checks?.length) schema = schema.check(...ast.checks)
      plan = {
        kind: 'object',
        fields: Object.fromEntries(children.map(([key, child]) => [key, child.plan])),
      }
    } else {
      if (binding && !('key' in binding.paths[path]!)) return undefined
      const operation = audience === 'public-minimal' ? a['x-public'] : undefined
      schema =
        operation === 'short-session'
          ? PublicSessionLookup
          : operation === 'strip-host'
            ? PublicIdentity
            : Schema.make<Schema.Top>(ast)
      plan = { kind: 'leaf', ...(operation ? { operation } : {}) }
    }
    // Historical binding views can lack a top-level fact in any family. Fresh
    // record projections are still validated against the required semantic
    // schema; current encoders additionally enforce the fresh-writer boundary.
    if (AST.isOptional(ast) || (binding && path.split('.').length === 2))
      schema = Schema.optionalKey(schema)
    return { schema: schema.pipe(Schema.annotateKey(a)), plan }
  }
  return lower({ ast: AgentTraceV2.ast, path: '' })!
}
const isObject = (input: unknown): input is Record<string, unknown> =>
  typeof input === 'object' && input !== null && !Array.isArray(input)
/** Rejects nonobject inputs at projection and rendering boundaries. */
export const object = (input: unknown): Record<string, unknown> => {
  if (!isObject(input)) throw new TypeError('Expected object')
  return input
}
const encodeRecord = Schema.encodeSync(AgentTraceV2, strict)
/** Builds a reusable projection while strictly validating every fresh event and projected result. */
export const makeProjection = <T extends Schema.Codec<unknown, unknown>>({
  schema,
  plan,
}: {
  schema: T
  plan: Plan
}): ((record: AgentTraceV2) => T['Type']) => {
  const decodeView = Schema.decodeUnknownSync(schema, strict)
  const walk = ({ childPlan, value }: { childPlan: Plan; value: unknown }): unknown => {
    if (childPlan.kind === 'object') {
      const source = object(value),
        result: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(childPlan.fields))
        if (Object.hasOwn(source, key)) result[key] = walk({ childPlan: child, value: source[key] })
      return result
    }
    if (typeof value === 'string') {
      if (childPlan.operation === 'short-session') return value.split('.').at(-1)
      if (
        childPlan.operation === 'strip-host' &&
        !value.startsWith('agent/') &&
        !value.startsWith('direct.')
      )
        return value.includes('.') ? value.slice(value.indexOf('.') + 1) : value
    }
    return value
  }
  return (record) => decodeView(walk({ childPlan: plan, value: encodeRecord(record) }))
}
