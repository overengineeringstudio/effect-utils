# Notion Gateway Spec

Sub-system slice of [spec.md](../../spec.md). Serves [requirements](./requirements.md).

Requirement trace: GW-R01, GW-R02, GW-R03, GW-R04, GW-R05, GW-R06, GW-R07, GW-R08.

## Gateway Port

Raw Notion HTTP access stays in the API-client layer. Datasource sync consumes the typed `NotionDataSourceGateway` port. Ports return decoded domain values, not raw JSON. Raw Notion payloads may be retained only through the store retention policy.

```ts
type NotionDataSourceGateway = {
  readonly apiContract: NotionApiContract
  readonly preflightCapabilities: (
    input: CapabilityPreflightInput,
  ) => Effect<CapabilityPreflightResult, NotionGatewayError>
  readonly retrieveDataSource: (id: DataSourceId) => Effect<DataSourceSnapshot, NotionGatewayError>
  readonly queryRows: (input: QueryRowsInput) => Stream<QueryRowsPage, NotionGatewayError>
  readonly retrievePage: (id: PageId) => Effect<PageSnapshot, NotionGatewayError>
  readonly retrievePageProperty: (
    input: RetrievePagePropertyInput,
  ) => Stream<PagePropertyItemPage, NotionGatewayError>
  readonly patchPageProperties: (
    command: PatchPagePropertiesCommand,
  ) => Effect<NotionRequestId, NotionGatewayError>
  readonly patchDataSourceSchema: (
    command: PatchDataSourceSchemaCommand,
  ) => Effect<NotionRequestId, NotionGatewayError>
  readonly trashPage: (command: TrashPageCommand) => Effect<NotionRequestId, NotionGatewayError>
  readonly restorePage: (command: RestorePageCommand) => Effect<NotionRequestId, NotionGatewayError>
}

type NotionApiContract = {
  readonly apiVersion: '2026-03-11'
  readonly clientVersion: string
  readonly supportedCapabilities: readonly CapabilityName[]
}

type QueryRowsInput = {
  readonly dataSourceId: DataSourceId
  // Product sync always supplies the full database membership contract. Custom
  // query contracts are internal test/debug inputs and are not CLI
  // establishment modes.
  readonly queryContract: QueryContract
  readonly startCursor: QueryCursor | null
}

type QueryRowsPage = {
  readonly apiVersion: NotionApiVersion
  readonly requestId: NotionRequestId
  readonly queryContractHash: Hash
  readonly rows: readonly RowPageSnapshot[]
  readonly nextCursor: QueryCursor | null
  readonly hasMore: boolean
  readonly cappedAtLimit: boolean
}

type QueryContract = {
  readonly apiVersion: '2026-03-11'
  readonly filter: null
  readonly sorts: readonly []
  readonly pageSize: PositiveInt
  readonly highWatermark: null
  readonly membershipScope: 'all-data-source-rows'
}

type PagePropertyItemPage = {
  readonly apiVersion: NotionApiVersion
  readonly requestId: NotionRequestId
  readonly pageId: PageId
  readonly propertyId: PropertyId
  readonly items: readonly PagePropertyItem[]
  readonly nextCursor: QueryCursor | null
  readonly hasMore: boolean
}
```

## API Version Contract

The supported Notion contract is `Notion-Version: 2026-03-11`.

| Concern         | Spec decision                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Request version | Every gateway request sends `2026-03-11` and records it in the request span and safe diagnostics.                         |
| Older versions  | Older versions are unsupported unless an explicit compatibility profile has fake-service coverage and a live smoke proof. |
| Newer versions  | Newer versions start blocked by `ApiVersionCompatibilityMissing` until decode and live compatibility proofs are added.    |
| Trash field     | Canonical lifecycle uses `in_trash`; `archived` is decode drift for supported surfaces.                                   |
| Meeting notes   | Canonical block/type naming uses `meeting_notes`; `transcription` is decode drift unless a compatibility profile maps it. |
| Block append    | Gateway command shapes use `position`, not `after`.                                                                       |

Decode drift is surface-scoped. An unsupported payload for one property, block, or data-source feature blocks that surface and writes a typed guard state without corrupting unrelated projections.

## Remote Query And Property Completeness

Remote membership and row hashing require two different completeness proofs:

| Proof                       | Source                   | Required terminal condition                                                  | Failure behavior                                             |
| --------------------------- | ------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Query scan completeness     | data-source query pages  | cursor chain reaches `hasMore=false` before the 10,000-result cap hides rows | do not advance completeness checkpoint or classify absence   |
| Property value completeness | page-property item pages | every paginated property needed for hashing reaches `hasMore=false`          | mark property incomplete; block writes to that property only |

`QueryContract` is private checkpoint identity for the full database membership
query. The membership contract is distinct from the scan window: a
high-watermark poll is an incremental observation of the same full-replica
membership, not a different product replica. Product replicas do not expose
filtered or query-contract establishment. Any internal debug/test query shape
starts a separate private `_nds_*` checkpoint and must not produce a
database-ID-named product replica. The query contract hash excludes the moving
high-watermark so repeated incremental windows update the same checkpoint row
instead of creating unbounded checkpoint identities.

Query policy:

| Case                                                       | Decision                                                                           |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| unsorted full query                                        | normal product scan; must page to terminal completion before absence is evidence   |
| inclusive `last_edited_time` high-watermark query          | steady-state optimization only; must not emit absence or tombstone candidates      |
| `last_edited_time` sort                                    | internal optimization only; repair scans still verify known pages and completeness |
| `filter_properties` omits edited/hash-relevant properties  | fetch omitted values through page-property pagination before hashing               |
| query result includes complete page property values        | hash inline values directly; do not issue per-row page retrieval                   |
| query result omits or truncates required property values   | fall back to page/page-property retrieval before producing clean hashes            |
| linked data source or unsupported wiki/special data source | block with unsupported guard                                                       |
| filtered query                                             | internal test/debug only; not a product replica or tombstone proof                 |

The 10,000-result query cap is a hard completeness boundary. Large databases
must either complete a full scan or stay blocked by `QueryResultCapExceeded`;
partial replicas are not a supported fallback.

The store-side checkpoint projections (`query_scan_checkpoint`,
`page_property_checkpoint`) that record these proofs are specified in
[../sync-store/spec.md](../sync-store/spec.md).
