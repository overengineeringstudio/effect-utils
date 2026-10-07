# @overeng Effect Utils

A collection of production-ready [Effect](https://effect.website) utilities and integrations.

## Packages

### Notion Integration

Full-featured Effect-native Notion API client with type-safe schema generation.

#### [@overeng/notion-effect-client](./packages/@overeng/notion-effect-client)

Effect-native HTTP client for the Notion API with typed queries

- **Schema-aware queries** - Pass Effect schemas to get fully typed results with automatic decoding
- **Markdown conversion** - Convert pages/blocks to Markdown with customizable transformers
- **Streaming API** - Auto-pagination via Effect Streams for all list operations

#### [@overeng/notion-effect-schema](./packages/@overeng/notion-effect-schema)

Comprehensive Effect schemas for all Notion API types

- **Complete coverage** - Schemas for all 27 block types and 21+ property types
- **Property transforms** - `asString`, `asNumber`, `asOption` variants for ergonomic access
- **Write support** - Dedicated write schemas for creating/updating pages

#### [@overeng/notion-effect-cli](./packages/@overeng/notion-effect-cli)

CLI tool to generate type-safe schemas from your Notion databases

- **Schema generation** - Generate typed schemas from live Notion databases
- **Drift detection** - Track schema changes with `diff` command for CI/CD
- **API wrapper generation** - Generate typed CRUD operations with `--include-api`

### AI Integration

| Package                                                                   | Description                       |
| ------------------------------------------------------------------------- | --------------------------------- |
| [@overeng/effect-ai-claude-cli](./packages/@overeng/effect-ai-claude-cli) | Claude CLI provider for Effect AI |

Use your **Claude Code subscription** instead of paying for API calls. Implements Effect AI's LanguageModel interface by delegating to the `claude` CLI.

- **Subscription-based** - Use your existing Claude Code subscription (much cheaper than API)
- **No API keys** - CLI handles authentication via your subscription
- **Full LanguageModel support** - Works with `@effect/ai` Chat, generateText, etc.

### Schema Forms

Headless form library for Effect Schemas with accessible React Aria implementation.

| Package                                                                         | Description                                                                                                          |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [@overeng/effect-schema-form](./packages/@overeng/effect-schema-form)           | Headless form component with schema introspection                                                                    |
| [@overeng/effect-schema-form-aria](./packages/@overeng/effect-schema-form-aria) | Styled React Aria components with Tailwind CSS ([Storybook](https://overeng-effect-utils-schema-form-ar.vercel.app)) |

- **Schema introspection** - Automatically generate form fields from Effect Schema structure
- **Headless architecture** - Bring your own components or use pre-built React Aria implementation
- **Tagged struct support** - Automatic handling of discriminated unions with labeled groups
- **Flexible rendering** - Provider pattern, render props, or hooks API for full control
- **Accessible by default** - React Aria Components with WCAG compliance

### React Integration

React hooks and utilities for building Effect-powered applications.

| Package                                                         | Description                                                                                                                |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [@overeng/effect-react](./packages/@overeng/effect-react)       | React integration for Effect runtime with hooks and context providers                                                      |
| [@overeng/react-inspector](./packages/@overeng/react-inspector) | DevTools-style inspectors with Effect Schema support ([Storybook](https://overeng-effect-utils-react-inspecto.vercel.app)) |

- **EffectProvider** - Initialize Effect runtime from a Layer and provide to React tree
- **Hooks API** - `useEffectRunner`, `useEffectCallback`, `useEffectOnMount` for running effects in components
- **Automatic error handling** - Built-in error boundaries with custom error components
- **DevTools inspectors** - Browser-style object/table inspectors with Effect Schema awareness
- **Type-safe runtime access** - Direct access to Effect runtime for advanced use cases

### Document Outlines

[`@overeng/outline`](./packages/@overeng/outline) provides theme-free outline models and accessible
React Aria navigation. Import `@overeng/outline/model` for DOM-independent hierarchy normalization,
active-section selection, and fixed-pitch preview geometry.

Callers own stable section IDs, ordered measurements, the reading edge, and scrolling. An
`OutlineScrollAdapter` connects those measurements to `getActiveSection`; `useOutlineRail` owns hover,
focus retention, the keyboard opener, and Escape focus return. Render `OutlineLink` with a navigation
callback or native section hrefs. Pass the active ID from actual scroll position, not the last click.
The package supplies no theme, document discovery, domain extraction, or virtualization.

Run `devenv tasks run test:outline` for the focused behavioral suite. Its scoped
`buck2:editor:publish:outline` prerequisite publishes the package's Buck-owned dependency view
without materializing unrelated package editor views.

### Browser Telemetry

`@overeng/otel-browser` provides scoped Effect tracing and OTLP/HTTP traces and metrics for browser
applications. Compose `BrowserTelemetry.layer({ identity, environment: 'dev', endpoint: '/otlp' })`
with `BrowserPlatform.layerWindow`, using a validated `ServiceIdentity` from `@overeng/otel-contract`.
Set `endpoint: undefined` for the bounded, in-memory span ring without network export. The endpoint must be
same-origin; the application server owns collector relay.

Optional `Interactions.layer`, `LongFrames.layer`, and `WebVitals.layer` record browser performance
without coupling telemetry to a UI framework. Scoped listeners and observers are removed at shutdown.
The transport uses beacon/keepalive on page hide and drops offline exports rather than retaining
an unbounded queue. `@overeng/otel-browser/vite` supplies `otlpDevProxy()` for development and preview;
it reads `OTEL_EXPORTER_OTLP_ENDPOINT` and strips application cookies before collector forwarding.

DOM-free W3C propagation lives in `@overeng/otel-contract/Traceparent`: `decode`/`encode` validate
version-00 context, while `headers`, `wsUrl`, and `withField` carry the current span over HTTP,
WebSocket upgrade URLs, and messages. Server consumers use `fromUrl` and `fromField`.

The public browser adapters and imperative telemetry methods use named arguments, for example
`telemetry.recordSpan({ name: 'browser.render', startMs: 10, endMs: 25 })` and
`Traceparent.wsUrl({ url: new URL('/stream', location.href) })`. UI histograms are defined through
schema-first `OtelMetric` contracts, preserving their exported metric identities and bucket policies.

### Playwright Integration

| Package                                                     | Description                                             |
| ----------------------------------------------------------- | ------------------------------------------------------- |
| [@overeng/utils/node/playwright](./packages/@overeng/utils) | Effect-native Playwright wrappers with OTEL integration |

- **Service tags** - `PwPage`, `PwBrowserContext` for dependency injection
- **Structured errors** - All operations wrapped with `PwOpError` for consistent error handling
- **OTEL spans** - Automatic tracing with cross-process trace propagation
- **Test helpers** - `withTestCtx` for automatic layer provision in Playwright tests

### Utilities

| Package                                     | Description                                          |
| ------------------------------------------- | ---------------------------------------------------- |
| [@overeng/utils](./packages/@overeng/utils) | Distributed locks, log bridging, and debug utilities |

Key features:

- SharedWorker→Tab log bridging via BroadcastChannel (`@overeng/utils/browser`)
- Scope/finalizer debugging and active handles monitoring
- File system-backed distributed locks with TTL expiration
- Workspace-aware command helpers with optional logging/retention

### Developer Tools

| Package                                               | Description                            |
| ----------------------------------------------------- | -------------------------------------- |
| [@overeng/genie](./packages/@overeng/genie)           | TypeScript-based config file generator |
| [@overeng/oxc-config](./packages/@overeng/oxc-config) | Shared oxlint and oxfmt configuration  |

**Genie** generates `package.json`, `tsconfig.json`, and GitHub workflow files from TypeScript sources (`.genie.ts` files). Features include:

- **Type-safe config** - Define configs as TypeScript with full autocomplete
- **Consistent formatting** - Auto-formats via oxfmt
- **Read-only protection** - Generated files are read-only by default
- **CI integration** - `--check` mode verifies files are up to date

## Quick Start

### Enter the dev shell

This repo uses `devenv` to provide a consistent toolchain. Run commands inside the shell:

```bash
devenv shell
```

### Publish Dependency Views

```bash
devenv tasks run buck2:editor:publish
```

### Check All TypeScript Projects

```bash
devenv tasks run buck2:quick
```

Publish Buck-produced declarations to package `dist` directories when source-side
tools or editors need them:

```bash
devenv tasks run buck2:typescript:materialize-dist
```

### Run Tests

```bash
# All tests
devenv tasks run test:run

# Single package (e.g., utils, genie)
devenv tasks run test:utils
devenv tasks run test:genie

# Integration tests (requires NOTION_API_TOKEN for Notion packages)
NOTION_API_TOKEN=secret_xxx devenv tasks run test:integration

# Watch mode
devenv tasks run test:watch
```

### Type Checking

Buck is the only repository-wide TypeScript check authority:

```bash
devenv tasks run buck2:quick
```

Audit cross-cell Buck provider identity separately:

```bash
devenv tasks run buck2:providers:check
```

### Consumer Buck Roots

Consumer dependency generators declare the cell that exports patches from each
nested checkout instead of loading that checkout's standalone `BUCK` files:

```ts
renderPnpmPackageTargets({
  metadata,
  sidecar,
  patchSourceCells: { 'repos/effect-utils': 'rules' },
})
```

The `buck2-rules` package exports the shared pnpm patch registry in its `rules`
cell. Unmapped patch paths retain same-cell labels; mappings match complete path
components, and the most specific checkout root wins.

Frozen source dependencies use an exact workspace-path-to-target mapping rather
than resolving a label beneath an ignored runtime directory:

```ts
makePnpmStoreProjection({
  metadata,
  sidecar,
  workspaceTreeTargets: {
    '.devenv/pnpm-source-inputs/current/repos/sdk/client':
      'pnpm_sources//:sdk_client_package_tree',
  },
})
```

The consumer owns that declared package tree and its cell. It must expose the
frozen package bytes named by the lockfile, not a mutable checkout with the same
path suffix. A source cell rooted at `.devenv/pnpm-source-inputs` can keep its
generated `BUCK` outside the immutable `current` generation and assemble sources
with `empty_package_view` (or `package_view` for packages with dependencies).
The consumer's Nix source closure must supply the same cell, package bytes, and
target declarations. The root continues to ignore `.devenv` wholesale. Unmapped
workspace packages retain their conventional same-cell `:package_tree` labels;
mapped labels participate in the projection fingerprint.

Put the effect-utils flake's pinned `packages.<system>.buck2` on `PATH` (or use
its `bin/buck2` as `BUCK2_BIN`). Direct commands, agents and devenv tasks then
share the same cache posture preflight; no separate task or probe command is
required:

```bash
buck2 build //your/package:target
```

Shell activation and Buck task preparation publish the realized Nix capabilities
into a stable real `.buck2/capabilities` cell. Publication is process-locked,
installs immutable generation metadata first, and atomically replaces the
watched `defs.bzl` last. Ordinary capability changes reach already-running
daemons without a restart. The one-time cell-root symlink migration uses atomic
exchange, then explicitly runs `buck2 kill` for this worktree's registered
isolation directories: the symlink-to-directory transition changes native watch
topology and requires a fresh daemon. The publisher logs each stop; a persistent
migration marker makes a failed or interrupted stop retryable.
Preparation diagnostics go to stderr, preserving command stdout when callers
capture Buck output paths. The daemon regression starts and shuts down its own
private Watchman service; it does not depend on a host service on Linux or macOS.

Retained generations have indirect Nix GC roots under `.buck2/capability-roots`.
The publisher keeps the three most recently published generations only when
Buck's state files show no live worktree daemon in any isolation directory.
Live or uncertain daemon state retains all generations; the next daemon-free
publication restores the bound. This protects even idle daemons with cached old
generation references. See the [capability publication contract](context/builds/04-buck2/02-platforms-toolchains/spec.md#capability-publication).

Tracked `[buck2] file_watcher = watchman` also opts into watcher admission, even
without remote-cache configuration. The packaged entrypoint queries the actual
Watchman service with a 900 ms deadline before native daemon startup; service
results are cached for at most five seconds and scoped to PATH, HOME and socket
environment identity. Darwin queries use `--no-spawn`, preserving the managed
service lifecycle. A healthy service selects Watchman in a separately managed
`.buckconfig.local` block. An unavailable service emits a warning on each launch
and selects Buck's original `notify` provider without caching that launch.
This fallback preserves availability, not Watchman's output-tree pruning:
populated worktrees can still encounter the original notify startup stall.

Explicit unmanaged local watcher choices take precedence and remove stale
managed watcher settings without disturbing the independent cache overlay.
In particular, immutable Nix source products select `fs_hash_crawler`: they have
no interactive edit loop, and Watchman's state-directory initialization is not
permitted in the Nix sandbox. Mutable worktrees retain Watchman to avoid hashing
the source tree on each command. After changing providers, stop only your own
daemon with `buck2 --isolation-dir <your-isolation> kill` in that project.
Watchman output exclusions are defined by `.watchmanconfig`; Buck's separate
`[project] ignore` settings alone do not prune notify's initial registrations.

RE client settings belong in `.buckconfig`, not invocation overrides. Pinned
Buck ignores `[buck2_re_client]` values supplied by `--config` or `--config-file`.
The entrypoint applies writer credentials/endpoints to the managed
`.buckconfig.local` block before daemon startup. After changing client endpoints
or credentials, stop the existing daemon with `buck2 kill` in the same project
and isolation directory; changing config does not rebuild an existing RE client.

The checkout and `mkConsumerBuckRoot` set
`buck2_re_client.max_total_batch_size = 3145728` (3 MiB of blob payload).
Pinned Buck2 counts payload bytes, not protobuf framing or per-blob digests,
when batching uploads. The lower threshold leaves transport headroom under
bazel-remote's 4 MiB gRPC receive limit; larger individual blobs use ByteStream
with the same bounded chunk size. A server capability value of
`max_batch_total_size_bytes = 0` does not remove its gRPC message limit.

The entrypoint reads the tracked private archive origin from
`archive_origin.trusted_url_prefix` and `archive_origin.trusted_tier`, including
roots generated by `mkConsumerBuckRoot`. Public read-only jobs set
`BUCK2_PUBLIC_CACHE_READ_ONLY=1`; protected public publishers provide
`BUCK2_CACHE_WRITE_BASIC_AUTH`. A private host resolves its own
`BUCK2_PRIVATE_CACHE_WRITE_AUTH=username:password` credential and declares
`BUCK2_PRIVATE_CACHE_ADDRESS=grpc://<private-host>:<port>`. The pinned entrypoint
converts raw host credentials into `BUCK2_PRIVATE_CACHE_WRITE_BASIC_AUTH`;
credentials never enter config files. Do not use a publisher credential as a
host credential.

Configured REAPI roots without archive-origin metadata use the same admission;
an omitted `remote_cache_enabled` follows the execution policy's enabled default.

`BUCK2_NO_REMOTE_CACHE=1` disables reads and uploads, and public read-only posture
wins over either writer credential. The entrypoint probes REAPI capabilities and
the archive origin concurrently with a 900 ms deadline, caches endpoint outcomes
for five seconds in the user's cache directory, and emits a warning on every
fail-open invocation. An unavailable read-only REAPI endpoint selects local
execution; an unavailable archive origin selects the registry while retaining a
reachable REAPI session. Writers still fail closed on REAPI outages. Outage
overrides are invocation-local and do not change tracked configuration.

Identical healthy read-only invocations reuse a shell fast path within the
remaining probe lifetime, avoiding JavaScript startup in warm loops. Its cache
key includes config contents, command arguments, working directory and exported
environment; writers, config includes and external mode files bypass it.

The probe is an admission snapshot: an endpoint that disappears after a
successful probe (including during its five-second cache lifetime) can still
fail inside native Buck. Native Buck has no configurable RE connection retry
limit or startup local-fallback switch at this pinned revision.

Only audited rules requesting the
`cache_hermetic` execution constraint may reuse/upload; the default platform
denies both even when root policy allows writes. The complete lane inventory and
current sandbox limits are in the [execution spec](context/builds/04-buck2/05-execution/spec.md#audited-action-inventory).
Do not put credentials in tracked configuration.

### Nix Artifact Import Checks

Validate the generic and JavaScript Buck product import boundaries without
realizing repository products:

```bash
devenv tasks run nix:buck2-artifact-import:check
devenv tasks run nix:javascript-product-import:check
```

CLI packaging uses Buck products and the validated Nix import boundary described
in [workspace tools](./nix/workspace-tools/README.md). Live pnpm workspaces share
install policy and source-input algebra; Buck products use immutable dependency
archives.

Fixed-source Nix products use `NIX_BUILD_CORES` for Buck execution (`build -j`),
Tokio workers (`build --config build.num_tokio_workers`), and daemon blocking
threads (`BUCK2_MAX_BLOCKING_THREADS`). An unset or zero Nix budget becomes one,
not the host CPU count. Configuration overrides follow the `build` subcommand;
only the isolation-directory flag is global.

`check:all` also evaluates every flake output for the host system without
building anything:

```bash
devenv tasks run nix:flake:eval
```

### Linting

```bash
# Check formatting + lint
devenv tasks run lint:check

# Auto-fix formatting + lint issues
devenv tasks run lint:fix
```

## Package Structure

Each package follows modern ESM conventions:

- Source files in `src/` (TypeScript with `.ts` extension)
- Entry point at `src/mod.ts`
- Compiled output in `dist/` (gitignored)
- Development exports point to source files
- Published exports point to compiled JavaScript

## Contributing

This monorepo uses:

- **bun workspaces** for package management
- **TypeScript project references** for incremental builds
- **oxlint + oxfmt** for linting and formatting
- **Vitest** for testing
- **Effect** for core functionality

See individual package READMEs for package-specific documentation.
