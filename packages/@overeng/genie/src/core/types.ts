import { Schema } from 'effect'

// Re-export GenieContext from runtime (single source of truth)
export type { GenieContext } from '../runtime/mod.ts'

/** Schema for the result of generating a single file */
export const GenerateSuccess = Schema.Union(
  Schema.TaggedStruct('created', { targetFilePath: Schema.String }),
  Schema.TaggedStruct('updated', {
    targetFilePath: Schema.String,
    diffSummary: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct('unchanged', { targetFilePath: Schema.String }),
  Schema.TaggedStruct('skipped', { targetFilePath: Schema.String, reason: Schema.String }),
)
export type GenerateSuccess = typeof GenerateSuccess.Type

/** Schema for the result of attempting to stat a file - handles broken symlinks gracefully */
export const StatResult = Schema.Union(
  Schema.Struct({ type: Schema.Literal('directory') }),
  Schema.Struct({ type: Schema.Literal('file') }),
  Schema.Struct({ type: Schema.Literal('skip'), reason: Schema.String }),
)
export type StatResult = typeof StatResult.Type
