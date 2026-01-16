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

/** Error thrown when package installation fails */
export class InstallError extends Schema.TaggedError<InstallError>()('InstallError', {
  failedCount: Schema.Number,
  totalCount: Schema.Number,
}) {
  override get message(): string {
    return `Failed to install ${this.failedCount}/${this.totalCount} packages`
  }
}

// =============================================================================
// Task Graph Errors
// =============================================================================

/** Error thrown when a task dependency is not found */
export class UnknownDependencyError extends Schema.TaggedError<UnknownDependencyError>()(
  'UnknownDependencyError',
  {
    dependencyId: Schema.String,
    taskId: Schema.String,
  },
) {
  override get message(): string {
    return `Unknown dependency '${this.dependencyId}' in task '${this.taskId}'`
  }
}

/** Error thrown when task graph has circular dependencies */
export class CircularDependencyError extends Schema.TaggedError<CircularDependencyError>()(
  'CircularDependencyError',
  {},
) {
  override get message(): string {
    return 'Circular dependency detected in task graph'
  }
}
