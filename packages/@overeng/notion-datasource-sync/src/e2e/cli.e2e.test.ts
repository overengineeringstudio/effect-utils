import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { Effect, Option, Schema, Stream } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  CliArgumentError,
  parseCliCommand,
  parseCliContext,
  renderCliResultJson,
  resolveCliCommandNotionRefs,
  runCliCommand,
  runCliCommandWithRuntime,
  runCliMain,
  type CliContext,
} from '../cli/main.ts'
import { propertySurfaceKey } from '../core/canonical.ts'
import { PagePropertyItemPage } from '../core/commands.ts'
import { AbsolutePath, BodyPointer, PageId, WorkspaceRelativePath } from '../core/domain.ts'
import { SyncEventId, type SyncEvent as SyncEventType } from '../core/events.ts'
import {
  LocalWorkspacePort,
  NotionDataSourceGateway,
  PageBodySyncPort,
  type LocalWorkspacePortShape,
  type NotionDataSourceGatewayShape,
} from '../core/ports.ts'
import { makeGatewayError, makeNotionApiContract } from '../gateway/gateway.ts'
import type { NotionGatewayClient, NotionGatewayPage } from '../gateway/notion.ts'
import { presentArtifactObservation } from '../local/workspace.ts'
import { projectReplicaFromSyncStore } from '../replica/replica.ts'
import { NotionSyncStore, openNotionSyncStore } from '../store/store.ts'
import { makeConflictRaisedEvent } from '../sync/observation.ts'
import { initOneShotSync, pullOneShotSync } from '../sync/sync.ts'
import {
  defaultQueryContract,
  decode,
  fakeBodyPage,
  fixedObservedAt,
  hash,
  makeFakeClock,
  makeFakeGatewayHarness,
  makeHarnessPorts,
  makeStoreFixture,
  pageSnapshot,
  testIds,
} from '../testing/harness.ts'
import { computeNotionWebhookSignature } from '../webhook/notion.ts'

const execFileAsync = promisify(execFile)
const packageDir = fileURLToPath(new URL('../..', import.meta.url))
const cliPath = join(packageDir, 'src/cli/main.ts')
const cliTestTimeoutMs = 10_000
const workspaceRoot = decode({ schema: AbsolutePath, value: '/tmp/notion-ds-sync-cli' })
const webhookPathPattern = /^\/notion-datasource-sync\/webhook\/notion\/[0-9a-f-]{36}$/
const webhookSetPathPattern =
  /^--set-path=\/notion-datasource-sync\/webhook\/notion\/[0-9a-f-]{36}$/

const schemaProperties = [
  {
    propertyId: testIds.propertyA,
    configHash: hash('config-a'),
    writeClass: 'writable' as const,
  },
]

const expectSqliteStoreFilesAbsent = async (storePath: string) => {
  await Promise.all(
    [storePath, `${storePath}-wal`, `${storePath}-shm`].map((path) =>
      expect(access(path)).rejects.toThrow(),
    ),
  )
}

const propertyPage = (valueHash = hash('property-a-base')) =>
  decode({
    schema: PagePropertyItemPage,
    value: {
      _tag: 'PagePropertyItemPage',
      apiVersion: '2026-03-11',
      requestId: testIds.requestId,
      pageId: testIds.pageId,
      propertyId: testIds.propertyA,
      items: [
        {
          _tag: 'PagePropertyItem',
          pageId: testIds.pageId,
          propertyId: testIds.propertyA,
          itemHash: valueHash,
          valueHash,
        },
      ],
      nextCursor: null,
      hasMore: false,
    },
  })

const bodyPage = (bodyHash = hash('body-a'), remoteBodyHash = bodyHash) =>
  fakeBodyPage({
    pointer: decode({
      schema: BodyPointer,
      value: {
        _tag: 'BodyPointer',
        pageId: testIds.pageId,
        bodyHash,
        observedAt: fixedObservedAt,
      },
    }),
    remoteBodyHash,
  })

const conflictEvent = (): SyncEventType =>
  makeConflictRaisedEvent({
    rootId: testIds.rootId,
    pageId: testIds.pageId,
    propertyId: testIds.propertyA,
    surface: propertySurfaceKey({ pageId: testIds.pageId, propertyId: testIds.propertyA }),
    baseHash: hash('property-a-base'),
    localHash: hash('property-a-local'),
    remoteHash: hash('property-a-remote'),
    conflictKind: 'property',
    message: 'Local and remote changed the same property',
    now: () => new Date(fixedObservedAt),
  })

const injectedNotionPage = (): NotionGatewayPage => ({
  id: testIds.pageId,
  parent: {
    type: 'data_source_id',
    data_source_id: testIds.dataSourceId,
  },
  properties: {
    [testIds.propertyA]: {
      type: 'title',
      title: [{ plain_text: 'Row' }],
    },
  },
  last_edited_time: fixedObservedAt,
  in_trash: false,
})

const makeInjectedNotionClient = (calls: {
  retrieveDataSource: number
  queryDataSource: number
  retrievePage: number
  retrieveDatabase?: number
}): NotionGatewayClient => ({
  retrieveDataSource: () => {
    calls.retrieveDataSource += 1
    return Effect.succeed({
      id: testIds.dataSourceId,
      properties: {
        [testIds.propertyA]: {
          id: testIds.propertyA,
          name: 'Row',
          type: 'title',
        },
      },
    })
  },
  queryDataSource: () => {
    calls.queryDataSource += 1
    return Effect.succeed({
      results: [injectedNotionPage()],
      nextCursor: Option.none(),
      hasMore: false,
    })
  },
  retrievePage: () => {
    calls.retrievePage += 1
    return Effect.succeed(injectedNotionPage())
  },
  retrievePageProperty: () =>
    Effect.succeed({
      results: [],
      nextCursor: Option.none(),
      hasMore: false,
    }),
  retrieveDatabase: () => {
    calls.retrieveDatabase = (calls.retrieveDatabase ?? 0) + 1
    return Effect.succeed({
      id: 'database-1',
      title: [],
      description: [],
      icon: null,
      data_sources: [{ id: testIds.dataSourceId, name: 'Rows' }],
    })
  },
  updatePage: (input) =>
    Effect.succeed({
      ...injectedNotionPage(),
      ...(input.inTrash === undefined ? {} : { in_trash: input.inTrash }),
    }),
  createPage: (input) =>
    Effect.succeed({
      ...injectedNotionPage(),
      id: `created-${Object.keys(input.properties).join('-')}`,
    }),
  updateDataSource: () =>
    Effect.succeed({
      id: testIds.dataSourceId,
      properties: {},
    }),
  updateDatabase: () =>
    Effect.succeed({
      id: 'database-1',
      title: [],
      description: [],
      icon: null,
    }),
})

const context = (input: {
  readonly store: CliContext['store']
  readonly clock: ReturnType<typeof makeFakeClock>
  readonly maxExecutorSteps?: number
  readonly workspaceRoot?: CliContext['workspaceRoot']
  readonly schemaProperties?: CliContext['schemaProperties']
  readonly requiredCapabilities?: CliContext['requiredCapabilities']
  readonly materializeBodies?: CliContext['materializeBodies']
  readonly tailscaleProcessRunner?: CliContext['tailscaleProcessRunner']
  readonly webhookReceiverPort?: CliContext['webhookReceiverPort']
  readonly webhookReceiverPath?: CliContext['webhookReceiverPath']
  readonly webhookReceiverStarted?: CliContext['webhookReceiverStarted']
}): CliContext => ({
  store: input.store,
  rootId: testIds.rootId,
  dataSourceId: testIds.dataSourceId,
  workspaceRoot: input.workspaceRoot ?? workspaceRoot,
  queryContract: defaultQueryContract(),
  schemaProperties: input.schemaProperties ?? schemaProperties,
  ...(input.requiredCapabilities === undefined
    ? {}
    : { requiredCapabilities: input.requiredCapabilities }),
  ...(input.materializeBodies === undefined ? {} : { materializeBodies: input.materializeBodies }),
  ...(input.maxExecutorSteps === undefined ? {} : { maxExecutorSteps: input.maxExecutorSteps }),
  ...(input.tailscaleProcessRunner === undefined
    ? {}
    : { tailscaleProcessRunner: input.tailscaleProcessRunner }),
  ...(input.webhookReceiverPort === undefined
    ? {}
    : { webhookReceiverPort: input.webhookReceiverPort }),
  ...(input.webhookReceiverPath === undefined
    ? {}
    : { webhookReceiverPath: input.webhookReceiverPath }),
  ...(input.webhookReceiverStarted === undefined
    ? {}
    : { webhookReceiverStarted: input.webhookReceiverStarted }),
  now: input.clock.now,
})

const runWithPorts = <TValue, TError>(
  effect: Effect.Effect<
    TValue,
    TError,
    NotionDataSourceGateway | PageBodySyncPort | LocalWorkspacePort
  >,
  input: {
    readonly gateway: ReturnType<typeof makeFakeGatewayHarness>['gateway']
    readonly body?: ReturnType<typeof makeHarnessPorts>['body']
    readonly workspace?: ReturnType<typeof makeHarnessPorts>['workspace']
  },
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(NotionDataSourceGateway, input.gateway),
      Effect.provideService(PageBodySyncPort, input.body ?? makeHarnessPorts().body),
      Effect.provideService(LocalWorkspacePort, input.workspace ?? makeHarnessPorts().workspace),
    ),
  )

const createBoundSqlite = async ({
  path,
  workspace = workspaceRoot,
}: {
  readonly path: string
  readonly workspace?: typeof AbsolutePath.Type
}): Promise<void> => {
  const clock = makeFakeClock()
  const store = openNotionSyncStore({ path, now: clock.now })
  try {
    initOneShotSync({
      store,
      rootId: testIds.rootId,
      dataSourceId: testIds.dataSourceId,
      workspaceRoot: workspace,
      now: clock.now,
    })
    await runWithPorts(
      pullOneShotSync(
        context({
          store,
          clock,
          workspaceRoot: workspace,
        }),
      ),
      {
        gateway: makeFakeGatewayHarness({ propertyPages: [propertyPage()] }).gateway,
      },
    )
  } finally {
    store.close()
  }
  projectReplicaFromSyncStore({
    syncStorePath: path,
    replicaPath: path,
    rootId: testIds.rootId,
  })
}

describe('CLI command surface', () => {
  it(
    'runs the source CLI through its shebang runtime with node:sqlite available',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-'))
      try {
        const sqlitePath = join(dir, 'store.sqlite')
        await createBoundSqlite({ path: sqlitePath })
        const { stdout } = await execFileAsync(
          cliPath,
          [
            'status',
            '--sqlite',
            sqlitePath,
            '--root-id',
            testIds.rootId,
            '--data-source-id',
            testIds.dataSourceId,
            '--workspace-root',
            workspaceRoot,
          ],
          { cwd: packageDir, timeout: cliTestTimeoutMs },
        )

        expect(JSON.parse(stdout)).toMatchObject({
          _tag: 'CliResultEnvelope',
          command: 'status',
          ok: true,
        })
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    cliTestTimeoutMs,
  )

  it('keeps sync --watch unbounded by default until --max-cycles is provided', () => {
    expect(parseCliCommand(['sync', '--watch', '--state', '/tmp/watch.json'])).toEqual({
      _tag: 'sync',
      watch: true,
      statePath: '/tmp/watch.json',
      dryRun: false,
    })
    expect(parseCliCommand(['sync', '--watch', '/tmp/workspace', '--max-cycles', '2'])).toEqual({
      _tag: 'sync',
      workspaceRoot: '/tmp/workspace',
      dryRun: false,
      watch: true,
      maxCycles: 2,
    })
    expect(
      parseCliCommand([
        'sync',
        '--watch',
        '--webhook',
        'none',
        '--mode',
        'development',
        '--non-interactive',
      ]),
    ).toEqual({
      _tag: 'sync',
      dryRun: false,
      watch: true,
      mode: 'development',
      webhook: 'none',
      nonInteractive: true,
    })
    expect(
      parseCliCommand([
        'sync',
        '--watch',
        '--webhook',
        'tailscale',
        '--webhook-required',
        '--max-cycles',
        '1',
      ]),
    ).toEqual({
      _tag: 'sync',
      dryRun: false,
      watch: true,
      webhook: 'tailscale',
      webhookRequired: true,
      maxCycles: 1,
    })
    expect(parseCliCommand(['sync', '--watch', '--webhook', 'manual'])).toEqual({
      _tag: 'sync',
      dryRun: false,
      watch: true,
      webhook: 'manual',
    })
    expect(() => parseCliCommand(['watch', '--state', '/tmp/watch.json'])).toThrow(CliArgumentError)
  })

  it(
    'emits a structured diagnostic and exits nonzero for invalid numeric flags',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-'))
      try {
        await expect(
          execFileAsync(
            cliPath,
            [
              'sync',
              '--watch',
              '--state',
              '/tmp/watch.json',
              '--max-cycles',
              '--sqlite',
              join(dir, 'store.sqlite'),
              '--root-id',
              testIds.rootId,
              '--data-source-id',
              testIds.dataSourceId,
              '--workspace-root',
              workspaceRoot,
            ],
            { cwd: packageDir, timeout: cliTestTimeoutMs },
          ),
        ).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining('Missing value for --max-cycles'),
        })

        await expect(
          execFileAsync(
            cliPath,
            [
              'status',
              '--sqlite',
              join(dir, 'store.sqlite'),
              '--root-id',
              testIds.rootId,
              '--data-source-id',
              testIds.dataSourceId,
              '--workspace-root',
              workspaceRoot,
              '--max-executor-steps',
            ],
            { cwd: packageDir, timeout: cliTestTimeoutMs },
          ),
        ).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining('Missing value for --max-executor-steps'),
        })

        await expect(
          execFileAsync(
            cliPath,
            ['sync', '--watch', '--state', '/tmp/watch.json', '--max-cycles', 'NaN'],
            {
              cwd: packageDir,
              timeout: cliTestTimeoutMs,
            },
          ),
        ).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining('CliErrorEnvelope'),
        })

        await expect(
          execFileAsync(
            cliPath,
            [
              'sync',
              '--watch',
              '--state',
              '/tmp/watch.json',
              '--max-cycles',
              '0',
              '--sqlite',
              join(dir, 'store.sqlite'),
              '--root-id',
              testIds.rootId,
              '--data-source-id',
              testIds.dataSourceId,
              '--workspace-root',
              workspaceRoot,
            ],
            {
              cwd: packageDir,
              timeout: cliTestTimeoutMs,
            },
          ),
        ).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining('--max-cycles must be a positive integer'),
        })
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    cliTestTimeoutMs * 2,
  )

  it('rejects unsupported numeric flag shapes before command execution', () => {
    expect(() =>
      parseCliCommand([
        'sync',
        '--watch',
        '--state',
        '/tmp/watch.json',
        '--max-cycles',
        '1',
        '--max-cycles',
        '2',
      ]),
    ).toThrow(CliArgumentError)

    expect(() =>
      parseCliCommand(['sync', '--watch', '--state', '/tmp/watch.json', '--max-cycles', '1e2']),
    ).toThrow('--max-cycles must be a positive integer')
    expect(() =>
      parseCliCommand([
        'sync',
        '--watch',
        '--state',
        '/tmp/watch.json',
        '--max-cycles',
        'Infinity',
      ]),
    ).toThrow('--max-cycles must be a positive integer')
    expect(() =>
      parseCliCommand(['sync', '--watch', '--state', '/tmp/watch.json', '--max-cycles', '-1']),
    ).toThrow('--max-cycles must be a positive integer')
  })

  it('parses mutating dry-run flags and explicit unsupported command gaps', () => {
    expect(parseCliCommand(['push', '--dry-run'])).toEqual({
      _tag: 'push',
      dryRun: true,
    })
    expect(parseCliCommand(['sync', '--dry-run'])).toEqual({
      _tag: 'sync',
      dryRun: true,
    })
    expect(
      parseCliCommand(['conflicts', 'resolve', '--conflict-id', 'conflict-1', '--dry-run']),
    ).toMatchObject({
      _tag: 'conflicts-resolve',
      conflictId: 'conflict-1',
      dryRun: true,
    })
    expect(parseCliCommand(['forget', '--page-id', testIds.pageId, '--dry-run'])).toEqual({
      _tag: 'forget',
      pageId: testIds.pageId,
      dryRun: true,
    })
    expect(parseCliCommand(['restore', '--page-id', testIds.pageId, '--dry-run'])).toEqual({
      _tag: 'restore',
      pageId: testIds.pageId,
      dryRun: true,
    })
    expect(parseCliCommand(['migrate', 'store', '--dry-run'])).toEqual({
      _tag: 'migrate-store',
      dryRun: true,
    })
    expect(parseCliCommand(['migrate', 'schema', '--dry-run'])).toEqual({
      _tag: 'migrate-schema',
      dryRun: true,
    })
    expect(parseCliCommand(['repair', '--dry-run'])).toEqual({
      _tag: 'repair',
      dryRun: true,
    })
  })

  it('parses sync-first establishment and established workspace forms', () => {
    expect(
      parseCliCommand([
        'sync',
        '--from-notion',
        '0123456789abcdef0123456789abcdef',
        '/tmp/notion-workspace',
      ]),
    ).toEqual({
      _tag: 'sync-from-notion',
      dataSourceId: '01234567-89ab-cdef-0123-456789abcdef',
      remoteRef: {
        _tag: 'data-source',
        dataSourceId: '01234567-89ab-cdef-0123-456789abcdef',
      },
      workspaceRoot: '/tmp/notion-workspace',
      dryRun: false,
    })
    expect(
      parseCliCommand([
        'sync',
        '--from-notion',
        'https://www.notion.so/example/0123456789abcdef0123456789abcdef?v=feedfacefeedfacefeedfacefeedface',
        '/tmp/notion-workspace',
        '--dry-run',
        '--limit',
        '25',
      ]),
    ).toEqual({
      _tag: 'sync-from-notion',
      dataSourceId: '01234567-89ab-cdef-0123-456789abcdef',
      remoteRef: {
        _tag: 'database',
        databaseId: '01234567-89ab-cdef-0123-456789abcdef',
      },
      workspaceRoot: '/tmp/notion-workspace',
      dryRun: true,
      limit: 25,
    })
    expect(parseCliCommand(['sync', '/tmp/notion-workspace', '--dry-run'])).toEqual({
      _tag: 'sync',
      workspaceRoot: '/tmp/notion-workspace',
      dryRun: true,
    })
    expect(() => parseCliCommand(['sync', '--from-notion'])).toThrow(CliArgumentError)
    expect(() => parseCliCommand(['sync', '/tmp/a', '/tmp/b'])).toThrow(CliArgumentError)
    expect(() =>
      parseCliCommand([
        'sync',
        '--from-notion',
        '0123456789abcdef0123456789abcdef',
        '/tmp/notion-workspace',
        '--limit',
        '25',
      ]),
    ).toThrow('--limit is only supported with sync --from-notion --dry-run')
  })

  it('resolves a Notion database URL to a single child data source before opening context', async () => {
    const calls = {
      retrieveDataSource: 0,
      queryDataSource: 0,
      retrievePage: 0,
      retrieveDatabase: 0,
    }
    const command = parseCliCommand([
      'sync',
      '--from-notion',
      'https://www.notion.so/example/0123456789abcdef0123456789abcdef?v=feedfacefeedfacefeedfacefeedface',
      '/tmp/notion-workspace',
      '--dry-run',
    ])

    const resolved = await Effect.runPromise(
      resolveCliCommandNotionRefs({
        command,
        options: { gatewayClient: makeInjectedNotionClient(calls) },
      }),
    )

    expect(resolved).toMatchObject({
      _tag: 'sync-from-notion',
      dataSourceId: testIds.dataSourceId,
      remoteRef: { _tag: 'data-source', dataSourceId: testIds.dataSourceId },
    })
    expect(calls.retrieveDatabase).toBe(1)
    expect(calls.retrieveDataSource).toBe(0)
  })

  it('fails closed when a Notion database URL has multiple child data sources', async () => {
    const calls = { retrieveDataSource: 0, queryDataSource: 0, retrievePage: 0 }
    const client: NotionGatewayClient = {
      ...makeInjectedNotionClient(calls),
      retrieveDatabase: () =>
        Effect.succeed({
          id: 'database-1',
          title: [],
          description: [],
          icon: null,
          data_sources: [
            { id: testIds.dataSourceId, name: 'First' },
            { id: '00000000-0000-0000-0000-000000000002', name: 'Second' },
          ],
        }),
    }
    const command = parseCliCommand([
      'sync',
      '--from-notion',
      'https://www.notion.so/example/0123456789abcdef0123456789abcdef',
      '/tmp/notion-workspace',
      '--dry-run',
    ])

    await expect(
      Effect.runPromise(
        resolveCliCommandNotionRefs({ command, options: { gatewayClient: client } }),
      ),
    ).rejects.toThrow('multiple child data sources')
  })

  it('renders BigInt values in JSON envelopes without throwing', () => {
    const rendered = renderCliResultJson({
      _tag: 'CliResultEnvelope',
      version: 'v1',
      command: 'status',
      ok: true,
      rootId: testIds.rootId,
      status: { state: 'clean', binding: undefined, counts: { events: 1n } },
      surface: { conflicts: [], guards: [], tombstones: [], outbox: [] },
      result: { sequence: 42n },
    } as unknown as Parameters<typeof renderCliResultJson>[0])

    expect(JSON.parse(rendered)).toMatchObject({
      status: { counts: { events: '1' } },
      result: { sequence: '42' },
    })
  })

  it('rejects the removed --store flag instead of treating it as a workspace dependency', () => {
    expect(() =>
      parseCliContext({
        argv: [
          'status',
          '--store',
          '/tmp/legacy-store.sqlite',
          '--root-id',
          testIds.rootId,
          '--data-source-id',
          testIds.dataSourceId,
          '--workspace-root',
          workspaceRoot,
        ],
      }),
    ).toThrow('--store has been removed')
  })

  it('discovers established workspace config for sync and suggests establishment when missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-config-'))
    try {
      expect(() => parseCliContext({ argv: ['sync', dir] })).toThrow(
        'No self-contained datasource-sync SQLite file found',
      )
      await createBoundSqlite({
        path: join(dir, `${testIds.databaseId}.sqlite`),
        workspace: decode({ schema: AbsolutePath, value: dir }),
      })
      const ctx = parseCliContext({ argv: ['sync', dir] })
      try {
        expect(ctx.rootId).toBe(testIds.rootId)
        expect(ctx.dataSourceId).toBe(testIds.dataSourceId)
        expect(ctx.workspaceRoot).toBe(dir)
      } finally {
        ctx.store.close()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.each([
    { command: { _tag: 'migrate-store' as const, dryRun: true }, expected: 'migrate-store' },
    { command: { _tag: 'migrate-schema' as const, dryRun: true }, expected: 'migrate-schema' },
    { command: { _tag: 'repair' as const, dryRun: true }, expected: 'repair' },
  ])('fails closed for unsupported $expected command execution', async ({ command, expected }) => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const ctx = context({ store: storeFixture.store, clock })

    try {
      await expect(
        runWithPorts(runCliCommand(command, ctx), {
          gateway: makeFakeGatewayHarness().gateway,
        }),
      ).rejects.toThrow(`${expected} is not implemented yet`)
    } finally {
      storeFixture.cleanup()
    }
  })

  it.each([
    { argv: ['migrate', 'store'] as const, expected: 'migrate-store' },
    { argv: ['migrate', 'schema'] as const, expected: 'migrate-schema' },
    { argv: ['repair'] as const, expected: 'repair' },
  ])(
    'fails closed for unsupported $expected with an explicit self-contained SQLite file',
    async ({ argv, expected }) => {
      const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-unsupported-'))
      const storePath = join(dir, `${expected}.sqlite`)
      try {
        await createBoundSqlite({ path: storePath })
        await expect(
          execFileAsync(
            cliPath,
            [
              ...argv,
              '--sqlite',
              storePath,
              '--root-id',
              testIds.rootId,
              '--data-source-id',
              testIds.dataSourceId,
              '--workspace-root',
              workspaceRoot,
            ],
            { cwd: packageDir, timeout: cliTestTimeoutMs },
          ),
        ).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining(`${expected} is not implemented yet`),
        })
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    cliTestTimeoutMs,
  )

  it(
    'accepts valid numeric CLI flags',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-'))
      try {
        const sqlitePath = join(dir, 'store.sqlite')
        await createBoundSqlite({ path: sqlitePath })
        const { stdout } = await execFileAsync(
          cliPath,
          [
            'status',
            '--sqlite',
            sqlitePath,
            '--root-id',
            testIds.rootId,
            '--data-source-id',
            testIds.dataSourceId,
            '--workspace-root',
            workspaceRoot,
            '--max-executor-steps',
            '1',
          ],
          { cwd: packageDir, timeout: cliTestTimeoutMs },
        )

        expect(JSON.parse(stdout)).toMatchObject({
          _tag: 'CliResultEnvelope',
          command: 'status',
          ok: true,
        })
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    cliTestTimeoutMs,
  )

  it('rejects query contracts before opening a product replica store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-context-'))
    const storePath = join(dir, 'store.sqlite')
    try {
      await expect(
        Effect.runPromise(
          runCliMain({
            argv: [
              'status',
              '--sqlite',
              storePath,
              '--root-id',
              testIds.rootId,
              '--data-source-id',
              testIds.dataSourceId,
              '--workspace-root',
              workspaceRoot,
              '--query-contract-json',
              JSON.stringify(defaultQueryContract()),
            ],
          }),
        ),
      ).rejects.toThrow('--query-contract-json is not supported')

      await expectSqliteStoreFilesAbsent(storePath)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('closes the store when command execution fails after context open', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-finalizer-'))
    const originalClose = NotionSyncStore.prototype.close
    const storePrototype = NotionSyncStore.prototype as {
      close: (this: NotionSyncStore) => void
    }
    let closeCalls = 0
    storePrototype.close = function close(this: NotionSyncStore) {
      closeCalls += 1
      return originalClose.call(this)
    }

    const failingGateway: NotionDataSourceGatewayShape = {
      apiContract: makeNotionApiContract({ supportedCapabilities: [] }),
      preflightCapabilities: () =>
        Effect.fail(
          makeGatewayError({
            operation: 'preflightCapabilities',
            dataSourceId: testIds.dataSourceId,
            guard: 'CapabilityPreflightFailed',
            message: 'forced preflight failure',
          }),
        ),
      retrieveDataSource: () => Effect.die('retrieveDataSource should not be called'),
      queryRows: () => Stream.die('queryRows should not be called'),
      retrievePage: () => Effect.die('retrievePage should not be called'),
      retrievePageProperty: () => Stream.die('retrievePageProperty should not be called'),
      patchPageProperties: () => Effect.die('patchPageProperties should not be called'),
      createPage: () => Effect.die('createPage should not be called'),
      patchDataSourceSchema: () => Effect.die('patchDataSourceSchema should not be called'),
      patchDataSourceMetadata: () => Effect.die('patchDataSourceMetadata should not be called'),
      patchDatabaseMetadata: () => Effect.die('patchDatabaseMetadata should not be called'),
      trashPage: () => Effect.die('trashPage should not be called'),
      restorePage: () => Effect.die('restorePage should not be called'),
    }

    try {
      await createBoundSqlite({ path: join(dir, 'store.sqlite') })
      closeCalls = 0
      await expect(
        Effect.runPromise(
          runCliMain({
            argv: [
              'pull',
              '--sqlite',
              join(dir, 'store.sqlite'),
              '--root-id',
              testIds.rootId,
              '--data-source-id',
              testIds.dataSourceId,
              '--workspace-root',
              workspaceRoot,
            ],
            options: { gateway: failingGateway },
          }),
        ),
      ).rejects.toThrow('forced preflight failure')
      expect(closeCalls).toBe(1)
    } finally {
      storePrototype.close = originalClose
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('renders sync progress on stderr while keeping the JSON result on stdout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-progress-'))
    const originalStdoutWrite = process.stdout.write
    const originalStderrWrite = process.stderr.write
    let stdout = ''
    let stderr = ''

    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += Buffer.isBuffer(chunk) === true ? chunk.toString('utf8') : String(chunk)
      return true
    }) as typeof process.stdout.write
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += Buffer.isBuffer(chunk) === true ? chunk.toString('utf8') : String(chunk)
      return true
    }) as typeof process.stderr.write

    try {
      const sqlitePath = join(dir, 'store.sqlite')
      await createBoundSqlite({ path: sqlitePath })
      await Effect.runPromise(
        runCliMain({
          argv: [
            'pull',
            '--sqlite',
            sqlitePath,
            '--root-id',
            testIds.rootId,
            '--data-source-id',
            testIds.dataSourceId,
            '--workspace-root',
            workspaceRoot,
            '--no-materialize-bodies',
          ],
          options: {
            gateway: makeFakeGatewayHarness({ propertyPages: [propertyPage()] }).gateway,
          },
        }),
      )

      expect(JSON.parse(stdout)).toMatchObject({
        _tag: 'CliResultEnvelope',
        command: 'pull',
        ok: true,
      })
      expect(stderr).toContain('notion-datasource-sync')
      expect(stderr).toContain('pull')
      expect(stderr).toContain('100%')
    } finally {
      process.stdout.write = originalStdoutWrite
      process.stderr.write = originalStderrWrite
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('renders sync --watch progress on stderr through the top-level CLI wrapper', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-watch-progress-'))
    const originalStdoutWrite = process.stdout.write
    const originalStderrWrite = process.stderr.write
    let stdout = ''
    let stderr = ''

    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += Buffer.isBuffer(chunk) === true ? chunk.toString('utf8') : String(chunk)
      return true
    }) as typeof process.stdout.write
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += Buffer.isBuffer(chunk) === true ? chunk.toString('utf8') : String(chunk)
      return true
    }) as typeof process.stderr.write

    try {
      const sqlitePath = join(dir, 'store.sqlite')
      await createBoundSqlite({ path: sqlitePath })
      await Effect.runPromise(
        runCliMain({
          argv: [
            'sync',
            '--watch',
            '--sqlite',
            sqlitePath,
            '--state',
            join(dir, 'watch.json'),
            '--max-cycles',
            '1',
            '--no-materialize-bodies',
          ],
          options: {
            gateway: makeFakeGatewayHarness({ propertyPages: [propertyPage()] }).gateway,
          },
        }),
      )

      expect(JSON.parse(stdout)).toMatchObject({
        _tag: 'CliResultEnvelope',
        command: 'sync',
        ok: true,
      })
      expect(stderr).toContain('notion-datasource-sync')
      expect(stderr).toContain('sync')
      expect(stderr).toContain('100%')
    } finally {
      process.stdout.write = originalStdoutWrite
      process.stderr.write = originalStderrWrite
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('wires pull/sync through an injected Notion client, real adapter, and real filesystem workspace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-runtime-'))
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const calls = { retrieveDataSource: 0, queryDataSource: 0, retrievePage: 0 }
    const ctx = context({
      store: storeFixture.store,
      clock,
      workspaceRoot: decode({ schema: AbsolutePath, value: dir }),
      schemaProperties: [],
      webhookReceiverPort: 0,
    })
    const body = makeHarnessPorts({ bodyPages: [bodyPage()] }).body

    try {
      await Effect.runPromise(
        runCliCommandWithRuntime({
          command: {
            _tag: 'init',
            dataSourceId: testIds.dataSourceId,
            workspaceRoot: ctx.workspaceRoot,
          },
          context: ctx,
          options: { gatewayClient: makeInjectedNotionClient(calls), body },
        }),
      )

      const result = await Effect.runPromise(
        runCliCommandWithRuntime({
          command: { _tag: 'sync' },
          context: ctx,
          options: { gatewayClient: makeInjectedNotionClient(calls), body },
        }),
      )

      expect(result).toMatchObject({
        _tag: 'CliResultEnvelope',
        command: 'sync',
        status: { state: 'clean' },
      })
      expect(calls).toEqual({ retrieveDataSource: 2, queryDataSource: 1, retrievePage: 0 })
      await expect(
        readFile(join(dir, `page-${testIds.pageId}--${testIds.pageId}.nmd`), 'utf8'),
      ).resolves.toContain('notion-datasource-sync body materialization placeholder')
    } finally {
      storeFixture.cleanup()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('establishes from Notion as a remote-only first run and reruns idempotently', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const ctx = context({ store: storeFixture.store, clock })
    const ports = makeHarnessPorts({ bodyPages: [bodyPage()] })
    const localWrites = {
      scans: 0,
      materializations: 0,
    }
    const workspace: LocalWorkspacePortShape = {
      scan: (root) => {
        localWrites.scans += 1
        return ports.workspace.scan(root)
      },
      claimPath: ports.workspace.claimPath,
      materialize: (plan) => {
        localWrites.materializations += 1
        return ports.workspace.materialize(plan)
      },
    }

    try {
      const first = await runWithPorts(
        runCliCommand(
          {
            _tag: 'sync-from-notion',
            dataSourceId: testIds.dataSourceId,
            remoteRef: { _tag: 'data-source', dataSourceId: testIds.dataSourceId },
            workspaceRoot,
          },
          ctx,
        ),
        { gateway: gateway.gateway, body: ports.body, workspace },
      )
      const afterFirstEvents = storeFixture.store.replay(testIds.rootId).length
      clock.advanceMillis(1_000)
      const second = await runWithPorts(
        runCliCommand(
          {
            _tag: 'sync-from-notion',
            dataSourceId: testIds.dataSourceId,
            remoteRef: { _tag: 'data-source', dataSourceId: testIds.dataSourceId },
            workspaceRoot,
          },
          ctx,
        ),
        { gateway: gateway.gateway, body: ports.body, workspace },
      )

      expect(first).toMatchObject({
        command: 'sync-from-notion',
        result: {
          mode: 'establish-from-notion',
          pushed: false,
          pull: { appendedEvents: expect.any(Number) },
        },
      })
      expect(
        (first.result as { readonly pull: { readonly appendedEvents: number } }).pull
          .appendedEvents,
      ).toBeGreaterThan(0)
      expect(second.result).toMatchObject({ pushed: false, pull: { appendedEvents: 0 } })
      expect(storeFixture.store.replay(testIds.rootId)).toHaveLength(afterFirstEvents)
      expect(storeFixture.store.readOutbox(testIds.rootId)).toHaveLength(0)
      expect(localWrites.scans).toBe(0)
      expect(localWrites.materializations).toBe(2)
      expect(gateway.ledger.attemptedPatchPageProperties).toHaveLength(0)
      expect(gateway.ledger.attemptedPatchDataSourceSchemas).toHaveLength(0)
    } finally {
      storeFixture.cleanup()
    }
  })

  it('dry-runs establishment without durable events or body materialization', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const ctx = context({ store: storeFixture.store, clock, materializeBodies: false })
    const ports = makeHarnessPorts({ bodyPages: [bodyPage()] })
    let materializations = 0
    const workspace: LocalWorkspacePortShape = {
      scan: ports.workspace.scan,
      claimPath: ports.workspace.claimPath,
      materialize: (plan) => {
        materializations += 1
        return ports.workspace.materialize(plan)
      },
    }

    try {
      const result = await runWithPorts(
        runCliCommand(
          {
            _tag: 'sync-from-notion',
            dataSourceId: testIds.dataSourceId,
            remoteRef: { _tag: 'data-source', dataSourceId: testIds.dataSourceId },
            workspaceRoot,
            dryRun: true,
          },
          ctx,
        ),
        { gateway: gateway.gateway, body: ports.body, workspace },
      )

      expect(result.result).toMatchObject({
        pushed: false,
        binding: { binding: undefined },
        pull: { appendedEvents: 0 },
      })
      expect(storeFixture.store.replay(testIds.rootId)).toHaveLength(0)
      expect(materializations).toBe(0)
      expect(gateway.ledger.attemptedPatchPageProperties).toHaveLength(0)
    } finally {
      storeFixture.cleanup()
    }
  })

  it('bounded establishment dry-run observes only the preview row limit and writes nothing', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const pageIds = ['page-preview-1', 'page-preview-2', 'page-preview-3'].map((value) =>
      decode({ schema: PageId, value }),
    )
    const pages = pageIds.map((pageId, index) =>
      pageSnapshot({
        pageId,
        propertiesHash: hash(`preview-properties-${index}`),
      }),
    )
    const gateway = makeFakeGatewayHarness({ pages })
    const ctx = context({
      store: storeFixture.store,
      clock,
      materializeBodies: false,
    })
    const ports = makeHarnessPorts({
      bodyPages: pageIds.map((pageId, index) =>
        fakeBodyPage({
          pageId,
          pointer: decode({
            schema: BodyPointer,
            value: {
              _tag: 'BodyPointer',
              pageId,
              bodyHash: hash(`preview-body-${index}`),
              observedAt: fixedObservedAt,
            },
          }),
        }),
      ),
    })
    let materializations = 0
    const workspace: LocalWorkspacePortShape = {
      scan: ports.workspace.scan,
      claimPath: ports.workspace.claimPath,
      materialize: (plan) => {
        materializations += 1
        return ports.workspace.materialize(plan)
      },
    }

    try {
      const result = await runWithPorts(
        runCliCommand(
          {
            _tag: 'sync-from-notion',
            dataSourceId: testIds.dataSourceId,
            remoteRef: { _tag: 'data-source', dataSourceId: testIds.dataSourceId },
            workspaceRoot,
            dryRun: true,
            limit: 2,
          },
          { ...ctx, rowLimit: 2, queryContract: { ...ctx.queryContract, pageSize: 2 } },
        ),
        { gateway: gateway.gateway, body: ports.body, workspace },
      )
      const observation = (
        result.result as { readonly pull: { readonly observation: { readonly query: unknown } } }
      ).pull.observation.query

      expect(observation).toMatchObject({
        rows: 2,
        cappedAtLimit: true,
        rowLimit: 2,
      })
      expect(storeFixture.store.replay(testIds.rootId)).toHaveLength(0)
      expect(materializations).toBe(0)
    } finally {
      storeFixture.cleanup()
    }
  })

  it('blocks establishment when body materialization would overwrite an unmanaged file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-establish-collision-'))
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const calls = { retrieveDataSource: 0, queryDataSource: 0, retrievePage: 0 }
    const ctx = context({
      store: storeFixture.store,
      clock,
      workspaceRoot: decode({ schema: AbsolutePath, value: dir }),
      schemaProperties: [],
    })
    const expectedPath = join(dir, `page-${testIds.pageId}--${testIds.pageId}.nmd`)
    const body = makeHarnessPorts({ bodyPages: [bodyPage()] }).body

    try {
      await writeFile(expectedPath, 'local unmanaged draft', 'utf8')
      await expect(
        Effect.runPromise(
          runCliCommandWithRuntime({
            command: {
              _tag: 'sync-from-notion',
              dataSourceId: testIds.dataSourceId,
              remoteRef: { _tag: 'data-source', dataSourceId: testIds.dataSourceId },
              workspaceRoot: ctx.workspaceRoot,
            },
            context: ctx,
            options: { gatewayClient: makeInjectedNotionClient(calls), body },
          }),
        ),
      ).rejects.toThrow('Workspace path collision has no sidecar or claim identity')
      expect(storeFixture.store.readOutbox(testIds.rootId)).toHaveLength(0)
    } finally {
      storeFixture.cleanup()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fails closed when a discovered workspace binding does not match the config context', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const ctx = context({ store: storeFixture.store, clock })

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.otherDataSourceId,
        workspaceRoot,
        now: clock.now,
      })
      await expect(
        runWithPorts(runCliCommand({ _tag: 'sync', workspaceRoot }, ctx), {
          gateway: gateway.gateway,
        }),
      ).rejects.toThrow('Workspace config/store binding mismatch')
    } finally {
      storeFixture.cleanup()
    }
  })

  it('runs one bounded sync --watch cycle through real runtime wiring over a temp filesystem', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-watch-'))
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const calls = { retrieveDataSource: 0, queryDataSource: 0, retrievePage: 0 }
    const ctx = context({
      store: storeFixture.store,
      clock,
      workspaceRoot: decode({ schema: AbsolutePath, value: dir }),
      schemaProperties: [],
    })
    const body = makeHarnessPorts({ bodyPages: [bodyPage()] }).body

    try {
      await Effect.runPromise(
        runCliCommandWithRuntime({
          command: {
            _tag: 'init',
            dataSourceId: testIds.dataSourceId,
            workspaceRoot: ctx.workspaceRoot,
          },
          context: ctx,
          options: { gatewayClient: makeInjectedNotionClient(calls), body },
        }),
      )

      const result = await Effect.runPromise(
        runCliCommandWithRuntime({
          command: {
            _tag: 'sync',
            watch: true,
            statePath: join(dir, 'watch.json'),
            maxCycles: 1,
          },
          context: ctx,
          options: { gatewayClient: makeInjectedNotionClient(calls), body },
        }),
      )

      expect(result).toMatchObject({
        command: 'sync',
        result: { _tag: 'WatchDaemonRunResult', cycles: 1, completed: 1 },
      })
      await expect(readFile(join(dir, 'watch.json'), 'utf8')).resolves.toContain(
        '"lastCompleteCycle": 1',
      )
    } finally {
      storeFixture.cleanup()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('runs sync --watch with manual webhook mode as a local receiver seam', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-watch-webhook-'))
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const calls = { retrieveDataSource: 0, queryDataSource: 0, retrievePage: 0 }
    const ctx = context({
      store: storeFixture.store,
      clock,
      workspaceRoot: decode({ schema: AbsolutePath, value: dir }),
      schemaProperties: [],
    })
    const body = makeHarnessPorts({ bodyPages: [bodyPage()] }).body

    try {
      await Effect.runPromise(
        runCliCommandWithRuntime({
          command: {
            _tag: 'init',
            dataSourceId: testIds.dataSourceId,
            workspaceRoot: ctx.workspaceRoot,
          },
          context: ctx,
          options: { gatewayClient: makeInjectedNotionClient(calls), body },
        }),
      )

      const result = await Effect.runPromise(
        runCliCommandWithRuntime({
          command: {
            _tag: 'sync',
            watch: true,
            webhook: 'manual',
            statePath: join(dir, 'watch.json'),
            maxCycles: 1,
          },
          context: ctx,
          options: { gatewayClient: makeInjectedNotionClient(calls), body },
        }),
      )

      expect(result).toMatchObject({
        command: 'sync',
        result: {
          _tag: 'SyncWatchRunResult',
          webhook: {
            _tag: 'WebhookManualStatus',
            provider: 'manual',
            state: 'running',
            receiver: {
              path: expect.stringMatching(webhookPathPattern),
            },
            exposure: {
              provider: 'manual',
              path: expect.stringMatching(webhookPathPattern),
            },
          },
          daemon: { _tag: 'WatchDaemonRunResult', cycles: 1, completed: 1 },
        },
      })
    } finally {
      storeFixture.cleanup()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('preserves an explicitly configured webhook receiver path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-watch-webhook-explicit-'))
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const calls = { retrieveDataSource: 0, queryDataSource: 0, retrievePage: 0 }
    const explicitPath = '/custom/notion/webhook'
    const ctx = context({
      store: storeFixture.store,
      clock,
      workspaceRoot: decode({ schema: AbsolutePath, value: dir }),
      schemaProperties: [],
      webhookReceiverPath: explicitPath,
    })
    const body = makeHarnessPorts({ bodyPages: [bodyPage()] }).body

    try {
      await Effect.runPromise(
        runCliCommandWithRuntime({
          command: {
            _tag: 'init',
            dataSourceId: testIds.dataSourceId,
            workspaceRoot: ctx.workspaceRoot,
          },
          context: ctx,
          options: { gatewayClient: makeInjectedNotionClient(calls), body },
        }),
      )

      const result = await Effect.runPromise(
        runCliCommandWithRuntime({
          command: {
            _tag: 'sync',
            watch: true,
            webhook: 'manual',
            statePath: join(dir, 'watch.json'),
            maxCycles: 1,
          },
          context: ctx,
          options: { gatewayClient: makeInjectedNotionClient(calls), body },
        }),
      )

      expect(result).toMatchObject({
        result: {
          _tag: 'SyncWatchRunResult',
          webhook: {
            _tag: 'WebhookManualStatus',
            receiver: { path: explicitPath },
            exposure: { path: explicitPath },
          },
        },
      })
    } finally {
      storeFixture.cleanup()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('checks Tailscale Funnel status for sync --watch --webhook tailscale', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-watch-tailscale-'))
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const calls = { retrieveDataSource: 0, queryDataSource: 0, retrievePage: 0 }
    const tailscaleCalls: string[][] = []
    let tailscaleWebhookPath = ''
    const ctx = context({
      store: storeFixture.store,
      clock,
      workspaceRoot: decode({ schema: AbsolutePath, value: dir }),
      schemaProperties: [],
      webhookReceiverPort: 0,
      tailscaleProcessRunner: async (command, args) => {
        tailscaleCalls.push([command, ...args])
        const setPath = args.find((arg) => arg.startsWith('--set-path='))
        if (setPath !== undefined && setPath.endsWith(' off') === false) {
          tailscaleWebhookPath = setPath.slice('--set-path='.length)
        }
        if (args.join(' ') !== 'funnel status --json') {
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            Web: [
              {
                Path: tailscaleWebhookPath,
                URL: `https://tasks.tailnet.example${tailscaleWebhookPath}`,
              },
            ],
          }),
          stderr: '',
        }
      },
    })
    const body = makeHarnessPorts({ bodyPages: [bodyPage()] }).body

    try {
      await Effect.runPromise(
        runCliCommandWithRuntime({
          command: {
            _tag: 'init',
            dataSourceId: testIds.dataSourceId,
            workspaceRoot: ctx.workspaceRoot,
          },
          context: ctx,
          options: { gatewayClient: makeInjectedNotionClient(calls), body },
        }),
      )

      const result = await Effect.runPromise(
        runCliCommandWithRuntime({
          command: {
            _tag: 'sync',
            watch: true,
            webhook: 'tailscale',
            webhookRequired: true,
            statePath: join(dir, 'watch.json'),
            maxCycles: 1,
          },
          context: ctx,
          options: { gatewayClient: makeInjectedNotionClient(calls), body },
        }),
      )

      expect(tailscaleCalls).toEqual([
        [
          'tailscale',
          'funnel',
          '--bg',
          '--https=443',
          expect.stringMatching(webhookSetPathPattern),
          expect.stringMatching(/^localhost:[0-9]+$/),
        ],
        ['tailscale', 'funnel', 'status', '--json'],
        ['tailscale', 'funnel', '--bg', expect.stringMatching(webhookSetPathPattern), 'off'],
      ])
      expect(result).toMatchObject({
        command: 'sync',
        result: {
          _tag: 'SyncWatchRunResult',
          webhook: {
            _tag: 'WebhookTailscaleStatus',
            provider: 'tailscale',
            state: 'running',
            receiver: {
              path: expect.stringMatching(webhookPathPattern),
            },
            exposure: {
              provider: 'tailscale-funnel',
              publicUrl: expect.stringMatching(
                /^https:\/\/tasks\.tailnet\.example\/notion-datasource-sync\/webhook\/notion\/[0-9a-f-]{36}$/,
              ),
              localTarget: expect.stringMatching(/^localhost:[0-9]+$/),
              path: expect.stringMatching(webhookPathPattern),
            },
          },
          daemon: { _tag: 'WatchDaemonRunResult', cycles: 1, completed: 1 },
        },
      })
    } finally {
      storeFixture.cleanup()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fails sync --watch --webhook-required when Tailscale status is not running', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const ctx = context({
      store: storeFixture.store,
      clock,
      schemaProperties: [],
      webhookReceiverPort: 0,
      tailscaleProcessRunner: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'not running',
      }),
    })

    try {
      await expect(
        Effect.runPromise(
          runCliCommandWithRuntime({
            command: {
              _tag: 'sync',
              watch: true,
              webhook: 'tailscale',
              webhookRequired: true,
              maxCycles: 1,
            },
            context: ctx,
            options: {
              gatewayClient: makeInjectedNotionClient({
                retrieveDataSource: 0,
                queryDataSource: 0,
                retrievePage: 0,
              }),
            },
          }),
        ),
      ).rejects.toThrow('sync --watch --webhook-required could not start Tailscale Funnel')
    } finally {
      storeFixture.cleanup()
    }
  })

  it('wakes sync --watch from a manual webhook delivery before the normal poll interval', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-watch-wake-'))
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const calls = { retrieveDataSource: 0, queryDataSource: 0, retrievePage: 0 }
    let receiverResolve: ((status: { readonly url: string }) => void) | undefined
    const receiverStarted = new Promise<{ readonly url: string }>((resolve) => {
      receiverResolve = resolve
    })
    const ctx = context({
      store: storeFixture.store,
      clock,
      workspaceRoot: decode({ schema: AbsolutePath, value: dir }),
      schemaProperties: [],
      webhookReceiverPort: 0,
      webhookReceiverStarted: (status) => receiverResolve?.(status),
    })
    const body = makeHarnessPorts({ bodyPages: [bodyPage()] }).body
    const verificationToken = 'cli-watch-webhook-verification-token'
    const withTimeout = async <TValue>(promise: Promise<TValue>, millis: number): Promise<TValue> =>
      await Promise.race([
        promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`timed out after ${millis.toString()}ms`)), millis),
        ),
      ])
    const waitForFirstCycle = async () => {
      const deadline = Date.now() + 2_000
      await new Promise<void>((resolve, reject) => {
        const interval = setInterval(() => {
          void (async () => {
            try {
              const state = JSON.parse(await readFile(join(dir, 'watch.json'), 'utf8')) as {
                readonly lastCompleteCycle?: unknown
              }
              if (state.lastCompleteCycle === 1) {
                clearInterval(interval)
                resolve()
                return
              }
            } catch {
              // File is created after the first cycle completes.
            }
            if (Date.now() > deadline) {
              clearInterval(interval)
              reject(new Error('sync --watch did not complete first cycle'))
            }
          })()
        }, 25)
      })
    }

    try {
      await Effect.runPromise(
        runCliCommandWithRuntime({
          command: {
            _tag: 'init',
            dataSourceId: testIds.dataSourceId,
            workspaceRoot: ctx.workspaceRoot,
          },
          context: ctx,
          options: { gatewayClient: makeInjectedNotionClient(calls), body },
        }),
      )

      const running = Effect.runPromise(
        runCliCommandWithRuntime({
          command: {
            _tag: 'sync',
            watch: true,
            webhook: 'manual',
            mode: 'normal',
            statePath: join(dir, 'watch.json'),
            maxCycles: 2,
          },
          context: ctx,
          options: { gatewayClient: makeInjectedNotionClient(calls), body },
        }),
      )

      const receiver = await withTimeout(receiverStarted, 1_000)
      await waitForFirstCycle()

      const verificationResponse = await fetch(receiver.url, {
        method: 'POST',
        body: JSON.stringify({ verification_token: verificationToken }),
        headers: { 'content-type': 'application/json' },
      })
      expect(verificationResponse.status).toBe(200)

      const rawBody = JSON.stringify({
        id: 'cli-watch-wake-event',
        type: 'page.updated',
        timestamp: '2026-05-29T08:00:00.000Z',
        entity: { id: testIds.pageId, type: 'page' },
        data: { parent: { data_source_id: testIds.dataSourceId } },
      })
      const eventResponse = await fetch(receiver.url, {
        method: 'POST',
        body: rawBody,
        headers: {
          'content-type': 'application/json',
          'x-notion-signature': computeNotionWebhookSignature({ rawBody, verificationToken }),
        },
      })
      expect(eventResponse.status).toBe(200)

      const result = await withTimeout(running, 2_500)
      expect(result).toMatchObject({
        command: 'sync',
        result: {
          _tag: 'SyncWatchRunResult',
          daemon: { _tag: 'WatchDaemonRunResult', cycles: 2, completed: 2 },
        },
      })
      expect(storeFixture.store.readSignalStatus(testIds.rootId)).toEqual({
        pending: 0,
        claimed: 0,
        processed: 1,
        failed: 0,
      })
    } finally {
      storeFixture.cleanup()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('wakes sync --watch from a Tailscale webhook delivery before the normal poll interval', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-watch-tailscale-wake-'))
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const calls = { retrieveDataSource: 0, queryDataSource: 0, retrievePage: 0 }
    let receiverResolve: ((status: { readonly url: string }) => void) | undefined
    const receiverStarted = new Promise<{ readonly url: string }>((resolve) => {
      receiverResolve = resolve
    })
    const tailscaleCalls: string[][] = []
    let tailscaleWebhookPath = ''
    const ctx = context({
      store: storeFixture.store,
      clock,
      workspaceRoot: decode({ schema: AbsolutePath, value: dir }),
      schemaProperties: [],
      webhookReceiverPort: 0,
      webhookReceiverStarted: (status) => receiverResolve?.(status),
      tailscaleProcessRunner: async (command, args) => {
        tailscaleCalls.push([command, ...args])
        const setPath = args.find((arg) => arg.startsWith('--set-path='))
        if (setPath !== undefined) {
          tailscaleWebhookPath = setPath.slice('--set-path='.length)
        }
        if (args.join(' ') !== 'funnel status --json') {
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            Web: [
              {
                Path: tailscaleWebhookPath,
                URL: `https://tasks.tailnet.example${tailscaleWebhookPath}`,
              },
            ],
          }),
          stderr: '',
        }
      },
    })
    const body = makeHarnessPorts({ bodyPages: [bodyPage()] }).body
    const verificationToken = 'cli-watch-tailscale-webhook-verification-token'
    const withTimeout = async <TValue>(promise: Promise<TValue>, millis: number): Promise<TValue> =>
      await Promise.race([
        promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`timed out after ${millis.toString()}ms`)), millis),
        ),
      ])
    const waitForFirstCycle = async () => {
      const deadline = Date.now() + 2_000
      await new Promise<void>((resolve, reject) => {
        const interval = setInterval(() => {
          void (async () => {
            try {
              const state = JSON.parse(await readFile(join(dir, 'watch.json'), 'utf8')) as {
                readonly lastCompleteCycle?: unknown
              }
              if (state.lastCompleteCycle === 1) {
                clearInterval(interval)
                resolve()
                return
              }
            } catch {
              // File is created after the first cycle completes.
            }
            if (Date.now() > deadline) {
              clearInterval(interval)
              reject(new Error('sync --watch did not complete first cycle'))
            }
          })()
        }, 25)
      })
    }

    try {
      await Effect.runPromise(
        runCliCommandWithRuntime({
          command: {
            _tag: 'init',
            dataSourceId: testIds.dataSourceId,
            workspaceRoot: ctx.workspaceRoot,
          },
          context: ctx,
          options: { gatewayClient: makeInjectedNotionClient(calls), body },
        }),
      )

      const running = Effect.runPromise(
        runCliCommandWithRuntime({
          command: {
            _tag: 'sync',
            watch: true,
            webhook: 'tailscale',
            mode: 'normal',
            statePath: join(dir, 'watch.json'),
            maxCycles: 2,
          },
          context: ctx,
          options: { gatewayClient: makeInjectedNotionClient(calls), body },
        }),
      )

      const receiver = await withTimeout(receiverStarted, 1_000)
      await waitForFirstCycle()

      const verificationResponse = await fetch(receiver.url, {
        method: 'POST',
        body: JSON.stringify({ verification_token: verificationToken }),
        headers: { 'content-type': 'application/json' },
      })
      expect(verificationResponse.status).toBe(200)

      const rawBody = JSON.stringify({
        id: 'cli-watch-tailscale-wake-event',
        type: 'page.updated',
        timestamp: '2026-05-29T08:00:00.000Z',
        entity: { id: testIds.pageId, type: 'page' },
        data: { parent: { data_source_id: testIds.dataSourceId } },
      })
      const eventResponse = await fetch(receiver.url, {
        method: 'POST',
        body: rawBody,
        headers: {
          'content-type': 'application/json',
          'x-notion-signature': computeNotionWebhookSignature({ rawBody, verificationToken }),
        },
      })
      expect(eventResponse.status).toBe(200)

      const result = await withTimeout(running, 2_500)
      expect(result).toMatchObject({
        command: 'sync',
        result: {
          _tag: 'SyncWatchRunResult',
          webhook: { provider: 'tailscale', state: 'running' },
          daemon: { _tag: 'WatchDaemonRunResult', cycles: 2, completed: 2 },
        },
      })
      expect(tailscaleCalls).toEqual([
        [
          'tailscale',
          'funnel',
          '--bg',
          '--https=443',
          expect.stringMatching(webhookSetPathPattern),
          expect.stringMatching(/^localhost:[0-9]+$/),
        ],
        ['tailscale', 'funnel', 'status', '--json'],
        ['tailscale', 'funnel', '--bg', expect.stringMatching(webhookSetPathPattern), 'off'],
      ])
      expect(storeFixture.store.readSignalStatus(testIds.rootId)).toEqual({
        pending: 0,
        claimed: 0,
        processed: 1,
        failed: 0,
      })
    } finally {
      storeFixture.cleanup()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns clean, pending, and conflict status envelopes for one-shot sync', async () => {
    const cleanClock = makeFakeClock()
    const cleanStore = makeStoreFixture({ mode: 'memory', now: cleanClock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })

    try {
      await runWithPorts(
        runCliCommand(
          {
            _tag: 'init',
            dataSourceId: testIds.dataSourceId,
            workspaceRoot,
          },
          context({ store: cleanStore.store, clock: cleanClock }),
        ),
        { gateway: gateway.gateway },
      )
      const clean = await runWithPorts(
        runCliCommand({ _tag: 'sync' }, context({ store: cleanStore.store, clock: cleanClock })),
        { gateway: gateway.gateway },
      )
      expect(clean).toMatchObject({
        _tag: 'CliResultEnvelope',
        command: 'sync',
        status: { state: 'clean' },
      })
    } finally {
      cleanStore.cleanup()
    }

    const pendingClock = makeFakeClock()
    const pendingStore = makeStoreFixture({ mode: 'memory', now: pendingClock.now })
    try {
      initOneShotSync({
        store: pendingStore.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: pendingClock.now,
      })
      await runWithPorts(
        pullOneShotSync({
          ...context({ store: pendingStore.store, clock: pendingClock }),
          store: pendingStore.store,
        }),
        { gateway: gateway.gateway },
      )
      const pending = await runWithPorts(
        runCliCommand(
          { _tag: 'sync' },
          context({ store: pendingStore.store, clock: pendingClock, maxExecutorSteps: 0 }),
        ),
        {
          gateway: gateway.gateway,
          body: makeHarnessPorts({ bodyPages: [bodyPage()] }).body,
          workspace: makeHarnessPorts({
            localObservations: [
              presentArtifactObservation({
                pageId: testIds.pageId,
                path: decode({ schema: WorkspaceRelativePath, value: 'row--page-1.nmd' }),
                contentHash: hash('body-local'),
                observedAt: decode({ schema: Schema.DateTimeUtc, value: fixedObservedAt }),
              }),
            ],
          }).workspace,
        },
      )
      expect(pending.status.state).toBe('pending')
      expect(pending.status.counts.pending).toBe(1)
    } finally {
      pendingStore.cleanup()
    }

    const conflictClock = makeFakeClock()
    const conflictStore = makeStoreFixture({ mode: 'memory', now: conflictClock.now })
    try {
      initOneShotSync({
        store: conflictStore.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: conflictClock.now,
      })
      await runWithPorts(
        pullOneShotSync({
          ...context({ store: conflictStore.store, clock: conflictClock }),
          store: conflictStore.store,
        }),
        { gateway: gateway.gateway },
      )
      const conflict = await runWithPorts(
        runCliCommand(
          { _tag: 'sync' },
          context({ store: conflictStore.store, clock: conflictClock }),
        ),
        {
          gateway: gateway.gateway,
          body: makeHarnessPorts({ bodyPages: [bodyPage(hash('body-a'), hash('body-remote'))] })
            .body,
          workspace: makeHarnessPorts({
            localObservations: [
              presentArtifactObservation({
                pageId: testIds.pageId,
                path: decode({ schema: WorkspaceRelativePath, value: 'row--page-1.nmd' }),
                contentHash: hash('body-local'),
                observedAt: decode({ schema: Schema.DateTimeUtc, value: fixedObservedAt }),
              }),
            ],
          }).workspace,
        },
      )
      expect(conflict.status.state).toBe('conflict')
      expect(conflict.surface.conflicts).toHaveLength(1)
    } finally {
      conflictStore.cleanup()
    }
  })

  it('dry-runs push and sync without appending events, mutating outbox, or issuing remote writes', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const ctx = context({ store: storeFixture.store, clock })
    const ports = makeHarnessPorts({
      bodyPages: [bodyPage()],
      localObservations: [
        presentArtifactObservation({
          pageId: testIds.pageId,
          path: decode({ schema: WorkspaceRelativePath, value: 'row--page-1.nmd' }),
          contentHash: hash('body-local'),
          observedAt: decode({ schema: Schema.DateTimeUtc, value: fixedObservedAt }),
        }),
      ],
    })

    try {
      await runWithPorts(
        runCliCommand(
          {
            _tag: 'init',
            dataSourceId: testIds.dataSourceId,
            workspaceRoot,
          },
          ctx,
        ),
        { gateway: gateway.gateway },
      )
      await runWithPorts(pullOneShotSync({ ...ctx, store: storeFixture.store }), {
        gateway: gateway.gateway,
      })

      const beforeEvents = storeFixture.store.replay(testIds.rootId).length
      const beforeOutbox = storeFixture.store.readOutbox(testIds.rootId).length

      const push = await runWithPorts(runCliCommand({ _tag: 'push', dryRun: true }, ctx), {
        gateway: gateway.gateway,
        body: ports.body,
        workspace: ports.workspace,
      })
      expect(push.result).toMatchObject({
        plan: { decisions: [{ _tag: 'EnqueueCommands' }] },
        executor: { steps: 0, results: [] },
      })

      const sync = await runWithPorts(runCliCommand({ _tag: 'sync', dryRun: true }, ctx), {
        gateway: gateway.gateway,
        body: ports.body,
        workspace: ports.workspace,
      })
      expect(sync.result).toMatchObject({
        pull: { appendedEvents: 0 },
        push: { plan: { decisions: [{ _tag: 'EnqueueCommands' }] } },
      })

      expect(storeFixture.store.replay(testIds.rootId)).toHaveLength(beforeEvents)
      expect(storeFixture.store.readOutbox(testIds.rootId)).toHaveLength(beforeOutbox)
      expect(gateway.ledger.attemptedPatchPageProperties).toHaveLength(0)
      expect(gateway.ledger.attemptedPatchDataSourceSchemas).toHaveLength(0)
      expect(gateway.ledger.attemptedTrashPages).toHaveLength(0)
      expect(gateway.ledger.attemptedRestorePages).toHaveLength(0)
    } finally {
      storeFixture.cleanup()
    }
  })

  it('lists and resolves conflicts through the existing user-command API', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })

    try {
      const conflict = storeFixture.store.appendEvent(conflictEvent())
      const ctx = context({ store: storeFixture.store, clock })

      const listed = await runWithPorts(runCliCommand({ _tag: 'conflicts-list' }, ctx), {
        gateway: gateway.gateway,
      })
      expect(listed).toMatchObject({
        command: 'conflicts-list',
        status: { state: 'conflict' },
        surface: { conflicts: [{ state: 'open' }] },
      })

      const resolved = await runWithPorts(
        runCliCommand(
          {
            _tag: 'conflicts-resolve',
            conflictId: decode({ schema: SyncEventId, value: conflict.eventId }),
            choice: { _tag: 'keep-remote' },
          },
          ctx,
        ),
        { gateway: gateway.gateway },
      )
      expect(resolved.result).toMatchObject({
        _tag: 'UserCommandResultEnvelope',
        action: 'resolve-conflict:keep-remote',
        applied: { events: [{ _tag: 'ConflictResolved' }] },
      })
      expect(resolved.status.state).toBe('clean')

      const forget = await runWithPorts(
        runCliCommand({ _tag: 'forget', pageId: testIds.pageId }, ctx),
        { gateway: gateway.gateway },
      )
      expect(forget.result).toMatchObject({
        _tag: 'UserCommandResultEnvelope',
        action: 'forget-page',
        applied: { events: [{ _tag: 'RowForgotten' }] },
      })

      const restore = await runWithPorts(
        runCliCommand({ _tag: 'restore', pageId: testIds.pageId, dryRun: true }, ctx),
        { gateway: gateway.gateway },
      )
      expect(restore.result).toMatchObject({
        _tag: 'UserCommandResultEnvelope',
        action: 'restore-page',
        dryRun: true,
      })
    } finally {
      storeFixture.cleanup()
    }
  })

  it('dry-runs conflict resolution, forget, and restore without appending events or outbox rows', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })

    try {
      const conflict = storeFixture.store.appendEvent(conflictEvent())
      const ctx = context({ store: storeFixture.store, clock })
      const beforeEvents = storeFixture.store.replay(testIds.rootId).length
      const beforeOutbox = storeFixture.store.readOutbox(testIds.rootId).length

      const resolved = await runWithPorts(
        runCliCommand(
          {
            _tag: 'conflicts-resolve',
            conflictId: decode({ schema: SyncEventId, value: conflict.eventId }),
            choice: { _tag: 'keep-remote' },
            dryRun: true,
          },
          ctx,
        ),
        { gateway: gateway.gateway },
      )
      expect(resolved.result).toMatchObject({
        _tag: 'UserCommandResultEnvelope',
        action: 'resolve-conflict:keep-remote',
        dryRun: true,
        applied: { events: [], commands: [] },
      })

      const forget = await runWithPorts(
        runCliCommand({ _tag: 'forget', pageId: testIds.pageId, dryRun: true }, ctx),
        { gateway: gateway.gateway },
      )
      expect(forget.result).toMatchObject({
        _tag: 'UserCommandResultEnvelope',
        action: 'forget-page',
        dryRun: true,
        applied: { events: [] },
      })

      const restore = await runWithPorts(
        runCliCommand({ _tag: 'restore', pageId: testIds.pageId, dryRun: true }, ctx),
        { gateway: gateway.gateway },
      )
      expect(restore.result).toMatchObject({
        _tag: 'UserCommandResultEnvelope',
        action: 'restore-page',
        dryRun: true,
        applied: { events: [], commands: [] },
      })

      expect(storeFixture.store.replay(testIds.rootId)).toHaveLength(beforeEvents)
      expect(storeFixture.store.readOutbox(testIds.rootId)).toHaveLength(beforeOutbox)
    } finally {
      storeFixture.cleanup()
    }
  })
})
