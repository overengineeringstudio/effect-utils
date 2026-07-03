/**
 * SEAM member contract for the `notion_md.*` telemetry namespace (decision 0005) — notion-md's OWN
 * observability, authored via the Layer-2 `@overeng/otel-contract/registry` surface. This is the
 * single home for notion-md's telemetry catalog + signals: the Weaver registry projection AND the
 * runtime encoders (`src/observability.ts`) both derive from it (SC-R13/R14).
 *
 * This is a `*.contract.ts` seam file, so it is exempt from the `otel-contract-in-seam-file` lint
 * and MUST be registered in the root aggregator's `memberSeamPaths` (a colocated no-orphan-seam
 * test asserts this).
 *
 * Placement: `src/` (notion-md has no dependency-free zone; `observability.ts` already imports
 * `@overeng/otel-contract` at runtime, so this file's `./registry` import is runtime-safe here).
 *
 * ANNOTATE-ONLY BUNDLES: notion-md annotates the CURRENT span with disjoint result-attribute
 * subsets (e.g. `pushResultAttrs`). The DSL exposes no sub-encoder and `operation.annotate` would
 * require the span's own required open fields, so each annotate bundle is a standalone
 * `OtelAttrs.defineSync` reusing the SAME `attr.*` schema objects (byte-identical encode). Keys
 * that appear ONLY in annotate bundles (or ONLY on a dynamic-name bridge span) land in the catalog
 * via `docOnlyAttributes` (SC-R13 catalog completeness).
 *
 * DYNAMIC-NAME BRIDGES: `stateFileSpan` / `batchRunSpan` / `cliCommandSpan` have runtime-varying
 * span names → no stable single-signal projection → they stay legacy inline `OtelOperation.define`
 * in `observability.ts` (SC-DQ5 migration-bridge, mirroring genie's `cli.mode`).
 */
import { Schema } from 'effect'

import { OtelAttr, OtelAttrs } from '@overeng/otel-contract'
import {
  attr,
  defineOtelContract,
  operation,
  recommended,
  required,
} from '@overeng/otel-contract/registry'

// ---------------------------------------------------------------------------
// attributes (annotated Effect Schemas; the notion_md.* catalog SSOT)
// ---------------------------------------------------------------------------

// -- identity / path --
/** Notion page id (UUID). */
export const NotionMdPageId = attr.string({
  key: 'notion_md.page_id',
  cardinality: 'high',
  brief: 'Notion page id (UUID).',
  stability: 'development',
  examples: ['205d5c1a-0000-4000-8000-000000000000'],
})

/** Parent Notion page id (UUID). */
export const NotionMdParentPageId = attr.string({
  key: 'notion_md.parent_page_id',
  cardinality: 'high',
  brief: 'Parent Notion page id (UUID).',
  stability: 'development',
  examples: ['205d5c1a-0000-4000-8000-000000000000'],
})

/** Notion data source (database) id. */
export const NotionMdDataSourceId = attr.string({
  key: 'notion_md.data_source_id',
  cardinality: 'high',
  brief: 'Notion data source (database) id.',
  stability: 'development',
  examples: ['205d5c1a-0000-4000-8000-000000000000'],
})

/** Basename of the `.nmd` path a span operates on. */
export const NotionMdPathBasename = attr.string({
  key: 'notion_md.path.basename',
  cardinality: 'high',
  brief: 'Basename of the `.nmd` path a span operates on.',
  stability: 'development',
  examples: ['index.nmd', 'notes.nmd'],
})

// -- object store --
/** Short prefix of a content-object hash (the full hash is high-cardinality). */
export const NotionMdObjectHashPrefix = attr.string({
  key: 'notion_md.object.hash_prefix',
  cardinality: 'high',
  brief: 'Short prefix of a content-object hash.',
  stability: 'development',
  examples: ['a1b2c3d4e5f6'],
})

/** Role of the stored content object. */
export const NotionMdObjectRole = attr.string({
  key: 'notion_md.object.role',
  cardinality: 'bounded',
  brief: 'Role of the stored content object.',
  stability: 'development',
  examples: ['markdown', 'frontmatter'],
})

// -- state store --
/** State-store file operation performed. */
export const NotionMdStateOperation = attr.string({
  key: 'notion_md.state.operation',
  cardinality: 'bounded',
  brief: 'State-store file operation performed.',
  stability: 'development',
  examples: ['read', 'write'],
})

// -- command / batch / watch --
/** notion-md command name. */
export const NotionMdCommand = attr.string({
  key: 'notion_md.command',
  cardinality: 'low',
  brief: 'notion-md command name.',
  stability: 'development',
  examples: ['status', 'sync'],
})

/** Whether the invocation runs over a batch of targets. */
export const NotionMdBatch = attr.boolean({
  key: 'notion_md.batch',
  brief: 'Whether the invocation runs over a batch of targets.',
  stability: 'development',
})

/** Number of targets in a batch run. */
export const NotionMdBatchTargetCount = attr.number({
  key: 'notion_md.batch.target_count',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of targets in a batch run.',
  stability: 'development',
  examples: [3],
})

/** Number of paths watched in a batch watch run. */
export const NotionMdBatchPathCount = attr.number({
  key: 'notion_md.batch.path_count',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of paths watched in a batch watch run.',
  stability: 'development',
  examples: [3],
})

/** Whether a batch run recurses into subdirectories. */
export const NotionMdBatchRecursive = attr.boolean({
  key: 'notion_md.batch.recursive',
  brief: 'Whether a batch run recurses into subdirectories.',
  stability: 'development',
})

/** Whether the command runs in watch mode. */
export const NotionMdWatch = attr.boolean({
  key: 'notion_md.watch',
  brief: 'Whether the command runs in watch mode.',
  stability: 'development',
})

/** What triggered a watch pass. */
export const NotionMdWatchReason = attr.enum({
  key: 'notion_md.watch.reason',
  values: ['file', 'initial', 'poll'],
  briefs: {
    file: 'A filesystem change triggered the pass.',
    initial: 'The initial pass at watch startup.',
    poll: 'A poll interval triggered the pass.',
  },
  brief: 'What triggered a watch pass.',
  stability: 'development',
})

// -- tree --
/** Whether a tree sync is plan-only (dry run). */
export const NotionMdTreePlan = attr.boolean({
  key: 'notion_md.tree.plan',
  brief: 'Whether a tree sync is plan-only (dry run).',
  stability: 'development',
})

/** Whether a tree plan/sync direction pulls from remote. */
export const NotionMdTreeFromRemote = attr.boolean({
  key: 'notion_md.tree.from_remote',
  brief: 'Whether a tree plan/sync direction pulls from remote.',
  stability: 'development',
})

// -- path flags --
/** Whether a path operation recurses over a tree. */
export const NotionMdPathRecursive = attr.boolean({
  key: 'notion_md.path.recursive',
  brief: 'Whether a path operation recurses over a tree.',
  stability: 'development',
})

// -- status --
/** Whether local content changed vs the baseline. */
export const NotionMdStatusLocalChanged = attr.boolean({
  key: 'notion_md.status.local_changed',
  brief: 'Whether local content changed vs the baseline.',
  stability: 'development',
})

/** Whether local page metadata changed vs the baseline. */
export const NotionMdStatusLocalPageMetadataChanged = attr.boolean({
  key: 'notion_md.status.local_page_metadata_changed',
  brief: 'Whether local page metadata changed vs the baseline.',
  stability: 'development',
})

/** Whether local database properties changed vs the baseline. */
export const NotionMdStatusLocalPropertiesChanged = attr.boolean({
  key: 'notion_md.status.local_properties_changed',
  brief: 'Whether local database properties changed vs the baseline.',
  stability: 'development',
})

/** Whether remote content changed vs the baseline. */
export const NotionMdStatusRemoteChanged = attr.boolean({
  key: 'notion_md.status.remote_changed',
  brief: 'Whether remote content changed vs the baseline.',
  stability: 'development',
})

/** Whether the remote page body changed vs the baseline. */
export const NotionMdStatusRemoteBodyChanged = attr.boolean({
  key: 'notion_md.status.remote_body_changed',
  brief: 'Whether the remote page body changed vs the baseline.',
  stability: 'development',
})

/** Whether remote page metadata changed vs the baseline. */
export const NotionMdStatusRemotePageMetadataChanged = attr.boolean({
  key: 'notion_md.status.remote_page_metadata_changed',
  brief: 'Whether remote page metadata changed vs the baseline.',
  stability: 'development',
})

/** Number of unknown (unrepresentable) blocks encountered during status. */
export const NotionMdStatusUnknownBlockCount = attr.number({
  key: 'notion_md.status.unknown_block_count',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of unknown (unrepresentable) blocks encountered during status.',
  stability: 'development',
  examples: [0, 2],
})

// -- push --
/** Whether force-push was requested. */
export const NotionMdPushForce = attr.boolean({
  key: 'notion_md.push.force',
  brief: 'Whether force-push was requested.',
  stability: 'development',
})

/** Whether deleting unknown blocks is permitted during push. */
export const NotionMdPushAllowDeleteUnknownBlocks = attr.boolean({
  key: 'notion_md.push.allow_delete_unknown_blocks',
  brief: 'Whether deleting unknown blocks is permitted during push.',
  stability: 'development',
})

/** Whether the push actually wrote anything. */
export const NotionMdPushPushed = attr.boolean({
  key: 'notion_md.push.pushed',
  brief: 'Whether the push actually wrote anything.',
  stability: 'development',
})

/** The storage/push decision verdict. */
export const NotionMdPushDecision = attr.string({
  key: 'notion_md.push.decision',
  cardinality: 'bounded',
  brief: 'The storage/push decision verdict.',
  stability: 'development',
  examples: ['push', 'skip'],
})

/** The resolved markdown-update command shape a push produced. */
export const NotionMdPushMarkdownCommand = attr.string({
  key: 'notion_md.push.markdown_command',
  cardinality: 'bounded',
  brief: 'The resolved markdown-update command shape a push produced.',
  stability: 'development',
  examples: ['replace', 'patch'],
})

// -- sync --
/** Terminal reconciliation verdict of a sync. */
export const NotionMdSyncResult = attr.string({
  key: 'notion_md.sync.result',
  cardinality: 'bounded',
  brief: 'Terminal reconciliation verdict of a sync.',
  stability: 'development',
  examples: ['pushed', 'pulled', 'no-op'],
})

/** Whether a watch sync pass failed. */
export const NotionMdSyncError = attr.boolean({
  key: 'notion_md.sync.error',
  brief: 'Whether a watch sync pass failed.',
  stability: 'development',
})

/** Tagged-error name for a failed watch sync pass. */
export const NotionMdSyncErrorTag = attr.string({
  key: 'notion_md.sync.error_tag',
  cardinality: 'bounded',
  brief: 'Tagged-error name for a failed watch sync pass.',
  stability: 'development',
  examples: ['NmdConflictError'],
})

// -- markdown update --
/** Markdown-update command kind. */
export const NotionMdMarkdownUpdateType = attr.string({
  key: 'notion_md.markdown_update.type',
  cardinality: 'bounded',
  brief: 'Markdown-update command kind.',
  stability: 'development',
  examples: ['replace', 'patch'],
})

/** Whether the markdown update is permitted to delete content. */
export const NotionMdMarkdownUpdateAllowDeletingContent = attr.boolean({
  key: 'notion_md.markdown_update.allow_deleting_content',
  brief: 'Whether the markdown update is permitted to delete content.',
  stability: 'development',
})

/** Number of content updates in a markdown-update command. */
export const NotionMdMarkdownUpdateContentUpdateCount = attr.number({
  key: 'notion_md.markdown_update.content_update_count',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of content updates in a markdown-update command.',
  stability: 'development',
  examples: [1, 5],
})

// -- page metadata --
/** Whether a page-metadata update sets the title. */
export const NotionMdPageMetadataTitle = attr.boolean({
  key: 'notion_md.page_metadata.title',
  brief: 'Whether a page-metadata update sets the title.',
  stability: 'development',
})

/** Whether a page-metadata update sets the icon. */
export const NotionMdPageMetadataIcon = attr.boolean({
  key: 'notion_md.page_metadata.icon',
  brief: 'Whether a page-metadata update sets the icon.',
  stability: 'development',
})

/** Whether a page-metadata update sets the cover. */
export const NotionMdPageMetadataCover = attr.boolean({
  key: 'notion_md.page_metadata.cover',
  brief: 'Whether a page-metadata update sets the cover.',
  stability: 'development',
})

/** Whether a page-metadata update trashes the page. */
export const NotionMdPageMetadataInTrash = attr.boolean({
  key: 'notion_md.page_metadata.in_trash',
  brief: 'Whether a page-metadata update trashes the page.',
  stability: 'development',
})

/** Whether a page-metadata update locks the page. */
export const NotionMdPageMetadataIsLocked = attr.boolean({
  key: 'notion_md.page_metadata.is_locked',
  brief: 'Whether a page-metadata update locks the page.',
  stability: 'development',
})

// -- editor (cat / put / edit) --
/** Editor representation mode for `cat` / `put` / `edit`. */
export const NotionMdEditorMode = attr.enum({
  key: 'notion_md.editor.mode',
  values: ['default', 'frontmatter'],
  briefs: {
    default: 'Body-only editor projection.',
    frontmatter: 'Frontmatter + body editor projection.',
  },
  brief: 'Editor representation mode for `cat` / `put` / `edit`.',
  stability: 'development',
})

/** Whether force-write was requested for `put`. */
export const NotionMdPutForce = attr.boolean({
  key: 'notion_md.put.force',
  brief: 'Whether force-write was requested for `put`.',
  stability: 'development',
})

/** Whether a `put` wrote the body. */
export const NotionMdPutBodyWritten = attr.boolean({
  key: 'notion_md.put.body_written',
  brief: 'Whether a `put` wrote the body.',
  stability: 'development',
})

/** Whether a `put` wrote the title. */
export const NotionMdPutTitleWritten = attr.boolean({
  key: 'notion_md.put.title_written',
  brief: 'Whether a `put` wrote the title.',
  stability: 'development',
})

/** Outcome of an `edit` session. */
export const NotionMdEditOutcome = attr.enum({
  key: 'notion_md.edit.outcome',
  values: ['pushed', 'noop', 'aborted', 'conflict', 'read-only'],
  briefs: {
    pushed: 'The edit was pushed to Notion.',
    noop: 'The edit made no changes.',
    aborted: 'The edit session was aborted.',
    conflict: 'The edit hit a conflict.',
    'read-only': 'The page was read-only.',
  },
  brief: 'Outcome of an `edit` session.',
  stability: 'development',
})

// -- media / comment / destructive-body write boundaries --
/** Files/media write-boundary operation. */
export const NotionMdMediaBoundaryOperation = attr.string({
  key: 'notion_md.media_boundary.operation',
  cardinality: 'bounded',
  brief: 'Files/media write-boundary operation.',
  stability: 'development',
  examples: ['upload', 'skip'],
})

/** Number of files considered at a files/media write boundary. */
export const NotionMdMediaBoundaryFileCount = attr.number({
  key: 'notion_md.media_boundary.file_count',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of files considered at a files/media write boundary.',
  stability: 'development',
  examples: [1, 3],
})

/** Files/media write-boundary verdict. */
export const NotionMdMediaBoundaryVerdict = attr.string({
  key: 'notion_md.media_boundary.verdict',
  cardinality: 'bounded',
  brief: 'Files/media write-boundary verdict.',
  stability: 'development',
  examples: ['allow', 'block'],
})

/** Guard that governed a files/media write. */
export const NotionMdMediaBoundaryGuard = attr.string({
  key: 'notion_md.media_boundary.guard',
  cardinality: 'bounded',
  brief: 'Guard that governed a files/media write.',
  stability: 'development',
  examples: ['force'],
})

/** Comment write-boundary operation. */
export const NotionMdCommentBoundaryOperation = attr.string({
  key: 'notion_md.comment_boundary.operation',
  cardinality: 'bounded',
  brief: 'Comment write-boundary operation.',
  stability: 'development',
  examples: ['create', 'skip'],
})

/** Number of comments considered at a comment write boundary. */
export const NotionMdCommentBoundaryCommentCount = attr.number({
  key: 'notion_md.comment_boundary.comment_count',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of comments considered at a comment write boundary.',
  stability: 'development',
  examples: [1, 2],
})

/** Comment write-boundary verdict. */
export const NotionMdCommentBoundaryVerdict = attr.string({
  key: 'notion_md.comment_boundary.verdict',
  cardinality: 'bounded',
  brief: 'Comment write-boundary verdict.',
  stability: 'development',
  examples: ['allow', 'block'],
})

/** Guard that governed a comment write. */
export const NotionMdCommentBoundaryGuard = attr.string({
  key: 'notion_md.comment_boundary.guard',
  cardinality: 'bounded',
  brief: 'Guard that governed a comment write.',
  stability: 'development',
  examples: ['force'],
})

/** Guard that governed a destructive body write. */
export const NotionMdDestructiveBodyGuard = attr.string({
  key: 'notion_md.destructive_body.guard',
  cardinality: 'bounded',
  brief: 'Guard that governed a destructive body write.',
  stability: 'development',
  examples: ['allow-delete'],
})

/** Number of blocks considered at a destructive body write gate. */
export const NotionMdDestructiveBodyBlockCount = attr.number({
  key: 'notion_md.destructive_body.block_count',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of blocks considered at a destructive body write gate.',
  stability: 'development',
  examples: [1, 10],
})

/** Destructive body write-gate verdict. */
export const NotionMdDestructiveBodyVerdict = attr.string({
  key: 'notion_md.destructive_body.verdict',
  cardinality: 'bounded',
  brief: 'Destructive body write-gate verdict.',
  stability: 'development',
  examples: ['allow', 'block'],
})

// -- object GC --
/** Whether an object-GC pass is plan-only (dry run). */
export const NotionMdObjectGcDryRun = attr.boolean({
  key: 'notion_md.object_gc.dry_run',
  brief: 'Whether an object-GC pass is plan-only (dry run).',
  stability: 'development',
})

/** Number of reachable objects after an object-GC pass. */
export const NotionMdObjectGcReachableCount = attr.number({
  key: 'notion_md.object_gc.reachable_count',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of reachable objects after an object-GC pass.',
  stability: 'development',
  examples: [12],
})

/** Number of removed (or would-be-removed) objects after an object-GC pass. */
export const NotionMdObjectGcRemovedCount = attr.number({
  key: 'notion_md.object_gc.removed_count',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of removed (or would-be-removed) objects after an object-GC pass.',
  stability: 'development',
  examples: [3],
})

// -- track --
/** Frontmatter `source` mode of a page tracked into a local file during a pull. */
export const NotionMdTrackSource = attr.enum({
  key: 'notion_md.track.source',
  values: ['local', 'remote', 'shared'],
  briefs: {
    local: 'A local-owned page.',
    remote: 'A remote-owned page.',
    shared: 'A shared (two-way reconciled) page.',
  },
  brief: 'Frontmatter `source` mode of a page tracked into a local file during a pull.',
  stability: 'development',
})

// -- webhook --
/** Webhook event type. */
export const NotionMdWebhookEventType = attr.string({
  key: 'notion_md.webhook.event_type',
  cardinality: 'bounded',
  brief: 'Webhook event type.',
  stability: 'development',
  examples: ['page.content_updated'],
})

/** Webhook surface the event targets. */
export const NotionMdWebhookSurface = attr.string({
  key: 'notion_md.webhook.surface',
  cardinality: 'bounded',
  brief: 'Webhook surface the event targets.',
  stability: 'development',
  examples: ['page', 'database'],
})

/** Number of watch triggers a webhook signal mapped to. */
export const NotionMdWebhookTriggerCount = attr.number({
  key: 'notion_md.webhook.trigger_count',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of watch triggers a webhook signal mapped to.',
  stability: 'development',
  examples: [1],
})

// ---------------------------------------------------------------------------
// operations (static-name spans; label extractors read catalog attributes)
// ---------------------------------------------------------------------------

/** `notion-md.status-path` — status over a filesystem path (file or recursive tree). */
export const StatusPathOperation = operation({
  id: 'span.notion_md.status_path',
  name: 'notion-md.status-path',
  brief: 'Status over a filesystem path (file or recursive tree).',
  stability: 'development',
  attributes: {
    basename: required(NotionMdPathBasename),
    recursive: required(NotionMdPathRecursive),
  },
  label: (v: { basename: string }) => v.basename,
})

/** `notion-md.plan-path` — plan a tree sync over a path. */
export const PlanPathOperation = operation({
  id: 'span.notion_md.plan_path',
  name: 'notion-md.plan-path',
  brief: 'Plan a tree sync over a path (`fromRemote` picks the plan direction).',
  stability: 'development',
  attributes: {
    basename: required(NotionMdPathBasename),
    fromRemote: required(NotionMdTreeFromRemote),
  },
  label: (v: { basename: string }) => v.basename,
})

/** `notion-md.sync-path` — sync over a filesystem path (recursive tree or single file). */
export const SyncPathOperation = operation({
  id: 'span.notion_md.sync_path',
  name: 'notion-md.sync-path',
  brief: 'Sync over a filesystem path (recursive tree or single file).',
  stability: 'development',
  attributes: {
    basename: required(NotionMdPathBasename),
    recursive: required(NotionMdPathRecursive),
    fromRemote: required(NotionMdTreeFromRemote),
  },
  label: (v: { basename: string }) => v.basename,
})

/** `notion-md.sync-tree` — sync an entire tree under a root. */
export const SyncTreeOperation = operation({
  id: 'span.notion_md.sync_tree',
  name: 'notion-md.sync-tree',
  brief: 'Sync an entire tree under a root.',
  stability: 'development',
  attributes: {
    basename: required(NotionMdPathBasename),
    plan: required(NotionMdTreePlan),
    fromRemote: required(NotionMdTreeFromRemote),
  },
  label: (v: { basename: string }) => v.basename,
})

/** `notion-md.state.read-nmd` — read the `.nmd` sidecar state file. */
export const ReadNmdStateOperation = operation({
  id: 'span.notion_md.state_read_nmd',
  name: 'notion-md.state.read-nmd',
  brief: 'Read the `.nmd` sidecar state file.',
  stability: 'development',
  attributes: {
    operation: required(NotionMdStateOperation),
    basename: required(NotionMdPathBasename),
  },
  label: (v: { basename: string }) => v.basename,
})

/** `notion-md.state.write-object` — write a content object into the state store. */
export const WriteObjectStateOperation = operation({
  id: 'span.notion_md.state_write_object',
  name: 'notion-md.state.write-object',
  brief: 'Write a content object into the state store (labelled by object role).',
  stability: 'development',
  attributes: {
    role: required(NotionMdObjectRole),
    basename: recommended(NotionMdPathBasename),
    hashPrefix: recommended(NotionMdObjectHashPrefix),
  },
  label: (v: { role: string }) => v.role,
})

/** `notion-md.state.read-object` — read a content object from the state store. */
export const ReadObjectStateOperation = operation({
  id: 'span.notion_md.state_read_object',
  name: 'notion-md.state.read-object',
  brief: 'Read a content object from the state store (labelled by object role).',
  stability: 'development',
  attributes: {
    role: required(NotionMdObjectRole),
    basename: recommended(NotionMdPathBasename),
    hashPrefix: recommended(NotionMdObjectHashPrefix),
  },
  label: (v: { role: string }) => v.role,
})

/** `notion-md.pull-page` — pull a single page from Notion into a local file. */
export const PullPageOperation = operation({
  id: 'span.notion_md.pull_page',
  name: 'notion-md.pull-page',
  brief: 'Pull a single page from Notion into a local file.',
  stability: 'development',
  attributes: {
    pageId: required(NotionMdPageId),
    basename: required(NotionMdPathBasename),
  },
  label: (v: { pageId: string }) => v.pageId.slice(0, 8),
})

/** `notion-md.establish-sidecar` — establish the `.nmd` baseline for a page on first contact. */
export const EstablishSidecarOperation = operation({
  id: 'span.notion_md.establish_sidecar',
  name: 'notion-md.establish-sidecar',
  brief: 'Establish the `.nmd` sidecar baseline for a page on first contact.',
  stability: 'development',
  attributes: {
    pageId: required(NotionMdPageId),
  },
  label: (v: { pageId: string }) => v.pageId.slice(0, 8),
})

/** `notion-md.status-page` — compute status of a single page against its baseline. */
export const StatusPageOperation = operation({
  id: 'span.notion_md.status_page',
  name: 'notion-md.status-page',
  brief: 'Compute status of a single page against its baseline.',
  stability: 'development',
  attributes: {
    basename: required(NotionMdPathBasename),
  },
  label: (v: { basename: string }) => v.basename,
})

/** `notion-md.push-page` — push a single local page to Notion. */
export const PushPageOperation = operation({
  id: 'span.notion_md.push_page',
  name: 'notion-md.push-page',
  brief: 'Push a single local page to Notion.',
  stability: 'development',
  attributes: {
    basename: required(NotionMdPathBasename),
    force: required(NotionMdPushForce),
    allowDeleteUnknownBlocks: required(NotionMdPushAllowDeleteUnknownBlocks),
  },
  label: (v: { basename: string }) => v.basename,
})

/** `notion-md.sync-page` — full reconcile (status + pull/push) of a single page. */
export const SyncPageOperation = operation({
  id: 'span.notion_md.sync_page',
  name: 'notion-md.sync-page',
  brief: 'Full reconcile (status + pull/push) of a single page.',
  stability: 'development',
  attributes: {
    basename: required(NotionMdPathBasename),
  },
  label: (v: { basename: string }) => v.basename,
})

/** `notion-md.gateway.pull-page` — Notion API call that pulls a page's content. */
export const GatewayPullPageOperation = operation({
  id: 'span.notion_md.gateway_pull_page',
  name: 'notion-md.gateway.pull-page',
  brief: "Gateway-level Notion API call that pulls a page's content.",
  stability: 'development',
  attributes: {
    pageId: required(NotionMdPageId),
  },
  label: (v: { pageId: string }) => v.pageId.slice(0, 8),
})

/** `notion-md.gateway.update-markdown` — apply a markdown body update to a page. */
export const GatewayUpdateMarkdownOperation = operation({
  id: 'span.notion_md.gateway_update_markdown',
  name: 'notion-md.gateway.update-markdown',
  brief: 'Gateway-level span for applying a markdown body update to a page.',
  stability: 'development',
  attributes: {
    pageId: required(NotionMdPageId),
    type: required(NotionMdMarkdownUpdateType),
    allowDeletingContent: required(NotionMdMarkdownUpdateAllowDeletingContent),
    contentUpdateCount: required(NotionMdMarkdownUpdateContentUpdateCount),
  },
  label: (v: { pageId: string }) => v.pageId.slice(0, 8),
})

/** `notion-md.gateway.update-page-properties` — update a page's database properties. */
export const GatewayUpdatePagePropertiesOperation = operation({
  id: 'span.notion_md.gateway_update_page_properties',
  name: 'notion-md.gateway.update-page-properties',
  brief: "Gateway-level span for updating a page's database properties.",
  stability: 'development',
  attributes: {
    pageId: required(NotionMdPageId),
  },
  label: (v: { pageId: string }) => v.pageId.slice(0, 8),
})

/** `notion-md.gateway.retrieve-data-source` — retrieve a data source (database) schema. */
export const GatewayRetrieveDataSourceOperation = operation({
  id: 'span.notion_md.gateway_retrieve_data_source',
  name: 'notion-md.gateway.retrieve-data-source',
  brief: 'Gateway-level span for retrieving a data source (database) schema.',
  stability: 'development',
  attributes: {
    dataSourceId: required(NotionMdDataSourceId),
  },
  label: (v: { dataSourceId: string }) => v.dataSourceId.slice(0, 8),
})

/** `notion-md.gateway.update-page-metadata` — update page metadata (title/icon/cover/trash/lock). */
export const GatewayUpdatePageMetadataOperation = operation({
  id: 'span.notion_md.gateway_update_page_metadata',
  name: 'notion-md.gateway.update-page-metadata',
  brief: 'Gateway-level span for updating page metadata (title/icon/cover/trash/lock).',
  stability: 'development',
  attributes: {
    pageId: required(NotionMdPageId),
    hasTitle: required(NotionMdPageMetadataTitle),
    hasIcon: required(NotionMdPageMetadataIcon),
    hasCover: required(NotionMdPageMetadataCover),
    inTrash: required(NotionMdPageMetadataInTrash),
    isLocked: required(NotionMdPageMetadataIsLocked),
  },
  label: (v: { pageId: string }) => v.pageId.slice(0, 8),
})

/** `notion-md.gateway.list-child-pages` — list a page's direct child pages. */
export const GatewayListChildPagesOperation = operation({
  id: 'span.notion_md.gateway_list_child_pages',
  name: 'notion-md.gateway.list-child-pages',
  brief: "Gateway-level span for listing a page's direct child pages.",
  stability: 'development',
  attributes: {
    pageId: required(NotionMdPageId),
  },
  label: (v: { pageId: string }) => v.pageId.slice(0, 8),
})

/** `notion-md.gateway.create-page` — create a new child page under a parent. */
export const GatewayCreatePageOperation = operation({
  id: 'span.notion_md.gateway_create_page',
  name: 'notion-md.gateway.create-page',
  brief: 'Gateway-level span for creating a new child page under a parent.',
  stability: 'development',
  attributes: {
    parentPageId: required(NotionMdParentPageId),
  },
  label: (v: { parentPageId: string }) => v.parentPageId.slice(0, 8),
})

/** `notion-md.gateway.move-page` — move a page to a new parent. */
export const GatewayMovePageOperation = operation({
  id: 'span.notion_md.gateway_move_page',
  name: 'notion-md.gateway.move-page',
  brief: 'Gateway-level span for moving a page to a new parent.',
  stability: 'development',
  attributes: {
    pageId: required(NotionMdPageId),
  },
  label: (v: { pageId: string }) => v.pageId.slice(0, 8),
})

/** `notion-md.gateway.archive-page` — archive (trash) a page. */
export const GatewayArchivePageOperation = operation({
  id: 'span.notion_md.gateway_archive_page',
  name: 'notion-md.gateway.archive-page',
  brief: 'Gateway-level span for archiving (trashing) a page.',
  stability: 'development',
  attributes: {
    pageId: required(NotionMdPageId),
  },
  label: (v: { pageId: string }) => v.pageId.slice(0, 8),
})

/** `notion-md.cat` — read-only editor projection of a Notion page (ROOT span at runtime). */
export const CatOperation = operation({
  id: 'span.notion_md.cat',
  name: 'notion-md.cat',
  brief: 'Read-only editor projection of a Notion page.',
  stability: 'development',
  attributes: {
    pageId: required(NotionMdPageId),
    mode: required(NotionMdEditorMode),
  },
  label: (v: { pageId: string }) => v.pageId.slice(0, 8),
})

/** `notion-md.put` — guarded title+body write to a Notion page (ROOT span at runtime). */
export const PutOperation = operation({
  id: 'span.notion_md.put',
  name: 'notion-md.put',
  brief: 'Guarded title+body write to a Notion page.',
  stability: 'development',
  attributes: {
    pageId: required(NotionMdPageId),
    force: required(NotionMdPutForce),
  },
  label: (v: { pageId: string }) => v.pageId.slice(0, 8),
})

/** `notion-md.edit` — ephemeral file-engine editor session (ROOT span at runtime). */
export const EditOperation = operation({
  id: 'span.notion_md.edit',
  name: 'notion-md.edit',
  brief: 'Ephemeral file-engine editor session (wraps engine spans).',
  stability: 'development',
  attributes: {
    pageId: required(NotionMdPageId),
    mode: required(NotionMdEditorMode),
  },
  label: (v: { pageId: string }) => v.pageId.slice(0, 8),
})

/** `notion-md.media-boundary` — files/media write-boundary classification. */
export const MediaBoundaryOperation = operation({
  id: 'span.notion_md.media_boundary',
  name: 'notion-md.media-boundary',
  brief: 'A files/media write-boundary classification.',
  stability: 'development',
  attributes: {
    operation: required(NotionMdMediaBoundaryOperation),
    fileCount: required(NotionMdMediaBoundaryFileCount),
    verdict: required(NotionMdMediaBoundaryVerdict),
    guard: recommended(NotionMdMediaBoundaryGuard),
  },
  label: (v: { operation: string; verdict: string }) => `${v.operation}:${v.verdict}`,
})

/** `notion-md.comment-boundary` — comment write-boundary classification. */
export const CommentBoundaryOperation = operation({
  id: 'span.notion_md.comment_boundary',
  name: 'notion-md.comment-boundary',
  brief: 'A comment write-boundary classification.',
  stability: 'development',
  attributes: {
    operation: required(NotionMdCommentBoundaryOperation),
    commentCount: required(NotionMdCommentBoundaryCommentCount),
    verdict: required(NotionMdCommentBoundaryVerdict),
    guard: recommended(NotionMdCommentBoundaryGuard),
  },
  label: (v: { operation: string; verdict: string }) => `${v.operation}:${v.verdict}`,
})

/** `notion-md.destructive-body` — destructive body write gate. */
export const DestructiveBodyOperation = operation({
  id: 'span.notion_md.destructive_body',
  name: 'notion-md.destructive-body',
  brief: 'A destructive body write gate.',
  stability: 'development',
  attributes: {
    guard: required(NotionMdDestructiveBodyGuard),
    blockCount: required(NotionMdDestructiveBodyBlockCount),
    verdict: required(NotionMdDestructiveBodyVerdict),
  },
  label: (v: { guard: string; verdict: string }) => `${v.guard}:${v.verdict}`,
})

/** `notion-md.object-gc` — object GC pass (plan-only or live prune). */
export const ObjectGcOperation = operation({
  id: 'span.notion_md.object_gc',
  name: 'notion-md.object-gc',
  brief: 'An object-GC pass (dry-run or live prune).',
  stability: 'development',
  attributes: {
    dryRun: required(NotionMdObjectGcDryRun),
    reachableCount: recommended(NotionMdObjectGcReachableCount),
    removedCount: recommended(NotionMdObjectGcRemovedCount),
  },
  label: (v: { dryRun: boolean }) => (v.dryRun === true ? 'plan' : 'prune'),
})

/** `notion-md.webhook.trigger` — map a webhook signal to watch triggers. */
export const WebhookTriggerOperation = operation({
  id: 'span.notion_md.webhook_trigger',
  name: 'notion-md.webhook.trigger',
  brief: 'A webhook signal mapped to watch triggers.',
  stability: 'development',
  attributes: {
    eventType: required(NotionMdWebhookEventType),
    surface: required(NotionMdWebhookSurface),
    triggerCount: required(NotionMdWebhookTriggerCount),
  },
  label: (v: { surface: string; eventType: string }) => `${v.surface}:${v.eventType}`,
})

/** `notion-md.batch-watch` — batch watch over multiple paths. */
export const BatchWatchOperation = operation({
  id: 'span.notion_md.batch_watch',
  name: 'notion-md.batch-watch',
  brief: 'A batch watch over multiple paths.',
  stability: 'development',
  attributes: {
    command: required(NotionMdCommand),
    watch: required(NotionMdWatch),
    batch: required(NotionMdBatch),
    pathCount: required(NotionMdBatchPathCount),
  },
  label: (v: { pathCount: number }) => `${v.pathCount} file(s)`,
})

/** `notion-md.watch` — a watch session over a single path. */
export const WatchOperation = operation({
  id: 'span.notion_md.watch',
  name: 'notion-md.watch',
  brief: 'A watch session over a single path.',
  stability: 'development',
  attributes: {
    command: required(NotionMdCommand),
    watch: required(NotionMdWatch),
    basename: required(NotionMdPathBasename),
  },
  label: (v: { basename: string }) => v.basename,
})

/** `notion-md.watch.sync-pass` — one watch-driven sync pass (ROOT span at runtime). */
export const WatchSyncPassOperation = operation({
  id: 'span.notion_md.watch_sync_pass',
  name: 'notion-md.watch.sync-pass',
  brief: 'One watch-driven sync pass.',
  stability: 'development',
  attributes: {
    command: required(NotionMdCommand),
    watch: required(NotionMdWatch),
    reason: required(NotionMdWatchReason),
    basename: required(NotionMdPathBasename),
  },
  label: (v: { basename: string; reason: string }) => `${v.basename}:${v.reason}`,
})

// ---------------------------------------------------------------------------
// static-name spans whose label is a runtime-only field (no catalog attribute carries it).
// These use the `labelFields` shape (a runtime-only `span.label` source, excluded from the
// registry), mirroring genie/megarepo operations. Re-points the notion-md sites that previously
// used raw `Effect.withSpan` (SC-R14 raw-otel-boundary), preserving the exact span names + encode.
// ---------------------------------------------------------------------------

/** Runtime-only span-label source field (excluded from the registry projection). */
const labelField = { label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()) } as const
const labelOf = (v: { label: string }): string => v.label

/**
 * `notion-md.track-page` — track/establish a page's local file from a remote pull. Carries the
 * frontmatter `source` mode (`notion_md.track.source`); the span is labelled by the page-id prefix
 * (a runtime-only field, so `labelFields`).
 */
export const TrackPageOperation = operation({
  id: 'span.notion_md.track_page',
  name: 'notion-md.track-page',
  brief: "Track/establish a page's local file from a remote pull.",
  stability: 'development',
  attributes: {
    source: required(NotionMdTrackSource),
  },
  labelFields: labelField,
  label: labelOf,
})

/**
 * `notion-md.status-file` — status of a single `.nmd` file. Label-only span (its only attribute is
 * the runtime `span.label` basename); it carries no catalog attribute, so it is authored here (to
 * derive the runtime encoder) but EXCLUDED from the `signals` list — a zero-catalog-attribute span
 * group is rejected by Weaver (like genie's `ImportMapResolverOperation`).
 */
export const StatusFileOperation = operation({
  id: 'span.notion_md.status_file',
  name: 'notion-md.status-file',
  brief: 'Status of a single `.nmd` file (label-only; labelled by basename).',
  stability: 'development',
  attributes: {},
  labelFields: labelField,
  label: labelOf,
})

/** `notion-md.reconcile-file` — reconcile of a single `.nmd` file. Label-only (see `StatusFileOperation`). */
export const ReconcileFileOperation = operation({
  id: 'span.notion_md.reconcile_file',
  name: 'notion-md.reconcile-file',
  brief: 'Reconcile of a single `.nmd` file (label-only; labelled by basename).',
  stability: 'development',
  attributes: {},
  labelFields: labelField,
  label: labelOf,
})

/**
 * `notion-md.webhook.decode` — decode a raw Notion webhook payload into a normalized signal. The
 * raw span carried NO attributes; routing it through the schema-backed seam requires a `span.label`
 * (`OtelSpan.with` mandates one), so it becomes a fixed-label span (label `decode`). Label-only, so
 * EXCLUDED from `signals` (see `StatusFileOperation`). The added `span.label` is the ONLY encode
 * delta of this migration (an enrichment; flagged in the migration report).
 */
export const WebhookDecodeOperation = operation({
  id: 'span.notion_md.webhook_decode',
  name: 'notion-md.webhook.decode',
  brief: 'Decode a raw Notion webhook payload into a normalized signal (label-only).',
  stability: 'development',
  attributes: {},
  labelFields: labelField,
  label: labelOf,
})

// ---------------------------------------------------------------------------
// annotate-only encoders (standalone; reuse the SAME attr schemas → identical encode).
// These annotate the CURRENT span with disjoint result-attribute subsets (SC-R14).
// ---------------------------------------------------------------------------

/** Status-comparison flags annotated onto a status span. */
export const statusAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    pageId: NotionMdPageId,
    localChanged: NotionMdStatusLocalChanged,
    localPageMetadataChanged: NotionMdStatusLocalPageMetadataChanged,
    localPropertiesChanged: NotionMdStatusLocalPropertiesChanged,
    remoteChanged: NotionMdStatusRemoteChanged,
    remoteBodyChanged: NotionMdStatusRemoteBodyChanged,
    remotePageMetadataChanged: NotionMdStatusRemotePageMetadataChanged,
    unknownBlockCount: NotionMdStatusUnknownBlockCount,
  }),
)

/** Outcome of a push: resolved page id plus whether anything was pushed. */
export const pushResultAttrs = OtelAttrs.defineSync(
  Schema.Struct({ pageId: NotionMdPageId, pushed: NotionMdPushPushed }),
)

/** Terminal sync outcome (`result` is the reconciliation verdict string). */
export const syncResultAttrs = OtelAttrs.defineSync(
  Schema.Struct({ pageId: NotionMdPageId, result: NotionMdSyncResult }),
)

/** Content-object identity carried as a short hash prefix. */
export const objectHashAttrs = OtelAttrs.defineSync(
  Schema.Struct({ hashPrefix: NotionMdObjectHashPrefix }),
)

/** The storage/push decision verdict annotated onto a push span. */
export const pushDecisionAttrs = OtelAttrs.defineSync(
  Schema.Struct({ decision: NotionMdPushDecision }),
)

/** Which markdown-update command shape a push resolved to. */
export const pushMarkdownCommandAttrs = OtelAttrs.defineSync(
  Schema.Struct({ markdownCommand: NotionMdPushMarkdownCommand }),
)

/** Combined push decision + resolved markdown-command annotated together. */
export const pushDecisionMarkdownCommandAttrs = OtelAttrs.defineSync(
  Schema.Struct({ decision: NotionMdPushDecision, markdownCommand: NotionMdPushMarkdownCommand }),
)

/** Result annotations for a completed `notion-md put`. */
export const putResultAttrs = OtelAttrs.defineSync(
  Schema.Struct({ bodyWritten: NotionMdPutBodyWritten, titleWritten: NotionMdPutTitleWritten }),
)

/** Outcome annotation for a completed `notion-md edit` session. */
export const editResultAttrs = OtelAttrs.defineSync(Schema.Struct({ outcome: NotionMdEditOutcome }))

/** Post-GC result attributes annotated onto the object-GC span. */
export const objectGcResultAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    reachableCount: NotionMdObjectGcReachableCount,
    removedCount: NotionMdObjectGcRemovedCount,
  }),
)

/** Watch sync-pass result annotations (verdict + reason). */
export const watchSyncResultAttrs = OtelAttrs.defineSync(
  Schema.Struct({ result: NotionMdSyncResult, reason: NotionMdWatchReason }),
)

/** Watch sync-pass error annotations (error flag + tagged-error name). */
export const watchSyncErrorAttrs = OtelAttrs.defineSync(
  Schema.Struct({ error: NotionMdSyncError, errorTag: NotionMdSyncErrorTag }),
)

// ---------------------------------------------------------------------------
// contract seam (namespace `notion_md`, derived).
// ---------------------------------------------------------------------------

export default defineOtelContract({
  memberPath: 'packages/@overeng/notion-md',
  displayName: 'Notion Markdown Attributes',
  signals: [
    StatusPathOperation,
    PlanPathOperation,
    SyncPathOperation,
    SyncTreeOperation,
    ReadNmdStateOperation,
    WriteObjectStateOperation,
    ReadObjectStateOperation,
    PullPageOperation,
    EstablishSidecarOperation,
    StatusPageOperation,
    PushPageOperation,
    SyncPageOperation,
    GatewayPullPageOperation,
    GatewayUpdateMarkdownOperation,
    GatewayUpdatePagePropertiesOperation,
    GatewayRetrieveDataSourceOperation,
    GatewayUpdatePageMetadataOperation,
    GatewayListChildPagesOperation,
    GatewayCreatePageOperation,
    GatewayMovePageOperation,
    GatewayArchivePageOperation,
    CatOperation,
    PutOperation,
    EditOperation,
    MediaBoundaryOperation,
    CommentBoundaryOperation,
    DestructiveBodyOperation,
    ObjectGcOperation,
    WebhookTriggerOperation,
    BatchWatchOperation,
    WatchOperation,
    WatchSyncPassOperation,
    // `notion_md.track.source` reaches the catalog via this static-name signal's open ref.
    TrackPageOperation,
    // NOTE: `StatusFileOperation` / `ReconcileFileOperation` / `WebhookDecodeOperation` are authored
    // above (to derive their runtime encoders) but deliberately NOT listed here — they are label-only
    // spans with zero catalog attributes, which Weaver rejects as an empty group (like genie's
    // `ImportMapResolverOperation`). They stay runtime-only, not registry-projected.
  ],
  // Keys that reach the catalog ONLY via an annotate-only bundle or a dynamic-name bridge span
  // (no static open-ref carries them). Catalog completeness (SC-R13).
  docOnlyAttributes: [
    // annotate-only result attributes
    NotionMdStatusLocalChanged,
    NotionMdStatusLocalPageMetadataChanged,
    NotionMdStatusLocalPropertiesChanged,
    NotionMdStatusRemoteChanged,
    NotionMdStatusRemoteBodyChanged,
    NotionMdStatusRemotePageMetadataChanged,
    NotionMdStatusUnknownBlockCount,
    NotionMdPushPushed,
    NotionMdPushDecision,
    NotionMdPushMarkdownCommand,
    NotionMdSyncResult,
    NotionMdPutBodyWritten,
    NotionMdPutTitleWritten,
    NotionMdEditOutcome,
    NotionMdSyncError,
    NotionMdSyncErrorTag,
    // dynamic-name bridge (`batchRunSpan`)-only keys
    NotionMdBatchTargetCount,
    NotionMdBatchRecursive,
  ],
})
