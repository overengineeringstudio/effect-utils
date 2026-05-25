import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Schema } from 'effect'

import {
  bodySafetySnapshot,
  makeFakePageBodySyncPort,
  type FakeBodyPageState,
} from '../body-adapter.ts'
import {
  bodySurfaceKey,
  pageSurfaceKey,
  propertySurfaceKey,
  querySurfaceKey,
} from '../canonical.ts'
import {
  PatchPagePropertiesCommand,
  QueryRowsPage,
  TrashPageCommand,
  type BodyLocalChangeInput,
  type CanonicalPropertyValue,
  type PagePropertyItemPage,
  type PatchDataSourceSchemaCommand,
  type QueryContract,
  type RestorePageCommand,
} from '../commands.ts'
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
} from '../domain.ts'
import {
  IdempotencyKey,
  SyncEvent,
  SyncEventId,
  SyncRootId,
  type SurfaceKey,
  type SyncEvent as SyncEventType,
} from '../events.ts'
import { makeFakeNotionDataSourceGateway } from '../gateway-fake.ts'
import type {
  BodySafetySnapshot,
  GuardName,
  QueryAbsenceSnapshot,
  QueryCompletenessSnapshot,
} from '../guards.ts'
import { defaultWorkspacePolicy, makeFakeLocalWorkspacePort } from '../local-workspace.ts'
import type {
  BodyAdapterResultIntent,
  OutboxCommandEnvelope,
  LocalDeleteIntent,
  PlannerProjectionSnapshot,
  PropertyEditIntent,
  QueryAbsenceIntent,
} from '../planner.ts'
import type { NotionDataSourceGatewayShape } from '../ports.ts'
import {
  openNotionSyncStore,
  type NotionSyncStore,
  type OpenNotionSyncStoreOptions,
} from '../store.ts'

export const decode = <TSchema extends Schema.Schema.AnyNoContext>(
  schema: TSchema,
  value: unknown,
): typeof schema.Type => Schema.decodeUnknownSync(schema)(value)

export const hash = (value: string): HashType =>
  decode(Hash, `sha256:${createHash('sha256').update(value).digest('hex')}`)

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

export const testIds: TestIds = {
  rootId: decode(SyncRootId, 'root-1'),
  dataSourceId: decode(DataSourceId, 'data-source-1'),
  otherDataSourceId: decode(DataSourceId, 'data-source-2'),
  pageId: decode(PageId, 'page-1'),
  otherPageId: decode(PageId, 'page-2'),
  propertyA: decode(PropertyId, 'prop-a'),
  propertyB: decode(PropertyId, 'prop-b'),
  commandId: decode(CommandId, 'cmd-1'),
  intentEventId: decode(SyncEventId, 'intent-1'),
  commandKey: decode(IdempotencyKey, 'intent:cmd-1'),
  requestId: decode(NotionRequestId, 'request-1'),
}

export const fixedObservedAt = '2026-05-25T00:00:00.000Z'

export type FakeClock = {
  readonly now: () => Date
  readonly nowIso: () => string
  readonly advanceMillis: (millis: number) => Date
}

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

export type FakeRateLimitDecision =
  | { readonly _tag: 'allowed' }
  | { readonly _tag: 'retry-after'; readonly retryAfterMillis: number }

export type FakeRateLimiter = {
  readonly decisions: ReadonlyArray<FakeRateLimitDecision>
  readonly acquire: () => FakeRateLimitDecision
}

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

export type FakeGatewayInput = {
  readonly capabilities?: ReadonlyArray<CapabilityName>
  readonly dataSource?: DataSourceSnapshot
  readonly pages?: ReadonlyArray<PageSnapshot>
  readonly propertyPages?: ReadonlyArray<PagePropertyItemPage>
}

export type FakeGatewayHarness = {
  readonly gateway: NotionDataSourceGatewayShape
  readonly patchedPageProperties: ReadonlyArray<PatchPagePropertiesCommand>
  readonly patchedDataSourceSchemas: ReadonlyArray<PatchDataSourceSchemaCommand>
  readonly trashedPages: ReadonlyArray<TrashPageCommand>
  readonly restoredPages: ReadonlyArray<RestorePageCommand>
}

export const makeFakeGatewayHarness = (input: FakeGatewayInput = {}): FakeGatewayHarness => {
  const patchedPageProperties: PatchPagePropertiesCommand[] = []
  const patchedDataSourceSchemas: PatchDataSourceSchemaCommand[] = []
  const trashedPages: TrashPageCommand[] = []
  const restoredPages: RestorePageCommand[] = []
  const dataSource =
    input.dataSource ??
    ({
      _tag: 'DataSourceSnapshot',
      dataSourceId: testIds.dataSourceId,
      requestId: testIds.requestId,
      observedAt: decode(Schema.DateTimeUtc, fixedObservedAt),
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

  return {
    patchedPageProperties,
    patchedDataSourceSchemas,
    trashedPages,
    restoredPages,
    gateway: makeFakeNotionDataSourceGateway({
      ...(input.capabilities === undefined ? {} : { supportedCapabilities: input.capabilities }),
      dataSources: [dataSource],
      pages,
    }),
  }
}

export type StoreFixture = {
  readonly store: NotionSyncStore
  readonly path: string
  readonly cleanup: () => void
}

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

export const bodyPointer = (bodyHash: HashType = hash('body-a')): BodyPointerType =>
  decode(BodyPointer, {
    _tag: 'BodyPointer',
    pageId: testIds.pageId,
    bodyHash,
    observedAt: fixedObservedAt,
  })

export const rowSnapshot = (overrides: Partial<RowPageSnapshot> = {}): RowPageSnapshot => ({
  _tag: 'RowPageSnapshot',
  pageId: testIds.pageId,
  propertiesHash: hash('properties-a'),
  lastEditedTime: decode(Schema.DateTimeUtc, fixedObservedAt),
  inTrash: false,
  ...overrides,
})

export const pageSnapshot = (overrides: Partial<PageSnapshot> = {}): PageSnapshot => ({
  _tag: 'PageSnapshot',
  pageId: testIds.pageId,
  dataSourceId: testIds.dataSourceId,
  requestId: testIds.requestId,
  observedAt: decode(Schema.DateTimeUtc, fixedObservedAt),
  propertiesHash: hash('properties-a'),
  inTrash: false,
  ...overrides,
})

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
  decode(QueryRowsPage, {
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
  })

export const defaultQueryContract = (): QueryContract => ({
  _tag: 'QueryContract',
  apiVersion: '2026-03-11',
  filter: null,
  sorts: [],
  pageSize: 100,
  highWatermark: null,
  membershipScope: 'all-data-source-rows',
})

export const bodySafety = bodySafetySnapshot

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

export const propertyPatchValue = (plainText = 'Updated'): CanonicalPropertyValue => ({
  _tag: 'title',
  plainText,
})

export const propertyEditIntent = (
  overrides: Partial<PropertyEditIntent> = {},
): PropertyEditIntent => {
  const command = decode(PatchPagePropertiesCommand, {
    _tag: 'PatchPagePropertiesCommand',
    commandId: testIds.commandId,
    pageId: testIds.pageId,
    basePropertiesHash: hash('properties-a'),
    propertyPatch: {
      [testIds.propertyA]: propertyPatchValue(),
    },
  })

  return {
    _tag: 'property-edit',
    intentEventId: testIds.intentEventId,
    commandKey: testIds.commandKey,
    surface: propertySurfaceKey(testIds.pageId, testIds.propertyA),
    pageId: testIds.pageId,
    propertyId: testIds.propertyA,
    command,
    baseHash: hash('property-a-base'),
    desiredHash: hash('property-a-next'),
    expectedPropertyConfigHash: hash('config-a'),
    ...overrides,
  }
}

export const queryAbsenceIntent = (
  overrides: Partial<QueryAbsenceIntent> = {},
): QueryAbsenceIntent => ({
  _tag: 'query-absence',
  surface: querySurfaceKey(testIds.dataSourceId, hash('query-contract')),
  dataSourceId: testIds.dataSourceId,
  pageId: testIds.pageId,
  queryContractHash: hash('query-contract'),
  ...overrides,
})

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

export const bodyAdapterResultIntent = (safety: BodySafetySnapshot): BodyAdapterResultIntent => ({
  _tag: 'body-adapter-result',
  surface: bodySurfaceKey(testIds.pageId),
  pageId: testIds.pageId,
  safety,
})

export const localDeleteIntent = (
  overrides: Partial<LocalDeleteIntent> = {},
): LocalDeleteIntent => {
  const command = decode(TrashPageCommand, {
    _tag: 'TrashPageCommand',
    commandId: testIds.commandId,
    pageId: testIds.pageId,
    basePropertiesHash: hash('properties-a'),
  })

  return {
    _tag: 'local-delete',
    intentEventId: testIds.intentEventId,
    commandKey: testIds.commandKey,
    surface: pageSurfaceKey(testIds.pageId),
    pageId: testIds.pageId,
    command,
    baseHash: hash('properties-a'),
    desiredHash: hash('trash-desired'),
    explicitDestructiveIntent: false,
    policy: 'candidateOnly',
    directRetrieve: 'accessible',
    ...overrides,
  }
}

export const fakeBodyPage = (overrides: Partial<FakeBodyPageState> = {}): FakeBodyPageState => ({
  pageId: testIds.pageId,
  pointer: bodyPointer(),
  requestId: testIds.requestId,
  safety: bodySafetySnapshot(),
  ...overrides,
})

export const bodyLocalChangeInput = (
  overrides: Partial<BodyLocalChangeInput> = {},
): BodyLocalChangeInput => ({
  _tag: 'BodyLocalChangeInput',
  pageId: testIds.pageId,
  baseBodyPointer: bodyPointer(),
  localBodyHash: hash('body-next'),
  ...overrides,
})

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

export const remoteWritePlannedEvent = (input: {
  readonly eventId: string
  readonly commandId: CommandId
  readonly commandKey: IdempotencyKey
  readonly intentEventId: SyncEventId
  readonly surface: SurfaceKey
  readonly commandTag: string
  readonly baseHash?: HashType
  readonly desiredHash: HashType
  readonly preflight: ReadonlyArray<GuardName>
}): SyncEventType =>
  decode(SyncEvent, {
    _tag: 'RemoteWritePlanned',
    ...eventBase({
      eventId: input.eventId,
      family: 'CommandEnqueued',
      eventType: 'RemoteWritePlanned',
      idempotencyKey: input.commandKey,
      surface: input.surface,
      canonicalJson: `{"commandId":"${input.commandId}"}`,
    }),
    commandId: input.commandId,
    commandKey: input.commandKey,
    intentEventId: input.intentEventId,
    commandTag: input.commandTag,
    ...(input.baseHash === undefined ? {} : { baseHash: input.baseHash }),
    desiredHash: input.desiredHash,
    preflight: input.preflight,
  })

export const remoteWriteAttemptedEvent = (input: {
  readonly eventId: string
  readonly idempotencyKey: string
  readonly commandId: CommandId
  readonly attemptState?: 'running' | 'retryable' | 'blocked' | 'fenced' | 'ambiguous'
}): SyncEventType =>
  decode(SyncEvent, {
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
    attempt: 1,
    attemptState: input.attemptState ?? 'running',
    leaseToken: 'lease-1',
  })

export const remoteWriteSettledEvent = (input: {
  readonly eventId: string
  readonly idempotencyKey: string
  readonly commandId: CommandId
  readonly commandTag: string
  readonly desiredHash: HashType
  readonly observedHash: HashType
}): SyncEventType =>
  decode(SyncEvent, {
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
  })

export const appendPlannedCommand = (
  store: NotionSyncStore,
  command: OutboxCommandEnvelope,
): SyncEventType =>
  store.appendEvent(
    remoteWritePlannedEvent({
      eventId: 'event-planned-1',
      commandId: command.commandId,
      commandKey: command.commandKey,
      intentEventId: command.intentEventId,
      surface: command.surface,
      commandTag: commandTag(command.command),
      baseHash: command.baseHash,
      desiredHash: command.desiredHash,
      preflight: command.preflight,
    }),
  )
