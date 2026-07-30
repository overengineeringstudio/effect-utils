import { Effect, Schema } from 'effect'

export const encodePrettyJson =
  <A, I>(schema: Schema.ConstraintCodec<A, I, never, never>) =>
  (value: A) =>
    Schema.encodeEffect(schema)(value).pipe(
    Effect.map((encoded) => JSON.stringify(encoded, null, 2)),
    )

export const encodePrettyJsonSync = <A, I>(
  schema: Schema.ConstraintCodec<A, I, never, never>,
  value: A,
): string => JSON.stringify(Schema.encodeSync(schema)(value), null, 2)
