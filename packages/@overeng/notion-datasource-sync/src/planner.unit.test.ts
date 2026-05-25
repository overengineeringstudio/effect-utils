import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  BodyPushCommand,
  CommandId,
  DataSourceId,
  Hash,
  IdempotencyKey,
  PageId,
  PatchPagePropertiesCommand,
  PropertyId,
  SyncEventId,
  SyncRootId,
  bodySurfaceKey,
  classifyConflict,
  guardApiCompatibility,
  guardBodyAdapterBoundary,
  guardBodySafety,
  guardCapabilityPreflight,
  guardDecodeDrift,
  guardExpiringFileUrl,
  guardPathClaimCollision,
  guardPropertyAvailability,
  guardPropertyWriteClass,
  guardQueryAbsence,
  guardQueryCompleteness,
  guardSchemaIntentSafety,
  guardStaleSurfaceBase,
  guardTombstoneSafety,
  guardUnavailableRelationTarget,
  pageSurfaceKey,
  pathSurfaceKey,
  planIntent,
  propertySurfaceKey,
  querySurfaceKey,
  schemaSurfaceKey,
  type BodySafetySnapshot,
  type ConflictSurface,
  type PlannerProjectionSnapshot,
} from './mod.ts'

const decode = <TSchema extends Schema.Schema.AnyNoContext>(schema: TSchema, value: unknown) =>
  Schema.decodeUnknownSync(schema)(value)

const hash = (char: string) => decode(Hash, `sha256:${char.repeat(64)}`)

const rootId = decode(SyncRootId, 'root-1')
const intentEventId = decode(SyncEventId, 'intent-1')
const commandKey = decode(IdempotencyKey, 'intent:cmd-1')
const dataSourceId = decode(DataSourceId, 'data-source-1')
const otherDataSourceId = decode(DataSourceId, 'data-source-2')
const pageId = decode(PageId, 'page-1')
const otherPageId = decode(PageId, 'page-2')
const propertyA = decode(PropertyId, 'prop-a')
const propertyB = decode(PropertyId, 'prop-b')
const commandId = decode(CommandId, 'cmd-1')

const bodySafety = (overrides: Partial<BodySafetySnapshot> = {}): BodySafetySnapshot => ({
  truncated: false,
  unknownBlockCause: undefined,
  selection: 'safe',
  wouldDeleteChildren: false,
  syncedPageUnsupported: false,
  adapterConflict: false,
  adapterMutationSurfaces: ['body'],
  ...overrides,
})

const propertyCommand = decode(PatchPagePropertiesCommand, {
  _tag: 'PatchPagePropertiesCommand',
  commandId,
  pageId,
  basePropertiesHash: hash('a'),
  propertyPatch: {
    'prop-a': { _tag: 'title', plainText: 'Updated' },
  },
})

const bodyCommand = decode(BodyPushCommand, {
  _tag: 'BodyPushCommand',
  commandId,
  pageId,
  baseBodyPointer: {
    _tag: 'BodyPointer',
    pageId,
    bodyHash: hash('f'),
    observedAt: '2026-05-25T00:00:00.000Z',
  },
  nextBodyHash: hash('e'),
})

const snapshot = (
  overrides: Partial<PlannerProjectionSnapshot> = {},
): PlannerProjectionSnapshot => ({
  rootId,
  api: { configuredApiVersion: '2026-03-11', compatibilityProof: 'present' },
  capabilities: {
    required: ['page_property_update'],
    supported: ['page_property_update'],
    preflight: 'passed',
  },
  schema: [
    {
      dataSourceId,
      propertyId: propertyA,
      schemaHash: hash('b'),
      configHash: hash('c'),
      writeClass: 'writable',
    },
    {
      dataSourceId,
      propertyId: propertyB,
      schemaHash: hash('b'),
      configHash: hash('d'),
      writeClass: 'writable',
    },
  ],
  rows: [
    {
      pageId,
      dataSourceId,
      propertiesHash: hash('a'),
      inTrash: false,
      movedOut: false,
      localDeleteCandidate: false,
    },
  ],
  properties: [
    {
      pageId,
      propertyId: propertyA,
      baseHash: hash('a'),
      remoteHash: hash('a'),
      availability: 'complete',
      pendingLocal: undefined,
    },
    {
      pageId,
      propertyId: propertyB,
      baseHash: hash('a'),
      remoteHash: hash('e'),
      availability: 'complete',
      pendingLocal: undefined,
    },
  ],
  bodies: [
    {
      pageId,
      path: 'row--page-1.nmd',
      baseHash: hash('f'),
      currentHash: hash('f'),
      sidecarIdentityProven: true,
      ownWriteMaterializationIds: [],
      safety: bodySafety(),
    },
  ],
  tombstones: [],
  queries: [],
  pathClaims: [],
  localWorkspace: [],
  remoteChanges: [],
  ...overrides,
})

describe('notion datasource planner guards', () => {
  it.each([
    [
      'API version unsupported',
      guardApiCompatibility({ configuredApiVersion: '2022-06-28', compatibilityProof: 'present' }),
      'ApiVersionUnsupported',
    ],
    [
      'API proof missing',
      guardApiCompatibility({ configuredApiVersion: '2026-03-11', compatibilityProof: 'missing' }),
      'ApiVersionCompatibilityMissing',
    ],
    [
      'capability preflight failed',
      guardCapabilityPreflight({
        required: ['page_property_update'],
        supported: [],
        preflight: 'failed',
      }),
      'CapabilityPreflightFailed',
    ],
    ['decode drift', guardDecodeDrift({ supported: false }), 'DecodeDriftUnsupported'],
    [
      'computed property write',
      guardPropertyWriteClass({ writeClass: 'computed' }),
      'ComputedPropertyWrite',
    ],
    [
      'property incomplete',
      guardPropertyAvailability({ availability: 'paginated-incomplete' }),
      'PropertyValueIncomplete',
    ],
    [
      'related data source unshared',
      guardPropertyAvailability({ availability: 'related-data-source-unshared' }),
      'RelatedDataSourceUnshared',
    ],
    [
      'stale surface base',
      guardStaleSurfaceBase({ baseHash: hash('a'), currentHash: hash('b') }),
      'StaleSurfaceBase',
    ],
    [
      'schema drift affects intent',
      guardSchemaIntentSafety({
        affectsLocalIntent: true,
        destructiveMigrationRequired: false,
        optionDeletionLosesValues: false,
      }),
      'SchemaDriftAffectsIntent',
    ],
    [
      'destructive schema migration',
      guardSchemaIntentSafety({
        affectsLocalIntent: false,
        destructiveMigrationRequired: true,
        optionDeletionLosesValues: false,
      }),
      'DestructiveSchemaMigrationRequired',
    ],
    [
      'option deletion loses values',
      guardSchemaIntentSafety({
        affectsLocalIntent: false,
        destructiveMigrationRequired: false,
        optionDeletionLosesValues: true,
      }),
      'OptionDeletionLosesValues',
    ],
    ['body lossy', guardBodySafety(bodySafety({ truncated: true })), 'BodyLossyRemote'],
    [
      'body unsafe unknown blocks',
      guardBodySafety(bodySafety({ unknownBlockCause: 'unknown' })),
      'MarkdownUnknownBlocksAmbiguous',
    ],
    [
      'body selection ambiguous',
      guardBodySafety(bodySafety({ selection: 'ambiguous' })),
      'MarkdownSelectionAmbiguous',
    ],
    [
      'body would delete children',
      guardBodySafety(bodySafety({ wouldDeleteChildren: true })),
      'MarkdownWouldDeleteChildren',
    ],
    [
      'synced page unsupported',
      guardBodySafety(bodySafety({ syncedPageUnsupported: true })),
      'MarkdownSyncedPageUnsupported',
    ],
    [
      'body adapter conflict',
      guardBodySafety(bodySafety({ adapterConflict: true })),
      'BodyAdapterConflict',
    ],
    ['path collision', guardPathClaimCollision({ collides: true }), 'PathClaimCollision'],
    [
      'query absence unclassified',
      guardQueryAbsence({
        classified: false,
        filtered: false,
        membershipScope: 'all-data-source-rows',
        directRetrieve: 'not-run',
      }),
      'QueryAbsenceUnclassified',
    ],
    [
      'pagination incomplete',
      guardQueryCompleteness({ terminal: false, cappedAtLimit: false, contractChanged: false }),
      'PaginationIncomplete',
    ],
    [
      'query contract changed',
      guardQueryCompleteness({ terminal: true, cappedAtLimit: false, contractChanged: true }),
      'QueryContractChanged',
    ],
    [
      'query cap exceeded',
      guardQueryCompleteness({ terminal: false, cappedAtLimit: true, contractChanged: false }),
      'QueryResultCapExceeded',
    ],
    [
      'filtered absence',
      guardQueryAbsence({
        classified: false,
        filtered: true,
        membershipScope: 'explicit-filter',
        directRetrieve: 'accessible',
      }),
      'FilteredAbsenceNotProof',
    ],
    [
      'permission ambiguous',
      guardQueryAbsence({
        classified: false,
        filtered: false,
        membershipScope: 'all-data-source-rows',
        directRetrieve: 'permission-ambiguous',
      }),
      'PermissionAmbiguous',
    ],
    [
      'delete vs edit',
      guardTombstoneSafety({
        deleteVsEdit: true,
        moveOutNotDelete: false,
        permissionAmbiguous: false,
      }),
      'DeleteVsEdit',
    ],
    [
      'move out not delete',
      guardTombstoneSafety({
        deleteVsEdit: false,
        moveOutNotDelete: true,
        permissionAmbiguous: false,
      }),
      'MoveOutNotDelete',
    ],
    [
      'unavailable relation',
      guardUnavailableRelationTarget({ available: false }),
      'UnavailableRelationTarget',
    ],
    [
      'expiring file URL',
      guardExpiringFileUrl({ kind: 'notion-hosted', stableRef: undefined, expiresAt: new Date() }),
      'ExpiringFileUrl',
    ],
    [
      'body adapter non-body mutation',
      guardBodyAdapterBoundary({ mutationSurfaces: ['body', 'schema'] }),
      'BodyAdapterNonBodyMutation',
    ],
  ])('blocks %s', (_name, decision, guard) => {
    expect(decision).toMatchObject({ _tag: 'blocked', guard })
  })

  it('allows safe property, query, body, and tombstone surfaces', () => {
    expect(guardPropertyAvailability({ availability: 'complete' })).toEqual({ _tag: 'allowed' })
    expect(
      guardQueryCompleteness({ terminal: true, cappedAtLimit: false, contractChanged: false }),
    ).toEqual({
      _tag: 'allowed',
    })
    expect(guardBodySafety(bodySafety())).toEqual({ _tag: 'allowed' })
    expect(
      guardTombstoneSafety({
        deleteVsEdit: false,
        moveOutNotDelete: false,
        permissionAmbiguous: false,
      }),
    ).toEqual({ _tag: 'allowed' })
  })
})

describe('notion datasource conflict classifier', () => {
  const propertySurface = (id: PropertyId): ConflictSurface => ({
    _tag: 'property',
    pageId,
    propertyId: id,
    baseHash: hash('a'),
    nextHash: hash('b'),
    surface: propertySurfaceKey(pageId, id),
  })

  it.each([
    ['same-property', propertySurface(propertyA), propertySurface(propertyA), 'same-property'],
    [
      'body-body delegated',
      {
        _tag: 'body',
        pageId,
        baseHash: hash('a'),
        nextHash: hash('b'),
        lossy: false,
        surface: bodySurfaceKey(pageId),
      } satisfies ConflictSurface,
      {
        _tag: 'body',
        pageId,
        baseHash: hash('a'),
        nextHash: hash('c'),
        lossy: false,
        surface: bodySurfaceKey(pageId),
      } satisfies ConflictSurface,
      'body-body-delegated',
    ],
    [
      'delete-vs-edit',
      { _tag: 'delete', pageId, surface: pageSurfaceKey(pageId) } satisfies ConflictSurface,
      propertySurface(propertyA),
      'delete-vs-edit',
    ],
    [
      'schema-affects-property',
      {
        _tag: 'schema',
        affectedPropertyIds: [propertyA],
        surface: schemaSurfaceKey(dataSourceId, propertyA),
      } satisfies ConflictSurface,
      propertySurface(propertyA),
      'schema-affects-property',
    ],
    [
      'relation unavailable',
      {
        _tag: 'relation',
        pageId,
        propertyId: propertyA,
        available: false,
        surface: propertySurfaceKey(pageId, propertyA),
      } satisfies ConflictSurface,
      propertySurface(propertyA),
      'relation-unavailable',
    ],
    [
      'path collision',
      {
        _tag: 'path',
        path: 'same.nmd',
        pageId,
        existingPageId: otherPageId,
        surface: pathSurfaceKey('same.nmd'),
      } satisfies ConflictSurface,
      propertySurface(propertyA),
      'path-collision',
    ],
    [
      'lossy body',
      {
        _tag: 'body',
        pageId,
        baseHash: hash('a'),
        nextHash: hash('b'),
        lossy: true,
        surface: bodySurfaceKey(pageId),
      } satisfies ConflictSurface,
      propertySurface(propertyA),
      'lossy-body',
    ],
    [
      'permission ambiguous',
      {
        _tag: 'permission',
        pageId,
        ambiguous: true,
        surface: pageSurfaceKey(pageId),
      } satisfies ConflictSurface,
      propertySurface(propertyA),
      'permission-ambiguous',
    ],
  ])('classifies %s', (_name, local, remote, kind) => {
    expect(classifyConflict(local, remote)).toMatchObject({
      _tag: 'conflict',
      conflict: { kind },
    })
  })

  it('classifies disjoint property and property-vs-body changes as mergeable', () => {
    expect(classifyConflict(propertySurface(propertyA), propertySurface(propertyB))).toMatchObject({
      _tag: 'mergeable',
      kind: 'disjoint-property',
    })

    expect(
      classifyConflict(propertySurface(propertyA), {
        _tag: 'body',
        pageId,
        baseHash: hash('a'),
        nextHash: hash('b'),
        lossy: false,
        surface: bodySurfaceKey(pageId),
      }),
    ).toMatchObject({
      _tag: 'mergeable',
      kind: 'property-vs-body',
    })
  })
})

describe('notion datasource planner', () => {
  it('enqueues outbox-ready command envelopes for safe property edits', () => {
    const decision = planIntent(snapshot(), {
      _tag: 'property-edit',
      intentEventId,
      commandKey,
      surface: propertySurfaceKey(pageId, propertyA),
      pageId,
      propertyId: propertyA,
      command: propertyCommand,
      baseHash: hash('a'),
      desiredHash: hash('f'),
      expectedPropertyConfigHash: hash('c'),
    })

    expect(decision).toMatchObject({
      _tag: 'EnqueueCommands',
      commands: [
        {
          rootId,
          intentEventId,
          commandKey,
          surface: propertySurfaceKey(pageId, propertyA),
          baseHash: hash('a'),
          desiredHash: hash('f'),
          preflight: ['CapabilityPreflightFailed', 'StaleSurfaceBase', 'SchemaDriftAffectsIntent'],
        },
      ],
    })
  })

  it('blocks property edits when the current property projection is missing', () => {
    const decision = planIntent(
      snapshot({
        properties: [],
      }),
      {
        _tag: 'property-edit',
        intentEventId,
        commandKey,
        surface: propertySurfaceKey(pageId, propertyA),
        pageId,
        propertyId: propertyA,
        command: propertyCommand,
        baseHash: hash('a'),
        desiredHash: hash('f'),
        expectedPropertyConfigHash: hash('c'),
      },
    )

    expect(decision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'CurrentSurfaceMissing',
    })
  })

  it('blocks property edits when the row data source no longer has the schema property', () => {
    const decision = planIntent(
      snapshot({
        schema: [
          {
            dataSourceId,
            propertyId: propertyB,
            schemaHash: hash('b'),
            configHash: hash('d'),
            writeClass: 'writable',
          },
        ],
      }),
      {
        _tag: 'property-edit',
        intentEventId,
        commandKey,
        surface: propertySurfaceKey(pageId, propertyA),
        pageId,
        propertyId: propertyA,
        command: propertyCommand,
        baseHash: hash('a'),
        desiredHash: hash('f'),
        expectedPropertyConfigHash: hash('c'),
      },
    )

    expect(decision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'CurrentSurfaceMissing',
      detail: {
        summary:
          'Current schema property projection is missing; observe the data source schema before planning a property write',
      },
    })
  })

  it('scopes property edit schema lookup to the row data source', () => {
    const decision = planIntent(
      snapshot({
        schema: [
          {
            dataSourceId,
            propertyId: propertyA,
            schemaHash: hash('b'),
            configHash: hash('c'),
            writeClass: 'writable',
          },
          {
            dataSourceId: otherDataSourceId,
            propertyId: propertyA,
            schemaHash: hash('d'),
            configHash: hash('e'),
            writeClass: 'computed',
          },
        ],
        rows: [
          {
            pageId,
            dataSourceId: otherDataSourceId,
            propertiesHash: hash('a'),
            inTrash: false,
            movedOut: false,
            localDeleteCandidate: false,
          },
        ],
      }),
      {
        _tag: 'property-edit',
        intentEventId,
        commandKey,
        surface: propertySurfaceKey(pageId, propertyA),
        pageId,
        propertyId: propertyA,
        command: propertyCommand,
        baseHash: hash('a'),
        desiredHash: hash('f'),
        expectedPropertyConfigHash: hash('e'),
      },
    )

    expect(decision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'ComputedPropertyWrite',
    })
  })

  it('blocks body edits when the current body projection is missing', () => {
    const decision = planIntent(
      snapshot({
        bodies: [],
      }),
      {
        _tag: 'body-edit',
        intentEventId,
        commandKey,
        surface: bodySurfaceKey(pageId),
        pageId,
        command: bodyCommand,
        baseHash: hash('f'),
        desiredHash: hash('e'),
      },
    )

    expect(decision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'CurrentSurfaceMissing',
    })
  })

  it('opens same-property conflict instead of silently overwriting a remote observation', () => {
    const decision = planIntent(
      snapshot({
        properties: [
          {
            pageId,
            propertyId: propertyA,
            baseHash: hash('a'),
            remoteHash: hash('d'),
            availability: 'complete',
            pendingLocal: undefined,
          },
        ],
      }),
      {
        _tag: 'property-edit',
        intentEventId,
        commandKey,
        surface: propertySurfaceKey(pageId, propertyA),
        pageId,
        propertyId: propertyA,
        command: propertyCommand,
        baseHash: hash('a'),
        desiredHash: hash('f'),
        expectedPropertyConfigHash: hash('c'),
      },
    )

    expect(decision).toMatchObject({
      _tag: 'OpenConflict',
      conflict: { kind: 'same-property', localHash: hash('f'), remoteHash: hash('d') },
    })
  })

  it('keeps pending local intent as the shadowed target when remote changes arrive', () => {
    const decision = planIntent(
      snapshot({
        properties: [
          {
            pageId,
            propertyId: propertyA,
            baseHash: hash('a'),
            remoteHash: hash('d'),
            availability: 'complete',
            pendingLocal: { intentEventId, targetHash: hash('f') },
          },
        ],
      }),
      {
        _tag: 'property-edit',
        intentEventId,
        commandKey,
        surface: propertySurfaceKey(pageId, propertyA),
        pageId,
        propertyId: propertyA,
        command: propertyCommand,
        baseHash: hash('a'),
        desiredHash: hash('f'),
        expectedPropertyConfigHash: hash('c'),
      },
    )

    expect(decision).toMatchObject({
      _tag: 'OpenConflict',
      conflict: { kind: 'same-property', localHash: hash('f'), remoteHash: hash('d') },
    })
  })

  it('allows disjoint property merge when bases are independent', () => {
    const decision = planIntent(
      snapshot({
        remoteChanges: [
          {
            _tag: 'property',
            pageId,
            propertyId: propertyB,
            baseHash: hash('a'),
            nextHash: hash('d'),
            surface: propertySurfaceKey(pageId, propertyB),
          },
        ],
      }),
      {
        _tag: 'property-edit',
        intentEventId,
        commandKey,
        surface: propertySurfaceKey(pageId, propertyA),
        pageId,
        propertyId: propertyA,
        command: propertyCommand,
        baseHash: hash('a'),
        desiredHash: hash('f'),
        expectedPropertyConfigHash: hash('c'),
      },
    )

    expect(decision._tag).toBe('EnqueueCommands')
  })

  it('keeps local file deletion as a candidate by default and does not enqueue trash', () => {
    const decision = planIntent(snapshot(), {
      _tag: 'local-delete',
      intentEventId,
      commandKey,
      surface: pageSurfaceKey(pageId),
      pageId,
      command: {
        _tag: 'TrashPageCommand',
        commandId,
        pageId,
        basePropertiesHash: hash('a'),
      },
      baseHash: hash('a'),
      desiredHash: hash('e'),
      explicitDestructiveIntent: false,
      policy: 'candidateOnly',
      directRetrieve: 'not-run',
    })

    expect(decision).toMatchObject({
      _tag: 'AppendEvents',
      events: [{ _tag: 'LocalDeleteCandidateAccepted' }],
    })
  })

  it('blocks trusted local deletes when the current row projection is missing', () => {
    const decision = planIntent(
      snapshot({
        rows: [],
      }),
      {
        _tag: 'local-delete',
        intentEventId,
        commandKey,
        surface: pageSurfaceKey(pageId),
        pageId,
        command: {
          _tag: 'TrashPageCommand',
          commandId,
          pageId,
          basePropertiesHash: hash('a'),
        },
        baseHash: hash('a'),
        desiredHash: hash('e'),
        explicitDestructiveIntent: true,
        policy: 'trustedRemoteTrash',
        directRetrieve: 'accessible',
      },
    )

    expect(decision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'CurrentSurfaceMissing',
    })
  })

  it('blocks filtered absence and capped queries from tombstone decisions', () => {
    const filteredDecision = planIntent(
      snapshot({
        queries: [
          {
            dataSourceId,
            pageId,
            queryContractHash: hash('b'),
            completeness: { terminal: true, cappedAtLimit: false, contractChanged: false },
            absence: {
              classified: false,
              filtered: true,
              membershipScope: 'explicit-filter',
              directRetrieve: 'accessible',
            },
          },
        ],
      }),
      {
        _tag: 'query-absence',
        surface: querySurfaceKey(dataSourceId, hash('b')),
        dataSourceId,
        pageId,
        queryContractHash: hash('b'),
      },
    )

    expect(filteredDecision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'FilteredAbsenceNotProof',
    })

    const cappedDecision = planIntent(
      snapshot({
        queries: [
          {
            dataSourceId,
            pageId,
            queryContractHash: hash('b'),
            completeness: { terminal: false, cappedAtLimit: true, contractChanged: false },
            absence: {
              classified: false,
              filtered: false,
              membershipScope: 'all-data-source-rows',
              directRetrieve: 'not-run',
            },
          },
        ],
      }),
      {
        _tag: 'query-absence',
        surface: querySurfaceKey(dataSourceId, hash('b')),
        dataSourceId,
        pageId,
        queryContractHash: hash('b'),
      },
    )

    expect(cappedDecision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'QueryResultCapExceeded',
    })
  })

  it('ignores query absence when direct retrieve proves the page is still accessible', () => {
    const decision = planIntent(
      snapshot({
        queries: [
          {
            dataSourceId,
            pageId,
            queryContractHash: hash('b'),
            completeness: { terminal: true, cappedAtLimit: false, contractChanged: false },
            absence: {
              classified: true,
              filtered: false,
              membershipScope: 'all-data-source-rows',
              directRetrieve: 'accessible',
            },
          },
        ],
      }),
      {
        _tag: 'query-absence',
        surface: querySurfaceKey(dataSourceId, hash('b')),
        dataSourceId,
        pageId,
        queryContractHash: hash('b'),
      },
    )

    expect(decision).toEqual({ _tag: 'AppendEvents', events: [] })
  })

  it('does not reuse an accessible direct retrieve for another absent page', () => {
    const decision = planIntent(
      snapshot({
        queries: [
          {
            dataSourceId,
            pageId,
            queryContractHash: hash('b'),
            completeness: { terminal: true, cappedAtLimit: false, contractChanged: false },
            absence: {
              classified: true,
              filtered: false,
              membershipScope: 'all-data-source-rows',
              directRetrieve: 'accessible',
            },
          },
        ],
      }),
      {
        _tag: 'query-absence',
        surface: querySurfaceKey(dataSourceId, hash('b')),
        dataSourceId,
        pageId: otherPageId,
        queryContractHash: hash('b'),
      },
    )

    expect(decision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'QueryAbsenceUnclassified',
    })
  })

  it.each(['in-trash', 'moved-out', 'inaccessible', 'unknown'] as const)(
    'does not reuse %s classification across page or data source boundaries',
    (directRetrieve) => {
      const queries = [
        {
          dataSourceId,
          pageId: otherPageId,
          queryContractHash: hash('b'),
          completeness: { terminal: true, cappedAtLimit: false, contractChanged: false },
          absence: {
            classified: true,
            filtered: false,
            membershipScope: 'all-data-source-rows',
            directRetrieve,
          },
        },
        {
          dataSourceId: otherDataSourceId,
          pageId,
          queryContractHash: hash('b'),
          completeness: { terminal: true, cappedAtLimit: false, contractChanged: false },
          absence: {
            classified: true,
            filtered: false,
            membershipScope: 'all-data-source-rows',
            directRetrieve,
          },
        },
      ] satisfies PlannerProjectionSnapshot['queries']

      const decision = planIntent(
        snapshot({
          queries,
        }),
        {
          _tag: 'query-absence',
          surface: querySurfaceKey(dataSourceId, hash('b')),
          dataSourceId,
          pageId,
          queryContractHash: hash('b'),
        },
      )

      expect(decision).toMatchObject({
        _tag: 'BlockedByGuard',
        guard: 'QueryAbsenceUnclassified',
      })
    },
  )

  it('blocks malformed query absence evidence instead of recording a tombstone', () => {
    const missingIntentDataSource = {
      _tag: 'query-absence',
      surface: querySurfaceKey(dataSourceId, hash('b')),
      pageId,
      queryContractHash: hash('b'),
    } as unknown as Parameters<typeof planIntent>[1]

    const decisionWithoutIntentDataSource = planIntent(
      snapshot({
        queries: [
          {
            dataSourceId,
            pageId,
            queryContractHash: hash('b'),
            completeness: { terminal: true, cappedAtLimit: false, contractChanged: false },
            absence: {
              classified: true,
              filtered: false,
              membershipScope: 'all-data-source-rows',
              directRetrieve: 'in-trash',
            },
          },
        ],
      }),
      missingIntentDataSource,
    )

    expect(decisionWithoutIntentDataSource).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'QueryAbsenceUnclassified',
    })

    const missingEvidencePage = {
      dataSourceId,
      queryContractHash: hash('b'),
      completeness: { terminal: true, cappedAtLimit: false, contractChanged: false },
      absence: {
        classified: true,
        filtered: false,
        membershipScope: 'all-data-source-rows',
        directRetrieve: 'in-trash',
      },
    } as unknown as PlannerProjectionSnapshot['queries'][number]

    const decisionWithoutEvidencePage = planIntent(
      snapshot({
        queries: [missingEvidencePage],
      }),
      {
        _tag: 'query-absence',
        surface: querySurfaceKey(dataSourceId, hash('b')),
        dataSourceId,
        pageId,
        queryContractHash: hash('b'),
      },
    )

    expect(decisionWithoutEvidencePage).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'QueryAbsenceUnclassified',
    })
  })

  it.each([
    ['in-trash', 'remote-trash'],
    ['moved-out', 'moved-out'],
    ['inaccessible', 'inaccessible'],
    ['unknown', 'unknown'],
  ] as const)('preserves classified query absence for %s', (directRetrieve, reason) => {
    const decision = planIntent(
      snapshot({
        queries: [
          {
            dataSourceId,
            pageId,
            queryContractHash: hash('b'),
            completeness: { terminal: true, cappedAtLimit: false, contractChanged: false },
            absence: {
              classified: true,
              filtered: false,
              membershipScope: 'all-data-source-rows',
              directRetrieve,
            },
          },
        ],
      }),
      {
        _tag: 'query-absence',
        surface: querySurfaceKey(dataSourceId, hash('b')),
        dataSourceId,
        pageId,
        queryContractHash: hash('b'),
      },
    )

    expect(decision).toMatchObject({
      _tag: 'AppendEvents',
      events: [{ _tag: 'TombstoneClassified', reason }],
    })
  })

  it('blocks body adapter surface leaks before command settlement', () => {
    const decision = planIntent(snapshot(), {
      _tag: 'body-adapter-result',
      surface: bodySurfaceKey(pageId),
      pageId,
      safety: bodySafety({ adapterMutationSurfaces: ['body', 'schema'] }),
    })

    expect(decision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'BodyAdapterNonBodyMutation',
    })
  })

  it('opens path claim conflicts instead of overwriting another page claim', () => {
    const decision = planIntent(
      snapshot({
        pathClaims: [{ path: 'same.nmd', ownerPageId: otherPageId, released: false }],
      }),
      {
        _tag: 'path-claim',
        surface: pathSurfaceKey('same.nmd'),
        pageId,
        path: 'same.nmd',
      },
    )

    expect(decision).toMatchObject({
      _tag: 'OpenConflict',
      conflict: { kind: 'path-collision' },
    })
  })
})
