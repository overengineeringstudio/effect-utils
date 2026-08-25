# Alignment Register

## schema-date

- **Difference:** v4 `Schema.Date` validates Date instances, while v3 `Schema.Date`
  represented ISO-string wire encoding.
- **Proposed decision:** Treat this as no intended behaviour change. Migrate v3
  `Schema.Date` wire sites to `Schema.DateFromString` on effect `4.0.0-beta.102`.
- **Blast radius:** Date wire codecs and custom transforms in session ingestion,
  Notion property codecs, and path/schema helpers.
- **Status:** proven for accepted ISO input and encoded wire string on beta.102;
  the earlier beta.99 `Schema.isDateValid` mapping is stale because the check is
  no longer exported and `Schema.Date` now rejects invalid Date instances.

## schema-date-invalid-message

- **Difference:** Invalid Date/null parse messages differ. v3 emits parse tree
  text; v4 emits `SchemaError(...)` text.
- **Proposed decision:** Do not treat this as a globally accepted difference.
  Accept only for internal structural failure checks. For user-facing or
  snapshotted boundaries, add an explicit formatter/normalizer or preserve the
  old text before flipping.
- **Blast radius:** schema decode errors and tests that assert exact parse
  messages.
- **Audit evidence:** Repo grep found no snapshots containing the specific v3
  Date parse-tree text or v4 `SchemaError(...)` text. A focused multiline grep
  across `notion-effect-schema`, `notion-datasource-sync`, `notion-cli`, and
  `tui-react` found snapshots of generated code, canonical JSON, renderer output,
  and store/event projections, but none of schema parse-error text. Structural
  decode-failure tests in `notion-effect-schema` and `notion-property-write`
  assert failure shape only. User-facing/stringified-error boundaries do exist:
  `notion-cli` TUI `SetError` paths stringify errors, `notion-datasource-sync`
  JSON error envelopes and manifest namespace diagnostics stringify failures,
  `tui-react` renders tagged/stringified errors, and `restate-effect` formats
  `ParseError` via `ParseResult.TreeFormatter`.
- **Status:** allowlisted only as a harness classification in
  `patterns/schema-date/scenario.json`; migration acceptance requires auditing
  the user-facing boundaries above.

## cli-A-nested-terminator-loss

- **Bucket:** A — V4 BUG, RESOLVED FIXED UPSTREAM.
- **Difference:** under a nested command, v4 beta.99 and beta.102 drop all argv after `--`. A
  required child positional supplied after the terminator becomes missing; an already-satisfied
  child silently loses its trailing operands.
- **Measured Effect 3 baseline:** `mr add` delivers the first token after `--` byte-for-byte to
  its positional handler, including dash-prefixed values and values matching parent or child flag
  names. It does not unconditionally accept every trailing token: because `add` declares one
  positional, multiple tokens preserve order only until that arity is exhausted, then the second
  token is rejected as an unknown argument. Bare `mr add --` remains the distinct missing-argument
  case.
- **Source confirmation:** the lexer preserves trailing operands
  (`effect/src/unstable/cli/internal/lexer.ts:24-40`), but parser recursion constructs the child
  input with `trailingOperands: []` (`internal/parser.ts:87`) and attaches the originals to the
  parent parse record (`internal/parser.ts:97`).
- **Decision:** RESOLVED: fixed upstream in beta.103 via PR #6692 (issue #6690 closed); verified
  against the pinned rc.111 — nested terminators deliver trailing operands byte-for-byte.
- **Blast radius:** was dash-prefixed positional values in nested commands (`megarepo`
  add/exec/pin/store, Notion database/schema commands, TUI story render/inspect). No longer
  gated; any allowlist traces gating on this entry should be removed.
- **Status:** RESOLVED-FIXED-UPSTREAM (beta.103, PR #6692).

## cli-B-accepted-grammar-improvements

- **Bucket:** B — INTENDED V4 IMPROVEMENT WE ACCEPT.
- **Differences accepted:** reject separated negative domain integers; accept clustered short
  aliases; accept `--flag=value` for repeated flags; strictly reject unknown flags after a
  variadic positional.
- **Decision:** accept these grammar changes. Current integer options model counts, delays, widths,
  timestamps, concurrency, limits, and PR numbers. No tracked effect-utils command uses variadic
  positional `Args`, so the strict-unknown variadic case has no current production consumer.
- **Blast radius:** negative integer invocations in `npm-release`, `ci-tools`, `tui-stories`,
  Notion/TUI helpers; newly valid alias clusters in `megarepo`, `notion-cli`, and `tui-stories`;
  newly valid equals-form repeated flags in `ci-tools` and `tui-stories`.
- **Status:** ACCEPTED for migration planning; 17 exact trace paths document the new grammar.

## cli-C-rendering-and-stdout-breakage

- **Bucket:** C — REAL BREAKAGE WE MUST PRESERVE OR SHIM.
- **Difference:** v4 changes root/nested help, version bytes, validation wording, ANSI, newline
  count, and stdout/stderr placement. Validation failures print full help to stdout where v3
  stdout was empty.
- **Decision:** RESOLVED by the locked full-rebaseline decision: accept the v4 help, version,
  and validation rendering; no compatibility rendering or shims. Validation help on stdout is
  accepted for all audited binaries as part of that rebaseline.
- **Blast radius:** all audited binaries: `megarepo`, `notion-cli`, `genie`, `ci-tools`,
  `npm-release`, and `tui-stories`. `notion-cli` already preserves root version bytes via its own
  fast path; the other five delegate version rendering to Effect CLI.
- **Status:** RESOLVED-REBASELINED at rc.111. The 13 exact output paths formerly gated on
  beta.102 bytes are no longer open compatibility work: every audited binary's
  `cli.contract.test.ts` snapshot suite was regenerated against v4 (ci-tools in commit
  `01f823c8b`; megarepo `abd4fae2b`, genie `97280e2a5`, npm-release/tui-stories `45d7f1324`,
  with tui-stories/notion-cli normalization in `c727ecc64`). No output path remains gated on
  v3 bytes.

## platform-error-wrapper

- **Difference:** FileSystem ENOENT, EEXIST, and EACCES failures change outer `_tag` from v3
  `SystemError` to v4 `PlatformError`.
- **Proposed decision:** Accept the v4 wrapper and rewrite error handling to match the wrapper then
  inspect its reason. Preserve the inner reason tag, module, and method; the probe shows those
  fields remain identical for all three errors.
- **Blast radius:** process/filesystem error branches in `agent-session-ingest`, `megarepo`,
  `restate-effect`, `ci-tools`, `effect-path`, `utils`, and their tests.
- **Status:** allowlisted at exactly three outer-tag paths; all successful Path/read/write/stat
  observations and inner error fields are identical.

## http-client-status-error-wrapper

- **Difference:** `HttpClientResponse.filterStatusOk` changes a rejected 418 from v3
  `ResponseError` / `reason: "StatusCode"` to v4 `HttpClientError` /
  `reason._tag: "StatusCodeError"`.
- **Proposed decision:** Accept the v4 wrapper and rewrite every response-error handler to inspect
  the wrapped reason. Preserve the status and body behavior; the 200 status/body and rejected 418
  status are identical in the local-server probe.
- **Blast radius:** HTTP retry, telemetry, and response classification branches using
  `catchTag("ResponseError")` or string reason checks.
- **Status:** two error-shape paths allowlisted; success behavior and numeric status are identical.

## fork-defaults

- **Difference:** No default startup-order difference was observed for v3
  `Effect.fork` vs v4 `Effect.forkChild`.
- **Proposed decision:** Migrate default child forks mechanically without adding
  `{ startImmediately: true, uninterruptible: "inherit" }`.
- **Blast radius:** background workers, RPC/websocket helpers, process wrappers,
  Playwright helpers, and tests that rely on startup order.
- **Status:** default case proven identical.

## fork-copied-options

- **Difference:** Copying `{ startImmediately: true }` to v4 moves `child-start`
  before the parent records `after-fork`.
- **Proposed decision:** Treat blanket copied options as a behaviour change and
  remove them unless the call site explicitly wants immediate startup.
- **Blast radius:** any migrated fork where a worker copied options to preserve
  imagined v3 behaviour.
- **Status:** allowlisted as a negative-control diff in
  `patterns/fork-defaults/scenario.json`.

## equality-structural-default

- **Difference:** v4 structurally compares plain objects, arrays, maps, sets,
  dates, and regexps; v3 used reference equality for these values.
- **Proposed decision:** Accept structural equality as the v4 default, but audit
  dedup/cache/change-detection code for identity-sensitive sites.
- **Blast radius:** Effect `HashSet`/`HashMap`, `Equal.equals`, cache keys, and
  any custom collection membership checks.
- **Status:** allowlisted in `patterns/equality/scenario.json`.

## equality-nan

- **Difference:** v4 treats `NaN` as equal to `NaN`; v3 did not.
- **Proposed decision:** Accept unless a numeric cache or validation path used
  `NaN` inequality as a sentinel.
- **Blast radius:** numeric dedup, cache invalidation, and schema/property tests
  with `NaN` sentinels.
- **Status:** allowlisted in `patterns/equality/scenario.json`.

## equality-by-reference-opt-out

- **Difference:** v4 adds `Equal.byReference` as an explicit identity-equality
  opt-out, returning a Proxy rather than the original object.
- **Proposed decision:** Use only where identity equality is load-bearing; prefer
  `byReference` for safety and `byReferenceUnsafe` only when the proxy identity
  cost is unacceptable and object mutation is controlled.
- **Blast radius:** identity-sensitive caches and sets.
- **Status:** documented in `patterns/equality/RECIPE.md`.

## layer-memoization-default

- **Difference:** v3 rebuilt the same layer twice across separate
  `Effect.provide` calls; v4 memoizes across those provides and builds once.
- **Proposed decision:** Accept v4 shared memoization for application wiring, but
  audit tests/resource factories for call sites where fresh construction is
  observable.
- **Blast radius:** test layers, scoped resources, process/RPC clients, caches,
  and service factories.
- **Status:** allowlisted in `patterns/layer-memoization/scenario.json`.

## layer-memoization-freshness-opt-outs

- **Difference:** v4 adds `{ local: true }`; `Layer.fresh` remains the portable
  freshness escape hatch.
- **Proposed decision:** Use `Layer.fresh` for a local layer that must rebuild;
  use `{ local: true }` when an entire provided layer subtree needs its own memo
  map.
- **Blast radius:** test harnesses and per-request/per-run resources.
- **Status:** `Layer.fresh` matches v3 count; `{ local: true }` documented as
  v4-only.

## rpc-failure-cause-wire-shape

- **Difference:** v3 RPC failure envelopes encode Cause as a recursive object;
  v4 encodes the flattened Cause reasons array. A tagged failure therefore
  changes bytes from `{"cause":{"_tag":"Fail",...}}` to
  `{"cause":[{"_tag":"Fail",...}]}`.
- **Proposed decision:** Accept the v4 envelope only for atomically upgraded
  internal peers. Require an explicit protocol version or compatibility adapter
  anywhere peers can run different majors or envelopes are persisted.
- **Blast radius:** every RPC error response, including unary exits and streaming
  exits.
- **Status:** allowlisted in `patterns/rpc-payload-codecs/scenario.json`;
  payload bytes and decoded handler values are otherwise identical.

## browser-testing-barrel

- **Difference:** a static re-export from v4 `effect/testing` reaches
  `node:assert`; the representative v3 runtime/testing facade remained
  browser-bundleable.
- **Proposed decision:** Remove testing exports from public runtime/browser
  facades and use direct `effect/testing/*` imports in test files.
- **Blast radius:** all browser-facing packages and any shared Effect facade.
- **Status:** allowlisted characterization in
  `patterns/browser-builtin-leakage/scenario.json`; the runtime-only facade
  passes the Node-builtin-forbidden bundle gate on both majors.

## effect-never-idle-timer

- **Difference:** v3 `Effect.never` registers one long interval; v4 parks the
  fiber without a timer.
- **Proposed decision:** Accept the v4 runtime improvement. Do not recreate the
  timer; use the platform main runner or a real owned resource when a process
  must stay alive.
- **Blast radius:** long-lived PTY, Restate, and agent-ingestion processes plus
  idle/hibernating runtimes.
- **Status:** allowlisted in `patterns/effect-never-idle/scenario.json`.

## filesystem-watch-recursive-option-removed

- **Bucket:** C — REAL BREAKAGE WE MUST PRESERVE OR SHIM.
- **Difference:** v3 `FileSystem.watch(path, { recursive: false })` observes only direct children.
  In beta.102 the option is removed from both `FileSystem.watch` and `WatchBackend.register`, and
  the shared Node implementation calls `node:fs.watch` with `{ recursive: true }`
  unconditionally. The Bun FileSystem layer delegates to that implementation.
- **Decision:** RESOLVED UPSTREAM at rc.111: recursive control is restored — `WatchOptions.recursive`
  is opt-in again and the Node backend defaults it to false. No compatibility shim is required;
  migration decides per call site whether to opt into recursion.
- **Blast radius:** `megarepo` and `genie` watch modes. Unexpected nested events can trigger
  spurious rebuilds or watch loops and present as timing flakiness rather than a clear migration
  failure.
- **Status:** OPEN DESIGN WORK; the beta.102 "REQUIRED COMPATIBILITY WORK" framing is retired.
  At rc.111 the forced-recursion premise no longer holds: `WatchOptions.recursive` is opt-in
  again (`effect/src/FileSystem.ts:1171-1176`) and the Node backend defaults it to false
  (`@effect/platform-node-shared/src/NodeFileSystem.ts:557-558`), so call sites pass
  `{ recursive: true }` explicitly where recursion is wanted. What remains open is applying the
  design study in `watch-recursion-experiments.md`: megarepo has no watch usage; genie should
  embrace recursion (fixes latent nested-genie-file blindness) with a 250ms coalescing window;
  notion-md keeps an exact-path filter for single-file watch and collapses batch watch to one
  recursive common-root watch; a shared `watchScoped` helper for @overeng/utils is proposed only
  after both migrations land. Historical characterization record: allowlisted at the one stable
  nested-path membership trace path; raw event ordering was deliberately not gated (five
  same-major runs produced four unique v3 and three unique v4 traces); draft upstream report in
  `recipes/filesystem-watch-ordering.md`.

## prompt-pty-ansi-rendering

- **Bucket:** C — REAL BYTE DIFFERENCE REQUIRING OWNER REVIEW.
- **Difference:** under a real PTY, beta.102 `Prompt.select` emits shorter ANSI SGR/reset sequences.
  The selection transcript changes from 452 to 356 bytes and the Ctrl-C transcript from 136 to
  104 bytes.
- **Decision:** do not blanket-rebaseline. Preserve exact bytes for raw-terminal parsers and
  snapshots; a package may accept the v4 rendering only after its PTY, inline-renderer, cleanup,
  and visual contracts pass.
- **Blast radius:** `tui-react`, `pty-effect`, and any CLI snapshot or terminal parser built on
  Effect Prompt.
- **Status:** two exact transcript paths allowlisted. Raw-mode lifecycle, key and Escape decoding,
  resize 80x24 -> 101x37, selected value, Quit behavior, bell, cursor restoration, and cleanup are
  identical across five same-major repetitions.
