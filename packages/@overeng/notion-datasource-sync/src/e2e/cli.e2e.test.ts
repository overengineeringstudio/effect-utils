import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  runCliCommand,
  runCliCommandWithRuntime,
  runCliMain,
  type CliContext,
} from '../cli/main.ts'
import { propertySurfaceKey } from '../core/canonical.ts'
import { PagePropertyItemPage } from '../core/commands.ts'
import { AbsolutePath, BodyPointer, WorkspaceRelativePath } from '../core/domain.ts'
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
import { NotionSyncStore } from '../store/store.ts'
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
  testIds,
} from '../testing/harness.ts'

const execFileAsync = promisify(execFile)
const packageDir = fileURLToPath(new URL('../..', import.meta.url))
const cliPath = join(packageDir, 'src/cli/main.ts')
const cliTestTimeoutMs = 10_000
const workspaceRoot = decode({ schema: AbsolutePath, value: '/tmp/notion-ds-sync-cli' })

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
  retrieveDatabase: () =>
    Effect.succeed({
      id: 'database-1',
      title: [],
      description: [],
      icon: null,
    }),
  updatePage: (input) =>
    Effect.succeed({
      ...injectedNotionPage(),
      ...(input.inTrash === undefined ? {} : { in_trash: input.inTrash }),
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

describe('CLI command surface', () => {
  it(
    'runs the source CLI through its shebang runtime with node:sqlite available',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-'))
      try {
        const { stdout } = await execFileAsync(
          cliPath,
          [
            'status',
            '--store',
            join(dir, 'store.sqlite'),
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

  it('keeps watch unbounded by default until --max-cycles is provided', () => {
    expect(parseCliCommand(['watch', '--state', '/tmp/watch.json'])).toEqual({
      _tag: 'watch',
      statePath: '/tmp/watch.json',
    })
    expect(parseCliCommand(['watch', '--state', '/tmp/watch.json', '--max-cycles', '2'])).toEqual({
      _tag: 'watch',
      statePath: '/tmp/watch.json',
      maxCycles: 2,
    })
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
              'watch',
              '--state',
              '/tmp/watch.json',
              '--max-cycles',
              '--store',
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
              '--store',
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
          execFileAsync(cliPath, ['watch', '--state', '/tmp/watch.json', '--max-cycles', 'NaN'], {
            cwd: packageDir,
            timeout: cliTestTimeoutMs,
          }),
        ).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining('CliErrorEnvelope'),
        })

        await expect(
          execFileAsync(
            cliPath,
            [
              'watch',
              '--state',
              '/tmp/watch.json',
              '--max-cycles',
              '0',
              '--store',
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
        'watch',
        '--state',
        '/tmp/watch.json',
        '--max-cycles',
        '1',
        '--max-cycles',
        '2',
      ]),
    ).toThrow(CliArgumentError)

    expect(() =>
      parseCliCommand(['watch', '--state', '/tmp/watch.json', '--max-cycles', '1e2']),
    ).toThrow('--max-cycles must be a positive integer')
    expect(() =>
      parseCliCommand(['watch', '--state', '/tmp/watch.json', '--max-cycles', 'Infinity']),
    ).toThrow('--max-cycles must be a positive integer')
    expect(() =>
      parseCliCommand(['watch', '--state', '/tmp/watch.json', '--max-cycles', '-1']),
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
      workspaceRoot: '/tmp/notion-workspace',
      dryRun: false,
    })
    expect(parseCliCommand(['sync', '/tmp/notion-workspace', '--dry-run'])).toEqual({
      _tag: 'sync',
      workspaceRoot: '/tmp/notion-workspace',
      dryRun: true,
    })
    expect(() => parseCliCommand(['sync', '--from-notion'])).toThrow(CliArgumentError)
    expect(() => parseCliCommand(['sync', '/tmp/a', '/tmp/b'])).toThrow(CliArgumentError)
  })

  it('discovers established workspace config for sync and suggests establishment when missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-config-'))
    try {
      expect(() => parseCliContext(['sync', dir])).toThrow(
        'Missing datasource-sync workspace config',
      )
      await mkdir(join(dir, '.notion-datasource-sync'), { recursive: true })
      await writeFile(join(dir, '.notion-datasource-sync', 'store.sqlite'), '', 'utf8')
      await writeFile(
        join(dir, '.notion-datasource-sync', 'config.json'),
        `${JSON.stringify(
          {
            version: 1,
            rootId: 'data-source:data-source-1',
            dataSourceId: testIds.dataSourceId,
            storePath: join(dir, '.notion-datasource-sync', 'store.sqlite'),
            workspaceRoot: dir,
            notionApiVersion: '2026-03-11',
            bodyMaterialization: 'enabled',
          },
          null,
          2,
        )}\n`,
        'utf8',
      )
      const ctx = parseCliContext(['sync', dir])
      try {
        expect(ctx.rootId).toBe('data-source:data-source-1')
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
    'fails closed for unsupported $expected before creating the SQLite store',
    async ({ argv, expected }) => {
      const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-unsupported-'))
      const storePath = join(dir, `${expected}.sqlite`)
      try {
        await expect(
          execFileAsync(
            cliPath,
            [
              ...argv,
              '--store',
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

        await expectSqliteStoreFilesAbsent(storePath)
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
        const { stdout } = await execFileAsync(
          cliPath,
          [
            'status',
            '--store',
            join(dir, 'store.sqlite'),
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

  it('does not open the store when context JSON is malformed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-cli-context-'))
    const storePath = join(dir, 'store.sqlite')
    try {
      await expect(
        Effect.runPromise(
          runCliMain({
            argv: [
              'status',
              '--store',
              storePath,
              '--root-id',
              testIds.rootId,
              '--data-source-id',
              testIds.dataSourceId,
              '--workspace-root',
              workspaceRoot,
              '--query-contract-json',
              '{',
            ],
          }),
        ),
      ).rejects.toThrow()

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
      patchDataSourceSchema: () => Effect.die('patchDataSourceSchema should not be called'),
      patchDataSourceMetadata: () => Effect.die('patchDataSourceMetadata should not be called'),
      trashPage: () => Effect.die('trashPage should not be called'),
      restorePage: () => Effect.die('restorePage should not be called'),
    }

    try {
      await expect(
        Effect.runPromise(
          runCliMain({
            argv: [
              'pull',
              '--store',
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
      expect(calls).toEqual({ retrieveDataSource: 2, queryDataSource: 1, retrievePage: 1 })
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
            workspaceRoot,
          },
          ctx,
        ),
        { gateway: gateway.gateway, body: ports.body, workspace },
      )
      const afterFirstEvents = storeFixture.store.replay(testIds.rootId).length
      const second = await runWithPorts(
        runCliCommand(
          {
            _tag: 'sync-from-notion',
            dataSourceId: testIds.dataSourceId,
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

  it('runs one bounded watch cycle through real runtime wiring over a temp filesystem', async () => {
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
          command: { _tag: 'watch', statePath: join(dir, 'watch.json'), maxCycles: 1 },
          context: ctx,
          options: { gatewayClient: makeInjectedNotionClient(calls), body },
        }),
      )

      expect(result).toMatchObject({
        command: 'watch',
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
