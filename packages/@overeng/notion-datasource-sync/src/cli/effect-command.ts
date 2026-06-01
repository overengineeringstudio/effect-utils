import { Args, Command, Options } from '@effect/cli'
import { Effect } from 'effect'

/** Handler used by the import-safe command descriptor for executable leaf commands. */
export type SqliteCommandHandler = (command: string) => Effect.Effect<void>

/** Shells supported by Effect CLI completion generation for datasource-sync. */
export type CompletionShell = 'bash' | 'fish' | 'sh' | 'zsh'

const defaultHandler: SqliteCommandHandler = () => Effect.void

const runtimeUnavailableHandler: SqliteCommandHandler = () =>
  Effect.sync(() => {
    process.stderr.write(
      'notion sqlite requires the packaged Nix/devenv Node-backed runtime because the SQLite sync implementation imports node:sqlite. Use `devenv shell` or the flake-built `notion` binary.\n',
    )
    process.exitCode = 1
  })

const workspaceRootArg = Args.text({ name: 'workspace-root' }).pipe(
  Args.withDescription('Workspace root or SQLite replica path'),
  Args.optional,
)

const dryRunOption = Options.boolean('dry-run').pipe(
  Options.withDescription('Validate without mutating local or remote state'),
  Options.withDefault(false),
)

const sqliteOption = Options.file('sqlite').pipe(
  Options.withDescription('SQLite store path'),
  Options.optional,
)

const rootIdOption = Options.text('root-id').pipe(
  Options.withDescription('Sync root id'),
  Options.optional,
)

const dataSourceIdOption = Options.text('data-source-id').pipe(
  Options.withDescription('Notion data source id'),
  Options.optional,
)

const workspaceRootOption = Options.directory('workspace-root').pipe(
  Options.withDescription('Local workspace root'),
  Options.optional,
)

const commonOptions = {
  sqlite: sqliteOption,
  rootId: rootIdOption,
  dataSourceId: dataSourceIdOption,
  workspaceRootOption,
} as const

const noMaterializeBodiesOption = Options.boolean('no-materialize-bodies').pipe(
  Options.withDescription('Skip local NotionMD body materialization'),
  Options.withDefault(false),
)

const leafCommand = ({
  name,
  description,
  handler,
  extraConfig = {},
}: {
  readonly name: string
  readonly description: string
  readonly handler: SqliteCommandHandler
  readonly extraConfig?: {}
}) =>
  Command.make(name, { ...commonOptions, ...extraConfig }, () => handler(name)).pipe(
    Command.withDescription(description),
  )

/**
 * Builds the datasource-sync CLI command tree without importing the Node-only
 * runtime modules that reach `node:sqlite`.
 */
export const makeDatasourceSyncCommand = ({
  name = 'notion-datasource-sync',
  handler = defaultHandler,
}: {
  readonly name?: 'notion-datasource-sync' | 'sqlite'
  readonly handler?: SqliteCommandHandler
} = {}) => {
  const initCommand = leafCommand({
    name: 'init',
    description: 'Initialize a local SQLite sync store',
    handler,
    extraConfig: {
      dryRun: dryRunOption,
    },
  })

  const syncCommand = Command.make(
    'sync',
    {
      ...commonOptions,
      workspaceRoot: workspaceRootArg,
      fromNotion: Options.text('from-notion').pipe(
        Options.withDescription('Adopt a Notion data source/database URL into a workspace'),
        Options.optional,
      ),
      dryRun: dryRunOption,
      watch: Options.boolean('watch').pipe(
        Options.withDescription('Continuously sync and process local SQLite changes'),
        Options.withDefault(false),
      ),
      state: Options.file('state').pipe(
        Options.withDescription('Durable watch state file path'),
        Options.optional,
      ),
      maxCycles: Options.integer('max-cycles').pipe(
        Options.withDescription('Maximum watch cycles before exiting'),
        Options.optional,
      ),
      mode: Options.choice('mode', ['development', 'normal', 'low-priority']).pipe(
        Options.withDescription('Watch daemon pacing mode'),
        Options.optional,
      ),
      webhook: Options.choice('webhook', ['none', 'tailscale', 'manual']).pipe(
        Options.withDescription('Webhook wakeup provider'),
        Options.optional,
      ),
      webhookRequired: Options.boolean('webhook-required').pipe(
        Options.withDescription('Fail if webhook exposure cannot be established'),
        Options.withDefault(false),
      ),
      nonInteractive: Options.boolean('non-interactive').pipe(
        Options.withDescription('Disable interactive daemon affordances'),
        Options.withDefault(false),
      ),
      limit: Options.integer('limit').pipe(
        Options.withDescription('Dry-run preview row limit for sync --from-notion'),
        Options.optional,
      ),
      noMaterializeBodies: noMaterializeBodiesOption,
    },
    () => handler('sync'),
  ).pipe(Command.withDescription('Run pull and push, or adopt from Notion with --from-notion'))

  const conflictsCommand = Command.make('conflicts').pipe(
    Command.withSubcommands([
      leafCommand({
        name: 'list',
        description: 'List unresolved conflicts',
        handler,
      }),
      leafCommand({
        name: 'resolve',
        description: 'Resolve a conflict',
        handler,
        extraConfig: {
          conflictId: Options.text('conflict-id').pipe(
            Options.withDescription('Conflict id to resolve'),
            Options.optional,
          ),
          strategy: Options.choice('strategy', ['keep-remote', 'keep-local', 'manual']).pipe(
            Options.withDescription('Conflict resolution strategy'),
            Options.optional,
          ),
          valueJson: Options.text('value-json').pipe(
            Options.withDescription('Manual resolution value as JSON'),
            Options.optional,
          ),
          dryRun: dryRunOption,
        },
      }),
    ]),
    Command.withDescription('Inspect and resolve SQLite sync conflicts'),
  )

  const migrateCommand = Command.make('migrate').pipe(
    Command.withSubcommands([
      leafCommand({
        name: 'store',
        description: 'Reserved; currently fails closed',
        handler,
        extraConfig: { dryRun: dryRunOption },
      }),
      leafCommand({
        name: 'schema',
        description: 'Reserved; currently fails closed',
        handler,
        extraConfig: { dryRun: dryRunOption },
      }),
    ]),
    Command.withDescription('Reserved SQLite migration commands'),
  )

  return Command.make(name).pipe(
    Command.withSubcommands([
      initCommand,
      leafCommand({
        name: 'pull',
        description: 'Pull remote Notion changes into SQLite',
        handler,
      }),
      leafCommand({
        name: 'push',
        description: 'Push accepted local SQLite changes to Notion',
        handler,
        extraConfig: {
          dryRun: dryRunOption,
        },
      }),
      syncCommand,
      leafCommand({
        name: 'status',
        description: 'Print workspace sync status',
        handler,
        extraConfig: {
          workspaceRoot: workspaceRootArg,
        },
      }),
      conflictsCommand,
      leafCommand({
        name: 'forget',
        description: 'Archive or forget a page locally',
        handler,
        extraConfig: {
          pageId: Options.text('page-id').pipe(
            Options.withDescription('Notion page id'),
            Options.optional,
          ),
          dryRun: dryRunOption,
        },
      }),
      leafCommand({
        name: 'restore',
        description: 'Restore a forgotten page locally',
        handler,
        extraConfig: {
          pageId: Options.text('page-id').pipe(
            Options.withDescription('Notion page id'),
            Options.optional,
          ),
          dryRun: dryRunOption,
        },
      }),
      migrateCommand,
      leafCommand({
        name: 'repair',
        description: 'Reserved; currently fails closed',
        handler,
        extraConfig: { dryRun: dryRunOption },
      }),
      leafCommand({
        name: 'doctor',
        description: 'Print diagnostics',
        handler,
      }),
    ]),
    Command.withDescription('SQLite-backed Notion data source sync'),
  )
}

/** Standalone datasource-sync command descriptor for help and completion rendering. */
export const datasourceSyncCommand = makeDatasourceSyncCommand()

/** Root `notion sqlite` command descriptor that fails closed outside the packaged Node runtime. */
export const notionSqliteCommand = makeDatasourceSyncCommand({
  name: 'sqlite',
  handler: runtimeUnavailableHandler,
})

/** Renders standalone datasource-sync shell completions from the shared command tree. */
export const renderDatasourceSyncCompletions = ({
  programName,
  shell,
}: {
  readonly programName: string
  readonly shell: CompletionShell
}) => {
  const completionLines =
    shell === 'fish'
      ? Command.getFishCompletions(datasourceSyncCommand, programName)
      : shell === 'zsh'
        ? Command.getZshCompletions(datasourceSyncCommand, programName)
        : Command.getBashCompletions(datasourceSyncCommand, programName)

  return completionLines.pipe(Effect.map((lines) => `${lines.join('\n')}\n`))
}
