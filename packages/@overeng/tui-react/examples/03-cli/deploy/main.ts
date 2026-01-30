/**
 * Deploy CLI - Full Example with Effect CLI
 *
 * Demonstrates:
 * - Effect CLI for argument parsing and signal handling
 * - Single `--output` flag for controlling output mode
 * - createTuiApp for state management
 * - Multiple output modes (tty, ci, pipe, json, ndjson, etc.)
 * - Graceful Ctrl+C handling with Interrupted state
 *
 * Run:
 *   bun examples/03-cli/deploy/main.ts --services api,web
 *   bun examples/03-cli/deploy/main.ts --services api,web --output json
 *   bun examples/03-cli/deploy/main.ts --services api,web --output ndjson
 *   bun examples/03-cli/deploy/main.ts --services api,web --dry-run
 *   bun examples/03-cli/deploy/main.ts --help
 */

import { Command, Options } from '@effect/cli'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Effect } from 'effect'

import { outputOption, outputModeLayer } from '../../../src/mod.ts'
import { runDeploy } from './deploy.tsx'

// =============================================================================
// Command Options
// =============================================================================

const services = Options.text('services').pipe(
  Options.withAlias('s'),
  Options.withDescription('Comma-separated list of services to deploy'),
)

const env = Options.text('env').pipe(
  Options.withAlias('e'),
  Options.withDefault('production'),
  Options.withDescription('Environment to deploy to'),
)

const dryRun = Options.boolean('dry-run').pipe(
  Options.withDefault(false),
  Options.withDescription('Validate without deploying'),
)

const timeout = Options.integer('timeout').pipe(
  Options.withAlias('t'),
  Options.withDefault(30000),
  Options.withDescription('Deployment timeout in milliseconds'),
)

const force = Options.boolean('force').pipe(
  Options.withAlias('f'),
  Options.withDefault(false),
  Options.withDescription('Force deployment even with warnings'),
)

// =============================================================================
// Command Definition
// =============================================================================

const deploy = Command.make(
  'deploy',
  {
    services,
    env,
    dryRun,
    timeout,
    force,
    output: outputOption,
  },
  ({ services: servicesArg, env: envArg, dryRun: dryRunArg, timeout: timeoutArg, force: forceArg, output }) =>
    runDeploy({
      services: servicesArg
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      environment: envArg,
      dryRun: dryRunArg,
      timeout: timeoutArg,
      force: forceArg,
    }).pipe(
      Effect.provide(outputModeLayer(output)),
      Effect.scoped,
      Effect.flatMap((result) => {
        // Exit with appropriate code based on result
        if (!result.success) {
          return Effect.fail(new Error(result.error ?? 'Deployment failed'))
        }
        return Effect.succeed(result)
      }),
    ),
)

// =============================================================================
// CLI Runner
// =============================================================================

const cli = Command.run(deploy, {
  name: 'deploy',
  version: '1.0.0',
})

// Run with Effect CLI (handles SIGINT/SIGTERM properly)
cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain)
