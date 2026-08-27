<!-- Findings authored by the verification pass; transcribed here because the verifier role
     is not permitted to author under context/. Content is verbatim below the summary. -->

# Alignment register — adversarial verification

An independent pass attacked every entry in `alignment-register.md`, trying to **refute** each
"accepted difference" by finding a real call site where the v3/v4 difference is observable at a
user-facing, durable, or cross-process boundary.

An allowlist entry claims a difference does not matter. Several entries carried caveats —
_"allow only where callers do not snapshot the parser message"_, _"accept only for atomically
upgraded internal peers"_ — that had never been checked against this repository. This pass
checked them.

**Result: 10 UPHELD, 2 REFUTED-PARTIAL.**

## Must reclassify before migration starts

| entry                          | why it is not an accepted difference                                                               |
| ------------------------------ | -------------------------------------------------------------------------------------------------- |
| `rpc-failure-cause-wire-shape` | browser/server HTTP protocol, independent deploys, no version field; **both** cross-decodes reject |
| `schema-date-invalid-message`  | parser text embedded verbatim in an HTTP 400 payload, making it an API surface                     |

---

Adversarial verification of every entry in `alignment-register.md`. `UPHELD`
means the repository search found no user-facing, durable, or cross-process
counterexample. It does not waive the migration tests named below.

## schema-date

**Verdict:** UPHELD

**Search performed:** `rg -n 'Schema\.Date\b|Schema\.DateFromString|DateFromSelf|DateTimeUtc' packages`;
read every non-story `Schema.Date` site and the Restate serde round-trip tests.

**Evidence:** `packages/@overeng/restate-effect/src/schema/Serde.test.ts:22-35`
asserts that the v3 `Schema.Date` decoded `Date` encodes to the exact ISO wire
string and round-trips. The property test at
`packages/@overeng/restate-effect/src/schema/Serde.test.ts:118-129` exercises
the same transformed schema through the generic durable serde. Production
Notion value schemas already use decoded-date schemas such as
`packages/@overeng/notion-effect-schema/src/properties/date.ts:142-151`.

No accepted-input or encoded-byte counterexample was found. Keep the proposed
`Schema.DateFromString.check(Schema.isDateValid())` mapping and the exact-byte
Restate serde test.

## schema-date-invalid-message

**Verdict:** REFUTED-PARTIAL

**Search performed:** Searched the four named snapshot suites for
`toMatchSnapshot`, `toMatchInlineSnapshot`, `ParseError`, `SchemaError`,
`TreeFormatter`, and `SetError`; searched production schema decoders followed
by `String(error)`, `.message`, JSON error output, or terminal transport.

**Evidence:** None of the named snapshots captures Date parser text:
`packages/@overeng/notion-effect-schema/src/properties/descriptor.unit.test.ts:98-122`
asserts only failure shape; the snapshots in
`packages/@overeng/notion-cli/src/codegen.unit.test.ts:142-981` are generated
code; and `packages/@overeng/tui-react/test/unit/exit-rendering.test.tsx:119-653`
captures renderer output for explicitly constructed errors.

The caveat is nevertheless observable. Restate's generic serde governs handler
input/output, state, durable step results, awakeables, and durable promises
(`packages/@overeng/restate-effect/src/schema/Serde.ts:9-25`). For an ingress
decode failure it embeds `ParseResult.TreeFormatter.formatErrorSync` verbatim
in a caller-facing `TerminalError(400)`
(`packages/@overeng/restate-effect/src/schema/Serde.ts:126-144`). That serde is
installed on public ingress calls and handler inputs
(`packages/@overeng/restate-effect/src/clients/InvocationPolicy.ts:107-126`,
`packages/@overeng/restate-effect/src/endpoint/Endpoint.ts:267`). A contract
using the supported transformed Date schema therefore exposes the changed
parser text over HTTP even though no repository snapshot currently pins it.

Before migration, the HTTP 400 message contains Effect 3's parse-tree rendering
after the stable prefix `serde decode failed: `. After migration the same
invalid bytes produce Effect 4's `SchemaError(...)` rendering after that prefix.
Status and classification stay 400, but the response message payload changes;
clients, logs, support tooling, or assertions that display/store it observe the
difference.

**If refuted:** This is a user-facing wire error-message change. Define a stable
Restate decode-error envelope/formatter owned by `restate-effect` (stable code,
schema identifier/path, and migration-independent summary) rather than sending
Effect's parser rendering. Add an ingress test with invalid Date input that
asserts the stable HTTP error body on both majors. Internal corrupt-journal
defects may retain framework diagnostics because they are not caller contracts.

## fork-defaults

**Verdict:** UPHELD

**Search performed:** `rg -n 'Effect\.fork\b|Effect\.forkScoped|Effect\.forkDaemon'`
over `tui-react`, `notion-md`, `restate-effect`, `utils`, `pty-effect`, and
`agent-session-ingest`; read every production hit where ordering could matter.

**Evidence:** The strongest ordering-sensitive site deliberately forks the URL
wait before executing the navigation action
(`packages/@overeng/utils/src/node/playwright/page.ts:216-235`). TUI input tests
explicitly `yieldNow` before injecting input
(`packages/@overeng/tui-react/test/unit/terminal-input.test.ts:42-56`).
Production watch loops fork producers and then block on their queue
(`packages/@overeng/notion-md/src/cli-program.ts:348-378`,
`packages/@overeng/notion-md/src/batch.ts:460-519`). None asserts or exposes a
parent/child trace ordering beyond the default case proven equal by the
prototype.

## fork-copied-options

**Verdict:** UPHELD

**Search performed:** The fork search above plus searches for
`startImmediately`, `uninterruptible`, and fork option objects in all packages.

**Evidence:** No current call site supplies either copied option. The
ordering-sensitive Playwright helper at
`packages/@overeng/utils/src/node/playwright/page.ts:216-235` is a concrete
reason not to introduce an unreviewed scheduling change.

The entry is correctly a negative control: migrate defaults mechanically and
require a call-site-specific behavioral test before adding immediate startup.

## equality-structural-default

**Verdict:** UPHELD

**Search performed:** `rg -n '\b(Equal|HashSet|HashMap|MutableHashMap|MutableHashSet)\b' packages`;
then searched `dedupe`, `distinct`, `cacheKey`, `memo`, and membership sites,
distinguishing native JavaScript `Map`/`Set` from Effect collections.

**Evidence:** No package uses `Equal.equals`, `HashSet`, or object-keyed Effect
`HashMap`. The only production Effect `HashMap` values are logger annotations:
`packages/@overeng/utils/src/browser/BroadcastLogger.ts:76-188`,
`packages/@overeng/utils/src/node/FileLogger.ts:9-232`, and
`packages/@overeng/utils/src/node/cmd.ts:516`; their keys are log annotation
strings, not identity-sensitive domain objects. The many Notion
dedup/membership sites use native key strings and native `Set`/`Map`, whose
semantics do not change with Effect 4.

No real site relying on reference inequality was found.

## equality-nan

**Verdict:** UPHELD

**Search performed:** `rg -n '\bNaN\b|Number\.isNaN|isNaN\(' packages`, then
cross-checked all results against the Effect equality/collection search.

**Evidence:** No `NaN` reaches Effect equality or an Effect collection. The
browser number field uses `NaN` only as a React Aria empty-value sentinel and
immediately converts it back to `undefined`
(`packages/@overeng/effect-schema-form-aria/src/components/NumberField.tsx:97-98`).
Other production sites branch with `Number.isNaN`; Restate's durable property
tests explicitly restrict JSON numbers to `Schema.Finite`
(`packages/@overeng/restate-effect/src/schema/Serde.test.ts:131-145`).

## equality-by-reference-opt-out

**Verdict:** UPHELD

**Search performed:** Same Effect equality/collection inventory as the two
preceding entries, plus `byReference` / `byReferenceUnsafe`.

**Evidence:** No current identity-sensitive Effect collection site and no
current opt-out call were found. There is therefore no justified migration
site for either API. Keep this entry as a narrowly scoped escape hatch; do not
apply it speculatively.

## layer-memoization-default

**Verdict:** UPHELD

**Search performed:** Searched all packages for `Effect.provide`, `Layer.effect`,
`Layer.scoped`, `Layer.unwrap*`, `Layer.fresh`, and `acquireRelease`; inspected
stateful file logger, browser logger, Notion gateway, Restate endpoint, test
layers, and repeated layer identifiers. Also ran a sibling-provide probe because
`genie` provides one lock layer to two sequential effects: both v3 and v4 built
twice; the prototype difference requires duplicate nested provides.

**Evidence:** Observable resources exist, for example the acquired file
descriptor in `packages/@overeng/utils/src/node/FileLogger.ts:55-75`, the
`BroadcastChannel` in
`packages/@overeng/utils/src/browser/BroadcastLogger.ts:210-222`, and the
throttled Notion client in
`packages/@overeng/notion-datasource-sync/src/gateway/notion.ts:1589-1615`.
No production/test call wraps the same required service in two nested
`Effect.provide` calls with the same stateful layer. Sequential sibling provides
such as `packages/@overeng/genie/src/core/generation.ts:740-760` do not exhibit
the v4 sharing behavior.

No fresh-construction boundary matching the prototype's changed topology was
found.

## layer-memoization-freshness-opt-outs

**Verdict:** UPHELD

**Search performed:** Same layer inventory as above, specifically searching
`Layer.fresh`, `{ local: true }`, resource factories, and per-test/per-request
layers.

**Evidence:** No current `Layer.fresh`/local-memo call and no duplicate nested
provide requiring one was found. The existing tests generally construct a new
fake layer per test or provide one layer once around the test effect. Apply an
opt-out only if a migrated call site first demonstrates the v4 construction
count differs.

## rpc-failure-cause-wire-shape

**Verdict:** REFUTED-PARTIAL

**Search performed:** Searched all source for `@effect/rpc`, `RpcClient`,
`RpcServer`, `Schema.Exit`, `cause`, serde/persistence, and replay. Read the
Effect RPC HTTP client/server and TanStack SSR exit paths. Inspected beta.99
`RpcMessage`, `RpcClient`, and serialization source for a protocol version.
Ran the prototype plus direct cross-decodes of each encoded failure through the
opposite major's exit schema.

**Evidence:** Restate is not affected by this particular envelope. Its durable
boundary schema-encodes application values directly to JSON
(`packages/@overeng/restate-effect/src/schema/Serde.ts:9-13,80-103`), and its
error transport uses a separate tagged-error JSON body
(`packages/@overeng/restate-effect/src/error/error-transport.test.ts:34-75`).
No `@effect/rpc` import exists in `restate-effect`, `pty-effect`, or
`agent-session-ingest`.

The actual cross-process counterexample is `effect-rpc-tanstack`. Its public
client accepts an arbitrary URL and constructs an HTTP RPC protocol
(`packages/@overeng/effect-rpc-tanstack/src/client.ts:14-30,49-79`); its server
constructs the matching web handler
(`packages/@overeng/effect-rpc-tanstack/src/server.ts:75-100`). The browser and
server can be deployed independently, and cached browser JS makes atomic
upgrade unenforceable. The package also has a second server-to-browser Cause
boundary: route loaders encode `Schema.Exit` for SSR and browser code decodes
it (`packages/@overeng/effect-rpc-tanstack/src/router.ts:15-41,222-235`).

Beta.99's encoded request/response types have no version or negotiation field
(`effect@4.0.0-beta.99/src/unstable/rpc/RpcMessage.ts:60-69,256-286`). Direct
cross-decode results were symmetric: v3 rejected the v4 cause array and v4
rejected the v3 cause object (`SchemaError(Expected array, got {...})`).
Therefore neither an unadapted server-first nor client-first rollout preserves
failure handling.

**Resolution:** Keep `effect-rpc-tanstack` single-current-format rather than
adding a protocol marker, legacy response encoder, or dual decoder. The
object-vs-array difference remains mechanically detectable, but a client-only
shim cannot repair already-loaded v3 clients, and permanent server negotiation
would move every consumer's finite deployment transition into the library.
Each independently deployed consumer instead owns a same-contract
browser/server upgrade, an explicit cache horizon and already-open-tab policy,
and deployed verification of both the HTTP RPC and SSR `ExitEncoded`
boundaries. Mixed-major failure decoding remains unsupported; a site is not
called migrated until those consumer-owned live checks pass (#979).

`effect-rpc-tanstack` may stay in Wave 0 only when Wave 0 means
repository-graph independence. It is independently mergeable; deployment
completion is determined per consumer site.

## browser-testing-barrel

**Verdict:** UPHELD

**Search performed:** Ran
`rg -n --glob '*.{ts,tsx,mts,cts}' 'effect/testing|node:assert|from .*(test|Test)|export \* from|export \{.*\} from'`
over `effect-react`, `notion-react`, `tui-react`, `react-inspector`,
`effect-schema-form`, `effect-schema-form-aria`, and `utils`. Then read every
`exportEntry(..., { environment: 'browser' })` in those packages' generated
sources and recursively followed its source barrel imports/re-exports. This
would have found a direct Effect testing import, a local test-helper re-export,
or a transitive Node-builtin import from any browser facade. A repository-wide
`rg -n 'effect/testing' packages` was the final backstop.

**Evidence:** No browser entry imports or re-exports Effect's testing barrel.
The browser exports are explicitly identified in the package generators:
`packages/@overeng/effect-react/package.json.genie.ts:45-47`,
`packages/@overeng/notion-react/package.json.genie.ts:57-69`,
`packages/@overeng/react-inspector/package.json.genie.ts:75-76`,
`packages/@overeng/effect-schema-form/package.json.genie.ts:28-29`,
`packages/@overeng/effect-schema-form-aria/package.json.genie.ts:48-49`, and
`packages/@overeng/utils/package.json.genie.ts:61-80`.

`tui-react` does re-export its own test helpers from the main barrel
(`packages/@overeng/tui-react/src/mod.tsx:233-256`), but that export is
explicitly Node-only (`packages/@overeng/tui-react/package.json.genie.ts:79-83`)
and the helper imports normal `effect`, not `effect/testing`
(`packages/@overeng/tui-react/src/effect/testing.tsx:22-35`). It is cleanup
debt under the proposed facade rule, not a browser `node:assert` contamination.

## effect-never-idle-timer

**Verdict:** UPHELD

**Search performed:** Searched `pty-effect`, `restate-effect`,
`agent-session-ingest`, `tui-react`, `notion-md`, and
`notion-datasource-sync` for `Effect.never`, `runFork`, `runPromise`, and
`NodeRuntime.runMain`; read every production `Effect.never` hit and long-lived
entry point.

**Evidence:** There is no production `Effect.never` use in the named long-lived
packages. The hits are test-only suspension controls, e.g.
`packages/@overeng/tui-react/test/unit/exit-rendering.test.tsx:399-409` and
`packages/@overeng/notion-datasource-sync/src/e2e/daemon.e2e.test.ts:2048-2076`.
Long-lived CLIs use the platform runner
(`packages/@overeng/notion-md/src/cli.ts:34-54`,
`packages/@overeng/notion-datasource-sync/src/cli/main.ts:3227-3312`), and the
Restate endpoint is a launched scoped server layer
(`packages/@overeng/restate-effect/src/endpoint/Endpoint.ts:849-876`).

No process currently relies on `Effect.never`'s incidental v3 timer handle.

## Summary

| Entry                                  | Verdict         | Boundary found                                        |
| -------------------------------------- | --------------- | ----------------------------------------------------- |
| `schema-date`                          | UPHELD          | Exact ISO durable bytes preserved by proposed mapping |
| `schema-date-invalid-message`          | REFUTED-PARTIAL | Restate caller-facing HTTP error text                 |
| `fork-defaults`                        | UPHELD          | None                                                  |
| `fork-copied-options`                  | UPHELD          | None; negative control remains valid                  |
| `equality-structural-default`          | UPHELD          | None                                                  |
| `equality-nan`                         | UPHELD          | None                                                  |
| `equality-by-reference-opt-out`        | UPHELD          | None                                                  |
| `layer-memoization-default`            | UPHELD          | None matching duplicate nested provide                |
| `layer-memoization-freshness-opt-outs` | UPHELD          | No justified opt-out site                             |
| `rpc-failure-cause-wire-shape`         | REFUTED-PARTIAL | HTTP RPC and SSR browser/server protocol              |
| `browser-testing-barrel`               | UPHELD          | No browser testing-barrel contamination               |
| `effect-never-idle-timer`              | UPHELD          | None                                                  |

## Entries that must be reclassified before migration starts

- `rpc-failure-cause-wire-shape` — from accepted-for-atomic-peers to a
  consumer-owned deployment gate for `effect-rpc-tanstack`, including its SSR
  `Exit` boundary, cache horizon, and already-open-tab policy. Atomic
  browser/server upgrade is impossible to guarantee, and the package does not
  provide mixed-major compatibility.
- `schema-date-invalid-message` — from an unresolved allowlist caveat to a
  required stable caller-facing error contract at Restate ingress. The lack of
  an existing snapshot does not make raw framework parser text unobservable.
