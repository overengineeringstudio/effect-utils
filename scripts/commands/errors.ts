import { Schema } from 'effect'

export class CommandError extends Schema.TaggedError<CommandError>()('CommandError', {
  command: Schema.String,
  message: Schema.String,
}) {}

export class GenieCoverageError extends Schema.TaggedError<GenieCoverageError>()(
  'GenieCoverageError',
  {
    missingGenieSources: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Config files missing genie sources:\n${this.missingGenieSources.map((f) => `  - ${f}`).join('\n')}\n\nCreate corresponding .genie.ts files for these config files.`
  }
}
