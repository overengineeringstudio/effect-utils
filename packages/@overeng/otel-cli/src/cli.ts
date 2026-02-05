/**
 * OTEL CLI
 *
 * Main CLI entry point for the `otel` command.
 * Provides trace inspection, listing, health checks, and debug tools.
 */

import * as Cli from '@effect/cli'

import { debugCommand } from './commands/debug/mod.ts'
import { healthCommand } from './commands/health.ts'
import { traceCommand } from './commands/trace/mod.ts'

// =============================================================================
// Main CLI
// =============================================================================

/** Root CLI command */
export const otelCommand = Cli.Command.make('otel').pipe(
  Cli.Command.withSubcommands([traceCommand, healthCommand, debugCommand]),
  Cli.Command.withDescription(
    'OTEL observability stack CLI - trace inspection, health checks, diagnostics',
  ),
)
