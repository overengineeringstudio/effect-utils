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

The NotionMD-backed adapter supports observe, materialize, plan, repair, and
guarded body push. It consumes NotionMD's public body-only facade for `.nmd`
remote observation, local body read, materialization, verified remote body
replace, and clean-base settlement. Datasource sync records its own sidecars
for path identity and own-write suppression, and carries local path/content
through body push commands. Hash-only commands, absent adapters, stale bases,
truncated or unknown-block bodies, and any adapter attempt to mutate non-body
surfaces remain unsupported: no body push settlement occurs and no non-body
mutation may be inferred from body sync.

The adapter accepts body-fidelity evidence from NotionMD without depending on
NotionMD internals. Pure completeness vocabulary belongs below both packages in
`@overeng/notion-core`; live Notion observation input belongs in
`@overeng/notion-effect-client`; NotionMD translates that evidence through its
body facade and fails closed before clean-base adoption. Datasource sync consumes
a typed `BodyPointer` whose identity is either rendered-only local desired
content or evidence-backed remote state. Lossy evidence is pessimistic: it
cannot establish or refresh a clean remote base.

`BodyPointer` carries a first-class `BodyIdentity`, never parallel hash/evidence
fields. Remote Notion body observations must return `EvidenceBackedBodyIdentity`.
Local desired Markdown can be represented as `RenderedBodyIdentity`, but a remote
clean base and a remote body settlement require evidence-backed identity. If the
adapter cannot produce complete evidence for a remote body, body writes remain
blocked instead of falling back to rendered-hash comparison.

Body evidence fingerprints are content-addressed observation envelopes, not
Notion revisions. They are safe to use as body-scoped base identities for
planner/executor guards, but they cannot eliminate the residual race after the
pre-write read because Notion does not expose server-side conditional body
writes.

`@overeng/notion-react` is intentionally not in this path: it is an owned-region
writer and may later reuse core classifiers or fingerprints for preflight/drift
reporting, but datasource-sync must not route guarded Markdown adoption through
the React reconciler.

After a verified body push, the NotionMD-backed adapter refreshes the local
`.nmd` clean base and datasource-sync sidecar only if the file still represents
the body content that was just pushed. If the file changed while the remote write
was in flight, the adapter fails closed instead of overwriting the newer local
edit. Clean-base refresh is settlement bookkeeping, not a second user-visible
body mutation, and it may settle only from a complete NotionMD body observation.
Settlement records preserve the verified `BodyPointer` inside
`BodyProjectionPayload`, including typed identity, safety, and materialization
state. Replay rebuilds the same body pointer from events/projections; it does not
reconstruct body identity from split hash columns or legacy safety JSON.

Body materialization is subordinate to the established sync no-unwanted-data-loss
invariant. The body adapter may provide materialization mechanics, but
datasource-sync orchestration decides when materialization is safe. If a local
`.nmd` differs from the captured/base body hash and has not been durably
preserved as a pending body intent or conflict artifact, the remote body must
not be written over it.

The body-related guards (`BodyLossyRemote`, `MarkdownUnknownBlocksAmbiguous`, `MarkdownSelectionAmbiguous`, `MarkdownWouldDeleteChildren`, `MarkdownSyncedPageUnsupported`, `BodyAdapterConflict`, `BodyAdapterNonBodyMutation`) live in the planner guard matrix in [spec.md](../../spec.md); this sub-system supplies the adapter state those guards consume.
