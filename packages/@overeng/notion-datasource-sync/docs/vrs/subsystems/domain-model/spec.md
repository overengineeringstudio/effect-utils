# Domain Model Spec

Sub-system slice of [spec.md](../../spec.md). Serves [requirements](./requirements.md).

Requirement trace: DOMAIN-R01, DOMAIN-R02, DOMAIN-R03, DOMAIN-R04, DOMAIN-R05, DOMAIN-R06, DOMAIN-R07, DOMAIN-R08, DOMAIN-R09, DOMAIN-R10.

The canonical domain model defines data-source, schema, row, property, body-pointer, and file types that are independent from local file layout. Sync identity is keyed by stable Notion IDs and canonical value hashes, never by display names.

Notion object identity is not datasource-sync-local domain. Datasource-sync
already aliases shared `PageId`, `PropertyId`, and `PropertyName` schemas from
`@overeng/notion-effect-schema` where the canonical property model carries them.
Package-local brands are reserved for local concepts such as sync roots, command
IDs, event IDs, leases, path claims, and store artifacts.

```ts
type DataSourceBinding = {
  readonly dataSourceId: DataSourceId
  readonly databaseId: DatabaseId | null
  readonly localRoot: AbsolutePath
  readonly storePath: AbsolutePath
  readonly policy: WorkspacePolicy
}

type PropertyIdentity = {
  readonly id: PropertyId
  readonly name: string
  readonly type: PropertyType
  readonly typeConfigHash: Hash
  readonly writeClass: 'writable' | 'computed' | 'unsupported'
}

type RowSurface = {
  readonly pageId: PageId
  readonly parentDataSourceId: DataSourceId
  readonly propertyHashes: Record<PropertyId, Hash>
  readonly bodyPointer: BodyPointer | null
  readonly lifecycle: RowLifecycle
}

type PropertySurface = {
  readonly pageId: PageId
  readonly propertyId: PropertyId
  readonly baseHash: Hash
  readonly remoteHash: Hash
  readonly localHash: Hash | null
  readonly availability:
    | 'complete'
    | 'computed'
    | 'unsupported'
    | 'paginated-incomplete'
    | 'relation-target-inaccessible'
    | 'related-data-source-unshared'
}

type BodyPointer = {
  readonly pageId: PageId
  readonly identity: BodyIdentity
  readonly observedAt: DateTimeUtc
  readonly safety: BodySafetySnapshot
}

type BodyIdentity =
  | {
      readonly _tag: 'RenderedBodyIdentity'
      readonly rendered: ContentDescriptor
    }
  | {
      readonly _tag: 'EvidenceBackedBodyIdentity'
      readonly evidenceFingerprint: BodyEvidenceFingerprint
      readonly rendered: ContentDescriptor
      readonly completeness: BodyCompletenessEvidence
    }

type BodySafetySnapshot = {
  readonly truncated: boolean
  readonly unknownBlockCause: 'truncation' | 'permission' | 'unsupported' | 'unknown' | null
  readonly selection: 'safe' | 'ambiguous'
  readonly wouldDeleteChildren: boolean
  readonly syncedPageUnsupported: boolean
  readonly adapterConflict: boolean
  readonly adapterMutationSurfaces: readonly BodyAdapterMutationSurface[]
}

type FileReference = {
  readonly kind: 'external' | 'notion-hosted' | 'unsupported'
  readonly stableRef: string | null
  readonly name: string | null
  readonly expiresAt: DateTimeUtc | null
}
```

Display names are never row-value identity. Property IDs and canonical value hashes drive rename-safe planning. Expiring Notion file URLs may appear in transient observations but must canonicalize to `FileReference` without persisting the signed URL.

Relation, people, rich-text, title, and rollup values are hashable only after their paginated page-property stream reaches `hasMore=false`. If a related data source is not shared with the integration, the value is `related-data-source-unshared` and cannot be silently treated as an empty relation. Public SQLite relation writes are supported only for removal/reorder of targets already present in a complete observed base; adding new targets remains fail-closed until target accessibility is modeled.

Body pointers do not carry parallel `bodyHash`, descriptor, and optional
evidence fields. The selected body guard identity is explicit in `BodyIdentity`,
so planning, execution, projection replay, and telemetry cannot disagree about
whether a body write was guarded by rendered content or remote evidence.
`unknownBlockCause` remains `unknown` unless the adapter can prove truncation,
permission loss, or an unsupported block type; ambiguous unknown blocks block
body writes.

The completeness proofs that gate property hashing are specified in
[../notion-gateway/spec.md](../notion-gateway/spec.md). Wire schemas and
canonical property codecs behind these types are shared across datasource-sync,
NotionMD, Notion React, and CLI tooling where those contracts already exist.
Datasource-sync owns byte-stable sync hashes and event payload identity for its
SQLite control plane.
