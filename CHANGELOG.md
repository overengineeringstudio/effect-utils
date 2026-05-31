# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- **@overeng/react-inspector**: Lineage annotation namespace (#687). New `Lineage` module with `SourceOfTruth | Derived | Projection | Cache | Mirror | External | Computed` tagged union, plus composable companion annotations (`Authority`, `Freshness`, `ForeignKey`). All annotations are self-describing Effect Schemas with ergonomic `pipe`-style constructors (`Lineage.derivedFrom`, `Lineage.cache`, `Lineage.authority`, etc.). The schema-aware renderer surfaces a small superscript glyph next to annotated field names and a dedicated `LINEAGE` / `AUTHORITY` / `FRESHNESS` / `REF` block in the schema tooltip. `SchemaInfo` gains an optional `lineage: LineageBundle` field. Source-field path references in `Derived.from` carry `data-lineage-target` attributes for future jump-to-source wiring. Round-trip-tested via vitest.
- **@overeng/react-inspector**: Map/Set container labels (#686). `Schema.Map({key, value})` renders as `Map<K, V>(N)`, `Schema.Set(T)` as `Set<T>(N)`, plus the `Readonly*` variants. Detected via the `effect/annotation/TypeConstructor` annotation on `Declaration` ASTs.
- **@overeng/react-inspector**: Runtime tagged-union narrowing (#686). When a field's declared schema is `Schema.Union(A, B, C)` of `_tag`-discriminated variants and the runtime value carries a matching `_tag`, the inspector narrows the display (name, tooltip, container label, nested field resolution) to the matched variant. Narrowing happens on every path segment, not just the leaf, so nested fields under a tagged union resolve through the matched variant. `SchemaProvider` gains a `rootData` prop and the context exposes a new `getContextForPathWithValue(path, value)` method.
- **@overeng/react-inspector**: Schema-derived container labels for arrays, records, and tuples (#686). Arrays show `Array<Item>(N)` instead of `Array(N)`, records show `Record<string, Money>` instead of `Object`, tuples show `[string, number, boolean]`. Named array/record schemas (`.annotations({ identifier: ... })`) take precedence over the constructed label. `SchemaInfo` gains a `containerLabel?: string` field. `getFieldSchema` now falls back to `indexSignature.type` so per-field schema resolution works inside records.
- **@overeng/react-inspector**: Rich schema annotation tooltips. Hovering or keyboard-focusing a field name (or struct type badge) now shows a tooltip surfacing `description`, `examples`, `default`, refinement-derived constraints (min/max/length/pattern/format/...), and possible values for `Literal` / `Enums` / `Union`-of-literal / `TemplateLiteral` ASTs. Replaces the previous native `title=` attribute. New exports: `SchemaTooltip`, `SchemaInfo`, `getSchemaInfo`, `getConstraintsFromJSONSchema`, `getPossibleValuesFromAST`. `getFieldSchema` no longer eagerly unwraps refinement/transformation wrappers so user-supplied annotations on those wrappers reach the tooltip.
- **@overeng/genie**: `githubLabels()` runtime primitive for declarative GitHub Issue/PR label management (color, description, deprecation, legacy migrations). Consumed by `mq-cli repo labels` in `schickling/dotfiles`.
- **genie/external.ts**: Shared label catalog exports (`commonLabels`, `mqLabels`, `andonLabels`, `deprecatedDefaults`, `legacyMigrations`) for cross-repo label IaC. Effect-utils self-applies via `.github/labels.json.genie.ts`.
- **@overeng/notion-effect-client**: Add database create/update/archive helpers and switch live Notion integration tests to provision isolated per-run fixtures under `NOTION_TEST_PARENT_PAGE_ID` instead of relying on stale hard-coded workspace page/database IDs.
- **@overeng/notion-md**: Add managed workspace materialization. `sync <page-id-or-url> <dir>` establishes a workspace from a Notion page tree, and later `sync <dir>` materializes newly discovered remote child pages while reusing the existing guarded one-page sync engine.
- **@overeng/notion-react**: JSX-driven page operations for root `<Page>` and sub-page `<ChildPage>` (#618). Root `<Page>` accepts `title` / `icon` / `cover` and drives `pages.update` on the sync root. `<ChildPage>` becomes a first-class sync boundary with `title` / `icon` / `cover` / `children` / `blockKey`; the sync driver emits and executes `createPage`, `updatePage`, `archivePage`, and `movePage` via `NotionPages.*` with inline block packing (depth ≤ 2, ≤ 100 blocks), tail block ops scoped to the new page, and partial-create rollback on tail failure. Each sub-page is its own sync boundary with its own `blockKey` namespace, and `diff()` descends recursively through retained sub-pages.
- **@overeng/notion-react**: Opt-in `reorderSiblings` on `sync()` (#618 phase 4d). Intra-parent `<ChildPage>` reorder lands via a single `reorderPages` op that the driver realizes with 2N `pages.move` roundtrips through a holding parent (Notion's `pages.move` rejects same-parent, but a trip out and back bumps the page to the end of the original parent's `child_page` block list). Accepts `true` (library auto-provisions and archives a scratch page per sync-with-reorder) or `{ holdingParentId }` (caller-owned lifecycle). Default `false` preserves the pre-4d contract: retained-but-reshuffled siblings still emit same-parent `movePage`, the API rejects, and the driver swallows the validation error.
- **@overeng/notion-cli**: Expose `notion` binary via Nix flake (`packages.${system}.notion-cli`) so consuming repos can add it to their `$PATH` without managing JS module resolution themselves
- **@overeng/pty-effect/client**: Add PTY client support for session tags, `getSession`, `gc`, `updateTags`, `sendData`, `queryStats`, `readRecentEvents`, and live event following
- **@overeng/notion-effect-schema**: Add `NamedIcon` (type: `"icon"`) variant to `Icon` union for native Notion icons (noticons) (#543)
- **@overeng/notion-effect-schema**: Add `NoticonColor` schema for named icon color palette
- **@overeng/notion-effect-schema**: Add `heading_4`, `tab`, and `meeting_notes` block types to `BlockType`
- **@overeng/notion-effect-schema**: Add optional `is_locked` field to `Page` and `DatabaseSchema`
- **@overeng/notion-effect-client**: Add `BlockInsertPosition` tagged union (`after_block`, `start`, `end`) for block insertion
- **@overeng/notion-effect-schema**: Add full `DataSourceSchema` for `GET /data_sources/:id` (properties, parent, database_parent, etc.)
- **@overeng/notion-effect-schema**: Add `PageMarkdown`, `Comment`, `CommentParent`, `View`, `ViewType` schemas
- **@overeng/notion-effect-schema**: Add `RelativeDate` schema type for query filter values (`today`, `tomorrow`, etc.)
- **@overeng/notion-effect-client**: Add `NotionDataSources` module with `retrieve()`, `create()`, `update()`
- **@overeng/notion-effect-client**: Add `NotionComments` module with `create()`, `list()`, `listStream()`
- **@overeng/notion-effect-client**: Add `NotionViews` module with `retrieve()`, `list()`, `listStream()`, `create()`, `update()`, `delete()`
- **@overeng/notion-effect-client**: Add `getParagraphIcon()` helper for tab paragraph block icons
- **@overeng/notion-effect-client**: Add `NotionCustomEmojis` module with `list()` for workspace custom emojis
- **@overeng/notion-effect-client**: Add `NotionPages.getMarkdown()` and `NotionPages.updateMarkdown()` for server-side markdown API
- **@overeng/notion-effect-client**: Add `NotionPages.move()` for moving pages between parents
- **@overeng/notion-effect-client**: Add `markdown` option to `CreatePageOptions` (alternative to `children`)
- **@overeng/notion-effect-client**: Add `is_locked` and `erase_content` to `UpdatePageOptions`
- **@overeng/notion-effect-client**: Add `filterProperties` and `inTrash` to data source query options
- **@overeng/notion-effect-client**: Add strict `.nmd` frontmatter schemas and a storage-size classifier for Notion enhanced Markdown sync metadata
- **@overeng/notion-md**: Add prototype `notion-md` CLI package for self-contained `.nmd` pull/status/push flows with guarded conflict detection and sidecar escalation tests
- **@overeng/notion-md**: Add live Notion E2E coverage for pull/status/push/conflict detection and wire it into the Notion integration CI job
- **@overeng/notion-md**: Expose `notion-md` as a Nix flake package with managed pnpm dependency hash refresh support
- **@overeng/notion-md**: Harden push safety for unknown blocks, Roughdraft review markup, body conflicts with base snapshots, and explicit typed property writes
- **@overeng/notion-md**: Add conservative automatic three-way body merge for non-overlapping line edits, insertions, and deletions
- **@overeng/notion-md**: Replace ad hoc sidecar/base files with strict frontmatter object refs and an Effect-native content-addressed `.notion-md` state store
- **@overeng/notion-md**: Use Notion Markdown `update_content` for proven unique body edits, with guarded `replace_content` fallback and live Notion E2E coverage
- **@overeng/notion-md**: Extract body merge/update planning into a focused pure module with unit coverage
- **@overeng/notion-md docs**: Consolidate scattered research/spec notes into the package-local VRS docs under `packages/@overeng/notion-md/docs/vrs/`
- **@overeng/notion-md docs**: Add package-local usage docs for getting started, CLI workflows, `.nmd` format, sync safety, and troubleshooting
- **@overeng/notion-md**: Add a durable Notion live E2E run ledger and a committed demo `.nmd` fixture synced with the automated Notion showcase page
- **@overeng/notion-md**: Push modeled page metadata from strict frontmatter, including page lock/trash state plus writable icon and cover shapes, and add typed `place`/`verification` property frontmatter values
- **@overeng/notion-md docs**: Fold the remaining VRS design decisions into `spec.md` and remove the companion question log
- **@overeng/notion-md**: Add a TUI Storybook for CLI output states and wire it into the shared Storybook task registry
- **@overeng/tui-stories**: Export `tui-stories` CLI as a Nix package via the flake (#525)

### Fixed

- **genie/ci-workflow**: Match managed workflow report PR comments by hidden `stateId` before patching so independent reports sharing the default marker cannot overwrite each other.
- **devenv/tasks/shared/pnpm**: Share live and fixed-output pnpm install policy, cap live install concurrency to match the prepared-workspace builder, and accept Darwin pnpm teardown exits only after materialization is proven complete.
- **@overeng/megarepo**: Keep store/test integration fixtures independent of user tag-signing Git config by creating fixture tags with `--no-sign`, avoid slow filesystem-watch semaphore acquisition in store locks, let `mr store gc --output json` take the final-state path directly, merge `git worktree list` with the on-disk store layout so GC never drops real worktrees from discovery, and run the megarepo Vitest suite with file parallelism disabled because the in-process CLI integration harness mutates global `process.env` and stdio.
- **devenv/tasks/shared/nix-cli**: Run aggregate `nix:check` package hash validations sequentially so CI does not fan out multiple full root-workspace pnpm FOD rebuilds at once on Darwin.
- **nix/workspace-tools**: Tighten pnpm child/network concurrency inside fixed-output pnpm deps builds and cap Darwin Node heap during the install step so macOS CI is less likely to die with an unstructured `Killed: 9` while materializing whole-workspace install roots.
- **@overeng/pty-effect**: Make the server-mode attach/read integration test wait briefly before emitting its marker so slower Linux CI runners do not miss one-shot startup output during initial attach replay.
- **@overeng/tui-react**: Let Effect CLI own Ctrl-C entrypoint handling for `run(App, handler)`. Apps whose action schema includes `Interrupted` now dispatch it during normal Effect interruption finalization, map interrupt-only CLI exits to code 130, and suppress noisy interrupt-only error output in `runTuiMain`.
- **@overeng/megarepo**: Stop store repository discovery from walking internal scratch roots like `tmp` before scanning repos, yield during repository discovery so Effect interruption can propagate promptly, and tighten CLI OTel flush timing so interrupted TTY commands return quickly while still exporting traces.
- **@overeng/megarepo**: Improve `mr store gc --dry-run --output tty` progress UX with early phase updates, heartbeat refreshes, realtime worktree discovery/active-check counts, explicit interrupted output, exit code 130 for Ctrl-C, and more granular OTel spans for removal status checks. GC removal checks now use a single `git status --untracked-files=normal` dirty preflight before the upstream check, avoiding expensive recursive untracked-file enumeration while still failing closed for dirty worktrees.
- **@overeng/megarepo**: Make store GC worktree discovery layout-authoritative across branch, tag, and commit ref roots, and add OTel/log visibility when `git worktree list` cannot be read.
- **@overeng/megarepo**: Avoid recursive `mr fetch --apply --all` hangs when nested apply falls back from a detached branch worktree to an already-created commit worktree.
- **@overeng/megarepo**: Make `mr store gc` data-loss safe for shared stores.
  - Tracks workspace liveness in a store-local registry and protects both active `repos/*` symlink targets and lock-derived `refs/heads/*` / `refs/commits/*` paths.
  - Keeps named `refs/heads/*` and `refs/tags/*` worktrees by default while reclaiming clean unrooted `refs/commits/*` worktrees.
  - Removes the temporary managed/unmanaged store metadata model and the `--include-unleased` GC mode.
  - Forces untracked-file detection during worktree status checks so user/global Git config cannot hide untracked work from GC.
  - Skips worktrees whose git status cannot be inspected unless `--force` is passed, preserving the fail-closed deletion policy.
  - Acquires worktree locks before removal and reports deletion errors as `error` instead of `removed`.
  - Discovers store repositories by `.bare/` presence instead of assuming only `host/owner/repo` paths, traverses discovery concurrently, skips dirty checks for named refs protected by default, streams GC progress through TTY/NDJSON output, avoids recursive worktree-content scans during GC discovery, prunes Git worktree metadata once per repo after safe removals, and adds OTel spans for GC, liveness, and repo discovery.
- **@overeng/react-inspector**: Render the schema display name exactly once in collapsed schema-aware object previews (#684). `SchemaAwareObjectPreview` is now the single owner of the schema title (rendered in the object-description slot, italicized when sourced from a `title`/`identifier` annotation); the collapsed branch in `SchemaAwareNodeRenderer` no longer prefixes a duplicate copy. Fixes `0: Source Origin Summary Source Origin Summary {…}` → `0: Source Origin Summary {…}`.
- **devenv/tasks/shared/nix-cli**: Make `dt nix:hash:*` update nested `depsBuilds.".".hash` entries used by `mkPnpmCli`
  - Lets CLI package hash refreshes converge again after repo-root `pnpm-lock.yaml` changes instead of looping until max iterations
  - Restores the intended `dt nix:hash:genie` workflow for package-version bumps that only need the fixed-output deps hash refreshed
- **@overeng/notion-react**: Route `<ChildPage>` title updates through `pages.update` instead of `blocks.update` (#618). Notion's `PATCH /v1/blocks/{id}` rejects a `{ child_page: { title } }` body with `validation_error`; the sync driver now emits `PATCH /v1/pages/{id}` with a properly-shaped `title` property for `child_page` updates.
- **@overeng/pty-effect/client**: Fix flaky timeout in `followEvents` (#577) — `asyncScoped`'s setup ran lazily inside the forked consumer fiber, missing events fired before the fiber started. Replaced with `Stream.asyncPush` (setup still lazy, but `emit.single` is now correctly synchronous for `fs.watch` callbacks). Test updated to watch `session_exit` instead of `session_start`, since `EventFollower.watchFile` starts reading at the current end-of-file when a new session is discovered, making `session_start` unreachable via live following.
- **@overeng/notion-md**: Verify content-addressed object bytes exactly, reject object-store inventory mismatches, and emit structured watch errors as compact JSON lines
- **@overeng/notion-md**: Allow property-only pushes across concurrent remote body edits, clear stale unknown-block storage after destructive replacements, and normalize object-ref path checks cross-platform
- **@overeng/notion-md**: Route watch file events through Effect Platform `FileSystem.watch` while preserving scoped cancellation, polling, debounce, and recoverable sync-error behavior
- **@overeng/notion-md**: Add batch multi-file and recursive folder orchestration for `status`, `push`, and `sync`, including duplicate page-id preflight, per-file result envelopes, bounded concurrency, and multi-file watch mode
- **@overeng/notion-md docs**: Add a recursive workspace demo template that shows multi-file folder sync setup without committing placeholder pages as live targets
- **@overeng/notion-md**: Give CLI subprocess e2e checks explicit timeouts so CI load does not fail the help-path smoke test at Vitest's default 5s limit

### Changed

- **@overeng/notion-md**: Breaking CLI simplification: collapse the user-facing page workflow around `sync` and `status`; replace the old explicit `pull` / `push` entrypoints with `sync <page-id-or-url> <file.nmd>` for bootstrap and guarded `sync <file.nmd>` for reconciliation.
- **@overeng/notion-md**: Remove legacy compatibility paths for batch `push` and local-first `page_id: null` page creation; existing Notion pages must be materialized with `sync <page-id-or-url> <target>`.
- **@overeng/pty-effect/client**: `spawnDaemon` now delegates to `@myobie/pty.spawnDaemon` instead of duplicating the daemon spawn pipeline. The Bun-on-Node case is routed through upstream's new `launcher` option (still honors `NODE_BIN`). Eliminates a divergent in-house spawn path so consumers automatically inherit upstream improvements such as bundle-safe spawn (myobie/pty#38). Public API and `PtyDaemonSpec` schema unchanged.
- **@overeng/notion-react**: `<Page>` and `<ChildPage>` accept `icon={null}` and `cover={null}` as explicit clear sentinels (#618). Dropping the prop is still "no claim" (preserves server state); passing `null` emits `pages.update({icon: null})` / `pages.update({cover: null})`. On a fresh page with no prior icon/cover, `null` is a no-op.
- **@overeng/notion-react**: Same-parent `<ChildPage>` creates are now sequential — JSX order is preserved 1:1 on the server (#618). Parallel `pages.create` under a common parent yields nondeterministic `child_page` ordering; the driver issues sequential POSTs so no post-create re-fetch is needed. T08 (formerly "concurrent sibling-page order is not authoritative") is now a normative invariant; the deferred `ensureSiblingOrder` sync option is dropped.
- **@overeng/notion-react**: `CACHE_SCHEMA_VERSION` bumped `2 → 3` to accommodate per-page cache subtrees (#618). v2 caches fall through the existing `"schema-mismatch"` cold path — transparent, no caller action required. The first sync after upgrade may emit one spurious metadata update per sub-page as response-normalized title/icon/cover is recomputed.
- **genie/ci-workflow**: Unify Vercel CI job generation behind a single `vercelDeployJobs()` helper
  - Removes the separate static-job and job-merge helpers now that task-level deploy mode is already unified in `vercel.nix`
  - Lets consumers mix build-mode and static-mode deploys in one project list and attach per-project pre-deploy setup like Vercel git-author configuration
- **deps**: Upgrade `@myobie/pty` from the old git-pinned fork to the published `0.8.0` release line
- **@overeng/notion-effect-client**: Upgrade Notion API version from `2022-06-28` to `2026-03-11`
- **@overeng/notion-effect-schema**: Remove `archived` field from `DatabaseSchema`, `Page`, and `Block` schemas (replaced by `in_trash` in API 2026-03-11)
- **@overeng/notion-effect-client**: Replace `after` parameter with `position` object in `AppendBlockChildrenOptions`
- **@overeng/notion-effect-client**: Replace `archived` with `in_trash` in `UpdatePageOptions` and `archive()` method
- **@overeng/notion-effect-client**: Remove `archived` from `TypedPage` interface (use `inTrash` instead)
- **@overeng/notion-effect-client**: Add named icon variant to `CreatePageOptions` and `UpdatePageOptions` icon types
- **@overeng/notion-effect-client**: Unify file upload API version with shared `NOTION_API_VERSION` constant
- **@overeng/notion-effect-client**: Update search filter from `'database'` to `'data_source'` (API 2025-09-03+ change)
- **@overeng/notion-effect-client**: Migrate database query from `/databases/:id/query` to `/data_sources/:id/query` (`databaseId` → `dataSourceId`)
- **@overeng/notion-effect-schema**: Add `data_source_id` parent variant to `PageParent` schema
- **@overeng/notion-effect-schema**: Add `data_source_id` parent variant to `BlockParent` schema for blocks returned from data-source-backed pages.
- **@overeng/notion-effect-schema**: Rename `DataSource` → `DataSourceRef` for lightweight reference in `DatabaseSchema.data_sources`
- **@overeng/notion-effect-client**: Widen `SchemaHelpers` to accept both `DatabaseSchema` and `DataSourceSchema`
- **@overeng/notion-md**: Use `NOTION_API_TOKEN` as the only Notion credential environment variable across code, docs, tests, and SecretSpec

### Fixed

- **genie/ci-workflow**: Add a shared step decorator for job-local private Cachix read auth
  - Creates a per-step netrc file and appends `netrc-file` to `NIX_CONFIG` instead of relying on runner-global Determinate state
  - Lets downstream repos decorate `devenv` and deploy run steps without exposing the Cachix token to unrelated actions
- **devenv/tasks/shared/vercel.nix**: Preserve dotfiles when packaging static prebuilt output for Vercel deploys
  - Copies `staticDir/.` into `.vercel/output/static/` instead of globbing `staticDir/*`, so hidden assets and config files are not silently dropped
- **@overeng/notion-effect-client**: Raise user integration-test timeouts to tolerate current Notion API latency in CI
- **@overeng/notion-cli**: Fix introspection pipeline to read properties from data source (API 2026-03-11 no longer returns properties on `GET /databases/:id`)
- **@overeng/pty-effect/client**: Keep daemon spawning on PTY's published client API while updating the wrapper to the current session/tag/event surface and preserving attach runtime context

### Changed

- **deps**: Upgrade all Effect ecosystem packages (+2 minor each): `effect` 3.19.19 → 3.21.0, `@effect/platform` 0.94.5 → 0.96.0, `@effect/ai` 0.33.2 → 0.35.0, and 12 other `@effect/*` packages to latest
- **nix**: Update `tsgo` flake input to `Effect-TS/tsgo@24a8a96` (2026-03-30)
- **nix/workspace-tools**: Replace committed per-package normalized pnpm lockfiles with direct staged installs from the authoritative root lockfile
  - Keeps the full pnpm 11 multi-document root lockfile intact inside staged workspaces instead of checking in derived `pnpm-lock.normalized.yaml` files
  - Keeps `manage-package-manager-versions=false` so pinned Nix pnpm builds stay sandbox-safe without self-bootstrapping another pnpm under `$HOME`
  - Removes first-party `pnpm-lock.normalized.yaml` artifacts from `genie` and `megarepo`

### Fixed

- **devenv/tasks/shared/ts.nix**: Make `ts:check:strict` inherit repo-local `ts:check.after` dependencies
  - Preserves consumer generators like `contentlayer:build` when strict typecheck is used as the CI gate
  - Prevents downstream repos from regressing when they already extend `ts:check` with extra build prerequisites
- **genie/external**: Export the shared `@effect-atom/atom` peer-version allowlist in megarepo pnpm policy
  - Keeps downstream repos on `strictPeerDependencies: true` while allowing the Effect version ranges already used inside effect-utils itself
  - Prevents consumer workspace installs from failing on the known pre-1.0 peer ranges declared by `@effect-atom/atom`
- **genie/external**: Export the full shared patch registry to peer repos
  - Adds the `node-pty@1.1.0` patch to `createPnpmPatchedDependencies()` / `pnpmPatchedDependencies()`
  - Unblocks composed-root `pnpm-workspace.yaml` generation in downstream megarepos that import `@overeng/utils`
- **@overeng/genie**: Use cwd-relative lock directory instead of shared `/tmp/genie-locks/` to fix `EACCES` errors in multi-user CI environments (#520)
- **@overeng/tui-react**: Format timeline timestamps as human-readable durations (e.g. `6m 18s / 16m 21s`) instead of raw seconds (`377.9s / 980.6s`) in `TuiStoryPreview` (#472)
- **devenv/tasks**: make warm shell bootstrap commit-scoped and remove `ts:emit` from shell entry
  - Adds an outer `setup:auto` cache so warm `devenv shell` skips unchanged bootstrap work instead of traversing `pnpm:install`, `genie:run`, and `mr:apply` on every entry
  - Switches shell bootstrap from `mr:sync` to initial `mr:apply` so a fresh worktree is normalized without fetching on every shell
  - Replaces setup fingerprint tool-version probes with resolved tool-identity hashing so warm shells do not pay `pnpm`, `genie`, or `mr` CLI startup just to validate unchanged setup inputs
  - Speeds up warm task status paths by using direct `mr status`, fingerprint-based `genie:run` caching, a one-process `pnpm:install` projection hash that preserves the previous structural guarantees, and a `ts:emit` graph that excludes `noEmit` references at emit time
  - Hardens the fast paths by making the outer cache only track setup inputs while each task still verifies its own outputs before skipping
- **devenv/otel**: update `devenv` to the upstream `v2.1` tag and move OTEL shell-entry notices onto `devenv.messages`
  - Resolves OTEL mode, dashboard sync, and Grafana trace-link construction in a dedicated shell-entry task instead of ad-hoc `enterShell` output
  - Auto-displays the OTEL shell-entry message through upstream task messages while keeping `otel-trace` as a lightweight re-open helper
  - Scrubs ambient task trace context before emitting `devenv/shell:entry` so the shell root span cannot self-parent or collide with later `dt` root spans
  - Emits `devenv/shell:entry` via the pinned store path for `otel-span` so tracing still works before `enterShell` PATH mutations are fully visible
- **@overeng/genie**: Validate GitHub Actions `runs-on` labels before emitting workflow YAML
  - Fails `genie` when workflow jobs serialize non-string, empty, or stale placeholder runner labels like `null` / `...=undefined`
  - Prevents CI helper API drift from silently generating invalid workflow files that only fail later in GitHub Actions
- **@overeng/megarepo**: Harden store against broken worktree remnants (#423)
  - `hasWorktree` now checks for `.git` file existence instead of just directory existence, so broken partial worktrees are properly detected and recreated
  - Lock-protected worktree creation cleans up broken directory remnants and prunes stale git worktree bookkeeping before recreating
  - Fix semaphore creation race in `StoreLock` using `SynchronizedRef` for atomic get-or-create
- **flake / nix/workspace-tools**: Document and regression-test strict downstream reuse of effect-utils' canonical nixpkgs input
  - Adds downstream flake-input and `devenv` fixture coverage for standalone and `repos/effect-utils`-prefixed consumers
  - Makes the intended contract explicit: downstream repos should follow `effect-utils/nixpkgs` instead of overriding effect-utils to their ambient nixpkgs
- **@overeng/megarepo**: Skip pre-flight hygiene checks in apply mode (#423)
  - Apply mode self-heals all store issues (missing bare repos, broken worktrees, ref mismatches)
  - Eliminates races in `--all` mode where concurrent nested syncs modify shared store state while sibling pre-flight checks observe it
  - Simplifies `runPreflightChecks` to lock-mode-only (removes `mode`/`commitMode` parameters and exception lists)

- **devenv/tasks/shared/nix-cli**: Update multiple stale Nix FOD hashes per `dt nix:hash:*` iteration
  - Adds `nix build --keep-going` to surface all fixed-output hash mismatches from one build
  - Parses and applies multiple reported hash updates in one pass instead of only the first mismatch
  - Adds regression coverage for mixed main-hash and local-dependency hash updates
- **nix/workspace-tools/mk-pnpm-deps / mk-pnpm-cli / oxc-config-plugin**: Switch Nix-contained pnpm builds to precomputed relocatable install trees
  - Prepares the staged workspace install tree once inside the fixed-output derivation instead of restoring a vendored pnpm store and rerunning `pnpm install` in downstream builds
  - Normalizes pnpm's absolute-path and timestamp metadata so the prepared tree stays deterministic across repeated builds
  - Restores the prepared tree into the real workspace and relocates pnpm path placeholders before Bun-based build steps run
- **nix/workspace-tools/mk-pnpm-deps**: Drop pnpm bookkeeping metadata from prepared install trees
  - Removes `.modules.yaml` and `.pnpm-workspace-state-v1.json` from the archived prepared tree because downstream Nix builders restore the tree and go straight to Bun instead of rerunning pnpm
  - Eliminates the remaining runner-specific pnpm metadata nondeterminism that was still flipping prepared-tree hashes across CI environments
- **nix/workspace-tools/mk-pnpm-cli**: Keep `pnpm` available in prepared-tree build environments
  - Restores `pnpm` to `nativeBuildInputs` so downstream packages can keep using `pnpm exec ...` in `postBuild` hooks after the install tree is precomputed
  - Gives pnpm a writable HOME and disables package-manager self-bootstrap in the builder so `pnpm exec` remains sandbox-safe and does not try to install a different pnpm version under `/homeless-shelter`
  - Fixes downstream CLI packages with asset builds layered on top of `mkPnpmCli`, such as `op-proxy` and `factory`
- **CI workflow / genie/ci-workflow**: Evict cached pnpm-deps outputs before CI jobs resolve `oxlint-npm`
  - Avoids stale fixed-output pnpm cache entries masking the validated prepared-install-tree hash on CI runners
  - Applies the cache bust to each job that resolves the shared Nix toolchain so `nix-check` and the faster task jobs agree on the same fresh deps output
- **@overeng/genie**: Fail `genie --check` when inherited peer deps use ranged local install versions
  - Allows ranged `peerDependencies`
  - Requires explicit local install versions in `dependencies` / `devDependencies` / `optionalDependencies`
- **@overeng/megarepo**: Handle stale locked commits during `mr sync --pull`
  - Prevents recursive sync from aborting when nested pinned members reference commits that no longer exist
  - Allows `mr sync --pull --force` to recover pinned branch members by resolving the tracked ref head
  - Adds regression coverage for recursive `--pull --all` with nested stale pinned lock entries
- **devenv/lint**: Adopt `execIfModified` negation patterns and drop the obsolete full-workspace lint install dependency
  - Excludes vendored/generated trees like `node_modules` during lint cache invalidation
  - Keeps `oxlint` install-free by using the bundled Nix JS plugin instead of the source plugin path
  - Retains the package-local `genie` install dependency because `genie --check` still runs via the repo's source-mode CLI
- **devenv/tasks/shared/check.nix**: Give aggregate check tasks explicit no-op commands so `devenv tasks run check:*` actually traverses their dependencies
  - Prevents current `devenv` from treating `check:quick` / `check:all` as skipped `No command` wrappers
  - Restores the intended shared quick-check entrypoint for downstream repos
- **Effect TypeScript tooling**: Pin the exported `effect-tsgo` flake input back to the last known-good upstream revision
  - Reverts the `tsgo` flake lock refresh after confirming `Effect-TS/tsgo@df2eaaa` currently fails to build its own `effect-tsgo` package
  - Keeps downstream `devenv` shells green until the upstream patch set catches up again
- **nix/workspace-tools/mk-pnpm-cli**: Build pnpm CLIs from filtered aggregate-root workspaces instead of package-level deploy closures
  - Moves patched dependency path discovery out of Nix evaluation and into the staging derivation
  - Preserves lockfile-driven patch staging for root and external install roots without recursive eval-time YAML walks
  - Unblocks downstream composed flake evaluation that was previously overflowing in `parsePatchedDependencyPaths`
  - Stages the target package and its workspace closure under one canonical root workspace
  - Installs dependencies at that staged root with the same aggregate lockfile model used by local dev
  - Compiles the target entrypoint with Bun from the staged package directory, reducing coupling to bespoke deploy-time workspace surgery
  - Narrows pnpm deps fetching to the staged root lockfile, closure package manifests, and referenced patch files
  - Removes legacy deploy-specific behavior and normalizes the store against the staged aggregate workspace input
  - Keeps the smoke harness focused on real Nix builds of the `genie` and `megarepo` packages
- **@overeng/tui-react**: Add `@types/react` and `@types/react-reconciler` to peer dependencies
  - Consumers need these type packages to type-check the `.tsx` source exports
- **devenv/tasks/shared/vercel.nix**: Export deploy URLs as task output env vars and fail fast when URL extraction fails
  - Captures Vercel CLI output inside task execution and extracts the deployment URL deterministically
  - Writes `VERCEL_DEPLOY_URL` and `VERCEL_DEPLOY_URL_<DEPLOYMENT_NAME>` via `DEVENV_TASK_OUTPUT_FILE`
  - Enables CI callers to consume deploy URLs from structured task output instead of brittle log scraping

### Changed

- **devenv/tasks/shared/ts-effect-lsp.nix**: document the tracked future unification of the standalone Effect LSP task with `ts:check`
  - Adds a linked TODO for collapsing the separate task once the main workspace TypeScript check becomes `Effect-TS/tsgo`-backed
- **@overeng/genie**: tighten pnpm workspace SSOT around package seeds
  - Removes `extraPackages` from `pnpmWorkspaceYaml.root(...)` and the matching `additionalMemberPaths` graph helper escape hatch
  - Removes committed package-level `pnpm-workspace.yaml` projections in favor of internal build-time package closures
  - Removes `pnpmWorkspaceYaml.manual(...)` and `packageJson.aggregate(...)`; all root projection now goes through `pnpmWorkspaceYaml.root(...)` and `packageJson.aggregateFromPackages(...)` with explicit `repoName`
  - Adds `extraMembers` as an exceptional escape hatch for non-genie-managed workspace members (e.g. standalone examples in livestore) — prefer real package generators over `extraMembers` whenever possible
  - Stops `genie/external.ts` from depending on internal workspace-graph helpers and documents the seed-only aggregate model
- **Effect TypeScript tooling**: switch local language-service integration to Nix-provided `effect-tsgo`
  - Repoints the dev environment to upstream `Effect-TS/tsgo`
  - Renames generator helpers/comments to describe the current tsgo-based model
  - Keeps the `@effect/language-service` tsconfig plugin entry only as the current upstream tsgo configuration channel
- **pnpm/dev workspace**: Switch dev installs to a generated repo-root hoisted pnpm workspace
  - Adds generated root `package.json` and `pnpm-workspace.yaml` with explicit workspace members
  - Makes `pnpm:install` own the repo-root install state and keeps the repo-root `pnpm-lock.yaml` as the only authoritative lockfile
  - Updates package-scoped task execution to use `pnpm exec` so Vitest, Storybook, and Vite resolve against the active workspace topology
  - Derives package closures for Nix/tooling at build time instead of committing package-level `pnpm-workspace.yaml` files
  - Clarifies in the install spec that the current symlinked `repos/*` Megarepo realization keeps imported members on a cross-repo `link:` boundary rather than making them aggregate-root workspace importers
- **@overeng/utils**: Make Storybook `viteFinal` typing opt-in generic for linked Vite workspaces
  - Keeps the default helper API free of foreign Vite types
  - Lets consumers opt into their own local `vite` config type when they need a typed `viteFinal` hook
- **devenv/tasks/shared/vercel.nix**: Switch to prebuilt deploy mode (`vercel pull` -> `vercel build` -> `vercel deploy --prebuilt`)
  - Replaces direct `vercel deploy <dir>` with local prebuilt workflow for deterministic deploys
  - Replaces `path`/`outputDir` deployment config with `cwd` (defaults to `"."`)
  - Adds `vercel pull` step to fetch project settings and env for the target environment
  - Adds `vercel build` step to produce `.vercel/output` locally before deploying
- **@overeng/genie / @overeng/notion-cli**: Source inherited install-time dependency versions from the Genie catalog instead of copied peer ranges
  - Keeps `peerDependencies` ranged for consumers
  - Makes the catalog the single source of truth for concrete local install versions

### Added

- **devenv/tasks/shared/ts-effect-lsp.nix**: add reusable `ts:effect-lsp` tsgo diagnostics task
  - Exports `effect-tsgo` from the flake package set for downstream devenv consumers
  - Keeps the task standalone so repos can opt into Effect diagnostics without conflating them with stylistic lint
- **@overeng/genie**: Added `githubAction` runtime generator for type-safe `action.yml` generation
- **docs/bun**: Document the upstream nested-workspace `patchedDependencies` blocker and link the Bun issue
- **docs/bun**: Note the Bun-only local workspace fork workaround for patched dependencies
- **@overeng/effect-rpc-tanstack**: Add custom fetch transport support to `layerClient`
  - Allows SSR callers to reuse Effect's built-in `FetchHttpClient` with an injected fetch implementation
  - Adds `fetchFromWebHandler(...)` for adapting colocated web handlers to fetch-compatible transport
  - Avoids app-local reimplementation of Effect HTTP request body/stream handling
- **docs/node-modules-install**: Clarify the pnpm GVS requirement for single-instance JS/TS dependency identity and add install-performance requirements

### Removed

- **devenv/tasks/shared/ts.nix**: remove the legacy `ts:patch-lsp` patching flow from the shared TypeScript task module
  - Drops the `lspPatchCmd`, `lspPatchAfter`, and `lspPatchDir` parameters from the exported shared task API
  - Removes stale shell-entry and OTEL references to `ts:patch-lsp`
- **devenv/tasks/shared/setup.nix**: Remove `setup:opt:*` wrapper tasks and `setup:optional` gate
  - Optional tasks now use native `@complete` dependency suffix instead of nested `devenv tasks run` wrappers
  - Eliminates 6x shell re-evaluation, ~5.9s trace gap, fork-bomb guards, and filesystem locks
  - The workaround for `cachix/devenv#2480` is no longer needed since we use `devenv shell` (not direnv)
- **nix/workspace-tools**: Remove compatibility-only Nix surface from CLI builders/tasks
  - Drops the dead `packageJsonDepsHash` argument from both `mk-pnpm-cli` and exported `mk-bun-cli`
  - Removes the deprecated `devenvModules.tasks.git-hooks-fix` export and deletes its module

### Fixed

- **CI diagnostics**: add temporary root-cause instrumentation for Nix store corruption flakes (`#272`)
  - `validateNixStoreStep` now captures full verify/repair/devenv logs and runner fingerprint into a diagnostics directory
  - Failed jobs now add a compact diagnostics summary and upload a diagnostics artifact for triage
  - Added a temporary `workflow_dispatch` debug switch to force a controlled CI failure and verify diagnostics summary/artifact behavior end-to-end
  - Marked as temporary with explicit cleanup intent once root cause is identified and CI is stable
- **devenv/tasks/shared/ts.nix**: Fix `ts:emit` missing `--build` flag
  - `tscWithDiagnostics` was called without `--build`, causing tsc to treat `tsconfig.all.json` as a source file
  - Previously masked by `setup:opt:*` wrappers silently swallowing the failure
- **beads packaging**: Avoid long emulated builds by using patched prebuilt `bd` release binaries (v0.55.4)
  - `nix/beads.nix` now fetches release tarballs instead of compiling Go sources under QEMU
  - Linux binaries are patched with Nix loader/RPATH (`icu74`) so Dolt-enabled `bd` runs correctly
- **@overeng/genie**: `genie --check` now fails fast on fatal `.genie.ts` import/build errors and marks interrupted sibling checks as canceled
  - Prevents indefinite stalls when a sibling check remains in-flight after a fatal import/build failure
  - Final JSON/TUI failure state is reconciled from `GenieGenerationFailedError.files` to avoid stale `active` entries
- **beads packaging/tasks**: Fix `bd` Dolt startup failures on macOS by building with CGO enabled and updating beads task/hook invocations for current CLI flags
  - `nix/beads.nix` now builds `bd` from source (`buildGo126Module`) with CGO + ICU/SQLite inputs instead of prebuilt no-CGO release tarballs
  - `nix/devenv-modules/tasks/shared/beads.nix` now uses Dolt-directory bootstrap checks and removes deprecated `--no-daemon/--no-db` flag usage

### Changed

- **genie/ci-workflow**: Switch CI helpers to lock-pinned `DEVENV_BIN` instead of PATH `devenv`
  - Replaced `installDevenvFromLockStep` with `preparePinnedDevenvStep` and made task commands use `"$DEVENV_BIN"`
  - `validateNixStoreStep` now runs `devenv info` with `restrict-eval = false` appended in `NIX_CONFIG`
  - `runDevenvTasksBefore` now forwards that unrestricted `NIX_CONFIG` to all `devenv tasks run ...` calls
  - `standardCIEnv` now defaults `NIX_CONFIG` to `restrict-eval = false` for CI jobs, and validation/tasks use that shared default

- **@overeng/megarepo**: Scope nested `megarepo.lock` reconciliation to recursive sync mode
  - `mr sync` now syncs direct member lock artifacts only (`flake.lock` / `devenv.lock`)
  - Nested `megarepo.lock` reconciliation now runs only with `mr sync --all`

- **devenv/tasks/shared/megarepo.nix**: Make `megarepo:sync` always run with `--frozen`
  - Prevents shell-entry and routine task runs from rewriting `megarepo.lock`
  - Adds `megarepo:sync:update` for intentional non-frozen lockfile updates

- **devenv/dt**: Remove CI/non-interactive TUI suppression workaround now that devenv auto-disables TUI in CI
  - Dropped manual `DEVENV_TUI=false` handling and PTY stderr piping from `dt`
  - Updated failure re-run hints to use `devenv tasks run ... --mode before` without `--no-tui`

- **@overeng/genie**: Reduce duplicate check-time work by reusing loaded genie modules between content verification and validation
  - Added `loadGenieFile` / `checkFileDetailed` in core generation to return reusable module/context metadata
  - `checkAll` now passes preloaded modules into `runGenieValidation` instead of re-importing every `.genie.ts`
  - Switched formatting hot path to in-process `oxfmt` API with CLI fallback, eliminating per-file formatter process spawn in normal operation

- **devenv/otel-span**: Consolidate `otel-span` and `otel-emit-span` into single CLI with subcommands
  - `otel-span run <service> <span-name> [opts] -- <cmd>` replaces bare `otel-span <service> ...`
  - `otel-span emit` replaces `otel-emit-span` (reads OTLP JSON from stdin)
  - Breaking: subcommand is now required

- **devenv/otel.nix**: Hard-cut system-mode dashboard sync compatibility
  - `OTEL_MODE=system` now fails shell entry when `OTEL_STATE_DIR`, `OTEL_EXPORTER_OTLP_ENDPOINT`, or `otel` CLI is missing
  - Removed `OTEL_DASHBOARDS_DIR` shell env export
  - Removed shell-side `extraDashboards` merge logic; `extraDashboards` is now rejected in system mode

- **devenv/otel.nix**: Replace `curl` with file spool (`otlpjsonfilereceiver`) in `otel-span`
  - Spans are written to `$OTEL_SPAN_SPOOL_DIR/spans.jsonl` instead of HTTP POST
  - Collector picks up spans via `otlpjsonfilereceiver` (500ms poll, delete after read)
  - Falls back to `curl` if spool dir not available
  - Reduces per-span overhead from ~58ms to <1ms

### Fixed

- **devenv/otel-span**: Emit boolean attributes and manage task trace context
  - `--attr` now serializes `true`/`false` values as `boolValue` (aligns dashboard TraceQL filters)
  - `otel-span` reads `OTEL_TASK_TRACEPARENT` (preferred over `TRACEPARENT`) and exports both for child processes
  - This isolates task traces from stale shell `TRACEPARENT` values caused by devenv shell re-evaluations

- **devenv/dt**: Simplify trace context propagation
  - `dt` now clears `TRACEPARENT` and delegates context management entirely to `otel-span`
  - Removes manual trace/span ID generation that was previously duplicated between `dt.nix` and `otel-span`

- **devenv/otel-span**: Add `--status-attr KEY` flag for status check spans
  - Derives bool attribute from exit code (0=true, non-zero=false)
  - Forces span status to OK (status checks aren't errors, exit 1 means "not cached")
  - Used by `trace.status` to set `task.cached` without masking the real exit code

- **devenv/tasks/lib/trace.nix**: Trace status checks with method and sub-trace support
  - `trace.status` now accepts a `method` parameter (`"binary"`, `"hash"`, `"path"`)
  - Status body runs INSIDE `otel-span` (not post-hoc) so sub-programs inherit TRACEPARENT
  - Binary status checks (e.g. `genie --check`, `mr status`) now produce child spans
  - `task.cached` is derived from exit code via `--status-attr` (no explicit bool passing)
  - Each real status execution gets its own span (no deduplication — duplicate spans from devenv's
    shell re-evaluations accurately reflect what actually happened)

- **devenv/tasks/shared/lint-oxc.nix**: Wire up `genieCoverageExcludes` and add `genieCoverageFiles` (#198)
  - `genieCoverageExcludes` was accepted but never applied; now uses git pathspec exclusion
  - New `genieCoverageFiles` parameter (default: `["package.json" "tsconfig.json"]`) makes checked file types configurable
  - Removed dead `defaultExcludes`/`excludeArgs` code from obsolete `find`-based approach
  - Made doc examples more generic (removed `@overeng`-specific paths)

### Added

- **genie**: Add programmatic TS SDK (`@overeng/genie/sdk`) for calling genie's generate/check
  logic from TypeScript without the CLI. Core orchestration extracted into shared `core.ts` using
  PubSub + Stream event bus pattern, consumed by both CLI (TUI progress) and SDK (silent).

- **genie**: Split `src/build/` into `src/core/` (shared, no TUI deps), `src/build/` (CLI/TUI),
  and `src/sdk/` (programmatic API). Each export path now maps 1:1 to a directory. SDK consumers
  no longer need `jsx` in their tsconfig.

- **devenv/tasks/shared/worktree-guard.nix**: Git hook to enforce worktree workflow
  - Refuses commits on the default branch (detected via `refs/remotes/<remote>/HEAD` with fallback)
  - Optionally refuses commits from the primary worktree
  - Detects megarepo store worktrees and prevents commits when the path-implied ref doesn't match `HEAD`

- **devenv/tasks/shared/ts.nix**: Add `ts:emit` task (`tsc --build --noCheck`) and use it for shell entry
  - Keeps `ts:build` as the typechecked build
  - Improves shell entry performance by skipping full type checking during emit
  - Shell entry now runs `ts:patch-lsp` separately; `ts:emit` no longer depends on patching so it can be used standalone
- **devenv/otel.nix**: TRACEPARENT propagation for shell entry waterfall tracing
  - `setup:gate` generates root TRACEPARENT for shell entry traces
  - `setup:save-hash` emits a `devenv:shell:entry` root span
  - `trace.nix` generates fallback TRACEPARENT when not already set
  - Enables end-to-end waterfall view in Grafana Tempo for shell startup

- **devenv.nix**: Nix eval visibility and cold-start detection
  - `SHELL_ENTRY_TIME_NS` captured at enterShell start
  - `shell:ready` marker span with `cold_start` attribute
  - `dt.nix` adds `shell.ready_ms` attribute for eval+setup time tracking

- **devenv/otel.nix**: `otel:test` task for shell-level unit tests
  - Validates JSON format, TRACEPARENT propagation, spool write, and fallback
  - Runs offline (~2s) without requiring `devenv up`

- **@overeng/otel-cli**: Spool file verification in `otel debug test`
  - Tests both HTTP and file spool delivery paths end-to-end
  - Gracefully skips spool test when `OTEL_SPAN_SPOOL_DIR` not set

- **@overeng/genie**: Validate `pnpmWorkspaceYaml` rejects absolute paths in `packages` during `genie:check` (#152)

- **@overeng/otel-cli**: New Effect CLI package for OTEL stack diagnostics and trace exploration
  - `otel health` — per-component health status (Grafana, Tempo, Collector)
  - `otel trace ls` — tabular trace listing with TraceQL query filtering
  - `otel trace inspect` — span tree with ASCII waterfall visualization
  - `otel metrics ls/query/tags` — TraceQL metrics querying with sparkline rendering
  - `otel api` — raw HTTP calls to Grafana, Tempo, Collector APIs
  - `otel debug test/dashboards` — E2E smoke tests and dashboard inspection

- **devenv/otel.nix**: Full OTEL observability stack as reusable devenv module
  - OTEL Collector + Grafana Tempo + Grafana with hash-based deterministic port allocation
  - Auto-provisioned dashboards via Grafonnet (Jsonnet DSL) build pipeline
  - `otel-span` shell helper for wrapping commands in OTLP trace spans
  - Compatible with Effect OTEL layers (same env var/protocol)

- **devenv/tasks/lib/trace.nix**: Task tracing helper with cache status tracking
  - `trace.exec` wraps task exec scripts with `otel-span` for child span emission
  - `trace.status` emits spans with `task.cached=true` for cached tasks
  - Applied to all shared task modules (ts, genie, lint, pnpm, test, megarepo, etc.)

- **devenv/otel/dashboards**: 6 Grafonnet dashboards with manual grid positioning
  - Overview, dt Task Performance, Shell Entry, pnpm Install Deep-Dive, TS App Traces, dt Duration Trends
  - dt-tasks dashboard with cache status filtering (executed vs cached)

- **@overeng/utils**: `node/otel` module for Effect-native OTEL instrumentation in CLI apps
  - `makeOtelCliLayer()` wires OTLP exporter with W3C TRACEPARENT propagation from `dt` tasks
  - Zero overhead when `OTEL_EXPORTER_OTLP_ENDPOINT` is not set

- **devenv**: Netlify deploy tasks for storybook preview deployments
  - New shared `netlify.nix` task module with `netlify:deploy:<name>` per-package tasks
  - Supports prod, PR preview (alias), and local draft deploy modes via `--input` flags
  - CI job `deploy-storybooks` deploys all 7 storybooks on PRs and pushes to main
  - Replaces Vercel-based storybook deployments

- **@overeng/tui-react**: Standalone `run` function with dual (data-first/data-last) API (#129)
  - `run(app, handler, { view })` replaces `Effect.scoped(Effect.gen(function* () { const tui = yield* app.run(view); ... }))`
  - Scope managed internally — consumers no longer need `Effect.scoped`
  - Error type `E` inferred from handler (no explicit error schema needed)
  - Added `TuiAppTypeId` brand and `isTuiApp` predicate for runtime type detection

### Fixed

- **devenv/lint**: Simplify `lint:check:format` by reverting to direct `oxfmt --check` invocation (#157)
  - Removed `git ls-files` complexity — oxfmt's directory walker already excludes `node_modules`
  - Added `pnpm:install` dependency to ensure stable `node_modules` state during formatting
  - Investigation confirmed `experimentalSortImports` uses string-based classification (no filesystem reads)

- **@effect/language-service/TypeScript config**: Elevate `missedPipeableOpportunity` diagnostics to warnings
  - `missedPipeableOpportunity` now emits as `warning` so Effect LSP findings are visible in non-IDE CLI typechecks
  - Keeps `ts:check` in `--noEmit` mode while preserving the existing `ts:check`/`ts:build` behavior split (#218)

- **CI/storybook**: Fix storybook builds used by Netlify preview deploys
  - Stub `@opentui/*` in `@overeng/genie` Storybook build (OpenTUI requires Bun runtime)
  - Fix `@overeng/tui-react` examples importing `src/mod.ts` (actual entry is `src/mod.tsx`)

- **CI/deploy-storybooks**: Make Netlify preview deploys more reliable
  - Run the deploy job on `ubuntu-latest` (avoids flaky Namespace runner Nix store state)
  - `netlify:deploy:*` now depends on `storybook:build:*` so deploys always have build output

- **@overeng/tui-react**: Fix `OutputCauseSchema` using `Schema.Never` for error field (#129)
  - Changed `error: Schema.Never` to `error: Schema.Defect` in `OutputCauseSchema`
  - Previously, typed errors (e.g. `GenieGenerationFailedError`) caused `ParseError: Expected never` during JSON encoding, masking the real error

### Changed

- **devenv/tasks**: Optimized `check:quick` by prioritizing utils package install
  - Moved utils and utils-dev to front of install queue for earlier `ts:patch-lsp` start
  - `check:quick` improved from ~18-28s to ~14-15s through better task parallelism

- **devenv/ts.nix**: Per-project tsc tracing via `--extendedDiagnostics` parsing
  - When OTEL is available, `ts:check` and `ts:build` emit per-project child spans with timing attributes
  - ~3% overhead when active, zero overhead when OTEL unavailable
  - Renamed `ts:watch` to `ts:build-watch`

- **@overeng/tui-react**, **@overeng/megarepo**, **@overeng/notion-cli**, **@overeng/genie**: Migrated all consumers to standalone `run` API (#129)
  - All command files now use `run(App, handler, { view })` instead of manual `Effect.scoped` + `app.run()`
  - Updated test utilities (`runTestCommand`) to not require `Scope.Scope`

- **@overeng/tui-react**: Automatic log capture for progressive-visual modes (breaking change)
  - `outputModeLayer()` now captures all Effect logs and `console.*` output in tty/ci/alt-screen modes
  - Captured logs accessible via `useCapturedLogs()` hook in React components
  - Prevents accidental log output from corrupting TUI terminal rendering
  - Console methods (`log`, `error`, `warn`, `info`, `debug`) are scoped and restored on cleanup
  - New `LogCapture.ts` module with `createLogCapture()`, `CapturedLogsProvider`, `useCapturedLogs()`
  - New example `06-log-capture/` demonstrating the feature
  - Updated spec.md with log capture documentation

- **@overeng/utils-dev**: New package with enhanced Vitest utilities for Effect-based testing
  - `makeWithTestCtx` / `withTestCtx` for automatic layer provisioning, OTEL integration, and timeouts
  - `asProp` for property-based testing with shrinking phase visibility
  - Migrated 22 test files across 7 packages to the new pattern

- **@overeng/genie**: GitHub Repository Ruleset generator (`githubRuleset`)
  - Type-safe configuration for GitHub Repository Rulesets via the REST API
  - Full support for all 22 rule types with comprehensive JSDoc documentation
  - Generates JSON config applied via `gh api repos/{owner}/{repo}/rulesets`
  - Added ruleset configuration for effect-utils protecting the main branch

### Changed

- **devenv/ts.nix**: Centralized Effect Language Service patching via `ts:patch-lsp` task
  - Removed per-package `postinstall: 'effect-language-service patch'` scripts from all 15 packages
  - Added `lspPatchCmd` parameter to `ts.nix` that creates a `ts:patch-lsp` task
  - Fixes consumer install failures for published packages (e.g. `@overeng/react-inspector`)
- Effect LSP patching now runs automatically before `ts:check`, `ts:build-watch`, `ts:build`

- **devenv/ts.nix**: Use package-local patched tsc binary for Effect Language Service diagnostics
  - Added `tscBin` parameter (default: `"tsc"`) to specify a patched TypeScript binary
  - Nix-provided tsc is unpatched and silently skips Effect plugin diagnostics
  - `ts:clean` uses Nix tsc (always available, doesn't need the patch)

- **@overeng/megarepo**, **@overeng/tui-react**: Migrated tests from async/await to `@effect/vitest`
  - All Effect-based tests now use `it.effect()` pattern instead of `async () => { await Effect.runPromise(...) }`
  - Provides better stack traces, fiber-aware timeouts, and cleaner Effect integration
  - See [#92](https://github.com/overengineeringstudio/effect-utils/issues/92)

- **@overeng/megarepo**: Simplified nix integration - removed workspace generator
  - Removed `mr generate nix` command and `.envrc.generated.megarepo` file
  - Removed `.direnv/megarepo-nix/workspace` mirror directory
  - Removed `MEGAREPO_ROOT_*`, `MEGAREPO_MEMBERS`, `MEGAREPO_NIX_WORKSPACE` env vars
  - Use `DEVENV_ROOT` (provided by devenv) instead of `MEGAREPO_ROOT_NEAREST`
  - Simplified `.envrc` to just `use devenv` (no generated file needed)

- **@overeng/megarepo**: Split `pnpmDepsHash` by platform to fix Linux/Darwin store divergence

- **@overeng/megarepo**: Nix lock sync is now auto-detected and uses top-level config
  - **Breaking**: Moved from `generators.nix.lockSync` to top-level `lockSync` config
  - Lock sync is now **auto-detected**: enabled if `devenv.lock` or `flake.lock` exists in megarepo root
  - No configuration needed for the common case; set `lockSync.enabled: false` to opt-out
  - Removed vestigial `NixGeneratorConfig` and `generators.nix` config options

- **nix/devenv-modules/tasks/shared/megarepo.nix**: Simplified megarepo tasks
  - Removed `megarepo:generate` task (no longer needed)
  - Simplified `megarepo:check` to just verify repos/ directory exists
  - Tasks no longer check for `.envrc.generated.megarepo` or workspace flake

### Fixed

- **@overeng/megarepo**: Configure fetch refspec when cloning bare repos (#111)
  - `git clone --bare` doesn't set `remote.origin.fetch`, breaking `git push --force-with-lease`
  - Now `cloneBare` configures `+refs/heads/*:refs/remotes/origin/*` after clone
  - Ensures remote tracking refs are created on fetch for proper git workflows

- **@overeng/tui-react**: Strengthen JSON schema typing in `TuiApp` unit tests
  - Replaced generic JSON parsing and `any` casts with schema-encoded helpers

- **@overeng/genie**: Fix YAML serializer producing empty output with matrix strategy
  - When GitHub Actions workflows use `${{ }}` expressions inside inline arrays (e.g., `runs-on: [${{ matrix.runner }}]`), oxfmt fails to parse the YAML
  - The `formatWithOxfmt` function now returns original content when oxfmt produces empty output
  - Closes [#108](https://github.com/overengineeringstudio/effect-utils/issues/108)

- **nix/devenv-modules/tasks/shared/test.nix**: Self-contained test tasks - each package uses its own vitest
  - Previously test tasks shared a vitest binary from `@overeng/utils`, violating self-contained packages requirements (R1-R5)
  - Now each package runs tests using `node_modules/.bin/vitest` from its own dependencies
  - Added `vitest.config.ts` to packages that were missing one: effect-path, effect-rpc-tanstack, genie, notion-cli, notion-effect-client, notion-effect-schema
  - Removed deprecated `vitestBin`, `vitestConfig`, and `vitestInstallTask` parameters from test module
  - This ensures packages are independently testable without cross-package dependencies

- **nix/devenv-modules/tasks/shared/nix-cli.nix**: Preflight lockfile/package.json fingerprint checks in `nix:check`
  - Prevents warmed Nix stores from masking stale hashes
  - Makes `nix:check` deterministic in CI vs local runs (R5)

- **nix/workspace-tools/lib/mk-pnpm-cli.nix**: Deterministic pnpm store tarball creation
  - Normalizes tar output (stable ordering + fixed timestamps)
  - Strips non-deterministic pnpm store `checkedAt` metadata
  - Prevents pnpm deps hash churn across CI runs
- **nix/workspace-tools/lib/mk-pnpm-cli.nix**: Force `supportedArchitectures` in Nix pnpm installs
  - Ensures pnpm store hashes remain stable across macOS/Linux (R5)
- **nix/workspace-tools/lib/mk-pnpm-cli.nix**: Generate pnpm store with recursive install
  - Aligns store generation scope with offline install (R6)
  - Prevents missing tarballs during `nix:check` for multi-package workspaces
- **nix/workspace-tools/lib/mk-pnpm-cli.nix**: Force dev dependencies during pnpm store generation
  - Avoids production-only installs that drop dev-only tarballs
  - Fixes `ERR_PNPM_NO_OFFLINE_TARBALL` in `nix build`/`nix:check`

### Removed

- **@overeng/mono**: Removed package entirely — all functionality is now covered by devenv tasks (`dt`). The package had zero consumers across all repos.

### Infrastructure

- **pnpm workspaces**: Hoist React-family packages in React-enabled workspaces to prevent duplicate React instances during local dev

- **nix/workspace-tools/lib/mk-pnpm-cli.nix**: Added `packageJsonDepsHash` parameter to fix build failures
  - `build.nix` files were passing `packageJsonDepsHash` but the function didn't accept it
  - Fixes `nix flake check` failures and downstream repo devenv shell issues
  - Renamed from `depsHash` to `packageJsonDepsHash` for clarity (breaking change)

- **nix/workspace-tools/lib/mk-bun-cli.nix**: Added `lockfileHash` and `packageJsonDepsHash` parameters for consistency
  - Both CLI builders now support the same fingerprint hash interface
  - Enables `nix:check:quick` to work uniformly across both build types

- **nix/devenv-modules/tasks/shared/nix-cli.nix**: Fixed missing task dependencies and improved error messages
  - `nix:check:*` tasks now depend on `pnpm:install` (full workspace)
  - Previously only depended on per-package install, causing failures when other packages had stale lockfiles
  - Added clear error messages for stale lockfiles with actionable fix instructions
  - Detects `ERR_PNPM_OUTDATED_LOCKFILE` and suggests `dt pnpm:update && dt nix:hash`

- **nix/devenv-modules/tasks/shared/pnpm.nix**: Added `pnpm:update` task
  - Runs `pnpm install --no-frozen-lockfile` in all packages to update lockfiles
  - Use when adding new dependencies that cause `ERR_PNPM_OUTDATED_LOCKFILE` errors
  - Now depends on `genie:run` so generated package.json files are up to date

- **nix/devenv-modules/tasks/shared/pnpm.nix**: Renamed `pnpm:clean-lock-files` to `pnpm:reset-lock-files`
  - Makes it clear this is a destructive, last-resort operation

- **nix/devenv-modules/tasks/shared/check.nix**: Updated check task semantics
  - `check:quick` - Fast development checks (genie, typecheck, lint, nix-fingerprint only)
  - `check:all` - Comprehensive validation including full `nix flake check`
  - `check:packages` - New task to validate allPackages matches filesystem

- **nix/devenv-modules/tasks/local/workspace-check.nix**: New local validation task
  - Validates that `allPackages` in devenv.nix matches actual filesystem packages
  - Prevents Nix build failures from unmanaged packages with stale lockfiles
  - Located in `local/` directory (effect-utils specific, not for reuse)

- **nix/devenv-modules/tasks**: Reorganized into `shared/` and `local/` directories
  - `shared/` - Reusable tasks meant for other repos via flake input
  - `local/` - Effect-utils specific tasks (not exported in flake.nix)
  - Added README.md documenting the organization

- **nix/devenv-modules/tasks/shared/check.nix**: Added `extraChecks` parameter
  - Allows repos to inject additional check tasks (e.g., `workspace:check`)
  - Maintains reusability while enabling local customization

- **devenv.nix**: Updated taskModules to use `shared/` directory paths
  - Fixed regression where local paths weren't updated after directory restructure

- **devenv.nix**: Added missing `packages/@overeng/tui-react` to `allPackages`

### Fixed

- **genie/internal**: Ensure `pnpmWorkspaceYaml` is locally imported so `pnpmWorkspaceReact` does not throw a ReferenceError

### Added

- **@overeng/effect-rpc-tanstack**: New package for Effect RPC integration with TanStack Start
  - `createRpcHandler` - Create server function handlers from Effect handlers
  - `createRpcHandlerWithLayer` - Handler with Effect Layer dependency injection
  - `wrapHandler` - Wrap handlers for proper error handling
  - `rpcValidator` - Schema validator for TanStack Start server functions
  - `RpcRequest/RpcResponse/RpcSuccess/RpcFailure/RpcDefect` - Protocol types
  - `RpcDefectError` - Client-side error type for unexpected server errors
  - Basic example with TanStack Start app and Playwright tests

### Changed

- **@overeng/utils**: Updated `effect-distributed-lock` to 0.0.11 and patched root exports to avoid loading optional `ioredis` (see https://github.com/ethanniser/effect-distributed-lock/issues/10)

- **@overeng/notion-effect-cli**: Migrated config from JSON to TypeScript (breaking change)
  - Config file is now `notion-schema-gen.config.ts` instead of `.notion-schema-gen.json`
  - Databases are now keyed by their Notion ID instead of an array
  - New `defineConfig` helper with full type checking and autocompletion
  - New typed `transforms` helpers (e.g., `transforms.status.asString`) instead of string literals
  - New `outputDir` option for base output directory (paths are relative to it)
  - Import config helpers from `@overeng/notion-effect-cli/config`
  - CLI now requires Bun runtime for native TypeScript config loading

- **@overeng/notion-effect-cli**: Adopted type-safe file paths from `@overeng/effect-path` (breaking change)
  - `DatabaseConfig.output` now requires `RelativeFilePath` - use `file()` helper
  - `SchemaGenConfig.outputDir` now requires `RelativeDirPath` - use `dir()` helper
  - Import `file` and `dir` helpers from `@overeng/notion-effect-cli/config`
  - Internal path operations now use `EffectPath.ops.*` instead of `node:path`
  - Removed `Path.Path` service dependency from Effect requirements

- **Monorepo CLI**: Replaced Biome with oxc toolchain (oxlint + oxfmt)
  - Removed `@biomejs/biome` dependency
  - `mono lint` now uses oxlint exclusively
  - `mono fmt [--check]` - Format code with oxfmt (Prettier-compatible, 30× faster)
  - `mono check` now includes format verification
  - Added shared oxlint/oxfmt configuration via `@overeng/oxc-config` package

- **@overeng/oxc-config**: New package for shared oxlint + oxfmt configuration
  - Base config with sensible defaults for TypeScript/Effect projects
  - Rules: `import/no-dynamic-require` (warn), `oxc/no-barrel-file` (warn, except `mod.ts`), `overeng/named-args` (warn), `import/no-commonjs` (error), `import/no-cycle` (warn), `func-style` (warn, prefer expressions/arrows)
  - Re-exports only allowed from `mod.ts` entry point files
  - Custom `overeng/named-args` rule enforces named arguments pattern (options objects), with automatic exemptions for callbacks, rest params, and Effect patterns

### Added

- **@overeng/utils**: Force revoke / lock stealing for file-system semaphore backing
  - `forceRevoke(options, key, holderId)` - Forcibly revoke a specific holder's permits
  - `forceRevokeAll(options, key)` - Revoke all holders for a semaphore key
  - `listHolders(options, key)` - List active holders with permit counts and expiry times
  - `HolderInfo` type for holder information
  - `HolderNotFoundError` for when target holder doesn't exist
  - See upstream feature request: https://github.com/ethanniser/effect-distributed-lock/issues/9

- **@overeng/notion-effect-schema**: New `PropertySchema` discriminated union for typed database property definitions
  - Full support for all 23 Notion property types using `Schema.TaggedStruct`
  - `SelectOptionConfig`, `StatusGroupConfig` for select/multi-select/status options
  - `NumberFormat`, `RollupFunction` enums
  - All property schemas exported individually (e.g., `SelectPropertySchema`, `RelationPropertySchema`)

- **@overeng/notion-effect-client**: New `SchemaHelpers` module for database schema introspection
  - `getProperties({ schema })` - Get all properties as typed `PropertySchema[]`
  - `getProperty({ schema, name })` - Get single property by name
  - `getPropertyByTag({ schema, name, tag })` - Get property filtered by type
  - `getSelectOptions({ schema, property })` - Get select property options
  - `getMultiSelectOptions({ schema, property })` - Get multi-select options
  - `getStatusOptions({ schema, property })` - Get status options
  - `getAnySelectOptions({ schema, property })` - Get options from any select-like property
  - `getRelationTarget({ schema, property })` - Get relation target database info
  - `getFormulaExpression({ schema, property })` - Get formula expression
  - `getNumberFormat({ schema, property })` - Get number format
  - `getRollupConfig({ schema, property })` - Get rollup configuration
  - `getUniqueIdPrefix({ schema, property })` - Get unique ID prefix

### Changed

- **@overeng/notion-effect-schema**: Renamed `Database` to `DatabaseSchema` for clarity (breaking change)
  - The type represents the schema/structure of a database, not the data itself

- **@overeng/notion-effect-cli**: Refactored introspect.ts to use new typed `PropertySchema` from schema package
  - Removed manual property type definitions in favor of shared schemas

- **@overeng/notion-effect-cli**: Generated schemas now include Effect Schema annotations
  - Schemas include `identifier` and `description` annotations for better debugging/tooling
  - Property fields with descriptions now have JSDoc comments instead of inline comments
  - Typed options (when `--typed-options` is used) also include `identifier` annotations

- Renamed **@overeng/notion-effect-schema-gen** to **@overeng/notion-effect-cli** to support more general-purpose CLI functionality
  - Binary name changed from `notion-effect-schema-gen` to `notion-effect-cli`
  - All commands remain the same: `generate`, `introspect`, `generate-config`, `diff`

### Added

- **@overeng/utils**: Workspace helpers (`CurrentWorkingDirectory`, `EffectUtilsWorkspace`) and command utilities (`cmd`, `cmdText`) with optional log capture/retention
- **Monorepo CLI**: Added `mono` CLI for streamlined development workflow
  - `mono build` - Build all packages
  - `mono test [--unit|--integration] [--watch]` - Run tests with filtering options
  - `mono lint [--fix]` - Check formatting and run oxlint
  - `mono ts [--watch] [--clean]` - TypeScript type checking
  - `mono clean` - Remove build artifacts
  - `mono check` - Run all checks (ts + fmt + lint + test)
  - Available directly in PATH via `scripts/bin/mono` wrapper
  - VSCode tasks.json for easy command palette integration
  - CI-aware output with GitHub Actions log grouping

- **@overeng/notion-effect-client**: Block helpers and Markdown converter improvements
  - `BlockHelpers` namespace with typed utilities for custom transformers:
    - `getRichText(block)` - Extract rich text content
    - `getCaption(block)` - Get media block captions
    - `getUrl(block)` - Get URL from image/video/file/embed/bookmark blocks
    - `isTodoChecked(block)` - Check to-do status
    - `getCodeLanguage(block)` - Get code block language
    - `getCalloutIcon(block)` - Get callout emoji
    - `getChildPageTitle(block)` / `getChildDatabaseTitle(block)` - Get titles
    - `getTableRowCells(block)` - Get table row cells
    - `getEquationExpression(block)` - Get equation expression
  - `BlockWithData` type for blocks with type-specific data
  - All helpers also exported as standalone functions
  - Rich Text utilities: `toPlainText`, `toMarkdown`, `toHtml` via `RichTextUtils`
  - Recursive block fetching: `NotionBlocks.retrieveAllNested` (flat stream), `NotionBlocks.retrieveAsTree` (tree)
  - Markdown converter: `NotionMarkdown.pageToMarkdown`, `NotionMarkdown.treeToMarkdown`, `NotionMarkdown.blocksToMarkdown`
  - Custom transformer support for all 27 block types

- **@overeng/react-inspector**: Added as git submodule for Effect Schema-aware data inspection
  - DevTools-style object/table/DOM inspectors for React
  - Enriched display of Effect Schema types with type names and custom formatting
  - Runs on port 9001 (separate from effect-schema-form-aria Storybook on 6006)
  - Maintains its own tooling (tsup, ESLint) - excluded from monorepo biome config

### Documentation

- **@overeng/notion-effect-cli**: Added comprehensive README with usage examples for CLI and programmatic API

### Added

- **@overeng/notion-effect-cli**: `diff` command for detecting schema drift
  - Compares current Notion database schema against an existing generated TypeScript file
  - Reports added properties (new in Notion), removed properties (no longer in Notion), and type changes
  - `--file` / `-f`: Path to existing generated schema file (required)
  - `--exit-code`: Exit with code 1 if differences found (useful for CI)
  - Parses generated schema files to extract property definitions
  - Displays formatted diff output with summary

- **@overeng/notion-effect-client**: Schema-aware typed queries and page retrieval
  - `TypedPage<T>` interface combining page metadata with decoded properties
  - `PageDecodeError` for schema decoding failures
  - `NotionDatabases.query()`: Now accepts optional `schema` parameter for typed results
  - `NotionDatabases.queryStream()`: Now accepts optional `schema` parameter for typed streaming
  - `NotionPages.retrieve()`: Now accepts optional `schema` parameter for typed retrieval
  - All methods return `TypedPage<T>` when schema is provided, with `id`, `createdTime`, `url`, `properties`, and `_raw` access

- **@overeng/notion-effect-cli**: Database API wrapper generation
  - `--include-api` / `-a` flag: Generate typed database API wrapper alongside schema
  - Generated API file includes:
    - `query()`: Stream-based query with auto-pagination
    - `queryAll()`: Collect all results
    - `get()`: Retrieve single page by ID
    - `create()`: Create page (when `--include-write` enabled)
    - `update()`: Update page (when `--include-write` enabled)
    - `archive()`: Archive page
  - Config file support: `includeApi` option in database and defaults config
  - API file written to `{output}.api.ts` (e.g., `tasks.ts` → `tasks.api.ts`)

### Fixed

- **@overeng/notion-effect-schema**: Fixed `BlockSchema` to preserve type-specific properties
  - Block objects now correctly retain their type-specific data (e.g., `block.paragraph`, `block.heading_1`)
  - Previously, decoding would strip these properties, breaking markdown conversion and block helpers
- **@overeng/notion-effect-client**: Removed yieldable-error `Effect.fail` usage and simplified search result literal schema
- **@overeng/notion-effect-cli**: Replaced global `Error` failures with tagged config/token errors

- **@overeng/notion-effect-cli**: Critical fixes to generated schema code
  - Fixed import references to use correct transform namespaces (e.g., `Title`, `Select`, `Num` instead of `TitleProperty`, `SelectProperty`, `NumberProperty`)
  - Fixed write schema generation to use nested Write APIs (e.g., `Title.Write.fromString` instead of `TitleWriteFromString`)
  - Generated schemas now correctly work with `@overeng/notion-effect-schema` package
  - Added integration tests verifying generated schemas decode/encode properly with actual Notion API data structures
  - Added runtime validation helpers to generated code:
    - Read helpers: `decode{Name}Properties`, `decode{Name}PropertiesEffect`
    - Write helpers: `decode{Name}Write`, `decode{Name}WriteEffect`, `encode{Name}Write`, `encode{Name}WriteEffect`

### Changed

- Renamed all packages from `@schickling` scope to `@overeng` scope
- TypeScript builds now emit ESM JavaScript to `dist/` with source maps and declaration maps.
- Property "read" transforms are now decode-only; write payloads are modeled separately via `*Write` schemas / transforms.
- Notion HTTP client retry behavior:
  - Treats request-body JSON encoding failures as typed `NotionApiError` (instead of defects).
  - Respects `retry-after` on 429 responses when retrying.
- Updated dependencies to latest versions (effect ^3.19.13, @effect/platform ^0.94.0)
- Moved all dependencies to pnpm catalog for centralized version management
- Updated pnpm catalog versions (Effect 3.19.14, @effect/platform 0.94.1, TypeScript 5.9.3, Vite 7.3.0, Vitest 3.2.4, Tailwind 4.1.18) and added @effect/rpc for peer compatibility

### Added

- **@overeng/effect-react**: React integration for Effect runtime
  - `makeReactAppLayer` for layer-based app initialization with React
  - `useServiceContext` hook for accessing Effect services from React components
  - `LoadingState` context for tracking app initialization progress
  - `ServiceContext` utilities for running effects with a provided runtime
  - React hooks: `useAsyncEffectUnsafe`, `useInterval`, `useStateRefWithReactiveInput`
  - `cuid` and `slug` utilities for generating unique IDs

- **@overeng/effect-schema-form**: Headless form component for Effect Schemas
  - Schema introspection utilities (`analyzeSchema`, `getStructProperties`, `analyzeTaggedStruct`)
  - Field type detection: string, number, boolean, literal, struct, unknown
  - Context + hooks API pattern for custom rendering
  - `SchemaFormProvider` for design system integration
  - `useSchemaForm` hook for building custom form UIs
  - Support for optional fields, tagged structs, and literal unions
  - `formatLiteralLabel` utility for human-readable label formatting

- **@overeng/effect-schema-form-aria**: Styled React Aria implementation
  - Pre-configured `AriaSchemaForm` component with accessible UI
  - `ariaRenderers` object for use with `SchemaFormProvider`
  - Individual styled components: `TextField`, `NumberField`, `BooleanField`, `LiteralField`
  - `FieldGroup` and `FieldWrapper` layout components
  - Tailwind CSS styling with design token support
  - Automatic segmented control/select switching for literal fields

- **@overeng/notion-effect-cli**: Full CLI implementation for schema generation
  - `generate` subcommand: Introspects a Notion database and generates Effect schemas
    - `--output` / `-o`: Output file path for generated schema
    - `--name` / `-n`: Custom name for the generated schema (defaults to database title)
    - `--token` / `-t`: Notion API token (defaults to NOTION_API_TOKEN env var)
    - `--transform`: Per-property transform configuration (e.g., `Status=raw`)
    - `--dry-run` / `-d`: Preview generated code without writing to file
    - `--include-write` / `-w`: Include Write schemas for creating/updating pages
    - `--typed-options`: Generate typed literal unions for select/status options
  - `introspect` subcommand: Displays database schema information
  - `generate-config` subcommand: Generates schemas for all databases from config
  - Config file support (`.notion-schema-gen.json`) for multi-database projects
  - Configurable property transforms per type (raw, asString, asOption, asNumber, etc.)
  - Support for all 21 Notion property types with sensible defaults
  - Improved PascalCase handling that preserves existing casing
  - Auto-formatting with Biome when available
  - Uses Effect FileSystem and Path for file operations
  - Generated code includes proper Effect Schema imports and type exports
  - Deterministic code generation (no timestamps); header includes generator version
  - Comprehensive unit tests for code generation functionality

- **@overeng/notion-effect-schema**: Core Notion object schemas
  - `Database`, `Page`, `Block` with full field definitions
  - Parent types: `DatabaseParent`, `PageParent`, `BlockParent`
  - File objects: `ExternalFile`, `NotionFile`, `FileObject`
  - Icon types: `EmojiIcon`, `CustomEmojiIcon`, `Icon`
  - Block type enum covering all 27 Notion block types
  - `DataSource` for database data sources

- **@overeng/notion-effect-schema**: Comprehensive Effect schemas
  - Foundation schemas: `NotionUUID`, `ISO8601DateTime`, `NotionColor`, `SelectColor`
  - Rich text support: `RichText`, `TextAnnotations`, `MentionRichText`, `EquationRichText`
  - User schemas: `Person`, `Bot`, `PartialUser`, `User` union
  - Property schemas with:
    - decode transforms (e.g. `Title.asString`, `Num.asNumber`, `Select.asStringRequired`)
    - write payload schemas/transforms for page create/update (e.g. `TitleWrite`, `SelectWrite`, `PeopleWrite`)
  - Custom `docsPath` annotation linking each schema to official Notion API docs
  - Proper Effect `Option` handling for nullable/optional fields

- **@overeng/notion-effect-client**: Comprehensive test suite with real API integration
  - Unit tests for internal HTTP utilities
    - `parseRateLimitHeaders`, `buildRequest`, `get`, `post` functions
    - `NotionApiError.isRetryable` logic
    - Pagination utilities: `paginationParams`, `toPaginatedResult`, `paginatedStream`
  - Integration tests for service modules (skipped when no token)
    - Databases: `retrieve`, `query`, `queryStream` with filters and pagination
    - Pages: `retrieve`, `create`, `update`, `archive`
    - Blocks: `retrieve`, `retrieveChildren`, `retrieveChildrenStream`, `append`, `update`, `delete`
    - Users: `me`, `list`, `listStream`, `retrieve`
    - Search: `search`, `searchStream` with filters and sorting
  - `describe.skipIf` pattern for graceful skipping when no API token
  - Separate `test:unit` and `test:integration` npm scripts

## [0.1.0] - 2025-08-03

Initial release of effect-notion monorepo.

### Added

- **@overeng/notion-effect-schema**: Effect schemas for the Notion HTTP API
- **@overeng/notion-effect-client**: Effect-native HTTP client for the Notion API
- **@overeng/notion-effect-cli**: CLI tool for schema generation

### Infrastructure

- Initial monorepo setup with pnpm workspaces
- TypeScript configuration with project references
- Modern ESM-first package structure
