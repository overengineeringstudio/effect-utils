import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect, Schema } from 'effect'

import {
  bodySafetySnapshot,
  makeFakePageBodySyncPort,
  type FakeBodyPageState,
} from '../body/adapter.ts'
import {
  bodySurfaceKey,
  pageSurfaceKey,
  propertySurfaceKey,
  querySurfaceKey,
} from '../core/canonical.ts'
import {
  PatchPagePropertiesCommand,
  QueryRowsPage,
  TrashPageCommand,
  type BodyLocalChangeInput,
  type CanonicalPropertyValue,
  type PagePropertyItemPage,
  type PatchDataSourceSchemaCommand,
  type RemoteWriteCommand,
  type QueryContract,
  type RestorePageCommand,
} from '../core/commands.ts'
import {
  BodyPointer,
  CommandId,
  DataSourceId,
  Hash,
  NotionRequestId,
  PageId,
  PropertyId,
  type BodyPointer as BodyPointerType,
  type CapabilityName,
  type DataSourceSnapshot,
  type Hash as HashType,
  type LocalArtifactObservation,
  type PageSnapshot,
  type PathClaimPlan,
  type RowPageSnapshot,
} from '../core/domain.ts'
import {
  IdempotencyKey,
  SyncEvent,
  SyncEventId,
  SyncRootId,
  type SurfaceKey,
  type SyncEvent as SyncEventType,
} from '../core/events.ts'
import type {
  BodySafetySnapshot,
  GuardName,
  QueryAbsenceSnapshot,
  QueryCompletenessSnapshot,
} from '../core/guards.ts'
import type { NotionDataSourceGatewayShape } from '../core/ports.ts'
import { makeFakeNotionDataSourceGateway } from '../gateway/fake.ts'
import { defaultWorkspacePolicy, makeFakeLocalWorkspacePort } from '../local/workspace.ts'
import type {
  BodyAdapterResultIntent,
  OutboxCommandEnvelope,
  LocalDeleteIntent,
  PlannerProjectionSnapshot,
  PropertyEditIntent,
  QueryAbsenceIntent,
} from '../planner/planner.ts'
import { pageLifecycleHash } from '../store/projections.ts'
import {
  openNotionSyncStore,
  type NotionSyncStore,
  type OpenNotionSyncStoreOptions,
} from '../store/store.ts'

/** Decode an unknown value against a schema using sync semantics — throws on invalid input (test-only helper, mirrors `Schema.decodeUnknownSync(schema)(value)`). */
export function decode<TSchema extends Schema.Schema.AnyNoContext>(
  input: {
    readonly schema: TSchema
    readonly value: unknown
  },
): typeof input.schema.Type
export function decode<TSchema extends Schema.Schema.AnyNoContext>(
  schema: TSchema,
  value: unknown,
): typeof schema.Type
export function decode<TSchema extends Schema.Schema.AnyNoContext>(
  input: TSchema | { readonly schema: TSchema; readonly value: unknown },
  value?: unknown,
) {
  if ('schema' in input) {
    return Schema.decodeUnknownSync(input.schema)(input.value)
  }

  return Schema.decodeUnknownSync(input)(value)
}

/** Build a decoded `Hash` branded value from an arbitrary string — stable shorthand for test assertions. */
export const hash = (value: string): HashType =>
  decode({ schema: Hash, value: `sha256:${createHash('sha256').update(value).digest('hex')}` })

/** Canonical set of decoded branded IDs shared across unit and e2e tests — use `testIds` for the pre-built instance. */
export type TestIds = {
  readonly rootId: SyncRootId
  readonly dataSourceId: DataSourceId
  readonly otherDataSourceId: DataSourceId
  readonly pageId: PageId
  readonly otherPageId: PageId
  readonly propertyA: PropertyId
  readonly propertyB: PropertyId
  readonly commandId: CommandId
  readonly intentEventId: SyncEventId
  readonly commandKey: IdempotencyKey
  readonly requestId: NotionRequestId
}

/** Pre-built set of decoded branded IDs for use in tests — covers a single root, two data sources, two pages, two properties, one command, one intent event, one command key, and one request ID. */
export const testIds: TestIds = {
  rootId: decode({ schema: SyncRootId, value: 'root-1' }),
  dataSourceId: decode({ schema: DataSourceId, value: 'data-source-1' }),
  otherDataSourceId: decode({ schema: DataSourceId, value: 'data-source-2' }),
  pageId: decode({ schema: PageId, value: 'page-1' }),
  otherPageId: decode({ schema: PageId, value: 'page-2' }),
  propertyA: decode({ schema: PropertyId, value: 'prop-a' }),
  propertyB: decode({ schema: PropertyId, value: 'prop-b' }),
  commandId: decode({ schema: CommandId, value: 'cmd-1' }),
  intentEventId: decode({ schema: SyncEventId, value: 'intent-1' }),
  commandKey: decode({ schema: IdempotencyKey, value: 'intent:cmd-1' }),
  requestId: decode({ schema: NotionRequestId, value: 'request-1' }),
}

/** Fixed ISO timestamp used as the baseline `observedAt` value across all harness fixtures — keeps snapshots deterministic. */
export const fixedObservedAt = '2026-05-25T00:00:00.000Z'

/** Controllable clock for tests — use `makeFakeClock` to create an instance whose time can be advanced deterministically. */
export type FakeClock = {
  readonly now: () => Date
  readonly nowIso: () => string
  readonly advanceMillis: (millis: number) => Date
}

/** Create a `FakeClock` starting at `initial` (defaults to `fixedObservedAt`) — `advanceMillis` moves the clock forward and returns the new time. */
export const makeFakeClock = (initial = fixedObservedAt): FakeClock => {
  let current = new Date(initial)

  return {
    now: () => new Date(current.getTime()),
    nowIso: () => current.toISOString(),
    advanceMillis: (millis) => {
      current = new Date(current.getTime() + millis)
      return new Date(current.getTime())
    },
  }
}

/** Tagged union representing a single rate-limiter decision — `allowed` lets the call through; `retry-after` signals a backoff delay. */
export type FakeRateLimitDecision =
  | { readonly _tag: 'allowed' }
  | { readonly _tag: 'retry-after'; readonly retryAfterMillis: number }

/** Scriptable rate-limiter for tests — replays a fixed sequence of `decisions`, repeating the last entry once exhausted. */
export type FakeRateLimiter = {
  readonly decisions: ReadonlyArray<FakeRateLimitDecision>
  readonly acquire: () => FakeRateLimitDecision
}

/** Create a `FakeRateLimiter` from a sequence of decisions — defaults to a single `allowed` entry. */
export const makeFakeRateLimiter = (
  decisions: ReadonlyArray<FakeRateLimitDecision> = [{ _tag: 'allowed' }],
): FakeRateLimiter => {
  let index = 0

  return {
    decisions,
    acquire: () => {
      const decision = decisions[Math.min(index, decisions.length - 1)] ?? { _tag: 'allowed' }
      index += 1
      return decision
    },
  }
}

/** Configuration knobs for `makeFakeGatewayHarness` — all fields are optional and fall back to sensible defaults. */
export type FakeGatewayInput = {
  readonly capabilities?: ReadonlyArray<CapabilityName>
  readonly dataSource?: DataSourceSnapshot
  readonly pages?: ReadonlyArray<PageSnapshot>
  readonly propertyPages?: ReadonlyArray<PagePropertyItemPage>
  readonly queryResultCap?: number
  readonly queryPageLimit?: number
  readonly pagePropertyPageSize?: number
  readonly permissionAmbiguousDataSourceIds?: ReadonlyArray<DataSourceId>
  readonly permissionAmbiguousPageIds?: ReadonlyArray<PageId>
  readonly readAfterWriteMismatchPageIds?: ReadonlyArray<PageId>
}

/** Wrapper around a fake `NotionDataSourceGatewayShape` that intercepts mutations and exposes observed command lists for assertions. */
export type FakeGatewayHarness = {
  readonly gateway: NotionDataSourceGatewayShape
  readonly ledger: FakeGatewayMutationLedger
  readonly patchedPageProperties: ReadonlyArray<PatchPagePropertiesCommand>
  readonly patchedDataSourceSchemas: ReadonlyArray<PatchDataSourceSchemaCommand>
  readonly trashedPages: ReadonlyArray<TrashPageCommand>
  readonly restoredPages: ReadonlyArray<RestorePageCommand>
}

/** Separate attempted vs. successful mutation counts for each command type — lets tests assert that commands were attempted but not committed when an error is injected. */
export type FakeGatewayMutationLedger = {
  readonly attemptedPatchPageProperties: ReadonlyArray<PatchPagePropertiesCommand>
  readonly successfulPatchPageProperties: ReadonlyArray<PatchPagePropertiesCommand>
  readonly attemptedPatchDataSourceSchemas: ReadonlyArray<PatchDataSourceSchemaCommand>
  readonly successfulPatchDataSourceSchemas: ReadonlyArray<PatchDataSourceSchemaCommand>
  readonly attemptedTrashPages: ReadonlyArray<TrashPageCommand>
  readonly successfulTrashPages: ReadonlyArray<TrashPageCommand>
  readonly attemptedRestorePages: ReadonlyArray<RestorePageCommand>
  readonly successfulRestorePages: ReadonlyArray<RestorePageCommand>
}

/** Build a `FakeGatewayHarness` — wraps `makeFakeNotionDataSourceGateway` and taps all mutation calls into the `ledger` for assertion. */
export const makeFakeGatewayHarness = (input: FakeGatewayInput = {}): FakeGatewayHarness => {
  const patchedPageProperties: PatchPagePropertiesCommand[] = []
  const patchedDataSourceSchemas: PatchDataSourceSchemaCommand[] = []
  const trashedPages: TrashPageCommand[] = []
  const restoredPages: RestorePageCommand[] = []
  const attemptedPatchPageProperties: PatchPagePropertiesCommand[] = []
  const attemptedPatchDataSourceSchemas: PatchDataSourceSchemaCommand[] = []
  const attemptedTrashPages: TrashPageCommand[] = []
  const attemptedRestorePages: RestorePageCommand[] = []
  const dataSource =
    input.dataSource ??
    ({
      _tag: 'DataSourceSnapshot',
      dataSourceId: testIds.dataSourceId,
      requestId: testIds.requestId,
      observedAt: decode({ schema: Schema.DateTimeUtc, value: fixedObservedAt }),
      schemaHash: hash('schema'),
    } satisfies DataSourceSnapshot)
  const propertyPages = input.propertyPages ?? []
  const pages = (input.pages ?? [pageSnapshot()]).map((page) => ({
    snapshot: page,
    row: rowSnapshot({
      pageId: page.pageId,
      propertiesHash: page.propertiesHash,
      inTrash: page.inTrash,
    }),
    propertyItems: propertyPages
      .filter((propertyPage) => propertyPage.pageId === page.pageId)
      .map((propertyPage) => ({
        propertyId: propertyPage.propertyId,
        items: propertyPage.items,
      })),
  }))

  const baseGateway = makeFakeNotionDataSourceGateway({
    ...(input.capabilities === undefined ? {} : { supportedCapabilities: input.capabilities }),
    ...(input.readAfterWriteMismatchPageIds === undefined
      ? {}
      : { readAfterWriteMismatchPageIds: input.readAfterWriteMismatchPageIds }),
    ...(input.queryResultCap === undefined ? {} : { queryResultCap: input.queryResultCap }),
    ...(input.queryPageLimit === undefined ? {} : { queryPageLimit: input.queryPageLimit }),
    ...(input.pagePropertyPageSize === undefined
      ? {}
      : { pagePropertyPageSize: input.pagePropertyPageSize }),
    ...(input.permissionAmbiguousDataSourceIds === undefined
      ? {}
      : { permissionAmbiguousDataSourceIds: input.permissionAmbiguousDataSourceIds }),
    ...(input.permissionAmbiguousPageIds === undefined
      ? {}
      : { permissionAmbiguousPageIds: input.permissionAmbiguousPageIds }),
    dataSources: [dataSource],
    pages,
  })
  const ledger = {
    attemptedPatchPageProperties,
    successfulPatchPageProperties: patchedPageProperties,
    attemptedPatchDataSourceSchemas,
    successfulPatchDataSourceSchemas: patchedDataSourceSchemas,
    attemptedTrashPages,
    successfulTrashPages: trashedPages,
    attemptedRestorePages,
    successfulRestorePages: restoredPages,
  } satisfies FakeGatewayMutationLedger

  return {
    ledger,
    patchedPageProperties,
    patchedDataSourceSchemas,
    trashedPages,
    restoredPages,
    gateway: {
      ...baseGateway,
      patchPageProperties: (command) =>
        Effect.sync(() => attemptedPatchPageProperties.push(command)).pipe(
          Effect.zipRight(baseGateway.patchPageProperties(command)),
          Effect.tap(() => Effect.sync(() => patchedPageProperties.push(command))),
        ),
      patchDataSourceSchema: (command) =>
        Effect.sync(() => attemptedPatchDataSourceSchemas.push(command)).pipe(
          Effect.zipRight(baseGateway.patchDataSourceSchema(command)),
          Effect.tap(() => Effect.sync(() => patchedDataSourceSchemas.push(command))),
        ),
      trashPage: (command) =>
        Effect.sync(() => attemptedTrashPages.push(command)).pipe(
          Effect.zipRight(baseGateway.trashPage(command)),
          Effect.tap(() => Effect.sync(() => trashedPages.push(command))),
        ),
      restorePage: (command) =>
        Effect.sync(() => attemptedRestorePages.push(command)).pipe(
          Effect.zipRight(baseGateway.restorePage(command)),
          Effect.tap(() => Effect.sync(() => restoredPages.push(command))),
        ),
    },
  }
}

/** An open `NotionSyncStore` instance paired with its on-disk path and a `cleanup()` that closes the store and removes the temp directory. */
export type StoreFixture = {
  readonly store: NotionSyncStore
  readonly path: string
  readonly cleanup: () => void
}

/** Open an in-memory (default) or file-backed `NotionSyncStore` for a test — returns a `StoreFixture` with a `cleanup()` that closes the store. */
export const makeStoreFixture = (
  options: Partial<OpenNotionSyncStoreOptions> & { readonly mode?: 'file' | 'memory' } = {},
): StoreFixture => {
  const clock = makeFakeClock()
  const directory =
    options.mode === 'memory' ? undefined : mkdtempSync(join(tmpdir(), 'notion-ds-sync-e2e-'))
  const path =
    options.path ?? (options.mode === 'memory' ? ':memory:' : join(directory!, 'sync.sqlite'))
  const store = openNotionSyncStore({
    path,
    busyTimeoutMs: options.busyTimeoutMs ?? 2_500,
    now: options.now ?? clock.now,
  })

  return {
    store,
    path,
    cleanup: () => {
      store.close()
      if (directory !== undefined) {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  }
}

/** Build a decoded `BodyPointer` fixture pointing to `testIds.pageId` — defaults to `hash('body-a')` for the body hash. */
export const bodyPointer = (bodyHash: HashType = hash('body-a')): BodyPointerType =>
  decode({ schema: BodyPointer, value: {
    _tag: 'BodyPointer',
    pageId: testIds.pageId,
    bodyHash,
    observedAt: fixedObservedAt,
  } })

/** Build a default `RowPageSnapshot` fixture — accepts partial overrides to vary only the fields under test. */
export const rowSnapshot = (overrides: Partial<RowPageSnapshot> = {}): RowPageSnapshot => ({
  _tag: 'RowPageSnapshot',
  pageId: testIds.pageId,
  propertiesHash: hash('properties-a'),
  lastEditedTime: decode({ schema: Schema.DateTimeUtc, value: fixedObservedAt }),
  inTrash: false,
  ...overrides,
})

/** Build a default `PageSnapshot` fixture — accepts partial overrides to vary only the fields under test. */
export const pageSnapshot = (overrides: Partial<PageSnapshot> = {}): PageSnapshot => ({
  _tag: 'PageSnapshot',
  pageId: testIds.pageId,
  dataSourceId: testIds.dataSourceId,
  requestId: testIds.requestId,
  observedAt: decode({ schema: Schema.DateTimeUtc, value: fixedObservedAt }),
  propertiesHash: hash('properties-a'),
  inTrash: false,
  ...overrides,
})

/** Build a decoded `QueryRowsPage` fixture from row snapshots — wraps the raw rows in `QueriedRow` records with the fixed test request ID and contract hash. */
export const queryRowsPage = ({
  rows,
  hasMore,
  nextCursor,
  cappedAtLimit,
}: {
  readonly rows: ReadonlyArray<RowPageSnapshot>
  readonly hasMore: boolean
  readonly nextCursor: QueryRowsPage['nextCursor']
  readonly cappedAtLimit: boolean
}): QueryRowsPage =>
  decode({ schema: QueryRowsPage, value: {
    _tag: 'QueryRowsPage',
    apiVersion: '2026-03-11',
    requestId: testIds.requestId,
    queryContractHash: hash('query-contract'),
    rows: rows.map((row) => ({
      _tag: 'QueriedRow',
      pageId: row.pageId,
      propertiesHash: row.propertiesHash,
      lastEditedTime: fixedObservedAt,
      inTrash: row.inTrash,
    })),
    nextCursor,
    hasMore,
    cappedAtLimit,
  } })

/** Build a baseline `QueryContract` with no filters, no sorts, a page size of 100, and `all-data-source-rows` membership scope. */
export const defaultQueryContract = (): QueryContract => ({
  _tag: 'QueryContract',
  apiVersion: '2026-03-11',
  filter: null,
  sorts: [],
  pageSize: 100,
  highWatermark: null,
  membershipScope: 'all-data-source-rows',
})

/** Alias for `bodySafetySnapshot` — convenience re-export for test files that only import from the harness. */
export const bodySafety = bodySafetySnapshot

/** Build a fully populated `PlannerProjectionSnapshot` fixture — covers schema, rows, properties, bodies, and an empty tombstone/query/path state. Accepts partial overrides. */
export const buildPlannerSnapshot = (
  overrides: Partial<PlannerProjectionSnapshot> = {},
): PlannerProjectionSnapshot => ({
  rootId: testIds.rootId,
  api: { configuredApiVersion: '2026-03-11', compatibilityProof: 'present' },
  capabilities: {
    required: ['page_property_update'],
    supported: ['page_property_update'],
    preflight: 'passed',
  },
  schema: [
    {
      dataSourceId: testIds.dataSourceId,
      propertyId: testIds.propertyA,
      schemaHash: hash('schema'),
      configHash: hash('config-a'),
      writeClass: 'writable',
    },
    {
      dataSourceId: testIds.dataSourceId,
      propertyId: testIds.propertyB,
      schemaHash: hash('schema'),
      configHash: hash('config-b'),
      writeClass: 'writable',
    },
  ],
  rows: [
    {
      pageId: testIds.pageId,
      dataSourceId: testIds.dataSourceId,
      propertiesHash: hash('properties-a'),
      inTrash: false,
      movedOut: false,
      localDeleteCandidate: false,
    },
  ],
  properties: [
    {
      pageId: testIds.pageId,
      propertyId: testIds.propertyA,
      baseHash: hash('property-a-base'),
      remoteHash: hash('property-a-base'),
      availability: 'complete',
      pendingLocal: undefined,
    },
    {
      pageId: testIds.pageId,
      propertyId: testIds.propertyB,
      baseHash: hash('property-b-base'),
      remoteHash: hash('property-b-base'),
      availability: 'complete',
      pendingLocal: undefined,
    },
  ],
  bodies: [
    {
      pageId: testIds.pageId,
      path: 'row--page-1.nmd',
      baseHash: hash('body-a'),
      currentHash: hash('body-a'),
      sidecarIdentityProven: true,
      ownWriteMaterializationIds: [],
      safety: bodySafetySnapshot(),
    },
  ],
  tombstones: [],
  queries: [],
  pathClaims: [],
  localWorkspace: [],
  remoteChanges: [],
  ...overrides,
})

/** Build a `title`-typed `CanonicalPropertyValue` fixture — defaults to plain text `'Updated'`. */
export const propertyPatchValue = (plainText = 'Updated'): CanonicalPropertyValue => ({
  _tag: 'title',
  plainText,
})

/** Build a default `property-edit` planner intent fixture targeting `testIds.propertyA` — accepts partial overrides for scenario-specific fields. */
export const propertyEditIntent = (
  overrides: Partial<PropertyEditIntent> = {},
): PropertyEditIntent => {
  const command = decode({ schema: PatchPagePropertiesCommand, value: {
    _tag: 'PatchPagePropertiesCommand',
    commandId: testIds.commandId,
    pageId: testIds.pageId,
    basePropertiesHash: hash('properties-a'),
    propertyPatch: {
      [testIds.propertyA]: propertyPatchValue(),
    },
  } })

  return {
    _tag: 'property-edit',
    intentEventId: testIds.intentEventId,
    commandKey: testIds.commandKey,
    surface: propertySurfaceKey({ pageId: testIds.pageId, propertyId: testIds.propertyA }),
    pageId: testIds.pageId,
    propertyId: testIds.propertyA,
    command,
    baseHash: hash('property-a-base'),
    desiredHash: hash('property-a-next'),
    expectedPropertyConfigHash: hash('config-a'),
    ...overrides,
  }
}

/** Build a default `query-absence` planner intent fixture — accepts partial overrides for scenario-specific fields. */
export const queryAbsenceIntent = (
  overrides: Partial<QueryAbsenceIntent> = {},
): QueryAbsenceIntent => ({
  _tag: 'query-absence',
  surface: querySurfaceKey({ dataSourceId: testIds.dataSourceId, queryContractHash: hash('query-contract') }),
  dataSourceId: testIds.dataSourceId,
  pageId: testIds.pageId,
  queryContractHash: hash('query-contract'),
  ...overrides,
})

/** Build a query surface fixture combining completeness and absence snapshots — uses `testIds.dataSourceId` and a stable contract hash. */
export const querySurface = ({
  completeness,
  absence,
}: {
  readonly completeness: QueryCompletenessSnapshot
  readonly absence: QueryAbsenceSnapshot
}) => ({
  dataSourceId: testIds.dataSourceId,
  pageId: testIds.pageId,
  queryContractHash: hash('query-contract'),
  completeness,
  absence,
})

/** Build a `body-adapter-result` planner intent fixture — the `safety` snapshot controls which body-safety guards are exercised. */
export const bodyAdapterResultIntent = (safety: BodySafetySnapshot): BodyAdapterResultIntent => ({
  _tag: 'body-adapter-result',
  surface: bodySurfaceKey(testIds.pageId),
  pageId: testIds.pageId,
  safety,
})

/** Build a default `local-delete` planner intent fixture — policy defaults to `candidateOnly` so no remote trash is enqueued without an explicit override. */
export const localDeleteIntent = (
  overrides: Partial<LocalDeleteIntent> = {},
): LocalDeleteIntent => {
  const command = decode({ schema: TrashPageCommand, value: {
    _tag: 'TrashPageCommand',
    commandId: testIds.commandId,
    pageId: testIds.pageId,
    basePropertiesHash: hash('properties-a'),
  } })

  return {
    _tag: 'local-delete',
    intentEventId: testIds.intentEventId,
    commandKey: testIds.commandKey,
    surface: pageSurfaceKey(testIds.pageId),
    pageId: testIds.pageId,
    command,
    baseHash: hash('properties-a'),
    desiredHash: pageLifecycleHash({ pageId: testIds.pageId, inTrash: true }),
    explicitDestructiveIntent: false,
    policy: 'candidateOnly',
    directRetrieve: 'accessible',
    ...overrides,
  }
}

/** Build a default `FakeBodyPageState` fixture — useful as the backing page state for `makeFakePageBodySyncPort`. */
export const fakeBodyPage = (overrides: Partial<FakeBodyPageState> = {}): FakeBodyPageState => ({
  pageId: testIds.pageId,
  pointer: bodyPointer(),
  requestId: testIds.requestId,
  safety: bodySafetySnapshot(),
  ...overrides,
})

/** Build a `BodyLocalChangeInput` fixture representing a local body edit from `hash('body-a')` to `hash('body-next')`. */
export const bodyLocalChangeInput = (
  overrides: Partial<BodyLocalChangeInput> = {},
): BodyLocalChangeInput => ({
  _tag: 'BodyLocalChangeInput',
  pageId: testIds.pageId,
  baseBodyPointer: bodyPointer(),
  localBodyHash: hash('body-next'),
  ...overrides,
})

/** Build the `body` and `workspace` fake ports used by most planner-level tests — defaults to a single `fakeBodyPage` and the default workspace policy. */
export const makeHarnessPorts = (
  input: {
    readonly bodyPages?: ReadonlyArray<FakeBodyPageState>
    readonly localObservations?: ReadonlyArray<LocalArtifactObservation>
    readonly claimedPaths?: ReadonlyArray<PathClaimPlan>
  } = {},
) => ({
  body: makeFakePageBodySyncPort({ pages: input.bodyPages ?? [fakeBodyPage()] }),
  workspace: makeFakeLocalWorkspacePort({
    policy: defaultWorkspacePolicy,
    ...(input.localObservations === undefined ? {} : { observations: input.localObservations }),
    ...(input.claimedPaths === undefined ? {} : { claimedPaths: input.claimedPaths }),
  }),
})

const eventPayload = (canonicalJson: string) => ({
  _tag: 'VersionedJson',
  codecVersion: 'v1',
  canonicalJson,
})

const eventBase = (input: {
  readonly eventId: string
  readonly family: SyncEventType['family']
  readonly eventType: SyncEventType['eventType']
  readonly idempotencyKey: string
  readonly surface?: SurfaceKey
  readonly canonicalJson?: string
}) => ({
  eventId: input.eventId,
  rootId: testIds.rootId,
  sequence: '0',
  codecVersion: 'v1',
  family: input.family,
  eventType: input.eventType,
  idempotencyKey: input.idempotencyKey,
  surface: input.surface ?? null,
  causedByEventIds: [],
  payloadHash: hash('placeholder'),
  payload: eventPayload(input.canonicalJson ?? '{}'),
  observedAt: fixedObservedAt,
})

const commandTag = (command: { readonly _tag: string }): string =>
  command._tag.replace(/Command$/, '')

/** Build a decoded `RemoteWritePlanned` `SyncEvent` fixture — used to pre-populate the outbox before exercising the executor. */
export const remoteWritePlannedEvent = (input: {
  readonly eventId: string
  readonly commandId: CommandId
  readonly commandKey: IdempotencyKey
  readonly intentEventId: SyncEventId
  readonly surface: SurfaceKey
  readonly command: RemoteWriteCommand
  readonly commandTag: string
  readonly baseHash?: HashType
  readonly desiredHash: HashType
  readonly preflight: ReadonlyArray<GuardName>
}): SyncEventType =>
  decode({ schema: SyncEvent, value: {
    _tag: 'RemoteWritePlanned',
    ...eventBase({
      eventId: input.eventId,
      family: 'CommandEnqueued',
      eventType: 'RemoteWritePlanned',
      idempotencyKey: input.commandKey,
      surface: input.surface,
      canonicalJson: JSON.stringify({ command: input.command }),
    }),
    commandId: input.commandId,
    commandKey: input.commandKey,
    intentEventId: input.intentEventId,
    commandTag: input.commandTag,
    ...(input.baseHash === undefined ? {} : { baseHash: input.baseHash }),
    desiredHash: input.desiredHash,
    preflight: input.preflight,
  } })

/** Build a decoded `RemoteWriteAttempted` `SyncEvent` fixture — simulates an in-flight or retryable outbox attempt for recovery tests. */
export const remoteWriteAttemptedEvent = (input: {
  readonly eventId: string
  readonly idempotencyKey: string
  readonly commandId: CommandId
  readonly attempt?: number
  readonly attemptState?: 'running' | 'retryable' | 'blocked' | 'fenced' | 'ambiguous'
  readonly leaseToken?: string
}): SyncEventType =>
  decode({ schema: SyncEvent, value: {
    _tag: 'RemoteWriteAttempted',
    ...eventBase({
      eventId: input.eventId,
      family: 'CommandAttempted',
      eventType: 'RemoteWriteAttempted',
      idempotencyKey: input.idempotencyKey,
      surface: pageSurfaceKey(testIds.pageId),
      canonicalJson: `{"attempt":"${input.eventId}"}`,
    }),
    commandId: input.commandId,
    attempt: input.attempt ?? 1,
    attemptState: input.attemptState ?? 'running',
    leaseToken: input.leaseToken ?? 'lease-1',
  } })

/** Build a decoded `RemoteWriteSettled` `SyncEvent` fixture — used in settlement verification tests to assert that the executor records the correct `observedHash`. */
export const remoteWriteSettledEvent = (input: {
  readonly eventId: string
  readonly idempotencyKey: string
  readonly commandId: CommandId
  readonly commandTag: string
  readonly desiredHash: HashType
  readonly observedHash: HashType
}): SyncEventType =>
  decode({ schema: SyncEvent, value: {
    _tag: 'RemoteWriteSettled',
    ...eventBase({
      eventId: input.eventId,
      family: 'CommandSettled',
      eventType: 'RemoteWriteSettled',
      idempotencyKey: input.idempotencyKey,
      surface: pageSurfaceKey(testIds.pageId),
      canonicalJson: `{"settled":"${input.eventId}"}`,
    }),
    commandId: input.commandId,
    commandTag: input.commandTag,
    requestId: testIds.requestId,
    desiredHash: input.desiredHash,
    observedHash: input.observedHash,
    settlementKind: 'verified-success',
  } })

/** Append a `RemoteWritePlanned` event to the store for a given outbox envelope — shorthand for pre-populating the outbox in executor tests. */
export const appendPlannedCommand = ({
  store,
  command,
}: {
  readonly store: NotionSyncStore
  readonly command: OutboxCommandEnvelope
}): SyncEventType =>
  store.appendEvent(
    remoteWritePlannedEvent({
      eventId: 'event-planned-1',
      commandId: command.commandId,
      commandKey: command.commandKey,
      intentEventId: command.intentEventId,
      surface: command.surface,
      command: command.command,
      commandTag: commandTag(command.command),
      baseHash: command.baseHash,
      desiredHash: command.desiredHash,
      preflight: command.preflight,
    }),
  )
