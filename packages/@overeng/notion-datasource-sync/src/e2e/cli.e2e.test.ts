import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { propertySurfaceKey } from '../canonical.ts'
import { CliArgumentError, parseCliCommand, runCliCommand, type CliContext } from '../cli.ts'
import { PagePropertyItemPage } from '../commands.ts'
import { AbsolutePath, BodyPointer, WorkspaceRelativePath } from '../domain.ts'
import { SyncEventId, type SyncEvent as SyncEventType } from '../events.ts'
import { presentArtifactObservation } from '../local-workspace.ts'
import { makeConflictRaisedEvent } from '../observation.ts'
import { LocalWorkspacePort, NotionDataSourceGateway, PageBodySyncPort } from '../ports.ts'
import { initOneShotSync, pullOneShotSync } from '../sync.ts'
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
const cliPath = join(packageDir, 'src/cli.ts')
const cliTestTimeoutMs = 10_000
const workspaceRoot = decode(AbsolutePath, '/tmp/notion-ds-sync-cli')

const schemaProperties = [
  {
    propertyId: testIds.propertyA,
    configHash: hash('config-a'),
    writeClass: 'writable' as const,
  },
]

const propertyPage = (valueHash = hash('property-a-base')) =>
  decode(PagePropertyItemPage, {
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
  })

const bodyPage = (bodyHash = hash('body-a'), remoteBodyHash = bodyHash) =>
  fakeBodyPage({
    pointer: decode(BodyPointer, {
      _tag: 'BodyPointer',
      pageId: testIds.pageId,
      bodyHash,
      observedAt: fixedObservedAt,
    }),
    remoteBodyHash,
  })

const conflictEvent = (): SyncEventType =>
  makeConflictRaisedEvent({
    rootId: testIds.rootId,
    pageId: testIds.pageId,
    propertyId: testIds.propertyA,
    surface: propertySurfaceKey(testIds.pageId, testIds.propertyA),
    baseHash: hash('property-a-base'),
    localHash: hash('property-a-local'),
    remoteHash: hash('property-a-remote'),
    conflictKind: 'property',
    message: 'Local and remote changed the same property',
    now: () => new Date(fixedObservedAt),
  })

const context = (input: {
  readonly store: CliContext['store']
  readonly clock: ReturnType<typeof makeFakeClock>
  readonly maxExecutorSteps?: number
}): CliContext => ({
  store: input.store,
  rootId: testIds.rootId,
  dataSourceId: testIds.dataSourceId,
  workspaceRoot,
  queryContract: defaultQueryContract(),
  schemaProperties,
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
  it('runs the source CLI through its shebang runtime with node:sqlite available', async () => {
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
  })

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

  it('emits a structured diagnostic and exits nonzero for invalid numeric flags', async () => {
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
  })

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

  it('accepts valid numeric CLI flags', async () => {
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
                path: decode(WorkspaceRelativePath, 'row--page-1.nmd'),
                contentHash: hash('body-local'),
                observedAt: decode(Schema.DateTimeUtc, fixedObservedAt),
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
                path: decode(WorkspaceRelativePath, 'row--page-1.nmd'),
                contentHash: hash('body-local'),
                observedAt: decode(Schema.DateTimeUtc, fixedObservedAt),
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
            conflictId: decode(SyncEventId, conflict.eventId),
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
})
