import { Effect } from 'effect'
import { Argument as Args, Command, Flag as Options } from 'effect/unstable/cli'

/** Handler used by the import-safe command descriptor for executable leaf commands. */
export type DatasourceDbCommandHandler = (command: string) => Effect.Effect<void>

/** Shells supported by Effect CLI completion generation for datasource-sync. */
export type CompletionShell = 'bash' | 'fish' | 'sh' | 'zsh'

const defaultHandler: DatasourceDbCommandHandler = () => Effect.void

const workspaceRootArg = Args.string('workspace-root').pipe(
  Args.withDescription('Workspace root or SQLite replica path'),
  Args.optional,
)

const dryRunOption = Options.boolean('dry-run').pipe(
  Options.withDescription('Validate without mutating local or remote state'),
  Options.withDefault(false),
)

const outputOption = Options.file('output').pipe(
  Options.withDescription('Export output path'),
  Options.optional,
)

const sqliteOption = Options.file('sqlite').pipe(
  Options.withDescription('SQLite store path'),
  Options.optional,
)

const rootIdOption = Options.string('root-id').pipe(
  Options.withDescription('Sync root id'),
  Options.optional,
)

const dataSourceIdOption = Options.string('data-source-id').pipe(
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
  readonly handler: DatasourceDbCommandHandler
  readonly extraConfig?: {}
}) =>
  Command.make(name, { ...commonOptions, ...extraConfig }, () => handler(name)).pipe(
    Command.withDescription(description),
  )

/** Builds the import-safe `notion db` subcommands shared by the root CLI and Node runtime. */
// oxlint-disable-next-line overeng/exports-first -- command builders depend on local option descriptors.
export const makeDatasourceDbSubcommands = (
  handler: DatasourceDbCommandHandler = defaultHandler,
) => {
  const syncCommand = Command.make(
    'sync',
    {
      ...commonOptions,
      workspaceRoot: workspaceRootArg,
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
      watchPriority: Options.choice('watch-priority', [
        'development',
        'normal',
        'low-priority',
      ]).pipe(Options.withDescription('Watch daemon pacing priority'), Options.optional),
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
      noMaterializeBodies: noMaterializeBodiesOption,
    },
    () => handler('sync'),
  ).pipe(
    Command.withDescription(
      'Reconcile an established workspace, or run the watch daemon with --watch',
    ),
  )

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
          conflictId: Options.string('conflict-id').pipe(
            Options.withDescription('Conflict id to resolve'),
            Options.optional,
          ),
          strategy: Options.choice('strategy', ['keep-remote', 'keep-local', 'manual']).pipe(
            Options.withDescription('Conflict resolution strategy'),
            Options.optional,
          ),
          valueJson: Options.string('value-json').pipe(
            Options.withDescription('Manual resolution value as JSON'),
            Options.optional,
          ),
          dryRun: dryRunOption,
        },
      }),
    ]),
    Command.withDescription('Inspect and resolve SQLite sync conflicts'),
  )

  const trackCommand = Command.make(
    'track',
    {
      ...commonOptions,
      remoteRef: Args.string('remote-ref').pipe(
        Args.withDescription('Notion data source or database URL to adopt'),
        Args.optional,
      ),
      workspaceRoot: workspaceRootArg,
      mode: Options.choice('mode', ['local', 'remote', 'shared']).pipe(
        Options.withDescription('Workspace authority mode (persisted to the manifest)'),
        Options.optional,
      ),
      dryRun: dryRunOption,
      limit: Options.integer('limit').pipe(
        Options.withDescription('Dry-run preview row limit for track --dry-run'),
        Options.optional,
      ),
      noMaterializeBodies: noMaterializeBodiesOption,
    },
    () => handler('track'),
  ).pipe(Command.withDescription('Adopt a Notion data source into a workspace (the adoption verb)'))

  return [
    trackCommand,
    syncCommand,
    Command.make(
      'export',
      {
        ...commonOptions,
        workspaceRoot: workspaceRootArg,
        output: outputOption,
        refresh: Options.boolean('refresh').pipe(
          Options.withDescription(
            'Re-observe the established binding (remote observe/project only) before exporting',
          ),
          Options.withDefault(false),
        ),
        format: Options.choice('format', ['ndjson', 'json']).pipe(
          Options.withDescription('Export file format'),
          Options.optional,
        ),
        requireClean: Options.boolean('require-clean').pipe(
          Options.withDescription('Fail if the replica has pending local changes or conflicts'),
          Options.withDefault(false),
        ),
        dryRun: dryRunOption,
        noMaterializeBodies: noMaterializeBodiesOption,
      },
      () => handler('export'),
    ).pipe(Command.withDescription('Export rows, schema, and sync metadata from SQLite')),
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
        pageId: Options.string('page-id').pipe(
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
        pageId: Options.string('page-id').pipe(
          Options.withDescription('Notion page id'),
          Options.optional,
        ),
        dryRun: dryRunOption,
      },
    }),
    leafCommand({
      name: 'doctor',
      description: 'Print diagnostics',
      handler,
    }),
  ] as const
}

/** Builds the datasource-sync CLI command tree without importing Node-only runtime modules. */
// oxlint-disable-next-line overeng/exports-first -- command builders depend on local option descriptors.
export const makeDatasourceSyncCommand = ({
  name = 'notion-db-runtime',
  handler = defaultHandler,
}: {
  readonly name?: 'notion-db-runtime' | 'db'
  readonly handler?: DatasourceDbCommandHandler
} = {}) => {
  return Command.make(name).pipe(
    Command.withSubcommands(makeDatasourceDbSubcommands(handler)),
    Command.withDescription('Notion database replica sync'),
  )
}

/** Internal Node-backed datasource-sync command descriptor for help and completion rendering. */
// oxlint-disable-next-line overeng/exports-first -- command descriptor depends on the local builder.
export const datasourceSyncCommand = makeDatasourceSyncCommand()

/** Renders datasource-sync shell completions from the shared command tree. */
// oxlint-disable-next-line overeng/exports-first -- completion rendering depends on the local descriptor.
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
