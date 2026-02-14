# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed

- **devenv/otel-span**: Consolidate `otel-span` and `otel-emit-span` into single CLI with subcommands
  - `otel-span run <service> <span-name> [opts] -- <cmd>` replaces bare `otel-span <service> ...`
  - `otel-span emit` replaces `otel-emit-span` (reads OTLP JSON from stdin)
  - Breaking: subcommand is now required

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
    - `--token` / `-t`: Notion API token (defaults to NOTION_TOKEN env var)
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
