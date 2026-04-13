import { Schema } from 'effect'

import { createGenieOutput } from '../core.ts'
import type { GenieOutput, Strict } from '../mod.ts'

/** Arguments for generating a JSON artifact from typed data. */
export type JsonArtifactArgs<TSchema extends Schema.Schema<any, any, never>> = {
  /** Schema used to encode the emitted JSON representation. */
  schema: TSchema
  /** Typed source-of-truth data kept available to TS consumers via `.data`. */
  data: Schema.Schema.Type<TSchema>
  /** JSON indentation level. Defaults to 2. */
  indentation?: number
}

/**
 * Creates a schema-backed JSON artifact.
 *
 * The structured `.data` field remains the typed TypeScript source of truth,
 * while the emitted file content is derived through `Effect.Schema` encoding.
 */
export const jsonArtifact = <const TSchema extends Schema.Schema<any, any, never>>(
  args: Strict<JsonArtifactArgs<TSchema>, JsonArtifactArgs<TSchema>>,
): GenieOutput<Schema.Schema.Type<TSchema>> =>
  createGenieOutput({
    data: args.data,
    stringify: (_ctx) =>
      JSON.stringify(Schema.encodeSync(args.schema)(args.data), null, args.indentation ?? 2) + '\n',
  })
