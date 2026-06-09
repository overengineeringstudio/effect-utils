# Requirements: 09-testing

**Role.** Docker-free testability: the native-server harness as a scoped `Layer`,
typed State inspect/seed, determinism-hunting modes, server-free contract
testability, the in-memory `TestContext`, the swappable `RestateTestEnv` façade,
and the dedicated CI integration lane. Owns how consumers (and the binding) test
durable handlers without containers.

Builds on the cross-cutting [../requirements.md](../requirements.md) (global
A/T) and [../glossary.md](../glossary.md). IDs are GLOBAL and preserved.

## Requirements

### Must be testable without Docker

- **R26 Scoped-Layer harness:** The binding MUST export a testing harness (opt-in
  subpath) as a scoped `Layer` that boots a native `restate-server` (no Docker),
  registers the deployment, and exposes the typed ingress client and State
  inspection. (A07; [../.decisions/0009](../.decisions/0009-effect-native-testing-harness.md).)
- **R27 Parallel-safe isolation:** The harness MUST use ephemeral ports and an
  isolated base dir per instance so tests run parallel-safe and leave no shared
  state. (A07; [../.decisions/0009](../.decisions/0009-effect-native-testing-harness.md).)
- **R28 Dedicated CI integration job:** CI MUST run the integration tests as a
  dedicated job with `restate-server` on `$PATH` (from `nix/restate.nix`, with
  `allowUnfree` scoped to `restate`). (A07; [../.decisions/0009](../.decisions/0009-effect-native-testing-harness.md).)
- **R26a Determinism-hunting modes:** The harness MUST expose typed `alwaysReplay`
  (force replay at every suspension) and `disableRetries` options, mirroring the
  testcontainers `RestateTestEnvironment`, as the primary tools for catching
  RT0016 journal mismatches. They MUST be consumer-available, and the harness MUST
  support multi-deployment registration so replay/upgrade across deployment
  versions is testable (T07). (A07, A11; [../.decisions/0009](../.decisions/0009-effect-native-testing-harness.md).)
- **R26b Typed State inspect/seed:** The harness MUST expose a `stateOf(contract,
key)` proxy with `get`/`getAll`/`set`/`setAll`, key- and value-typed against the
  contract's `state` block and serialized via `effectSerde` over the Admin API, as
  stable public API. (A07; [../.decisions/0009](../.decisions/0009-effect-native-testing-harness.md).)
- **R26c Server-free contract testability:** The two core guarantees — the
  error-transport round-trip (decode helper over a constructed `TerminalError`)
  and OTel exactly-once emission (in-memory `SpanExporter`) — MUST be testable
  WITHOUT a running server, so the bulk of correctness is covered by unit/contract
  tests and only true end-to-end paths need the integration job. (Vision;
  [../.decisions/0009](../.decisions/0009-effect-native-testing-harness.md).)
- **R26d Consumer AppLayer threading:** The harness `Layer` MUST accept the
  consumer's `AppLayer`, so handler `R` is satisfied inside the spawned endpoint,
  and expose the typed ingress client plus `stateOf` for use with
  `@effect/vitest` `it.effect`. (A07; [../.decisions/0009](../.decisions/0009-effect-native-testing-harness.md).)
