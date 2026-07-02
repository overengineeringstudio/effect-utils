// Generated file - DO NOT EDIT
// Source: constants.rs.genie.ts
// registry-source: genie/weaver-registry/registry.ts
// fingerprint: sha256:bf2703f996967958f3a2ebd804efc4262a0937302e53945e8d9ed86e75d9ff76
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
    pub const MEGAREPO_BRANCH: &str = "megarepo.branch";
    pub const MEGAREPO_CLI_ALL: &str = "megarepo.cli.all";
    pub const MEGAREPO_CLI_COMMAND: &str = "megarepo.cli.command";
    pub const MEGAREPO_CLI_DRY_RUN: &str = "megarepo.cli.dry_run";
    pub const MEGAREPO_CLI_FORCE: &str = "megarepo.cli.force";
    pub const MEGAREPO_CLI_OUTPUT: &str = "megarepo.cli.output";
    pub const MEGAREPO_CLI_PORCELAIN: &str = "megarepo.cli.porcelain";
    pub const MEGAREPO_MEMBER: &str = "megarepo.member";
    pub const MEGAREPO_REPO: &str = "megarepo.repo";
    pub const MEGAREPO_REPO_PATH: &str = "megarepo.repo_path";
    pub const MEGAREPO_REPO_ROOT: &str = "megarepo.repo_root";
    pub const MEGAREPO_ROOT: &str = "megarepo.root";
    pub const MEGAREPO_STORE_BARE_REPO_PATH: &str = "megarepo.store.bare_repo_path";
    pub const MEGAREPO_STORE_BASE_REF: &str = "megarepo.store.base_ref";
    pub const MEGAREPO_STORE_COMMIT: &str = "megarepo.store.commit";
    pub const MEGAREPO_STORE_GC_ARCHIVE_PATH: &str = "megarepo.store.gc.archive_path";
    pub const MEGAREPO_STORE_GC_ARCHIVE_REASON: &str = "megarepo.store.gc.archive_reason";
    pub const MEGAREPO_STORE_GC_CANDIDATE_COMMITS: &str = "megarepo.store.gc.candidate_commits";
    pub const MEGAREPO_STORE_GC_CANDIDATE_NAMED_REFS: &str = "megarepo.store.gc.candidate_named_refs";
    pub const MEGAREPO_STORE_GC_PHASE: &str = "megarepo.store.gc.phase";
    pub const MEGAREPO_STORE_GC_POLICY: &str = "megarepo.store.gc.policy";
    pub const MEGAREPO_STORE_GC_REPO_CONCURRENCY: &str = "megarepo.store.gc.repo_concurrency";
    pub const MEGAREPO_STORE_GC_REPO_COUNT: &str = "megarepo.store.gc.repo_count";
    pub const MEGAREPO_STORE_GC_REPO_TOTAL: &str = "megarepo.store.gc.repo_total";
    pub const MEGAREPO_STORE_GC_RESULT_ARCHIVED: &str = "megarepo.store.gc.result_archived";
    pub const MEGAREPO_STORE_GC_RESULT_KEPT: &str = "megarepo.store.gc.result_kept";
    pub const MEGAREPO_STORE_GC_RESULT_REAPED: &str = "megarepo.store.gc.result_reaped";
    pub const MEGAREPO_STORE_GC_RESULT_REMOVED: &str = "megarepo.store.gc.result_removed";
    pub const MEGAREPO_STORE_GC_RESULT_SKIPPED_DIRTY: &str = "megarepo.store.gc.result_skipped_dirty";
    pub const MEGAREPO_STORE_GC_RESULT_SKIPPED_IN_USE: &str = "megarepo.store.gc.result_skipped_in_use";
    pub const MEGAREPO_STORE_GC_RESULT_TOTAL: &str = "megarepo.store.gc.result_total";
    pub const MEGAREPO_STORE_GC_ROOT_SET_WORKSPACE_COUNT: &str = "megarepo.store.gc.root_set_workspace_count";
    pub const MEGAREPO_STORE_GC_WORKTREE_COUNT: &str = "megarepo.store.gc.worktree_count";
    pub const MEGAREPO_STORE_GC_WORKTREE_DISCOVERED: &str = "megarepo.store.gc.worktree_discovered";
    pub const MEGAREPO_STORE_GIT_WORKTREE_LIST_FAILED: &str = "megarepo.store.git_worktree_list_failed";
    pub const MEGAREPO_STORE_HAS_CURRENT_WORKSPACE: &str = "megarepo.store.has_current_workspace";
    pub const MEGAREPO_STORE_PRUNE_STALE_REGISTRY: &str = "megarepo.store.prune_stale_registry";
    pub const MEGAREPO_STORE_REF: &str = "megarepo.store.ref";
    pub const MEGAREPO_STORE_REF_TYPE: &str = "megarepo.store.ref_type";
    pub const MEGAREPO_STORE_REFRESH_CURRENT_WORKSPACE: &str = "megarepo.store.refresh_current_workspace";
    pub const MEGAREPO_STORE_REPO: &str = "megarepo.store.repo";
    pub const MEGAREPO_STORE_SOURCE: &str = "megarepo.store.source";
    pub const MEGAREPO_STORE_WORKTREE_BROKEN: &str = "megarepo.store.worktree_broken";
    pub const MEGAREPO_STORE_WORKTREE_PATH: &str = "megarepo.store.worktree_path";
    pub const MEGAREPO_SYNC_DEPTH: &str = "megarepo.sync.depth";
    pub const MEGAREPO_SYNC_MEMBER_ACTION: &str = "megarepo.sync.member.action";
    pub const MEGAREPO_SYNC_MEMBER_BARE_EXISTS: &str = "megarepo.sync.member.bare_exists";
    pub const MEGAREPO_SYNC_MEMBER_NAME: &str = "megarepo.sync.member.name";
    pub const MEGAREPO_SYNC_MEMBER_REF: &str = "megarepo.sync.member.ref";
    pub const MEGAREPO_SYNC_MEMBER_REF_TYPE: &str = "megarepo.sync.member.ref_type";
    pub const MEGAREPO_SYNC_MEMBER_RESULT_STATUS: &str = "megarepo.sync.member.result_status";
    pub const MEGAREPO_SYNC_MEMBER_SOURCE: &str = "megarepo.sync.member.source";
    pub const MEGAREPO_SYNC_MODE: &str = "megarepo.sync.mode";
    pub const MEGAREPO_TEST_STORE_FIXTURE_BRANCH_COUNT: &str = "megarepo.test.store_fixture.branch_count";
    pub const MEGAREPO_TEST_STORE_FIXTURE_COMMIT_COUNT: &str = "megarepo.test.store_fixture.commit_count";
    pub const MEGAREPO_TEST_STORE_FIXTURE_PHASE: &str = "megarepo.test.store_fixture.phase";
    pub const MEGAREPO_TEST_STORE_FIXTURE_REPO: &str = "megarepo.test.store_fixture.repo";
    pub const MEGAREPO_TEST_STORE_FIXTURE_REPO_COUNT: &str = "megarepo.test.store_fixture.repo_count";
    pub const MEGAREPO_TEST_STORE_FIXTURE_TAG_COUNT: &str = "megarepo.test.store_fixture.tag_count";
    pub const MEGAREPO_TEST_STORE_FIXTURE_WITH_REMOTE: &str = "megarepo.test.store_fixture.with_remote";
    pub const MEGAREPO_TRAVERSAL_ALL: &str = "megarepo.traversal.all";
    pub const MEGAREPO_TRAVERSAL_CYCLES_SKIPPED: &str = "megarepo.traversal.cycles_skipped";
    pub const MEGAREPO_TRAVERSAL_MAX_DEPTH: &str = "megarepo.traversal.max_depth";
    pub const MEGAREPO_TRAVERSAL_NODES_VISITED: &str = "megarepo.traversal.nodes_visited";
    pub const MEGAREPO_TRAVERSAL_PURPOSE: &str = "megarepo.traversal.purpose";
    pub const MEGAREPO_TRAVERSAL_ROOT: &str = "megarepo.traversal.root";
    pub const MEGAREPO_WORKSPACE_ROOT: &str = "megarepo.workspace_root";
    pub const MEGAREPO_WORKTREE_HEAD: &str = "megarepo.worktree_head";
    pub const MEGAREPO_WORKTREE_PATH: &str = "megarepo.worktree_path";
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
        "megarepo.branch",
        "megarepo.cli.all",
        "megarepo.cli.command",
        "megarepo.cli.dry_run",
        "megarepo.cli.force",
        "megarepo.cli.output",
        "megarepo.cli.porcelain",
        "megarepo.member",
        "megarepo.repo",
        "megarepo.repo_path",
        "megarepo.repo_root",
        "megarepo.root",
        "megarepo.store.bare_repo_path",
        "megarepo.store.base_ref",
        "megarepo.store.commit",
        "megarepo.store.gc.archive_path",
        "megarepo.store.gc.archive_reason",
        "megarepo.store.gc.candidate_commits",
        "megarepo.store.gc.candidate_named_refs",
        "megarepo.store.gc.phase",
        "megarepo.store.gc.policy",
        "megarepo.store.gc.repo_concurrency",
        "megarepo.store.gc.repo_count",
        "megarepo.store.gc.repo_total",
        "megarepo.store.gc.result_archived",
        "megarepo.store.gc.result_kept",
        "megarepo.store.gc.result_reaped",
        "megarepo.store.gc.result_removed",
        "megarepo.store.gc.result_skipped_dirty",
        "megarepo.store.gc.result_skipped_in_use",
        "megarepo.store.gc.result_total",
        "megarepo.store.gc.root_set_workspace_count",
        "megarepo.store.gc.worktree_count",
        "megarepo.store.gc.worktree_discovered",
        "megarepo.store.git_worktree_list_failed",
        "megarepo.store.has_current_workspace",
        "megarepo.store.prune_stale_registry",
        "megarepo.store.ref",
        "megarepo.store.ref_type",
        "megarepo.store.refresh_current_workspace",
        "megarepo.store.repo",
        "megarepo.store.source",
        "megarepo.store.worktree_broken",
        "megarepo.store.worktree_path",
        "megarepo.sync.depth",
        "megarepo.sync.member.action",
        "megarepo.sync.member.bare_exists",
        "megarepo.sync.member.name",
        "megarepo.sync.member.ref",
        "megarepo.sync.member.ref_type",
        "megarepo.sync.member.result_status",
        "megarepo.sync.member.source",
        "megarepo.sync.mode",
        "megarepo.test.store_fixture.branch_count",
        "megarepo.test.store_fixture.commit_count",
        "megarepo.test.store_fixture.phase",
        "megarepo.test.store_fixture.repo",
        "megarepo.test.store_fixture.repo_count",
        "megarepo.test.store_fixture.tag_count",
        "megarepo.test.store_fixture.with_remote",
        "megarepo.traversal.all",
        "megarepo.traversal.cycles_skipped",
        "megarepo.traversal.max_depth",
        "megarepo.traversal.nodes_visited",
        "megarepo.traversal.purpose",
        "megarepo.traversal.root",
        "megarepo.workspace_root",
        "megarepo.worktree_head",
        "megarepo.worktree_path",
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
    pub const ACME_OPERATION: &str = "acme.operation";
    pub const ATOMICWRITEFILE: &str = "atomicWriteFile";
    pub const GENIE_COMMAND: &str = "genie/command";
    pub const GENIE_FILE: &str = "genie/file";
    pub const GENIE_OXFMT: &str = "genie/oxfmt";
    pub const GENIE_PATH: &str = "genie/path";
    pub const GENIE_RUNVALIDATION: &str = "genie/runValidation";
    pub const GENIE_TARGET_LOCK: &str = "genie/target-lock";
    pub const GIT_DELETE_BRANCH: &str = "git/delete-branch";
    pub const GIT_DETACH_WORKTREE_HEAD: &str = "git/detach-worktree-head";
    pub const MEGAREPO_STORE_GC: &str = "megarepo/store/gc";
    pub const MEGAREPO_STORE_GC_ARCHIVE_WORKTREE: &str = "megarepo/store/gc/archive-worktree";
    pub const MEGAREPO_STORE_GC_ASSESS_LOSSLESS: &str = "megarepo/store/gc/assess-lossless";
    pub const MEGAREPO_STORE_GC_COLD_RECLAIM_REPO: &str = "megarepo/store/gc/cold-reclaim-repo";
    pub const MEGAREPO_STORE_GC_REAP_ARCHIVE: &str = "megarepo/store/gc/reap-archive";
    pub const MEGAREPO_STORE_GC_RESOLVE_PR_STATE: &str = "megarepo/store/gc/resolve-pr-state";
    pub const MEGAREPO_STORE_GC_SCAN_ARCHIVES: &str = "megarepo/store/gc/scan-archives";
    pub const MEGAREPO_STORE_GC_UNPUSHED_COMMIT_COUNT: &str = "megarepo/store/gc/unpushed-commit-count";
    pub const MEGAREPO_SYNC: &str = "megarepo/sync";
    pub const MEGAREPO_SYNC_MEMBER: &str = "megarepo/sync/member";
    pub const MEGAREPO_SYNC_MEMBER_CLONE_OR_FETCH: &str = "megarepo/sync/member/clone-or-fetch";
    pub const MEGAREPO_SYNC_MEMBER_CREATE_WORKTREE: &str = "megarepo/sync/member/create-worktree";
    pub const MEGAREPO_SYNC_MEMBER_RESOLVE_REF: &str = "megarepo/sync/member/resolve-ref";
    pub const MEGAREPO_TEST_STORE_FIXTURE_CREATE: &str = "megarepo/test/store-fixture/create";
    pub const MEGAREPO_TEST_STORE_FIXTURE_REPO: &str = "megarepo/test/store-fixture/repo";
    pub const MEGAREPO_TRAVERSAL: &str = "megarepo/traversal";
    pub const NOTION_MD_BATCH_WATCH: &str = "notion-md.batch-watch";
    pub const NOTION_MD_CAT: &str = "notion-md.cat";
    pub const NOTION_MD_COMMENT_BOUNDARY: &str = "notion-md.comment-boundary";
    pub const NOTION_MD_DESTRUCTIVE_BODY: &str = "notion-md.destructive-body";
    pub const NOTION_MD_EDIT: &str = "notion-md.edit";
    pub const NOTION_MD_ESTABLISH_SIDECAR: &str = "notion-md.establish-sidecar";
    pub const NOTION_MD_GATEWAY_ARCHIVE_PAGE: &str = "notion-md.gateway.archive-page";
    pub const NOTION_MD_GATEWAY_CREATE_PAGE: &str = "notion-md.gateway.create-page";
    pub const NOTION_MD_GATEWAY_LIST_CHILD_PAGES: &str = "notion-md.gateway.list-child-pages";
    pub const NOTION_MD_GATEWAY_MOVE_PAGE: &str = "notion-md.gateway.move-page";
    pub const NOTION_MD_GATEWAY_PULL_PAGE: &str = "notion-md.gateway.pull-page";
    pub const NOTION_MD_GATEWAY_RETRIEVE_DATA_SOURCE: &str = "notion-md.gateway.retrieve-data-source";
    pub const NOTION_MD_GATEWAY_UPDATE_MARKDOWN: &str = "notion-md.gateway.update-markdown";
    pub const NOTION_MD_GATEWAY_UPDATE_PAGE_METADATA: &str = "notion-md.gateway.update-page-metadata";
    pub const NOTION_MD_GATEWAY_UPDATE_PAGE_PROPERTIES: &str = "notion-md.gateway.update-page-properties";
    pub const NOTION_MD_MEDIA_BOUNDARY: &str = "notion-md.media-boundary";
    pub const NOTION_MD_OBJECT_GC: &str = "notion-md.object-gc";
    pub const NOTION_MD_PLAN_PATH: &str = "notion-md.plan-path";
    pub const NOTION_MD_PULL_PAGE: &str = "notion-md.pull-page";
    pub const NOTION_MD_PUSH_PAGE: &str = "notion-md.push-page";
    pub const NOTION_MD_PUT: &str = "notion-md.put";
    pub const NOTION_MD_STATE_READ_NMD: &str = "notion-md.state.read-nmd";
    pub const NOTION_MD_STATE_READ_OBJECT: &str = "notion-md.state.read-object";
    pub const NOTION_MD_STATE_WRITE_OBJECT: &str = "notion-md.state.write-object";
    pub const NOTION_MD_STATUS_PAGE: &str = "notion-md.status-page";
    pub const NOTION_MD_STATUS_PATH: &str = "notion-md.status-path";
    pub const NOTION_MD_SYNC_PAGE: &str = "notion-md.sync-page";
    pub const NOTION_MD_SYNC_PATH: &str = "notion-md.sync-path";
    pub const NOTION_MD_SYNC_TREE: &str = "notion-md.sync-tree";
    pub const NOTION_MD_WATCH: &str = "notion-md.watch";
    pub const NOTION_MD_WATCH_SYNC_PASS: &str = "notion-md.watch.sync-pass";
    pub const NOTION_MD_WEBHOOK_TRIGGER: &str = "notion-md.webhook.trigger";
    pub const SPAN_ACME_PROBE: &str = "span.acme.probe";

    pub const ALL: &[&str] = &[
        "acme.operation",
        "atomicWriteFile",
        "genie/command",
        "genie/file",
        "genie/oxfmt",
        "genie/path",
        "genie/runValidation",
        "genie/target-lock",
        "git/delete-branch",
        "git/detach-worktree-head",
        "megarepo/store/gc",
        "megarepo/store/gc/archive-worktree",
        "megarepo/store/gc/assess-lossless",
        "megarepo/store/gc/cold-reclaim-repo",
        "megarepo/store/gc/reap-archive",
        "megarepo/store/gc/resolve-pr-state",
        "megarepo/store/gc/scan-archives",
        "megarepo/store/gc/unpushed-commit-count",
        "megarepo/sync",
        "megarepo/sync/member",
        "megarepo/sync/member/clone-or-fetch",
        "megarepo/sync/member/create-worktree",
        "megarepo/sync/member/resolve-ref",
        "megarepo/test/store-fixture/create",
        "megarepo/test/store-fixture/repo",
        "megarepo/traversal",
        "notion-md.batch-watch",
        "notion-md.cat",
        "notion-md.comment-boundary",
        "notion-md.destructive-body",
        "notion-md.edit",
        "notion-md.establish-sidecar",
        "notion-md.gateway.archive-page",
        "notion-md.gateway.create-page",
        "notion-md.gateway.list-child-pages",
        "notion-md.gateway.move-page",
        "notion-md.gateway.pull-page",
        "notion-md.gateway.retrieve-data-source",
        "notion-md.gateway.update-markdown",
        "notion-md.gateway.update-page-metadata",
        "notion-md.gateway.update-page-properties",
        "notion-md.media-boundary",
        "notion-md.object-gc",
        "notion-md.plan-path",
        "notion-md.pull-page",
        "notion-md.push-page",
        "notion-md.put",
        "notion-md.state.read-nmd",
        "notion-md.state.read-object",
        "notion-md.state.write-object",
        "notion-md.status-page",
        "notion-md.status-path",
        "notion-md.sync-page",
        "notion-md.sync-path",
        "notion-md.sync-tree",
        "notion-md.watch",
        "notion-md.watch.sync-pass",
        "notion-md.webhook.trigger",
        "span.acme.probe",
    ];
}

/// Metric names.
pub mod metric {
    pub const ACME_PROBE_DURATION: &str = "acme.probe.duration";
    pub const ACME_PROBES: &str = "acme.probes";
    pub const MEGAREPO_STORE_GC_RSS_BYTES: &str = "megarepo_store_gc_rss_bytes";

    pub const ALL: &[&str] = &[
        "acme.probe.duration",
        "acme.probes",
        "megarepo_store_gc_rss_bytes",
    ];
}
