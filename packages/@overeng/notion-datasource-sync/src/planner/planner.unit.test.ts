import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  BodyPushCommand,
  BodyPointer,
  CommandId,
  DatabaseId,
  DataSourceId,
  Hash,
  IdempotencyKey,
  PageId,
  PatchDataSourceSchemaCommand,
  PatchDataSourceMetadataCommand,
  PatchPagePropertiesCommand,
  PropertyId,
  PropertyName,
  SyncEventId,
  SyncRootId,
  bodyDescriptorForDigest,
  bodyEvidenceFingerprintFromContentDigest,
  evidenceBackedBodyIdentity,
  bodySurfaceKey,
  dataSourceMetadataSurfaceKey,
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
  applyConvergenceVerdicts,
  convergeLocalSurfaces,
  pageSurfaceKey,
  pathSurfaceKey,
  planIntent,
  propertySurfaceKey,
  querySurfaceKey,
  schemaSurfaceKey,
  type BodySafetySnapshot,
  type ConflictSurface,
  type PlannerProjectionSnapshot,
} from '../mod.ts'

const decode = <TSchema extends Schema.Codec<any, any, never>>(schema: TSchema, value: unknown) =>
  Schema.decodeUnknownSync(schema)(value)

const hash = (char: string) => decode(Hash, `sha256:${char.repeat(64)}`)

const pointer = (bodyHash = hash('f')) =>
  decode(BodyPointer, {
    _tag: 'BodyPointer',
    pageId,
    identity: evidenceBackedBodyIdentity({
      rendered: bodyDescriptorForDigest(bodyHash),
      evidenceFingerprint: bodyEvidenceFingerprintFromContentDigest(bodyHash),
      completeness: 'complete',
    }),
    observedAt: '2026-05-25T00:00:00.000Z',
    safety: bodySafety(),
  })

const rootId = decode(SyncRootId, 'root-1')
const intentEventId = decode(SyncEventId, 'intent-1')
const commandKey = decode(IdempotencyKey, 'intent:cmd-1')
const dataSourceId = decode(DataSourceId, 'data-source-1')
const databaseId = decode(DatabaseId, 'database-1')
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
  baseBodyPointer: Schema.encodeSync(BodyPointer)(pointer(hash('f'))),
  nextBodyHash: hash('e'),
})

const metadataCommand = decode(PatchDataSourceMetadataCommand, {
  _tag: 'PatchDataSourceMetadataCommand',
  commandId,
  dataSourceId,
  baseMetadataHash: hash('e'),
  metadataPatch: { descriptionPlainText: 'Synced description' },
})

const snapshot = (
  overrides: Partial<PlannerProjectionSnapshot> = {},
): PlannerProjectionSnapshot => ({
  rootId,
  api: { configuredApiVersion: '2026-03-11', compatibilityProof: 'present' },
  capabilities: {
    required: ['page_property_update', 'data_source_metadata_update'],
    supported: ['page_property_update', 'data_source_metadata_update'],
    preflight: 'passed',
  },
  metadata: [{ dataSourceId, metadataHash: hash('e') }],
  databaseMetadata: [{ databaseId, dataSourceId, metadataHash: hash('e') }],
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
      pointer: pointer(hash('f')),
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
        membershipScope: 'all-data-source-rows',
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
    surface: propertySurfaceKey({ pageId: pageId, propertyId: id }),
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
        surface: schemaSurfaceKey({ dataSourceId: dataSourceId, propertyId: propertyA }),
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
        surface: propertySurfaceKey({ pageId: pageId, propertyId: propertyA }),
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
    expect(classifyConflict({ local, remote })).toMatchObject({
      _tag: 'conflict',
      conflict: { kind },
    })
  })

  it('classifies disjoint property and property-vs-body changes as mergeable', () => {
    expect(
      classifyConflict({ local: propertySurface(propertyA), remote: propertySurface(propertyB) }),
    ).toMatchObject({
      _tag: 'mergeable',
      kind: 'disjoint-property',
    })

    expect(
      classifyConflict({
        local: propertySurface(propertyA),
        remote: {
          _tag: 'body',
          pageId,
          baseHash: hash('a'),
          nextHash: hash('b'),
          lossy: false,
          surface: bodySurfaceKey(pageId),
        },
      }),
    ).toMatchObject({
      _tag: 'mergeable',
      kind: 'property-vs-body',
    })
  })
})

describe('notion datasource planner', () => {
  it('enqueues metadata patches against the independent data-source metadata surface', () => {
    const decision = planIntent({
      snapshot: snapshot(),
      intent: {
        _tag: 'data-source-metadata-edit',
        intentEventId,
        commandKey,
        surface: dataSourceMetadataSurfaceKey(dataSourceId),
        dataSourceId,
        command: metadataCommand,
        baseHash: hash('e'),
        desiredHash: hash('f'),
      },
    })

    expect(decision).toMatchObject({
      _tag: 'EnqueueCommands',
      commands: [
        {
          rootId,
          intentEventId,
          commandKey,
          surface: dataSourceMetadataSurfaceKey(dataSourceId),
          baseHash: hash('e'),
          desiredHash: hash('f'),
          preflight: ['CapabilityPreflightFailed', 'StaleSurfaceBase'],
        },
      ],
    })
  })

  it('blocks stale metadata patches without consulting schema state', () => {
    const decision = planIntent({
      snapshot: snapshot({
        metadata: [{ dataSourceId, metadataHash: hash('d') }],
        databaseMetadata: [{ databaseId, dataSourceId, metadataHash: hash('d') }],
      }),
      intent: {
        _tag: 'data-source-metadata-edit',
        intentEventId,
        commandKey,
        surface: dataSourceMetadataSurfaceKey(dataSourceId),
        dataSourceId,
        command: metadataCommand,
        baseHash: hash('e'),
        desiredHash: hash('f'),
      },
    })

    expect(decision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'StaleSurfaceBase',
    })
  })

  it('enqueues outbox-ready command envelopes for safe property edits', () => {
    const decision = planIntent({
      snapshot: snapshot(),
      intent: {
        _tag: 'property-edit',
        intentEventId,
        commandKey,
        surface: propertySurfaceKey({ pageId: pageId, propertyId: propertyA }),
        pageId,
        propertyId: propertyA,
        command: propertyCommand,
        baseHash: hash('a'),
        desiredHash: hash('f'),
        expectedPropertyConfigHash: hash('c'),
      },
    })

    expect(decision).toMatchObject({
      _tag: 'EnqueueCommands',
      commands: [
        {
          rootId,
          intentEventId,
          commandKey,
          surface: propertySurfaceKey({ pageId: pageId, propertyId: propertyA }),
          baseHash: hash('a'),
          desiredHash: hash('f'),
          preflight: ['CapabilityPreflightFailed', 'StaleSurfaceBase', 'SchemaDriftAffectsIntent'],
        },
      ],
    })
  })

  it('blocks a files property write whose value carries a Notion-hosted (signed/expiring) URL with ExpiringFileUrl', () => {
    // Decision 0016 part 2 (#775 M3b): a `CanonicalFileValue` is durable identity
    // only with an `externalUrl`; a Notion-hosted file is canonicalized without one,
    // so a missing `externalUrl` is the signed/expiring case. The base is clean
    // (`baseHash === remoteHash === hash('a')`), so planning reaches the guard rather
    // than yielding to a StaleSurfaceBase/OpenConflict block first.
    const filesCommand = decode(PatchPagePropertiesCommand, {
      _tag: 'PatchPagePropertiesCommand',
      commandId,
      pageId,
      basePropertiesHash: hash('a'),
      propertyPatch: {
        'prop-a': {
          _tag: 'files',
          files: [
            { _tag: 'CanonicalFileValue', name: 'report.pdf', identityHash: 'sha256:report' },
          ],
        },
      },
    })

    const decision = planIntent({
      snapshot: snapshot(),
      intent: {
        _tag: 'property-edit',
        intentEventId,
        commandKey,
        surface: propertySurfaceKey({ pageId: pageId, propertyId: propertyA }),
        pageId,
        propertyId: propertyA,
        command: filesCommand,
        baseHash: hash('a'),
        desiredHash: hash('f'),
        expectedPropertyConfigHash: hash('c'),
      },
    })

    expect(decision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'ExpiringFileUrl',
    })
  })

  it('allows a files property write whose value carries an external durable URL (not blocked by ExpiringFileUrl)', () => {
    const filesCommand = decode(PatchPagePropertiesCommand, {
      _tag: 'PatchPagePropertiesCommand',
      commandId,
      pageId,
      basePropertiesHash: hash('a'),
      propertyPatch: {
        'prop-a': {
          _tag: 'files',
          files: [
            {
              _tag: 'CanonicalFileValue',
              name: 'report.pdf',
              identityHash: 'sha256:report',
              externalUrl: 'https://example.com/report.pdf',
            },
          ],
        },
      },
    })

    const decision = planIntent({
      snapshot: snapshot(),
      intent: {
        _tag: 'property-edit',
        intentEventId,
        commandKey,
        surface: propertySurfaceKey({ pageId: pageId, propertyId: propertyA }),
        pageId,
        propertyId: propertyA,
        command: filesCommand,
        baseHash: hash('a'),
        desiredHash: hash('f'),
        expectedPropertyConfigHash: hash('c'),
      },
    })

    // An external durable URL clears the file-reference guard; the write proceeds.
    expect(decision).toMatchObject({ _tag: 'EnqueueCommands' })
  })

  it('blocks a files property write whose value carries an obviously-expiring EXTERNAL (presigned) URL with ExpiringFileUrl', () => {
    // Decision 0016 part 3 (#775 0016 upgrade): durability is a property of the URL,
    // not its source. An external URL with an AWS S3 presign signature
    // (`X-Amz-Signature`/`X-Amz-Expires`) expires just like a Notion-hosted signed
    // link, so it must fail closed on a clean base rather than be attached as durable.
    const filesCommand = decode(PatchPagePropertiesCommand, {
      _tag: 'PatchPagePropertiesCommand',
      commandId,
      pageId,
      basePropertiesHash: hash('a'),
      propertyPatch: {
        'prop-a': {
          _tag: 'files',
          files: [
            {
              _tag: 'CanonicalFileValue',
              name: 'report.pdf',
              identityHash: 'sha256:report',
              externalUrl:
                'https://bucket.s3.amazonaws.com/report.pdf?X-Amz-Signature=abc123&X-Amz-Expires=3600',
            },
          ],
        },
      },
    })

    const decision = planIntent({
      snapshot: snapshot(),
      intent: {
        _tag: 'property-edit',
        intentEventId,
        commandKey,
        surface: propertySurfaceKey({ pageId: pageId, propertyId: propertyA }),
        pageId,
        propertyId: propertyA,
        command: filesCommand,
        baseHash: hash('a'),
        desiredHash: hash('f'),
        expectedPropertyConfigHash: hash('c'),
      },
    })

    expect(decision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'ExpiringFileUrl',
    })
  })

  it('blocks property edits when the current property projection is missing', () => {
    const decision = planIntent({
      snapshot: snapshot({
        properties: [],
      }),
      intent: {
        _tag: 'property-edit',
        intentEventId,
        commandKey,
        surface: propertySurfaceKey({ pageId: pageId, propertyId: propertyA }),
        pageId,
        propertyId: propertyA,
        command: propertyCommand,
        baseHash: hash('a'),
        desiredHash: hash('f'),
        expectedPropertyConfigHash: hash('c'),
      },
    })

    expect(decision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'CurrentSurfaceMissing',
    })
  })

  it('blocks property edits when the row data source no longer has the schema property', () => {
    const decision = planIntent({
      snapshot: snapshot({
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
      intent: {
        _tag: 'property-edit',
        intentEventId,
        commandKey,
        surface: propertySurfaceKey({ pageId: pageId, propertyId: propertyA }),
        pageId,
        propertyId: propertyA,
        command: propertyCommand,
        baseHash: hash('a'),
        desiredHash: hash('f'),
        expectedPropertyConfigHash: hash('c'),
      },
    })

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
    const decision = planIntent({
      snapshot: snapshot({
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
      intent: {
        _tag: 'property-edit',
        intentEventId,
        commandKey,
        surface: propertySurfaceKey({ pageId: pageId, propertyId: propertyA }),
        pageId,
        propertyId: propertyA,
        command: propertyCommand,
        baseHash: hash('a'),
        desiredHash: hash('f'),
        expectedPropertyConfigHash: hash('e'),
      },
    })

    expect(decision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'ComputedPropertyWrite',
    })
  })

  it('blocks body edits when the current body projection is missing', () => {
    const decision = planIntent({
      snapshot: snapshot({
        bodies: [],
      }),
      intent: {
        _tag: 'body-edit',
        intentEventId,
        commandKey,
        surface: bodySurfaceKey(pageId),
        pageId,
        command: bodyCommand,
        baseHash: hash('f'),
        desiredHash: hash('e'),
      },
    })

    expect(decision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'CurrentSurfaceMissing',
    })
  })

  it('opens same-property conflict instead of silently overwriting a remote observation', () => {
    const decision = planIntent({
      snapshot: snapshot({
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
      intent: {
        _tag: 'property-edit',
        intentEventId,
        commandKey,
        surface: propertySurfaceKey({ pageId: pageId, propertyId: propertyA }),
        pageId,
        propertyId: propertyA,
        command: propertyCommand,
        baseHash: hash('a'),
        desiredHash: hash('f'),
        expectedPropertyConfigHash: hash('c'),
      },
    })

    expect(decision).toMatchObject({
      _tag: 'OpenConflict',
      conflict: { kind: 'same-property', localHash: hash('f'), remoteHash: hash('d') },
    })
  })

  it('keeps pending local intent as the shadowed target when remote changes arrive', () => {
    const decision = planIntent({
      snapshot: snapshot({
        properties: [
          {
            pageId,
            propertyId: propertyA,
            baseHash: hash('a'),
            remoteHash: hash('d'),
            availability: 'complete',
            pendingLocal: { intentEventId, targetHash: hash('f'), state: 'queued' },
          },
        ],
      }),
      intent: {
        _tag: 'property-edit',
        intentEventId,
        commandKey,
        surface: propertySurfaceKey({ pageId: pageId, propertyId: propertyA }),
        pageId,
        propertyId: propertyA,
        command: propertyCommand,
        baseHash: hash('a'),
        desiredHash: hash('f'),
        expectedPropertyConfigHash: hash('c'),
      },
    })

    expect(decision).toMatchObject({
      _tag: 'OpenConflict',
      conflict: { kind: 'same-property', localHash: hash('f'), remoteHash: hash('d') },
    })
  })

  it('treats a pending local intent as already landed when the remote hash reaches its target', () => {
    const decision = planIntent({
      snapshot: snapshot({
        properties: [
          {
            pageId,
            propertyId: propertyA,
            baseHash: hash('a'),
            remoteHash: hash('f'),
            availability: 'complete',
            pendingLocal: { intentEventId, targetHash: hash('f'), state: 'queued' },
          },
        ],
      }),
      intent: {
        _tag: 'property-edit',
        intentEventId,
        commandKey,
        surface: propertySurfaceKey({ pageId: pageId, propertyId: propertyA }),
        pageId,
        propertyId: propertyA,
        command: propertyCommand,
        baseHash: hash('a'),
        desiredHash: hash('f'),
        expectedPropertyConfigHash: hash('c'),
      },
    })

    expect(decision).toEqual({ _tag: 'AppendEvents', events: [] })
  })

  it('allows disjoint property merge when bases are independent', () => {
    const decision = planIntent({
      snapshot: snapshot({
        remoteChanges: [
          {
            _tag: 'property',
            pageId,
            propertyId: propertyB,
            baseHash: hash('a'),
            nextHash: hash('d'),
            surface: propertySurfaceKey({ pageId: pageId, propertyId: propertyB }),
          },
        ],
      }),
      intent: {
        _tag: 'property-edit',
        intentEventId,
        commandKey,
        surface: propertySurfaceKey({ pageId: pageId, propertyId: propertyA }),
        pageId,
        propertyId: propertyA,
        command: propertyCommand,
        baseHash: hash('a'),
        desiredHash: hash('f'),
        expectedPropertyConfigHash: hash('c'),
      },
    })

    expect(decision._tag).toBe('EnqueueCommands')
  })

  const propertyEditIntent = {
    _tag: 'property-edit' as const,
    intentEventId,
    commandKey,
    surface: propertySurfaceKey({ pageId: pageId, propertyId: propertyA }),
    pageId,
    propertyId: propertyA,
    command: propertyCommand,
    baseHash: hash('a'),
    desiredHash: hash('f'),
    expectedPropertyConfigHash: hash('c'),
  }

  const propertyASurface = (
    overrides: Partial<PlannerProjectionSnapshot['properties'][number]> = {},
  ): PlannerProjectionSnapshot['properties'][number] => ({
    pageId,
    propertyId: propertyA,
    baseHash: hash('a'),
    remoteHash: hash('a'),
    availability: 'complete',
    pendingLocal: undefined,
    ...overrides,
  })

  const schemaA = (
    overrides: Partial<PlannerProjectionSnapshot['schema'][number]> = {},
  ): PlannerProjectionSnapshot['schema'][number] => ({
    dataSourceId,
    propertyId: propertyA,
    schemaHash: hash('b'),
    configHash: hash('c'),
    writeClass: 'writable',
    ...overrides,
  })

  it('blocks a property edit when the remote schema was not freshly observed', () => {
    const decision = planIntent({
      snapshot: snapshot({
        schema: [schemaA({ remoteSchemaObserved: false })],
      }),
      intent: propertyEditIntent,
    })

    expect(decision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'RemoteSchemaRequired',
    })
  })

  it('blocks a property edit when the display name resolves ambiguously', () => {
    const decision = planIntent({
      snapshot: snapshot({
        schema: [schemaA({ displayNameUnambiguous: false })],
      }),
      intent: propertyEditIntent,
    })

    expect(decision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'PropertyIdentityAmbiguous',
    })
  })

  it('blocks a property edit when the observed schema hash differs from the authored one', () => {
    const decision = planIntent({
      snapshot: snapshot({
        schema: [schemaA({ schemaHash: hash('b'), expectedSchemaHash: hash('d') })],
      }),
      intent: propertyEditIntent,
    })

    expect(decision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'StaleRemoteSchema',
    })
  })

  it('blocks a property edit when the local surface disagrees with the observed remote surface', () => {
    const decision = planIntent({
      snapshot: snapshot({
        properties: [propertyASurface({ localConvergence: 'disagrees' })],
      }),
      intent: propertyEditIntent,
    })

    expect(decision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'LocalSurfaceDisagreement',
      detail: { summary: 'Local surface disagrees with the observed remote surface' },
    })
  })

  it('drives LocalSurfaceDisagreement from the real convergence engine (not a test literal)', () => {
    // The convergence engine compares the drained SQLite edit against the `.nmd`
    // fact for `(pageId, propertyA)`; a divergent hash yields a `disagrees`
    // verdict, which `applyConvergenceVerdicts` overlays onto the property surface
    // so the planner blocks with `LocalSurfaceDisagreement`. The production CLI
    // push path wires this same chain (see local-convergence-production.e2e).
    const identity = { kind: 'property' as const, pageId, propertyId: propertyA }
    const convergence = convergeLocalSurfaces({
      authorityMode: 'shared',
      dataFileEdits: [{ identity, desiredHash: hash('a') }],
      nmdFacts: [{ identity, desiredHash: hash('b') }],
    })
    if (convergence._tag !== 'shared') throw new Error('expected shared convergence')
    expect(convergence.conflicts).toHaveLength(1)

    const properties = applyConvergenceVerdicts({
      properties: [propertyASurface()],
      verdicts: convergence.propertyVerdicts,
    })
    const decision = planIntent({ snapshot: snapshot({ properties }), intent: propertyEditIntent })

    expect(decision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'LocalSurfaceDisagreement',
    })
  })

  it('blocks a shared-mode property edit when the read-after-write settlement is missing', () => {
    const decision = planIntent({
      snapshot: snapshot({
        properties: [propertyASurface({ writeMode: 'shared', settlement: 'missing' })],
      }),
      intent: propertyEditIntent,
    })

    expect(decision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'ReadAfterWriteMismatch',
      detail: { summary: 'Read-after-write settlement is missing' },
    })
  })

  it('refuses a local property mutation against a remote-authoritative page before the core', () => {
    const decision = planIntent({
      snapshot: snapshot({
        properties: [propertyASurface({ writeMode: 'remote' })],
      }),
      intent: propertyEditIntent,
    })

    expect(decision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'RemoteAuthoritativeDrift',
    })
  })

  it('blocks a property edit when the property value surface is unsupported', () => {
    const decision = planIntent({
      snapshot: snapshot({
        properties: [propertyASurface({ availability: 'unsupported' })],
      }),
      intent: propertyEditIntent,
    })

    // `unsupported` availability routes through `writeClass: 'unsupported'`
    // (core check 4 — unconditional), preserving the legacy `UnsupportedRemoteShape`.
    expect(decision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'UnsupportedRemoteShape',
    })
  })

  it('blocks an unsupported-availability clear-to-empty property edit (no fail-open)', () => {
    // Regression: the planner defaults a missing patch entry to `{_tag:'empty'}`.
    // An `unsupported`-availability block must hold UNCONDITIONALLY — routing it
    // through value tag-fit would let `empty` (fits any type) slip through.
    const clearCommand = decode(PatchPagePropertiesCommand, {
      _tag: 'PatchPagePropertiesCommand',
      commandId,
      pageId,
      basePropertiesHash: hash('a'),
      propertyPatch: {
        // Patch omits `prop-a`, so the planner defaults the desired value to empty.
        'prop-b': { _tag: 'rich_text', plainText: 'Other' },
      },
    })

    const decision = planIntent({
      snapshot: snapshot({
        properties: [propertyASurface({ availability: 'unsupported' })],
      }),
      intent: { ...propertyEditIntent, command: clearCommand },
    })

    expect(decision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'UnsupportedRemoteShape',
    })
  })

  it('keeps local file deletion as a candidate by default and does not enqueue trash', () => {
    const decision = planIntent({
      snapshot: snapshot(),
      intent: {
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
      },
    })

    expect(decision).toMatchObject({
      _tag: 'AppendEvents',
      events: [{ _tag: 'LocalDeleteCandidateAccepted' }],
    })
  })

  it('blocks restoring a moved-out page as MoveOutNotDelete (symmetric with trash)', () => {
    const decision = planIntent({
      snapshot: snapshot({
        rows: [
          {
            pageId,
            dataSourceId,
            propertiesHash: hash('a'),
            inTrash: true,
            // Moved out of the tracked source, not genuinely trashed: a restore of
            // this row is not a legitimate trash restore and must be blocked.
            movedOut: true,
            localDeleteCandidate: false,
          },
        ],
      }),
      intent: {
        _tag: 'local-delete',
        intentEventId,
        commandKey,
        surface: pageSurfaceKey(pageId),
        pageId,
        command: {
          _tag: 'RestorePageCommand',
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
    })

    expect(decision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'MoveOutNotDelete',
    })
  })

  it('restores a genuinely-trashed page (not moved-out) by enqueuing the restore command', () => {
    const decision = planIntent({
      snapshot: snapshot({
        rows: [
          {
            pageId,
            dataSourceId,
            propertiesHash: hash('a'),
            inTrash: true,
            movedOut: false,
            localDeleteCandidate: false,
          },
        ],
      }),
      intent: {
        _tag: 'local-delete',
        intentEventId,
        commandKey,
        surface: pageSurfaceKey(pageId),
        pageId,
        command: {
          _tag: 'RestorePageCommand',
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
    })

    expect(decision).toMatchObject({
      _tag: 'EnqueueCommands',
      commands: [{ command: { _tag: 'RestorePageCommand' } }],
    })
  })

  it('blocks trusted local deletes when the current row projection is missing', () => {
    const decision = planIntent({
      snapshot: snapshot({
        rows: [],
      }),
      intent: {
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
    })

    expect(decision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'CurrentSurfaceMissing',
    })
  })

  it('blocks filtered absence and capped queries from tombstone decisions', () => {
    const filteredDecision = planIntent({
      snapshot: snapshot({
        queries: [
          {
            dataSourceId,
            pageId,
            queryContractHash: hash('b'),
            completeness: { terminal: true, cappedAtLimit: false, contractChanged: false },
            absence: {
              classified: false,
              filtered: true,
              membershipScope: 'all-data-source-rows',
              directRetrieve: 'accessible',
            },
          },
        ],
      }),
      intent: {
        _tag: 'query-absence',
        surface: querySurfaceKey({ dataSourceId: dataSourceId, queryContractHash: hash('b') }),
        dataSourceId,
        pageId,
        queryContractHash: hash('b'),
      },
    })

    expect(filteredDecision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'FilteredAbsenceNotProof',
    })

    const cappedDecision = planIntent({
      snapshot: snapshot({
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
      intent: {
        _tag: 'query-absence',
        surface: querySurfaceKey({ dataSourceId: dataSourceId, queryContractHash: hash('b') }),
        dataSourceId,
        pageId,
        queryContractHash: hash('b'),
      },
    })

    expect(cappedDecision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'QueryResultCapExceeded',
    })
  })

  it('allows explicit-filter absence to prove a page is only outside the sync scope', () => {
    const decision = planIntent({
      snapshot: snapshot({
        queries: [
          {
            dataSourceId,
            pageId,
            queryContractHash: hash('b'),
            completeness: { terminal: true, cappedAtLimit: false, contractChanged: false },
            absence: {
              classified: true,
              filtered: true,
              membershipScope: 'explicit-filter',
              directRetrieve: 'accessible',
            },
          },
        ],
      }),
      intent: {
        _tag: 'query-absence',
        surface: querySurfaceKey({ dataSourceId: dataSourceId, queryContractHash: hash('b') }),
        dataSourceId,
        pageId,
        queryContractHash: hash('b'),
      },
    })

    expect(decision).toEqual({ _tag: 'AppendEvents', events: [] })
  })

  it('ignores query absence when direct retrieve proves the page is still accessible', () => {
    const decision = planIntent({
      snapshot: snapshot({
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
      intent: {
        _tag: 'query-absence',
        surface: querySurfaceKey({ dataSourceId: dataSourceId, queryContractHash: hash('b') }),
        dataSourceId,
        pageId,
        queryContractHash: hash('b'),
      },
    })

    expect(decision).toEqual({ _tag: 'AppendEvents', events: [] })
  })

  it('does not reuse an accessible direct retrieve for another absent page', () => {
    const decision = planIntent({
      snapshot: snapshot({
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
      intent: {
        _tag: 'query-absence',
        surface: querySurfaceKey({ dataSourceId: dataSourceId, queryContractHash: hash('b') }),
        dataSourceId,
        pageId: otherPageId,
        queryContractHash: hash('b'),
      },
    })

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

      const decision = planIntent({
        snapshot: snapshot({
          queries,
        }),
        intent: {
          _tag: 'query-absence',
          surface: querySurfaceKey({ dataSourceId: dataSourceId, queryContractHash: hash('b') }),
          dataSourceId,
          pageId,
          queryContractHash: hash('b'),
        },
      })

      expect(decision).toMatchObject({
        _tag: 'BlockedByGuard',
        guard: 'QueryAbsenceUnclassified',
      })
    },
  )

  it('blocks malformed query absence evidence instead of recording a tombstone', () => {
    const missingIntentDataSource = {
      _tag: 'query-absence',
      surface: querySurfaceKey({ dataSourceId: dataSourceId, queryContractHash: hash('b') }),
      pageId,
      queryContractHash: hash('b'),
    } as unknown as Parameters<typeof planIntent>[0]['intent']

    const decisionWithoutIntentDataSource = planIntent({
      snapshot: snapshot({
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
      intent: missingIntentDataSource,
    })

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

    const decisionWithoutEvidencePage = planIntent({
      snapshot: snapshot({
        queries: [missingEvidencePage],
      }),
      intent: {
        _tag: 'query-absence',
        surface: querySurfaceKey({ dataSourceId: dataSourceId, queryContractHash: hash('b') }),
        dataSourceId,
        pageId,
        queryContractHash: hash('b'),
      },
    })

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
    const decision = planIntent({
      snapshot: snapshot({
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
      intent: {
        _tag: 'query-absence',
        surface: querySurfaceKey({ dataSourceId: dataSourceId, queryContractHash: hash('b') }),
        dataSourceId,
        pageId,
        queryContractHash: hash('b'),
      },
    })

    expect(decision).toMatchObject({
      _tag: 'AppendEvents',
      events: [{ _tag: 'TombstoneClassified', reason }],
    })
  })

  it('blocks body adapter surface leaks before command settlement', () => {
    const decision = planIntent({
      snapshot: snapshot(),
      intent: {
        _tag: 'body-adapter-result',
        surface: bodySurfaceKey(pageId),
        pageId,
        safety: bodySafety({ adapterMutationSurfaces: ['body', 'schema'] }),
      },
    })

    expect(decision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'BodyAdapterNonBodyMutation',
    })
  })

  const schemaCommandWithOperations = decode(PatchDataSourceSchemaCommand, {
    _tag: 'PatchDataSourceSchemaCommand',
    commandId,
    dataSourceId,
    baseSchemaHash: hash('b'),
    schemaPatch: {},
    operations: [
      {
        _tag: 'AddProperty',
        name: decode(PropertyName, 'Notes'),
        definition: { _tag: 'rich_text' },
      },
      {
        _tag: 'RenameProperty',
        propertyId: propertyA,
        newName: decode(PropertyName, 'Task'),
      },
    ],
  })

  const schemaMigrationIntent = (
    overrides: {
      readonly safety?: {
        readonly affectsLocalIntent: boolean
        readonly destructiveMigrationRequired: boolean
        readonly optionDeletionLosesValues: boolean
      }
    } = {},
  ) =>
    ({
      _tag: 'schema-migration',
      intentEventId,
      commandKey,
      surface: schemaSurfaceKey({ dataSourceId: dataSourceId, propertyId: propertyA }),
      dataSourceId,
      affectedPropertyIds: [propertyA],
      command: schemaCommandWithOperations,
      baseHash: hash('b'),
      desiredHash: hash('e'),
      safety: overrides.safety ?? {
        affectsLocalIntent: false,
        destructiveMigrationRequired: false,
        optionDeletionLosesValues: false,
      },
    }) as const

  it('enqueues a typed schema patch command when the conservative subset is safe', () => {
    const decision = planIntent({ snapshot: snapshot(), intent: schemaMigrationIntent() })

    expect(decision._tag).toBe('EnqueueCommands')
    if (decision._tag === 'EnqueueCommands') {
      const [envelope] = decision.commands
      expect(envelope?.command).toBe(schemaCommandWithOperations)
      expect(envelope?.command._tag).toBe('PatchDataSourceSchemaCommand')
      if (envelope?.command._tag === 'PatchDataSourceSchemaCommand') {
        expect(envelope.command.operations).toHaveLength(2)
        expect(envelope.command.operations[0]?._tag).toBe('AddProperty')
        expect(envelope.command.operations[1]?._tag).toBe('RenameProperty')
      }
      expect(envelope?.preflight).toContain('DestructiveSchemaMigrationRequired')
      expect(envelope?.preflight).toContain('OptionDeletionLosesValues')
    }
  })

  it.each([
    [
      'destructive migration required',
      'DestructiveSchemaMigrationRequired' as const,
      {
        affectsLocalIntent: false,
        destructiveMigrationRequired: true,
        optionDeletionLosesValues: false,
      },
    ],
    [
      'option deletion loses values',
      'OptionDeletionLosesValues' as const,
      {
        affectsLocalIntent: false,
        destructiveMigrationRequired: false,
        optionDeletionLosesValues: true,
      },
    ],
    [
      'schema drift affects intent',
      'SchemaDriftAffectsIntent' as const,
      {
        affectsLocalIntent: true,
        destructiveMigrationRequired: false,
        optionDeletionLosesValues: false,
      },
    ],
  ])('blocks schema migration when %s', (_label, expectedGuard, safety) => {
    const decision = planIntent({ snapshot: snapshot(), intent: schemaMigrationIntent({ safety }) })

    expect(decision).toMatchObject({ _tag: 'BlockedByGuard', guard: expectedGuard })
  })

  it('opens path claim conflicts instead of overwriting another page claim', () => {
    const decision = planIntent({
      snapshot: snapshot({
        pathClaims: [{ path: 'same.nmd', ownerPageId: otherPageId, released: false }],
      }),
      intent: {
        _tag: 'path-claim',
        surface: pathSurfaceKey('same.nmd'),
        pageId,
        path: 'same.nmd',
      },
    })

    expect(decision).toMatchObject({
      _tag: 'OpenConflict',
      conflict: { kind: 'path-collision' },
    })
  })
})
