/**
 * Deploy CLI - Full Example with Effect CLI
 *
 * Demonstrates:
 * - Effect CLI for argument parsing and signal handling
 * - Reusable outputModeOptions for --json/--stream flags
 * - createTuiApp for state management
 * - Multiple output modes (visual, JSON, NDJSON)
 * - Graceful Ctrl+C handling with Interrupted state
 *
 * Run:
 *   bun examples/04-cli/deploy/main.ts --services api,web
 *   bun examples/04-cli/deploy/main.ts --services api,web --json
 *   bun examples/04-cli/deploy/main.ts --services api,web --json --stream
 *   bun examples/04-cli/deploy/main.ts --services api,web --dry-run
 *   bun examples/04-cli/deploy/main.ts --help
 */

import { Command, Options } from '@effect/cli'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Effect } from 'effect'

import { outputModeOptions, outputModeLayerFromFlagsWithTTY } from '../../../src/mod.ts'
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

// =============================================================================
// Command Definition
// =============================================================================

const deploy = Command.make(
  'deploy',
  {
    services,
    env,
    dryRun,
    ...outputModeOptions, // Adds --json and --stream flags
  },
  ({ services: servicesArg, env: envArg, dryRun: dryRunArg, json, stream }) =>
    runDeploy({
      services: servicesArg
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      environment: envArg,
      dryRun: dryRunArg,
    }).pipe(
      Effect.provide(outputModeLayerFromFlagsWithTTY({ json, stream, visual })),
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
