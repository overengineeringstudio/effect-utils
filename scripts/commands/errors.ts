import { Schema } from 'effect'

/** Error thrown when a shell command fails during execution */
export class CommandError extends Schema.TaggedError<CommandError>()('CommandError', {
  command: Schema.String,
  message: Schema.String,
}) {}

/** Error thrown when config files are missing corresponding .genie.ts source files */
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
