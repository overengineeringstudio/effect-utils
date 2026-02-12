/**
 * OTEL CLI
 *
 * Main CLI entry point for the `otel` command.
 * Provides trace inspection, listing, health checks, and debug tools.
 */

import * as Cli from '@effect/cli'

import { apiCommand } from './commands/api.ts'
import { dashCommand } from './commands/dash.ts'
import { debugCommand } from './commands/debug/mod.ts'
import { healthCommand } from './commands/health.ts'
import { metricsCommand } from './commands/metrics/mod.ts'
import { traceCommand } from './commands/trace/mod.ts'

// =============================================================================
// Main CLI
// =============================================================================

/** Root CLI command */
export const otelCommand = Cli.Command.make('otel').pipe(
  Cli.Command.withSubcommands([
    traceCommand,
    metricsCommand,
    healthCommand,
    dashCommand,
    debugCommand,
    apiCommand,
  ]),
  Cli.Command.withDescription(
    'OTEL observability stack CLI - trace inspection, metrics queries, health checks, diagnostics',
  ),
)
