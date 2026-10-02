import { Schema } from 'effect'

/** Only Layer acquisition can fail with Init. Rebuilding a retired instance is a defect. */
export class Init extends Schema.TaggedError<Init>()('Init', {
  runtime: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export class Input extends Schema.TaggedError<Input>()('Input', {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export class Transport extends Schema.TaggedError<Transport>()('Transport', {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export class Unsupported extends Schema.TaggedError<Unsupported>()('Unsupported', {
  runtime: Schema.String,
  capability: Schema.String,
  message: Schema.String,
}) {}
