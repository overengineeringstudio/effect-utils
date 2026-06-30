# 0012 - Adapter admission is a vertical-slice gate

Status: accepted

## Context

`otel-scrape` is useful only if adapter output is trustworthy. Build tools
expose many tempting signals, but weak adapters that parse human logs, leak
local paths, or emit span-per-line structures would make the trace tree look
precise while hiding unsupported evidence.

## Evidence and Argument

The existing supported adapters prove different source shapes:

- `oxlint` uses structured JSON diagnostics and keeps filenames hashed.
- `node-cpuprofile` uses a native profile artifact and the CAS profile lane.

The deferred candidates are useful, but each has a contract gap that should be
closed before CLI support. The queue has two lanes:

- Cargo JSON/timings are the first general adapter-fleet candidate, but need
  stable compile-unit/event and artifact semantics.
- `tsc --generateTrace` is the first profile/artifact build-tool candidate, but
  needs artifact grouping, retention size, and phase-to-span semantics.
- Vitest needs stable suite/test identity and nested-wrapper ownership.
- Package-manager phases and Vite need a structured-source audit so we do not
  promote debug logs or progress output into first-class telemetry.

Accepting candidate names as placeholders would make unsupported evidence look
supported and would weaken the support matrix.

## Options

| Option                                                      | Consequence                                                                                                                       |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Admit adapters only after a full vertical slice             | Slower fleet growth, but each supported adapter has structured input, privacy, degradation, registry, contract, and E2E evidence. |
| Accept candidate adapter names early and degrade at runtime | Easier demos, but unsupported evidence appears first-class and downstream users cannot distinguish placeholder support.           |
| Parse human logs as a generic adapter fallback              | Broad coverage, but unstable source text and progress output become a false schema.                                               |

## Decision

New adapters are admitted only through a complete vertical slice. The adapter
must define its structured input source, output kinds, privacy boundary,
degradation behavior, generated-registry additions, and consumer evidence before
it is listed as supported.

Candidate order has two lanes:

1. keep `oxlint` and `node-cpuprofile` as supported baseline adapters,
2. for general adapter-fleet expansion, add Cargo JSON/timings when a stable
   compile-unit/event mapping and artifact contract are specified,
3. for profile/artifact build-tool expansion, add `tsc --generateTrace` when
   trace artifact grouping, CAS handoff, retention size, and phase semantics are
   specified,
4. then add Vitest JSON or OTEL-aware test output when suite/test identity is
   stable,
5. then add package-manager phases and Vite profiles only after a
   structured-source audit proves they avoid debug-log parsing.

Adapters may remain documented as candidates before implementation, but support
matrices must distinguish candidates from supported adapters. The CLI must not
accept candidate adapter names as placeholders.

## Consequences

- Adapter growth optimizes for evidence quality instead of breadth.
- Human-readable logs are excluded from first-class adapters unless explicitly
  documented as degraded fallback evidence.
- Registry, summary, OTLP, CAS, and contract tests evolve together for each
  admitted adapter.
- Core wrapper contracts cannot be changed casually by adapter work; a wrapper,
  process, CAS, or profile-link contract change requires a separate VRS update
  and regression gate.
