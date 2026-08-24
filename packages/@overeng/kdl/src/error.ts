import { Schema } from 'effect'

/** Source location within a KDL document */
export const KdlLocation = Schema.Struct({
  offset: Schema.Number,
  line: Schema.Number,
  column: Schema.Number,
}).annotate({ identifier: 'Kdl.Location' })

export type KdlLocation = typeof KdlLocation.Type

/** Error thrown when invalid KDL is encountered */
export class KdlParseError extends Schema.TaggedError<KdlParseError>()('KdlParseError', {
  message: Schema.String,
  start: Schema.OptionFromOptional(KdlLocation),
  end: Schema.OptionFromOptional(KdlLocation),
  errors: Schema.OptionFromOptional(Schema.Array(Schema.Unknown)),
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
