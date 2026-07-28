#!/usr/bin/env bun

/**
 * `npm-release` — verify that an npm registry serves what a release published.
 *
 * Shipped as a binary because its callers span runtimes: an Effect release command,
 * a workflow shell step, and a plain Node script. A process boundary is the one
 * interface all three can share, and is how this repository already ships `genie`
 * and `megarepo`.
 */

import { Command as Cli, Options } from 'effect/unstable/cli'
import { NodeServices, NodeRuntime } from '@effect/platform-node'
import { Cause, Duration, Effect, Option, Schedule } from 'effect'

import { readPlan, verifyPlan, type VerifyFailure } from './verify.ts'

const planOption = Options.file('plan').pipe(
  Options.withDescription(
    'Path to a JSON verify plan: { schemaVersion, version, npmTag, packages }',
  ),
)

const registryOption = Options.text('registry').pipe(
  Options.withDefault('https://registry.npmjs.org'),
  Options.withDescription('Registry to query'),
)

const attemptsOption = Options.integer('attempts').pipe(
  Options.withDefault(60),
  Options.withDescription('How many times to re-check a package that has not converged'),
)

const delaySecondsOption = Options.integer('delay-seconds').pipe(
  Options.withDefault(5),
  Options.withDescription('Seconds to wait between convergence checks'),
)

/**
 * Problems first: an operator needs the failing package and why, not a success
 * roll-call. Reasons are already package-qualified, so they are not re-prefixed.
 */
const renderFailures = (failures: ReadonlyArray<VerifyFailure>) =>
  Effect.forEach(
    failures,
    (failure) =>
      Effect.logError(`${failure.reason}${failure.terminal === true ? ' [terminal]' : ''}`),
    { discard: true },
  )

const verifyCommand = Cli.make(
  'verify',
  {
    plan: planOption,
    registry: registryOption,
    attempts: attemptsOption,
    delaySeconds: delaySecondsOption,
  },
  Effect.fn('verify')(function* ({ plan: planPath, registry, attempts, delaySeconds }) {
    const plan = yield* readPlan(planPath)
    const schedule = Schedule.spaced(Duration.seconds(delaySeconds)).pipe(
      Schedule.compose(Schedule.recurs(attempts)),
    )

    yield* Effect.logInfo(
      `Verifying ${plan.packages.length} package(s) at ${plan.version} (dist-tag ${plan.npmTag})`,
    )

    yield* verifyPlan({ plan, registry, schedule }).pipe(
      Effect.tapError((error) => renderFailures(error.failures)),
    )

    yield* Effect.logInfo(`All ${plan.packages.length} package(s) match the registry`)
  }),
).pipe(
  Cli.withDescription(
    'Verify that the registry serves the release described by a plan: version visibility, tarball digest, and dist-tag target.',
  ),
)

const cli = Cli.run(Cli.make('npm-release').pipe(Cli.withSubcommands([verifyCommand])), {
  name: 'npm-release',
  version: '0.1.0',
})

/**
 * Expected failures are already rendered as one line per package, so the default
 * cause dump would bury that under a stack trace from inside a bundled binary —
 * noise for the operator reading a failed release log.
 */
const reportUnexpected = (cause: Cause.Cause<unknown>) =>
  Cause.isInterruptedOnly(cause) === true
    ? Effect.void
    : Option.match(Cause.failureOption(cause), {
        onNone: () => Effect.logError(Cause.pretty(cause)),
        onSome: (error) =>
          isRendered(error) === true ? Effect.void : Effect.logError(String(error)),
      })

/** Failures already surfaced by `renderFailures`; re-logging them would duplicate. */
const isRendered = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  '_tag' in error &&
  error._tag === 'VerificationFailed'

if (import.meta.main) {
  cli(process.argv).pipe(
    Effect.tapErrorCause(reportUnexpected),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain({ disableErrorReporting: true }),
  )
}
