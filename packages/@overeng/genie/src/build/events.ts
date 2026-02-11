import { Context, Effect, PubSub, Schema } from 'effect'

import { GenieFileStatus, GenieSummary } from './schema.ts'

/** Schema for events emitted during genie generation/check. */
export const GenieEvent = Schema.Union(
  Schema.TaggedStruct('FilesDiscovered', {
    files: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        relativePath: Schema.String,
      }),
    ),
  }),

  Schema.TaggedStruct('FileStarted', { path: Schema.String }),

  Schema.TaggedStruct('FileCompleted', {
    path: Schema.String,
    status: GenieFileStatus,
    message: Schema.optional(Schema.String),
  }),

  Schema.TaggedStruct('Complete', { summary: GenieSummary }),

  Schema.TaggedStruct('Error', { message: Schema.String }),
)
export type GenieEvent = Schema.Schema.Type<typeof GenieEvent>

/** PubSub for genie progress events, injected via Context. */
export class GenieEventBus extends Context.Tag('@overeng/genie/EventBus')<
  GenieEventBus,
  PubSub.PubSub<GenieEvent>
>() {}

/** Publish a GenieEvent to the bus from Context. */
export const emit = (event: GenieEvent): Effect.Effect<boolean, never, GenieEventBus> =>
  Effect.flatMap(GenieEventBus, (bus) => PubSub.publish(bus, event))
