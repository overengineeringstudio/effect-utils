/**
 * otel dash
 *
 * Dashboard provisioning commands for syncing project dashboards
 * to the system-level Grafana instance at ~/.local/state/otel/dashboards/.
 */

import * as Cli from '@effect/cli'
import { Effect } from 'effect'

import { outputModeLayer, outputOption } from '@overeng/tui-react/node'

import * as DashboardManager from '../services/DashboardManager.ts'

// =============================================================================
// otel dash sync
// =============================================================================

const projectOption = Cli.Options.text('project').pipe(
  Cli.Options.withDescription('Project name (default: auto-detect from .otel/dashboards.json)'),
  Cli.Options.optional,
)

const sourceOption = Cli.Options.text('source').pipe(
  Cli.Options.withDescription('Dashboard JSON source directory (default: auto-detect)'),
  Cli.Options.optional,
)

const targetOption = Cli.Options.text('target').pipe(
  Cli.Options.withDescription('Target base directory (default: ~/.local/state/otel/dashboards)'),
  Cli.Options.optional,
)

/** Sync project dashboards to the system-level Grafana instance. */
const syncCommand = Cli.Command.make(
  'sync',
  {
    output: outputOption,
    project: projectOption,
    source: sourceOption,
    target: targetOption,
  },
  ({ output, project, source, target }) =>
    Effect.gen(function* () {
      let resolvedProject: string
      let resolvedSource: string

      if (project._tag === 'Some' && source._tag === 'Some') {
        resolvedProject = project.value
        resolvedSource = source.value
      } else {
        const detected = yield* DashboardManager.detectProjectConfig(process.cwd())
        resolvedProject = project._tag === 'Some' ? project.value : detected.project
        resolvedSource = source._tag === 'Some' ? source.value : detected.source
      }

      const manifest = yield* DashboardManager.sync({
        project: resolvedProject,
        source: resolvedSource,
        ...(target._tag === 'Some' && { target: target.value }),
      })

      yield* Effect.log(
        `Synced ${String(manifest.dashboards.length)} dashboards for "${manifest.project}"`,
      )
      for (const db of manifest.dashboards) {
        yield* Effect.log(`  ${db.filename}`)
      }
    }).pipe(Effect.provide(outputModeLayer(output))),
).pipe(Cli.Command.withDescription('Sync project dashboards to ~/.local/state/otel/dashboards/'))

// =============================================================================
// otel dash list
// =============================================================================

/** List registered projects and their synced dashboards. */
const listCommand = Cli.Command.make(
  'list',
  {
    output: outputOption,
    target: targetOption,
  },
  ({ output, target }) =>
    Effect.gen(function* () {
      const manifests = yield* DashboardManager.list({
        ...(target._tag === 'Some' && { target: target.value }),
      })

      if (manifests.length === 0) {
        yield* Effect.log('No projects synced. Run `otel dash sync` to provision dashboards.')
        return
      }

      yield* Effect.log(`Projects (${String(manifests.length)}):`)
      for (const m of manifests) {
        yield* Effect.log(
          `  ${m.project} — ${String(m.dashboards.length)} dashboards (synced: ${m.syncedAt})`,
        )
        yield* Effect.log(`    source: ${m.source}`)
      }
    }).pipe(Effect.provide(outputModeLayer(output))),
).pipe(Cli.Command.withDescription('List synced dashboard projects'))

// =============================================================================
// otel dash remove
// =============================================================================

const projectArg = Cli.Args.text({ name: 'project' }).pipe(
  Cli.Args.withDescription('Project name to remove'),
)

/** Remove a project's dashboards from the target directory. */
const removeCommand = Cli.Command.make(
  'remove',
  {
    output: outputOption,
    project: projectArg,
    target: targetOption,
  },
  ({ output, project, target }) =>
    Effect.gen(function* () {
      yield* DashboardManager.remove({
        project,
        ...(target._tag === 'Some' && { target: target.value }),
      })
      yield* Effect.log(`Removed dashboards for "${project}"`)
    }).pipe(Effect.provide(outputModeLayer(output))),
).pipe(Cli.Command.withDescription('Remove a project\'s dashboards'))

// =============================================================================
// otel dash (parent command)
// =============================================================================

/** Dashboard provisioning subcommand group. */
export const dashCommand = Cli.Command.make('dash').pipe(
  Cli.Command.withSubcommands([syncCommand, listCommand, removeCommand]),
  Cli.Command.withDescription('Dashboard provisioning (sync project dashboards to system Grafana)'),
)
