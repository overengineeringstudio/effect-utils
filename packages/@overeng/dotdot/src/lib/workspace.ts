import { Context, Effect, Layer } from 'effect'

/** Current working directory service */
export class CurrentWorkingDirectory extends Context.Tag('dotdot/CurrentWorkingDirectory')<
  CurrentWorkingDirectory,
  string
>() {
  /** Layer that captures the process cwd once */
  static live = Layer.effect(
    CurrentWorkingDirectory,
    Effect.sync(() => process.cwd()),
  )

  /** Override CWD for tests or nested invocations */
  static fromPath = (cwd: string) => Layer.succeed(CurrentWorkingDirectory, cwd)
}
