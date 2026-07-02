// Generated file - DO NOT EDIT
// Source: constants.rs.genie.ts
// registry-source: weaver-registry/registry.ts
// fingerprint: sha256:8a1bda18876552408a55070e25c221fa2ade20caa1d92a8b49d63ce823e0c1cd
// regen: devenv tasks run genie:run

//! Generated OpenTelemetry semantic-convention name constants.

/// Attribute keys.
pub mod attribute {
    pub const ACME_ATTEMPT: &str = "acme.attempt";
    pub const ACME_PROBE_LABEL: &str = "acme.probe.label";
    pub const ACME_PROBE_NAME: &str = "acme.probe.name";
    pub const ACME_REGION: &str = "acme.region";
    pub const ACME_REQUEST_HEADER: &str = "acme.request.header";
    pub const GENIE_CONCURRENCY: &str = "genie.concurrency";
    pub const GENIE_CWD: &str = "genie.cwd";
    pub const GENIE_DRY_RUN: &str = "genie.dry_run";
    pub const GENIE_FILE_MODE: &str = "genie.file.mode";
    pub const GENIE_FILE_SOURCE_PATH: &str = "genie.file.source_path";
    pub const GENIE_FILE_TARGET_PATH: &str = "genie.file.target_path";
    pub const GENIE_OXFMT_HAS_CONFIG: &str = "genie.oxfmt.has_config";
    pub const GENIE_PATH: &str = "genie.path";
    pub const GENIE_READ_ONLY: &str = "genie.read_only";
    pub const GENIE_VALIDATION_FILE_COUNT: &str = "genie.validation.file_count";
    pub const GENIE_VALIDATION_PRELOADED_FILE_COUNT: &str = "genie.validation.preloaded_file_count";
    pub const GENIE_VALIDATION_REQUIRE_PACKAGE_JSON_VALIDATE: &str = "genie.validation.require_package_json_validate";
    pub const NOTION_MD_BATCH: &str = "notion_md.batch";
    pub const NOTION_MD_BATCH_PATH_COUNT: &str = "notion_md.batch.path_count";
    pub const NOTION_MD_BATCH_RECURSIVE: &str = "notion_md.batch.recursive";
    pub const NOTION_MD_BATCH_TARGET_COUNT: &str = "notion_md.batch.target_count";
    pub const NOTION_MD_COMMAND: &str = "notion_md.command";
    pub const NOTION_MD_COMMENT_BOUNDARY_COMMENT_COUNT: &str = "notion_md.comment_boundary.comment_count";
    pub const NOTION_MD_COMMENT_BOUNDARY_GUARD: &str = "notion_md.comment_boundary.guard";
    pub const NOTION_MD_COMMENT_BOUNDARY_OPERATION: &str = "notion_md.comment_boundary.operation";
    pub const NOTION_MD_COMMENT_BOUNDARY_VERDICT: &str = "notion_md.comment_boundary.verdict";
    pub const NOTION_MD_DATA_SOURCE_ID: &str = "notion_md.data_source_id";
    pub const NOTION_MD_DESTRUCTIVE_BODY_BLOCK_COUNT: &str = "notion_md.destructive_body.block_count";
    pub const NOTION_MD_DESTRUCTIVE_BODY_GUARD: &str = "notion_md.destructive_body.guard";
    pub const NOTION_MD_DESTRUCTIVE_BODY_VERDICT: &str = "notion_md.destructive_body.verdict";
    pub const NOTION_MD_EDIT_OUTCOME: &str = "notion_md.edit.outcome";
    pub const NOTION_MD_EDITOR_MODE: &str = "notion_md.editor.mode";
    pub const NOTION_MD_MARKDOWN_UPDATE_ALLOW_DELETING_CONTENT: &str = "notion_md.markdown_update.allow_deleting_content";
    pub const NOTION_MD_MARKDOWN_UPDATE_CONTENT_UPDATE_COUNT: &str = "notion_md.markdown_update.content_update_count";
    pub const NOTION_MD_MARKDOWN_UPDATE_TYPE: &str = "notion_md.markdown_update.type";
    pub const NOTION_MD_MEDIA_BOUNDARY_FILE_COUNT: &str = "notion_md.media_boundary.file_count";
    pub const NOTION_MD_MEDIA_BOUNDARY_GUARD: &str = "notion_md.media_boundary.guard";
    pub const NOTION_MD_MEDIA_BOUNDARY_OPERATION: &str = "notion_md.media_boundary.operation";
    pub const NOTION_MD_MEDIA_BOUNDARY_VERDICT: &str = "notion_md.media_boundary.verdict";
    pub const NOTION_MD_OBJECT_GC_DRY_RUN: &str = "notion_md.object_gc.dry_run";
    pub const NOTION_MD_OBJECT_GC_REACHABLE_COUNT: &str = "notion_md.object_gc.reachable_count";
    pub const NOTION_MD_OBJECT_GC_REMOVED_COUNT: &str = "notion_md.object_gc.removed_count";
    pub const NOTION_MD_OBJECT_HASH_PREFIX: &str = "notion_md.object.hash_prefix";
    pub const NOTION_MD_OBJECT_ROLE: &str = "notion_md.object.role";
    pub const NOTION_MD_PAGE_ID: &str = "notion_md.page_id";
    pub const NOTION_MD_PAGE_METADATA_COVER: &str = "notion_md.page_metadata.cover";
    pub const NOTION_MD_PAGE_METADATA_ICON: &str = "notion_md.page_metadata.icon";
    pub const NOTION_MD_PAGE_METADATA_IN_TRASH: &str = "notion_md.page_metadata.in_trash";
    pub const NOTION_MD_PAGE_METADATA_IS_LOCKED: &str = "notion_md.page_metadata.is_locked";
    pub const NOTION_MD_PAGE_METADATA_TITLE: &str = "notion_md.page_metadata.title";
    pub const NOTION_MD_PARENT_PAGE_ID: &str = "notion_md.parent_page_id";
    pub const NOTION_MD_PATH_BASENAME: &str = "notion_md.path.basename";
    pub const NOTION_MD_PATH_RECURSIVE: &str = "notion_md.path.recursive";
    pub const NOTION_MD_PUSH_ALLOW_DELETE_UNKNOWN_BLOCKS: &str = "notion_md.push.allow_delete_unknown_blocks";
    pub const NOTION_MD_PUSH_DECISION: &str = "notion_md.push.decision";
    pub const NOTION_MD_PUSH_FORCE: &str = "notion_md.push.force";
    pub const NOTION_MD_PUSH_MARKDOWN_COMMAND: &str = "notion_md.push.markdown_command";
    pub const NOTION_MD_PUSH_PUSHED: &str = "notion_md.push.pushed";
    pub const NOTION_MD_PUT_BODY_WRITTEN: &str = "notion_md.put.body_written";
    pub const NOTION_MD_PUT_FORCE: &str = "notion_md.put.force";
    pub const NOTION_MD_PUT_TITLE_WRITTEN: &str = "notion_md.put.title_written";
    pub const NOTION_MD_STATE_OPERATION: &str = "notion_md.state.operation";
    pub const NOTION_MD_STATUS_LOCAL_CHANGED: &str = "notion_md.status.local_changed";
    pub const NOTION_MD_STATUS_LOCAL_PAGE_METADATA_CHANGED: &str = "notion_md.status.local_page_metadata_changed";
    pub const NOTION_MD_STATUS_LOCAL_PROPERTIES_CHANGED: &str = "notion_md.status.local_properties_changed";
    pub const NOTION_MD_STATUS_REMOTE_BODY_CHANGED: &str = "notion_md.status.remote_body_changed";
    pub const NOTION_MD_STATUS_REMOTE_CHANGED: &str = "notion_md.status.remote_changed";
    pub const NOTION_MD_STATUS_REMOTE_PAGE_METADATA_CHANGED: &str = "notion_md.status.remote_page_metadata_changed";
    pub const NOTION_MD_STATUS_UNKNOWN_BLOCK_COUNT: &str = "notion_md.status.unknown_block_count";
    pub const NOTION_MD_SYNC_ERROR: &str = "notion_md.sync.error";
    pub const NOTION_MD_SYNC_ERROR_TAG: &str = "notion_md.sync.error_tag";
    pub const NOTION_MD_SYNC_RESULT: &str = "notion_md.sync.result";
    pub const NOTION_MD_TREE_FROM_REMOTE: &str = "notion_md.tree.from_remote";
    pub const NOTION_MD_TREE_PLAN: &str = "notion_md.tree.plan";
    pub const NOTION_MD_WATCH: &str = "notion_md.watch";
    pub const NOTION_MD_WATCH_REASON: &str = "notion_md.watch.reason";
    pub const NOTION_MD_WEBHOOK_EVENT_TYPE: &str = "notion_md.webhook.event_type";
    pub const NOTION_MD_WEBHOOK_SURFACE: &str = "notion_md.webhook.surface";
    pub const NOTION_MD_WEBHOOK_TRIGGER_COUNT: &str = "notion_md.webhook.trigger_count";

    pub const ALL: &[&str] = &[
        "acme.attempt",
        "acme.probe.label",
        "acme.probe.name",
        "acme.region",
        "acme.request.header",
        "genie.concurrency",
        "genie.cwd",
        "genie.dry_run",
        "genie.file.mode",
        "genie.file.source_path",
        "genie.file.target_path",
        "genie.oxfmt.has_config",
        "genie.path",
        "genie.read_only",
        "genie.validation.file_count",
        "genie.validation.preloaded_file_count",
        "genie.validation.require_package_json_validate",
        "notion_md.batch",
        "notion_md.batch.path_count",
        "notion_md.batch.recursive",
        "notion_md.batch.target_count",
        "notion_md.command",
        "notion_md.comment_boundary.comment_count",
        "notion_md.comment_boundary.guard",
        "notion_md.comment_boundary.operation",
        "notion_md.comment_boundary.verdict",
        "notion_md.data_source_id",
        "notion_md.destructive_body.block_count",
        "notion_md.destructive_body.guard",
        "notion_md.destructive_body.verdict",
        "notion_md.edit.outcome",
        "notion_md.editor.mode",
        "notion_md.markdown_update.allow_deleting_content",
        "notion_md.markdown_update.content_update_count",
        "notion_md.markdown_update.type",
        "notion_md.media_boundary.file_count",
        "notion_md.media_boundary.guard",
        "notion_md.media_boundary.operation",
        "notion_md.media_boundary.verdict",
        "notion_md.object_gc.dry_run",
        "notion_md.object_gc.reachable_count",
        "notion_md.object_gc.removed_count",
        "notion_md.object.hash_prefix",
        "notion_md.object.role",
        "notion_md.page_id",
        "notion_md.page_metadata.cover",
        "notion_md.page_metadata.icon",
        "notion_md.page_metadata.in_trash",
        "notion_md.page_metadata.is_locked",
        "notion_md.page_metadata.title",
        "notion_md.parent_page_id",
        "notion_md.path.basename",
        "notion_md.path.recursive",
        "notion_md.push.allow_delete_unknown_blocks",
        "notion_md.push.decision",
        "notion_md.push.force",
        "notion_md.push.markdown_command",
        "notion_md.push.pushed",
        "notion_md.put.body_written",
        "notion_md.put.force",
        "notion_md.put.title_written",
        "notion_md.state.operation",
        "notion_md.status.local_changed",
        "notion_md.status.local_page_metadata_changed",
        "notion_md.status.local_properties_changed",
        "notion_md.status.remote_body_changed",
        "notion_md.status.remote_changed",
        "notion_md.status.remote_page_metadata_changed",
        "notion_md.status.unknown_block_count",
        "notion_md.sync.error",
        "notion_md.sync.error_tag",
        "notion_md.sync.result",
        "notion_md.tree.from_remote",
        "notion_md.tree.plan",
        "notion_md.watch",
        "notion_md.watch.reason",
        "notion_md.webhook.event_type",
        "notion_md.webhook.surface",
        "notion_md.webhook.trigger_count",
    ];
}

/// Span names.
pub mod span {
    pub const SPAN_ACME_OPERATION: &str = "span.acme.operation";
    pub const SPAN_ACME_PROBE: &str = "span.acme.probe";
    pub const SPAN_GENIE_ATOMIC_WRITE: &str = "span.genie.atomic_write";
    pub const SPAN_GENIE_COMMAND: &str = "span.genie.command";
    pub const SPAN_GENIE_FILE: &str = "span.genie.file";
    pub const SPAN_GENIE_OXFMT: &str = "span.genie.oxfmt";
    pub const SPAN_GENIE_PATH: &str = "span.genie.path";
    pub const SPAN_GENIE_RUN_VALIDATION: &str = "span.genie.run_validation";
    pub const SPAN_GENIE_TARGET_LOCK: &str = "span.genie.target_lock";
    pub const SPAN_NOTION_MD_BATCH_WATCH: &str = "span.notion_md.batch_watch";
    pub const SPAN_NOTION_MD_CAT: &str = "span.notion_md.cat";
    pub const SPAN_NOTION_MD_COMMENT_BOUNDARY: &str = "span.notion_md.comment_boundary";
    pub const SPAN_NOTION_MD_DESTRUCTIVE_BODY: &str = "span.notion_md.destructive_body";
    pub const SPAN_NOTION_MD_EDIT: &str = "span.notion_md.edit";
    pub const SPAN_NOTION_MD_ESTABLISH_SIDECAR: &str = "span.notion_md.establish_sidecar";
    pub const SPAN_NOTION_MD_GATEWAY_ARCHIVE_PAGE: &str = "span.notion_md.gateway_archive_page";
    pub const SPAN_NOTION_MD_GATEWAY_CREATE_PAGE: &str = "span.notion_md.gateway_create_page";
    pub const SPAN_NOTION_MD_GATEWAY_LIST_CHILD_PAGES: &str = "span.notion_md.gateway_list_child_pages";
    pub const SPAN_NOTION_MD_GATEWAY_MOVE_PAGE: &str = "span.notion_md.gateway_move_page";
    pub const SPAN_NOTION_MD_GATEWAY_PULL_PAGE: &str = "span.notion_md.gateway_pull_page";
    pub const SPAN_NOTION_MD_GATEWAY_RETRIEVE_DATA_SOURCE: &str = "span.notion_md.gateway_retrieve_data_source";
    pub const SPAN_NOTION_MD_GATEWAY_UPDATE_MARKDOWN: &str = "span.notion_md.gateway_update_markdown";
    pub const SPAN_NOTION_MD_GATEWAY_UPDATE_PAGE_METADATA: &str = "span.notion_md.gateway_update_page_metadata";
    pub const SPAN_NOTION_MD_GATEWAY_UPDATE_PAGE_PROPERTIES: &str = "span.notion_md.gateway_update_page_properties";
    pub const SPAN_NOTION_MD_MEDIA_BOUNDARY: &str = "span.notion_md.media_boundary";
    pub const SPAN_NOTION_MD_OBJECT_GC: &str = "span.notion_md.object_gc";
    pub const SPAN_NOTION_MD_PLAN_PATH: &str = "span.notion_md.plan_path";
    pub const SPAN_NOTION_MD_PULL_PAGE: &str = "span.notion_md.pull_page";
    pub const SPAN_NOTION_MD_PUSH_PAGE: &str = "span.notion_md.push_page";
    pub const SPAN_NOTION_MD_PUT: &str = "span.notion_md.put";
    pub const SPAN_NOTION_MD_STATE_READ_NMD: &str = "span.notion_md.state_read_nmd";
    pub const SPAN_NOTION_MD_STATE_READ_OBJECT: &str = "span.notion_md.state_read_object";
    pub const SPAN_NOTION_MD_STATE_WRITE_OBJECT: &str = "span.notion_md.state_write_object";
    pub const SPAN_NOTION_MD_STATUS_PAGE: &str = "span.notion_md.status_page";
    pub const SPAN_NOTION_MD_STATUS_PATH: &str = "span.notion_md.status_path";
    pub const SPAN_NOTION_MD_SYNC_PAGE: &str = "span.notion_md.sync_page";
    pub const SPAN_NOTION_MD_SYNC_PATH: &str = "span.notion_md.sync_path";
    pub const SPAN_NOTION_MD_SYNC_TREE: &str = "span.notion_md.sync_tree";
    pub const SPAN_NOTION_MD_WATCH: &str = "span.notion_md.watch";
    pub const SPAN_NOTION_MD_WATCH_SYNC_PASS: &str = "span.notion_md.watch_sync_pass";
    pub const SPAN_NOTION_MD_WEBHOOK_TRIGGER: &str = "span.notion_md.webhook_trigger";

    pub const ALL: &[&str] = &[
        "span.acme.operation",
        "span.acme.probe",
        "span.genie.atomic_write",
        "span.genie.command",
        "span.genie.file",
        "span.genie.oxfmt",
        "span.genie.path",
        "span.genie.run_validation",
        "span.genie.target_lock",
        "span.notion_md.batch_watch",
        "span.notion_md.cat",
        "span.notion_md.comment_boundary",
        "span.notion_md.destructive_body",
        "span.notion_md.edit",
        "span.notion_md.establish_sidecar",
        "span.notion_md.gateway_archive_page",
        "span.notion_md.gateway_create_page",
        "span.notion_md.gateway_list_child_pages",
        "span.notion_md.gateway_move_page",
        "span.notion_md.gateway_pull_page",
        "span.notion_md.gateway_retrieve_data_source",
        "span.notion_md.gateway_update_markdown",
        "span.notion_md.gateway_update_page_metadata",
        "span.notion_md.gateway_update_page_properties",
        "span.notion_md.media_boundary",
        "span.notion_md.object_gc",
        "span.notion_md.plan_path",
        "span.notion_md.pull_page",
        "span.notion_md.push_page",
        "span.notion_md.put",
        "span.notion_md.state_read_nmd",
        "span.notion_md.state_read_object",
        "span.notion_md.state_write_object",
        "span.notion_md.status_page",
        "span.notion_md.status_path",
        "span.notion_md.sync_page",
        "span.notion_md.sync_path",
        "span.notion_md.sync_tree",
        "span.notion_md.watch",
        "span.notion_md.watch_sync_pass",
        "span.notion_md.webhook_trigger",
    ];
}

/// Metric names.
pub mod metric {
    pub const ACME_PROBE_DURATION: &str = "acme.probe.duration";
    pub const ACME_PROBES: &str = "acme.probes";

    pub const ALL: &[&str] = &["acme.probe.duration", "acme.probes"];
}
