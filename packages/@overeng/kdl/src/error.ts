import { Schema } from 'effect'

/** Source location within a KDL document */
export const KdlLocation = Schema.Struct({
  offset: Schema.Number,
  line: Schema.Number,
  column: Schema.Number,
}).annotations({ identifier: 'Kdl.Location' })

export type KdlLocation = typeof KdlLocation.Type

/** Error thrown when invalid KDL is encountered */
export class KdlParseError extends Schema.TaggedError<KdlParseError>()('KdlParseError', {
  message: Schema.String,
  start: Schema.optionalWith(KdlLocation, { as: 'Option' }),
  end: Schema.optionalWith(KdlLocation, { as: 'Option' }),
  errors: Schema.optionalWith(Schema.Array(Schema.Unknown), { as: 'Option' }),
}) {
  /** Iterate over all leaf errors (flattening nested error collections) */
  *flat(): Generator<KdlParseError, void, void> {
    if (this.errors._tag === 'None') {
      yield this
      return
    }

    for (const error of this.errors.value) {
      if (error instanceof KdlParseError) {
        yield* error.flat()
      }
    }
  }
}
