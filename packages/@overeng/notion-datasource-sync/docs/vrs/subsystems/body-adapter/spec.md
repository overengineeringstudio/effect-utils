# Body Adapter Spec

Sub-system slice of [spec.md](../../spec.md). Serves [requirements](./requirements.md).

Requirement trace: BODY-R01, BODY-R02.

The body adapter is the boundary between datasource sync and `@overeng/notion-md`. Datasource sync never owns page-body internals; it delegates observation, planning, materialization, repair, and push of `.nmd` bodies to a `PageBodySyncPort`. Keeping the contract narrow makes alternative body adapters (or local storage adapters) possible without changing the sync planner.

## Runtime Port

`PageBodySyncPort` is the only interface datasource sync uses to interact with bodies. It returns decoded domain values, not raw JSON.

```ts
type PageBodySyncPort = {
  readonly observe: (input: ObserveBodyInput) => Effect<BodyPointer, BodySyncError>
  readonly planLocalChange: (
    input: BodyLocalChangeInput,
  ) => Effect<BodyIntent | BodyConflict, BodySyncError>
  readonly push: (command: BodyPushCommand) => Effect<BodyPushResult, BodySyncError>
  readonly repair: (input: BodyRepairInput) => Effect<BodyPointer | BodyConflict, BodySyncError>
}
```

## Body Adapter Semantics

Datasource sync treats public markdown operations as body-adapter internals, but the adapter contract must surface enough state for safe planning:

| Markdown condition                                      | Datasource-sync behavior                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `GET /pages/:page_id/markdown` returns `truncated=true` | body surface is lossy; body writes blocked                                     |
| `unknown_block_ids` is non-empty                        | body writes blocked unless adapter proves the operation preserves those blocks |
| `update_content` target missing or repeated             | do not rely on selection; use a verified safer operation or open conflict      |
| patch would delete child pages/databases                | block unless an explicit destructive-body command supplies deletion approval   |
| synced page cannot be updated                           | persist body conflict/unsupported state; property sync remains independent     |

`PageBodySyncPort` is body-only by contract. It may read page identity and body metadata needed to guard Markdown operations, but it must not write row properties, schema, title, trash state, icon, cover, parent, lock state, or other page metadata. If a body operation needs a non-body surface change, datasource sync must append an explicit event and outbox command for that surface and record the body operation as delegated context.

The body adapter must not set `allow_deleting_content` as part of ordinary sync, conflict resolution, or repair. Destructive body operations are separate explicit commands with dry-run output.

Staging note: the current package has a NotionMD-backed adapter slice for observe, materialize, plan, repair, and guarded body push. It uses NotionMD public APIs to write real `.nmd` files and sidecars, records datasource-sync sidecars for path identity and own-write suppression, and carries local path/content through body push commands. Hash-only commands, absent adapters, stale bases, truncated or unknown-block bodies, and any adapter attempt to mutate non-body surfaces remain unsupported: no body push settlement occurs and no non-body mutation may be inferred from body sync.

Body materialization is subordinate to the established sync no-unwanted-data-loss
invariant. The body adapter may provide materialization mechanics, but
datasource-sync orchestration decides when materialization is safe. If a local
`.nmd` differs from the captured/base body hash and has not been durably
preserved as a pending body intent or conflict artifact, the remote body must
not be written over it.

The body-related guards (`BodyLossyRemote`, `MarkdownUnknownBlocksAmbiguous`, `MarkdownSelectionAmbiguous`, `MarkdownWouldDeleteChildren`, `MarkdownSyncedPageUnsupported`, `BodyAdapterConflict`, `BodyAdapterNonBodyMutation`) live in the planner guard matrix in [spec.md](../../spec.md); this sub-system supplies the adapter state those guards consume.
