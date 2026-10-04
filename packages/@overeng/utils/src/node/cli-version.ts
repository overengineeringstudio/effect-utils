import { Console as NodeConsole } from 'node:console'

import { Console, Context, Effect, Layer, Option } from 'effect'
import { CliOutput } from 'effect/cli'

/** CLI name and version pair, provided at startup for error diagnostics. */
export interface CliVersionInfo {
  readonly name: string
  readonly version: string
}

/** Version stamp appended to rendered diagnostics, e.g. `" (genie 0.1.0+abc123)"`. */
const versionSuffix = ({ name, version }: CliVersionInfo): string => ` (${name} ${version})`

/**
 * Wrap an upstream `CliOutput.Formatter` (rc.111) so rendered CLI errors carry
 * the CLI version stamp. This is the rendering-side successor of the deleted
 * `CliVersion.enrichErrors` error-cloning workaround, which tripped Effect v4's
 * getter-only `message` accessors under Bun: errors are no longer mutated, and
 * help/version rendering stays upstream bytes.
 */
const stampErrorsWithVersion = ({
  formatter,
  info,
}: {
  formatter: CliOutput.Formatter
  info: CliVersionInfo
}): CliOutput.Formatter => {
  const stamp = (rendered: string): string => `${rendered}${versionSuffix(info)}`
  return {
    ...formatter,
    formatCliError: (error) => stamp(formatter.formatCliError(error)),
    formatError: (error) => stamp(formatter.formatError(error)),
    formatErrors: (errors) =>
      errors.length === 0 ? formatter.formatErrors(errors) : stamp(formatter.formatErrors(errors)),
  }
}

/** CLI identity and version, provided at startup for error diagnostics. */
export class CliVersion extends Context.Service<CliVersion, CliVersionInfo>()('CliVersion') {
  /**
   * Yield a version suffix for use in error messages.
   * Returns e.g. `" (genie 0.1.0+abc123)"` or `""` if `CliVersion` is not provided.
   */
  static suffix: Effect.Effect<string> = Effect.serviceOption(CliVersion).pipe(
    Effect.map((v) => (Option.isSome(v) === true ? versionSuffix(v.value) : '')),
  )

  /**
   * Upstream `CliOutput.Formatter` whose rendered CLI errors carry this CLI's
   * version stamp (`Command.runWith` renders validation and user errors through
   * it). Apply at the CLI boundary alongside the `CliVersion` service:
   *
   * @example
   * ```ts
   * Cli.Command.runWith(cmd, { version })(args).pipe(
   *   Effect.scoped,
   *   Effect.provide(CliVersion.formatterLayer),
   *   Effect.provideService(CliVersion, { name: 'mr', version }),
   *   runTuiMain(NodeRuntime),
   * )
   * ```
   */
  static formatterLayer: Layer.Layer<never, never, CliVersion> = Layer.effect(
    CliOutput.Formatter,
    Effect.map(CliVersion, (info) =>
      stampErrorsWithVersion({ formatter: CliOutput.defaultFormatter(), info }),
    ),
  )
}

/**
 * Whether an argv requests machine-readable stdout — `--output json|ndjson`
 * (`=`-attached or as the following token, `-o` alias included), the schema
 * command's `--output-mode json|ndjson` (where `--output` names the output
 * file), or a `--json` boolean. Such invocations must keep diagnostics off
 * stdout (cli-C guard); `auto` output resolving to JSON when piped is
 * deliberately not guessed here.
 */
export const argvRequestsJsonStdout = (args: ReadonlyArray<string>): boolean => {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === undefined) continue
    if (arg === '--json') return true
    const match = /^(?:--output|-o|--output-mode)(?:=(.*))?$/.exec(arg)
    if (match === null) continue
    const value = match[1] ?? args[index + 1]
    if (value === 'json' || value === 'ndjson') return true
  }
  return false
}

/** Console with every method bound to stderr, used while argv parsing renders diagnostics. */
const consoleOnStderr: Console.Console = new NodeConsole({
  stdout: process.stderr,
  stderr: process.stderr,
})

/**
 * Keep validation help off stdout for JSON/NDJSON invocations (cli-C guard):
 * upstream `Command.runWith` renders `ShowHelp` documents via `Console.log`,
 * which would corrupt the machine-readable stdout channel that the rc.111
 * locked-rebaseline otherwise accepts for human invocations. Inert unless the
 * argv requests JSON/NDJSON output; also reroutes parse-phase logger output
 * (loggers read the `Console` reference). Pair with {@link handlerConsoleLayer}
 * so handler-phase payload writes still reach stdout.
 */
export const jsonStdoutGuardLayer = (args: ReadonlyArray<string>): Layer.Layer<never> =>
  argvRequestsJsonStdout(args) === true
    ? Layer.succeed(Console.Console, consoleOnStderr)
    : Layer.empty

/**
 * Console binding for the command-handler phase, provided via
 * `Command.provide`: once argv parsing has succeeded, restore the ambient
 * console so handler-phase payload writes that go through the `Console`
 * service (TuiApp JSON/NDJSON output) land on stdout even while
 * {@link jsonStdoutGuardLayer} is active. No-op when the guard is inert.
 */
export const handlerConsoleLayer: Layer.Layer<never> = Layer.succeed(
  Console.Console,
  globalThis.console,
)

// One formatter for CLI runtime and Node-loaded browser build integrations.
export {
  parseCliBuildStamp,
  resolveCliBuildIdentity,
  resolveCliMachineVersion,
  resolveCliVersion,
} from './cli-build-identity.js'
export type {
  LocalStamp,
  NixStamp,
  CliStamp,
  CliBuildIdentity,
} from './cli-build-identity.js'
