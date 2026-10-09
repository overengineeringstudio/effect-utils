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
`buck2:editor:publish:test:outline` prerequisite publishes the package's Buck-owned dependency view
plus the root and OpenTelemetry bootstrap views, without materializing unrelated package views.

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

### Peer-to-peer QUIC (prototype)

[`@overeng/effect-iroh`](./packages/@overeng/effect-iroh) wraps the official
[`@number0/iroh`](https://docs.iroh.computer/languages/javascript) Node N-API
bindings in Effect 4. This is a working, private prototype, not a published
production package or a replacement for host networking policy.

```ts
import { Effect, Stream } from 'effect'
import { IrohEndpoint } from '@overeng/effect-iroh'

const program = Effect.gen(function* () {
  const endpoint = yield* IrohEndpoint
  const connection = yield* endpoint.connect(peerAddress, 'my-protocol/1')
  // Check connection.remoteId against application policy before processing data.
  const bi = yield* connection.openBi
  const protocol = bi.messages(MyVersionedSchema)
  yield* Stream.make(message).pipe(Stream.run(protocol.write))
  return yield* Stream.runCollect(protocol.read)
})

// The Layer owns bind/close; connection and stream acquisition require Scope.
// `peerAddress`, `MyVersionedSchema`, and `message` belong to the caller's protocol.
const run = Effect.scoped(program).pipe(
  Effect.provide(IrohEndpoint.layer({ alpns: ['my-protocol/1'] })),
)
```

`IrohEndpoint.make(options)` permits multiple independent endpoints in one Scope.
`accept` is a scoped Effect returning a connection, or `undefined` after endpoint
closure. Connections expose `openBi`, `acceptBi`, `remoteId`, negotiated `alpn`,
and observed `paths`. Bidirectional streams expose byte Streams/Sinks, explicit
`close`, and `messages(schema)` Streams/Sinks. Choose one reader and one writer
per stream half; do not mix the raw and framed interfaces on the same half.
Sinks send FIN after successful upstream completion. Frames are a four-byte
big-endian length followed by Schema JSON encoded as UTF-8; the default limit
is 1 MiB. The [echo example](./packages/@overeng/effect-iroh/src/echo.ts) uses an
explicit `apiVersion: 1` envelope and exchanges two Unicode-capable messages.
Failures are Schema-tagged `IrohInitError`, `IrohTransportError`, and
`IrohProtocolError`.

The official promises do not expose cancellation handles. Interruption therefore
closes the owning **connection** for stream operations, or the **endpoint** for
accept/connect/online, and awaits native settlement. Cancelling an accept ends
that endpoint's accept loop; cancelling a read also ends sibling streams on that
connection. This explicit, conservative behavior avoids abandoning Rust futures,
but should become per-operation cancellation before broad adoption.

#### Binding choice and versions

The latest npm binding is `@number0/iroh@1.1.0`; its upstream lock pins the older
iroh 1.0.2. The prototype also provides a
[hash-pinned source build recipe](./packages/@overeng/effect-iroh/native/build-native.sh)
and a committed Cargo lock rebuilding the official bindings against
[`iroh@1.3.0`](https://docs.rs/iroh/1.3.0/iroh/), without maintaining a second Rust
adapter. The recipe pins upstream commit
`3103bf5295be6d50c5272ff7a426e9b539f3f587` and compiles with `nice -n19 -j4`.
Pass the resulting absolute `.node` path as `nativeLibraryPath`; the default
uses the published npm binary, not the rebuilt 1.3.0 core. Do not set
`NAPI_RS_NATIVE_LIBRARY_PATH` globally: it also overrides unrelated N-API modules
such as Vitest's rolldown binding. The npm 1.1.0 manifest's `main` points to an
absent `iroh-js/index.js`; this package explicitly loads its actual
`@number0/iroh/index.js` entry.

- **Handwritten napi-rs:** possible, but duplicates the officially maintained
  endpoint/connection/stream bindings and their platform work.
- **Our Effect/Rust interop:** retains value for new application-specific Rust
  engines and cancellation-aware jobs. Its resource macros currently support
  synchronous resource methods, not iroh's async handle graph, and a generated
  adapter would need a new Rust wrapper. We do not add that work to this prototype.
- **Wasm:** [iroh supports browsers](https://docs.iroh.computer/languages/wasm-browser),
  but ordinary browser connections are relay-only because the sandbox has no UDP,
  and there is no official browser npm package. Native FFI preserves hole punching
  for desktop/server Node and Bun; no misleading isomorphic export is advertised.

#### Reproduction and observed evidence

Inside an environment with Cargo/Rust >=1.91 and a C linker:

```bash
bash packages/@overeng/effect-iroh/native/build-native.sh
cd packages/@overeng/effect-iroh
CI=1 IROH_NATIVE_LIBRARY_PATH="$PWD/native/.build/iroh.node" \
  node ../../../node_modules/vitest/vitest.mjs run --config vitest.config.ts
```

On 2026-10-09, the latest-core build completed in 108.95 s. Node 24.20.0,
Effect/@effect-vitest 4.0.0 and Vitest 5.0.3 passed three real native tests in
663 ms: schema roundtrip, scoped Layer/cancelled accept, and oversized-frame
rejection before reading its payload. A separate Node direct-IP run measured
26.06 ms binding, 11.18 ms connection, 8.59 ms message exchange, 47.61 ms total.
A Bun 1.4.2 run with the n0 preset and no supplied direct-address hints measured
3106.14 ms binding/online, 50.39 ms connection, 43.22 ms exchange, 3203.60 ms total.
Its initial selected path was the public `euc1-1.relay.n0.iroh.link` relay;
the final selected path was a local direct-IP path. These are two endpoints on
one host, not evidence of cross-host internet hole punching or a throughput
benchmark.

Before shipping: admit the rebuilt native product through Buck and Nix instead
of this development recipe; fix/confirm upstream npm entrypoints; test the
Linux/macOS/Windows matrix (official JS prebuilds do not include Intel macOS);
expand Bun lifecycle/cancellation coverage; add per-operation native cancellation
and bounded-buffer APIs (upstream currently converts byte arrays through
`number[]`); and define application authorization/identity persistence separately
from authenticated transport. No fleet ACL or operational cutover is included.

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

The aggregate starts `test:buck2:unit` after `genie:check`, independently of
editor dependency publication. It first prebuilds every declared Vitest collection
product from `buck2-test-authority.json`, then executes the bounded lanes in the
existing single Buck test invocation. The prebuild performs no source tests and
does not cache source reports or coverage verdicts.

After the source suites and bounded verdicts finish, `test:run` still invokes
the baseline-collection gate. That gate resolves the identical collection targets
with the same local-only host-platform Buck build, so current inputs are checked
even when the products are warm. It then validates the complete filesystem census,
each bounded selection's exact inventory, source-task ownership and baseline counts.
Prebuilding changes scheduling only: missing or malformed products, coverage drift,
failed bounded execution and missing source evidence still fail the aggregate.

### Type Checking

Buck is the only repository-wide TypeScript check authority:

```bash
devenv tasks run buck2:quick
```

The shared compiler options require `erasableSyntaxOnly`, so package and fixture
typechecks reject TypeScript constructs requiring runtime transformation, such
as parameter properties, enums, and runtime namespaces, before merge-group
consumer tests. Source exports can therefore use Node's strip-only mode without
TypeScript lowering; unrelated runtime requirements and JSX transforms still apply.

Audit cross-cell Buck provider identity separately:

```bash
devenv tasks run buck2:providers:check
```

### Consumer Buck Roots

`mkConsumerBuckRoot` accepts the named `watcherPolicy` argument. Its default,
`"mutable-checkout"`, emits `file_watcher = watchman` and retains fail-closed
Watchman admission for interactive source edits. Roots copied into immutable
Nix builds or filtered, immutable source checks must instead pass:

```nix
watcherPolicy = "immutable-input";
```

This emits `file_watcher = fs_hash_crawler`: declared inputs do not change
during the build, so no Watchman executable or service is required. The
from-source builder uses the same policy mapping. Unknown policies fail Nix
evaluation with a message listing both allowed values; raw watcher-provider
strings are not accepted.

TypeScript package projections retain census destinations below nested Buck packages,
but resolve each input through its nearest owning `BUCK` (or `BUCK.genie.ts` during
generation). For example, `src/main.ts` below `parent/src/BUCK` is staged from
`//parent/src:main.ts`; only locally owned sources are exported by the parent.
Each nested package must publish the explicit inputs the parent consumes with
`export_materialization_inputs`, including test modules, snapshots and fixture data.
Its target names escape `$` as `__dollar__`, while staged destinations stay unchanged.
This file-level contract preserves source-granular dependencies instead of introducing
a second, nested-tree materialization interface. Project and runner configuration
remain package-root files; declared `projectInputs` may reference nested files.

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
    '.devenv/pnpm-source-inputs/current/repos/sdk/client': 'pnpm_sources//:sdk_client_package_tree',
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
private Watchman service, using a fixture-only global config that permits nice 19;
it does not depend on a host service on Linux or macOS.

The publisher fixture retains assertion failures before cleanup under
`${XDG_STATE_HOME:-$HOME/.local/state}/buck2-cache-reports/capability-publisher/`
and prints the private evidence directory. Each capture keeps at most five
snapshots: the new capture and the four newest prior evidence directories.
It contains the failed generation observation, copied generation metadata and
publisher JSONs, shell job IDs/PIDs/states without command text, and native PID
ancestry without command arguments or environment.
`CAPABILITY_TEST_EVIDENCE_DIR` overrides the destination for focused proofs.
Copies are best-effort observations while writers may still run, not an atomic
snapshot or a Nix closure archive; collection errors are recorded explicitly.

Retained generations have indirect Nix GC roots under `.buck2/capability-roots`.
The publisher keeps the three most recently published generations only when
Buck's state files show no live worktree daemon in any isolation directory.
Live or uncertain daemon state retains all generations; the next daemon-free
publication restores the bound. This protects even idle daemons with cached old
generation references. See the [capability publication contract](context/builds/04-buck2/02-platforms-toolchains/spec.md#capability-publication).

Tracked `[buck2] file_watcher = watchman` also opts into watcher admission, even
without remote-cache configuration. The packaged entrypoint admits the actual
Watchman service and canonical watched root with `watchman --no-local
watch-project <root>` before native daemon startup. An attempt has a 2500 ms
deadline and one retry for a timeout only. Successful root admission is cached
for at most five seconds, scoped to the root, `.watchmanconfig`, PATH, HOME and
socket environment identity. Un-niced default-service queries allow Watchman
to spawn on demand on Linux and Darwin, including job-local CI runners. Niced
clients use `--no-spawn`: they may connect to an existing service, but never
create a permanently niced shared daemon. Only a proven-missing default
service (the silent no-spawn client plus an absent computed socket) or
Watchman's own startup refusal is diagnosed as a priority problem: start the
service un-niced with `watchman get-sockname` outside the gate or provision
the host service, and never relax the shared startup priority limit. Other
niced failures keep their genuine executable or service diagnosis; admission
never falls back to notify.
An explicit `WATCHMAN_SOCK` also uses `--no-spawn` on every platform: admission
must reach that owned service, not create a replacement. Missing, unhealthy or incorrectly
rooted Watchman fails with the probe command and remediation; it never selects notify as an
outage fallback. For an ancestor-root mismatch, run `watchman watch <root>` and
rerun the displayed probe. Enter `devenv shell` if Watchman is missing from PATH.

Explicit unmanaged local watcher choices take precedence and remove stale
managed watcher settings without disturbing the independent cache overlay.
In particular, immutable Nix source products select `fs_hash_crawler`: they have
no interactive edit loop, and Watchman's state-directory initialization is not
permitted in the Nix sandbox. Mutable worktrees retain Watchman to avoid hashing
the source tree on each command. Watchman-configured worktrees automatically
transition the selected daemon isolation after successful admission: a missing
provider marker or a changed provider stops only that worktree's registered
daemon with the native `--isolation-dir <selected> kill` command before startup.
The per-root/isolation marker and crash-released lock live outside Buck's
daemon directory in `~/.buck/file-watcher-admission-v1/`; native startup cleans
the daemon directory, not these markers. Matching markers prevent repeated stops,
and other worktrees and isolations are never stopped. Failed stops prevent
startup and do not record successful migration. Maintenance `kill`, `status`,
and `log` commands bypass Watchman admission so diagnosis and shutdown remain
available during an outage.
The existing explicit local `[buck2] file_watcher = notify` choice is retained
for deliberate non-agent use, but is unsafe for agent builds: completed source
writes can race notify's unsynchronized callback buffer and produce stale
copied inputs. Agent workflows require a healthy, correctly rooted Watchman
service instead. No new notify opt-in environment variable is introduced.
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

Local `builtins.getFlake` calls use `git+file://` references so Nix copies only
Git-tracked sources, not ignored build outputs or development state. The shared
test runner sets `NIX_FLAKE_REF` to that same Git reference.
`devenv tasks run lint:check:getflake` checks this contract with negative fixtures;
it also runs through `nix:check:quick` and `check:quick`. For a standalone check
without shell evaluation, run `node --test scripts/lint-getflake.unit.test.mjs`
and `node scripts/lint-getflake.mjs`.

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
