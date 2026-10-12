import { defineAuthority, Registry, walkSchema } from '@schickling/schema-registry'
import { Schema, type SchemaAST } from 'effect'

import { AgentTraceRuntimeV1, AgentTraceV2 } from './schema.ts'
/** Registry ownership declaration for the frozen Agent Trace semantic authority. */
export const authority = defineAuthority({
  id: 'agent-trace',
  owner: 'dotfiles/annotations',
  fragments: [{ id: 'agent-trace/v2', schema: AgentTraceV2 }],
})
/** Separate authority for the mutable private runtime file, not an artifact event. */
export const runtimeAuthority = defineAuthority({
  id: 'agent-trace-runtime',
  owner: 'dotfiles/annotations',
  fragments: [{ id: 'agent-trace-runtime/v1', schema: AgentTraceRuntimeV1 }],
})

const jsonAnnotationKeys: Record<string, true> = {
  [Registry.sensitivity]: true,
  [Registry.row]: true,
  [Registry.format]: true,
  [Registry.public]: true,
}
/** Native JSON Schema options preserving only the authority's typed render metadata. */
export const jsonSchemaOptions = {
  onExcessProperty: 'error',
  includeAnnotationKey: (key: string) => Object.hasOwn(jsonAnnotationKeys, key),
} as const

const inspect = ({ check, path }: { check: SchemaAST.Check<unknown>; path: string }): void => {
  if (check._tag === 'FilterGroup') {
    for (const child of check.checks) inspect({ check: child, path })
    return
  }
  const representation = check.annotations?.representation
  if (representation?.id !== 'effect/schema/isPattern') return
  const pattern = Schema.decodeUnknownSync(
    Schema.Struct({ source: Schema.String, flags: Schema.String }),
  )(representation.payload)
  // Effect 4.0.0-rc.118 documents that isPattern omits non-Unicode
  // regexes from JSON Schema. Fail authoring rather than emit a weaker
  // Rust contract; other nonexportable flags are rejected as well.
  if (!/^[dg]*uy?$/u.test(pattern.flags))
    throw new TypeError(
      `Non-exportable isPattern at ${path || '<root>'}: use the u flag without i/m/s/v flags`,
    )
}
/** Rejects patterns that Effect cannot export into the Rust contract. */
export const assertJsonPatternExports = (schema: Schema.Constraint): void => {
  walkSchema({
    schema,
    onNode: ({ ast, path }) => {
      for (const check of ast.checks ?? []) inspect({ check, path })
    },
  })
}
