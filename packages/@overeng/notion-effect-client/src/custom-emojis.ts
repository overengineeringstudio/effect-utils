import { Effect, Schema } from 'effect'

import { get } from './internal/http.ts'

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

const CustomEmojiSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  url: Schema.String,
}).annotations({ identifier: 'CustomEmoji' })

export type CustomEmoji = typeof CustomEmojiSchema.Type

const CustomEmojisResponseSchema = Schema.Struct({
  object: Schema.Literal('list'),
  results: Schema.Array(CustomEmojiSchema),
}).annotations({ identifier: 'CustomEmojisResponse' })

// -----------------------------------------------------------------------------
// Service Implementation
// -----------------------------------------------------------------------------

/**
 * List all custom emojis in the workspace.
 *
 * @see https://developers.notion.com/reference/list-custom-emojis
 */
export const list = Effect.fn('NotionCustomEmojis.list')(function* () {
  const response = yield* get({
    path: '/custom_emojis',
    responseSchema: CustomEmojisResponseSchema,
  })
  return response.results
})

// -----------------------------------------------------------------------------
// Namespace Export
// -----------------------------------------------------------------------------

/** Notion Custom Emojis API */
export const NotionCustomEmojis = {
  list,
} as const
