import { Schema } from 'effect'

import { createGenieOutput } from '../core.ts'
import type { GenieOutput, Strict } from '../mod.ts'

/** Arguments for generating a JSON artifact from plain typed data. */
export type JsonArtifactDataArgs<TData> = {
  /** Typed source-of-truth data kept available to TS consumers via `.data`. */
  data: TData
  /** JSON indentation level. Defaults to 2. */
  indentation?: number
}

/** Arguments for generating a JSON artifact through schema-backed encoding. */
export type JsonArtifactSchemaArgs<TSchema extends Schema.Schema<any, any, never>> = {
  /** Schema used to encode the emitted JSON representation. */
  schema: TSchema
  /** Typed source-of-truth data kept available to TS consumers via `.data`. */
  data: Schema.Schema.Type<TSchema>
  /** JSON indentation level. Defaults to 2. */
  indentation?: number
}

/**
 * Creates a JSON artifact from typed data.
 *
 * If a schema is provided, the emitted file content is derived through
 * `Effect.Schema` encoding. Otherwise the data is stringified as-is.
 */
export function jsonArtifact<const TData>(
  args: Strict<JsonArtifactDataArgs<TData>, JsonArtifactDataArgs<TData>>,
): GenieOutput<TData>
export function jsonArtifact<const TSchema extends Schema.Schema<any, any, never>>(
  args: Strict<JsonArtifactSchemaArgs<TSchema>, JsonArtifactSchemaArgs<TSchema>>,
): GenieOutput<Schema.Schema.Type<TSchema>>
export function jsonArtifact<const TData>(
  args:
    | Strict<JsonArtifactDataArgs<TData>, JsonArtifactDataArgs<TData>>
    | Strict<
        JsonArtifactSchemaArgs<Schema.Schema<any, any, never>>,
        JsonArtifactSchemaArgs<Schema.Schema<any, any, never>>
      >,
): GenieOutput<TData> {
  return createGenieOutput({
    data: args.data,
    stringify: (_ctx) => {
      const jsonValue = 'schema' in args ? Schema.encodeSync(args.schema)(args.data) : args.data

      return JSON.stringify(jsonValue, null, args.indentation ?? 2) + '\n'
    },
  })
}
