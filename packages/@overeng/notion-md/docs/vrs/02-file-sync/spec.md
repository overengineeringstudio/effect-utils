# Spec: 02-file-sync

Specifies the file-based sync surface: the pull / status / push flows over a
persistent `.nmd` file, the CLI and batch/tree orchestration, and the watch-mode
lifecycle. Builds on [../requirements.md](../requirements.md) +
[./requirements.md](./requirements.md); terms in [../glossary.md](../glossary.md);
rationale in [../.decisions/](../.decisions/). See [../spec.md](../spec.md) for the
architecture index.

Traces: R20, R28. The guarded-push / three-way-merge / settle decisions invoked
by these flows are owned by [03-sync-engine](../03-sync-engine/spec.md) (R09, R11,
R13, R15); the lossy-page refusal at the pull is owned by
[04-fidelity](../04-fidelity/spec.md) (R30/R38); the `.nmd` envelope and object
store written by these flows are owned by [05-local-state](../05-local-state/spec.md);
the schema-drift check before a property write is owned by
[06-data-source](../06-data-source/spec.md) (R14).

## Pull Flow

1. Decode CLI options.
2. Retrieve Notion page metadata.
3. Observe the remote body through the Notion body observation service.
4. Reject clean-base adoption if the observation is lossy. **Under R38 "lossy"
   means any block whose body-Markdown rendering does not reparse to the same
   block** (round-trip-safety), so a page with a `child_database` /
   `table_of_contents` / `synced_block` / `child_page`-in-body / API `unsupported`
   block is refused here — uniformly with the editor verbs (decisions 0016, 0017;
   [04-fidelity](../04-fidelity/spec.md)).
5. Adopt the block-tree-rendered Markdown as the local body and base snapshot;
   keep endpoint Markdown only as diagnostic evidence.
6. Retrieve block-API payloads only for **round-trip-safe** captures (files, media,
   resolvable unknowns) to enrich storage; a not-round-trip-safe block makes the
   observation lossy (step 4) rather than something to preserve and edit around.
7. Compute the body hash over the adopted rendered body.
8. Build a strict frontmatter envelope ([05-local-state](../05-local-state/spec.md)).
9. Write base snapshot and storage objects.
10. Write the `.nmd` file.
11. Emit a pull result with storage mode and object refs.

Future selected surfaces add data-source schema, comments, and files before the write commit.

## Status Flow

1. Read and decode `.nmd` once.
2. Validate all referenced objects.
3. Retrieve the current remote page and Markdown.
4. Compute local body hash, remote body hash, property edit state, metadata drift, and unresolved unknown block IDs.
5. Return a typed status result.

Status distinguishes `remoteBodyChanged` from `remotePageMetadataChanged`. The current implementation still exposes a combined `remoteChanged` convenience field.

## Push Flow

1. Read and decode `.nmd` once.
2. Pull remote state once for status.
3. Reject clean-base use of any lossy remote body observation ([04-fidelity](../04-fidelity/spec.md)).
4. Reject unresolved Roughdraft review markup unless explicitly allowed ([03-sync-engine](../03-sync-engine/spec.md), R13).
5. Reject body pushes that could delete resolvable unknown blocks unless destructive intent is explicit. (Not-round-trip-safe blocks never reach a push: the page was refused at pull, step 4 / R38 — this push guard is the secondary defense for resolvable captures only.)
6. If only page metadata or properties changed and the remote body changed, patch those surfaces and refresh local body from remote only when the refreshed body is complete.
7. If the remote body changed and local body changed, attempt a conservative three-way merge ([03-sync-engine](../03-sync-engine/spec.md)).
8. If merge succeeds, update Markdown and then properties. Before a property write, compare the data-source schema against the pull-time `schema_snapshot`; on drift, refuse with exit 6 (`NmdSchemaDriftError`, R14, [06-data-source](../06-data-source/spec.md)) rather than risk silently auto-creating options — resolve by re-pulling.
9. If merge fails, write a Roughdraft conflict artifact and leave remote unchanged.
10. Land the merged (or still-at-base) body through the engine's write-verb
    selection — targeted `update_content` when safe, guarded `replace_content`
    otherwise ([03-sync-engine](../03-sync-engine/spec.md#update_content-vs-replace_content)).
11. Settle: re-observe the remote body after writes and rewrite `.nmd` with fresh
    body, base, page metadata, storage, and completeness evidence. The post-push
    `semanticEquivalent` gate and the trusted-base refresh are owned by the engine
    ([03-sync-engine](../03-sync-engine/spec.md#settle-and-post-push-verification)).

The local file is read once for a push decision to avoid local snapshot drift.

Clean-base writes are allowed only from complete body observations with
block-tree-rendered Markdown available. Endpoint truncation, unknown block IDs,
unsupported inventory entries, missing rendered evidence, or a rendered
block-tree suffix not present in the endpoint Markdown all block establishment,
tree materialization, facade settlement, and post-write clean-base refresh. The
engine governs when a write is considered settled (an incomplete refreshed
observation leaves the local `.nmd` base untrusted; [03-sync-engine](../03-sync-engine/spec.md#settle-and-post-push-verification)).

Pull adoption is block-aware. Notion's Markdown endpoint may omit blank block
boundaries around heading/paragraph/divider sequences; reparsing that endpoint
Markdown through CommonMark can promote prose paragraphs to Setext/ATX headings.
`notion-md` therefore treats endpoint Markdown as evidence and adopts the
client block-tree renderer output as the clean body.

## CLI

Current commands:

```bash
notion-md sync <page-id-or-url> page.nmd
notion-md sync docs --from-remote --root <page-id-or-url>
notion-md plan docs
notion-md status page.nmd
notion-md sync page.nmd [--watch] [--poll-interval-ms 30000]
notion-md sync docs
```

Environment:

| Variable           | Meaning          |
| ------------------ | ---------------- |
| `NOTION_API_TOKEN` | Notion API token |

Output:

- One-shot commands emit pretty JSON results by default.
- Watch emits compact NDJSON event lines by default.
- Watch `sync_error` events include structured typed error fields.
- The long-term stable contract is explicit `--output human|json|ndjson`, with `auto` allowed only as a convenience alias after envelope schemas are versioned.

The write-path commands also surface the staged sync-progress indicator on a TTY
stderr ([01-editor](../01-editor/spec.md#sync-progress-indicator-write-path), R43–R45).

Future CLI contract:

```bash
notion-md diff <file.nmd> [--surface body|properties|comments|files]
notion-md comments pull|push <file.nmd>
notion-md doctor <page-id-or-url|file.nmd>
notion-md store verify|gc|export <file.nmd>
```

Batch commands:

```bash
notion-md status <target...> [--recursive] [--concurrency 4]
notion-md sync <target> [--recursive] [--concurrency 4] [--watch]
```

Rules:

- A single file target emits a single-page JSON result.
- Multiple status targets or flat recursive directory targets emit a batch envelope.
- Directory tree targets read `.notion-md/workspace.json` as an internal tree
  index when present. `plan` reports tree operations without writing files, and
  `sync` applies the local tree unless `--from-remote` is explicit.
- Recursive discovery includes existing `*.nmd` files and skips `.notion-md`,
  `.git`, and `node_modules`.
- Duplicate `page_id` values in the same batch are rejected before any Notion
  mutation.
- Missing or malformed files are reported as per-file errors when other valid
  targets can still run.
- Local file deletion, local rename, and remote page moves are not destructive
  intent. Remote archive/delete remains explicit future behavior.

Batch and folder support do not change the ownership unit: one `.nmd` file maps
to one Notion page, and every mutation still passes through the same page-local
guards ([03-sync-engine](../03-sync-engine/spec.md)). The batch layer only owns
target discovery, duplicate page-id preflight, bounded concurrency, per-file
result reporting, and multi-file watch scheduling.

## Watch Lifecycle

Requirement trace: R19, R20, R28.

```
initial event ----\
file event --------> sliding queue -> debounce -> sync pass -> JSON event
remote poll ------/
```

Rules:

- One sync pass runs at a time per process.
- File events and poll events are coalesced.
- Each pass emits `sync` or `sync_error`.
- Sync-pass spans observe failures before the watch loop recovers.
- Interruption closes the watcher, stops polling, and cancels queued work.
- File events come from the Effect Platform `FileSystem.watch` stream. Production
  adapters are thin stream producers; coalescing policy stays in the watch loop.
- Multi-file watch resolves the target set at startup, watches the containing
  directories for those files, coalesces by path, and runs batch sync passes with
  bounded concurrency. New files discovered after startup require restarting the
  watcher until a tree manifest/daemon owns dynamic discovery.

The watch core uses a sliding queue and debounce window. Future tests may inject
source streams and `TestClock`, but production code must stay on Effect Platform
watch primitives instead of raw runtime callbacks.
