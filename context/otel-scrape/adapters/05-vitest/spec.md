# Spec: vitest adapter (supported)

This document specifies _how_ the `vitest` adapter works. It builds on its
[requirements.md](./requirements.md), the fleet [../spec.md](../spec.md), and the
parent adapter contract [../../spec.md](../../spec.md). Content is derived from
the implementation; vitest was not re-investigated in the fleet audit.

## Status

Active (supported). Implemented in `packages/@overeng/otel-scrape/src/lib.rs`
(`VITEST_ADAPTER`, `vitest_outputs`, `vitest_sidechannel`,
`scan_vitest_user_flags`).

## Sources of truth

| Concern                    | Source of truth                                                                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Structured-source contract | `vitest --reporter=json --outputFile.json=<file>` (vitest 4.1.9, side-channel); `VitestJson { numTotalTests, numFailedTests }` schema owned by vitest upstream                                                                        |
| Adapter implementation     | `packages/@overeng/otel-scrape/src/adapters/vitest.rs` — `VitestAdapter` impl of `ToolAdapter` (side-channel `prepare`/`parse`/`cleanup_structured_source`; `VitestJson`; `Inherit`/`Inherited`); registered in `src/adapters/mod.rs` |
| Telemetry constants        | `context/otel-scrape/telemetry-registry.json` (`vitest_tests`, `vitest_failures`) → generated `src/telemetry_registry.gen.rs` (genie)                                                                                                 |
| Call-site wiring           | `nix/devenv-modules/tasks/lib/trace.nix` + `nix/devenv-modules/tasks/shared/test.nix` (task `test:<pkg>`)                                                                                                                             |
| Governing decisions        | parent [0017](../../.decisions/0017-adapter-structured-source-and-presentation.md); span-promotion precondition parent [0012](../../.decisions/0012-adapter-admission-policy.md) lane 4                                               |

## Source (side-channel)

- **Flags injected:** `--reporter=json --outputFile.json=<tmp>` — the child
  writes its JSON report to an otel-scrape-owned temp file while the human
  reporter stays on the terminal. This is the reference **side-channel** source
  (parent decision 0017): stdout is untouched, so there is no re-render
  (ADP.VITEST-R01). Injection is gated by `scan_vitest_user_flags` so a user's
  own `--reporter`/`--outputFile.json` is respected (ADP.VITEST-R02).
- **Schema (parsed subset):** `VitestJson { numTotalTests, numFailedTests }`.
  Read after the child exits.

## Records (classification ladder)

| Record                                              | Kind             | Derivation                                                                                                                                  | Status            |
| --------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `vitest.tests`                                      | Metric           | `numTotalTests` (registry `VITEST_TESTS`)                                                                                                   | implemented       |
| `vitest.failures`                                   | Metric           | `numFailedTests` (registry `VITEST_FAILURES`)                                                                                               | implemented       |
| `vitest.{passed,skipped,todo,suites,suites_failed}` | Metric→span-attr | `numPassedTests`, `numPendingTests`, `numTodoTests`, `numTotalTestSuites`, `numFailedTestSuites` — all public-safe ints already in the file | **add** (ADP-R06) |

The actionable enhancement (from the deep-dive,
[../.experiments/0006-vitest-schema-and-span-feasibility.md](../.experiments/0006-vitest-schema-and-span-feasibility.md)):
broaden the count set and expose all of them as `otel_scrape.adapter.vitest.*`
command-span attributes (ADP-R06), flipping vitest counts from summary-only to
trace-visible. No stdout/ownership change (ADP.VITEST-R01 holds).

Spans are **not** derived from the side-channel file — see DQ-vitest-1.

## Open design questions

- **DQ-vitest-1 (resolved: per-test spans are NOT an adapter change):** the JSON
  reporter is a post-hoc summary — per-TEST records carry `duration` but **no
  start timestamp**, so a per-test span would fabricate its start (R11/T02
  violation). A _faithful_ per-test lifecycle exists only in vitest's in-process
  reporter API (`TestCase.diagnostic()` carries `startTime`+`duration`), which is
  a **first-party custom reporter emitting OTLP — the native self-instrumentation
  lane (ADP-A01), not an otel-scrape adapter**. Per-FILE spans _are_ faithful
  (`startTime`+`endTime`) but carry hash-only identity and are outside this
  scope — deferred as a conditional slice. No native OTEL reporter ships in
  vitest 4.1.9.
- **DQ-vitest-2 (fleet ADP-R06):** surface the broadened counts as command-span
  attributes so they reach OTLP. This is the actionable output above.
- **DQ-vitest-3:** if the native custom-reporter lane is ever pursued, resolve
  per-test span identity — opaque hashed name vs trust-gated raw names (R27 in a
  public repo used with private repos).
