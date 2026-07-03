# Spec: oxlint adapter (supported reference)

This document specifies *how* the `oxlint` adapter works. It builds on its
[requirements.md](./requirements.md) (the oxlint-specific constraints it must
satisfy), the fleet [../spec.md](../spec.md), and the parent adapter contract
[../../spec.md](../../spec.md). oxlint is the reference diagnostics adapter; the
deadnix leaf mirrors it.

## Status

Active (supported). Implemented in `packages/@overeng/otel-scrape/src/lib.rs`;
wired via `trace.instr { adapter = "oxlint" }` in
`nix/devenv-modules/tasks/shared/lint-oxc.nix`.

## Sources of truth

| Concern | Source of truth |
| --- | --- |
| Structured-source contract | `oxlint --format=json` (oxlint 1.39.0); schema owned by oxc upstream. Captured: [../.experiments/0001-oxlint-source.md](../.experiments/0001-oxlint-source.md) |
| Adapter implementation | `packages/@overeng/otel-scrape/src/adapters/oxlint.rs` — `OxlintAdapter` impl of `ToolAdapter` (`Oxlint{Json,Diagnostic,Label,Span}` + parse/render); registered in `src/adapters/mod.rs` (`ADAPTERS`); OTLP emission `otlp_span_events` in `lib.rs` |
| Telemetry constants | `context/otel-scrape/telemetry-registry.json` (`oxlint_diagnostics`; adapter-event attrs `adapter_event_{severity,source_filename_hash,rule,line}`) → generated `src/telemetry_registry.gen.rs` (genie) |
| Call-site wiring | `nix/devenv-modules/tasks/lib/trace.nix` (`instrChildFlags`: `oxlint → --format=json`) + `nix/devenv-modules/tasks/shared/lint-oxc.nix` (`mkOxlintCmd`, task `lint:check:oxlint`) |
| Governing decisions | parent [0017](../../.decisions/0017-adapter-structured-source-and-presentation.md), [0018](../../.decisions/0018-devenv-task-cooperation.md); fleet [0002](../.decisions/0002-aggregate-counts-as-command-span-attributes.md) |

## Source (ADP-R01 diagnostics lane)

- **Flag (declared, stable):** `--format=json`. Injected as a gated child flag
  (`instrChildFlags` in `nix/devenv-modules/tasks/lib/trace.nix`) so a repo
  without otel-scrape never sees raw JSON on its terminal.
- **stdout ownership:** needs-render. `--format=json` *replaces* oxlint's human
  stdout (no side-channel), so the adapter owns re-presentation (R30): leaf runs
  `StdoutMode::CaptureSilent`, parses, and renders `oxlint: N diagnostic(s) over
  M file(s)` + one line per diagnostic. Non-JSON stdout → parse fails → captured
  bytes flushed (never swallowed).
- **Schema (parsed subset):** top level `{ diagnostics[], number_of_files,
  number_of_rules, threads_count, start_time }`. Per diagnostic the adapter reads
  `{ message, severity ("warning"|"error"), filename, code, labels[].span.line }`.
  Ignored: `url`, `help`, `causes`, `column`, `offset`, `length`, top-level
  stats. No `fixable`/`fix` field exists. Alternative formats (checkstyle/junit
  XML, gitlab JSON) are not used; **no SARIF** is offered.

## Records (classification ladder)

| Record | Kind | Derivation |
| --- | --- | --- |
| per diagnostic | Event | `{ severity, filename_hash = hash_path_identity(filename), rule = code, line = first label span line }`, emitted as `otel_scrape.adapter.event` span events + summary events |
| `oxlint.diagnostics` | Metric | `diagnostics.len()`; summary-only today (OTLP-dropped) |
| (none) | Span | correct: a diagnostic has no start/stop lifecycle (T02) |

## Public-safe disposition (realizes ADP.OXLINT-R02)

The mechanism that satisfies the fixed-sink-record requirement: `filename_hash =
hash_path_identity(filename)`; `rule = code`; all four fields carry public-safe
registry descriptions. `message`, `filename`, `help`, `url`, `causes`,
`column`/`offset` are held back and appear only in the terminal render (not a
sink). No gaps found in the implementation.

## Enhancements (deferred / via ADP-R06)

| # | Enhancement | Data? | Path |
| --- | --- | --- | --- |
| 1 | severity-split counts (`errors`/`warnings`) | yes (severity token) | ship as command-span attributes via [../.decisions/0002-aggregate-counts-as-command-span-attributes.md](../.decisions/0002-aggregate-counts-as-command-span-attributes.md) |
| 2 | per-rule histogram | yes (`code`) | needs a metric label dimension → defer to DQ1 (does not fit `AdapterMetric{name,value}`) |
| 3 | SARIF for stability | **no** (not offered) | rejected |
| 4 | per-file/per-rule timing | **no** (only coarse `start_time`, redundant with wallMs) | rejected |
| 5 | fix-availability counts | **no** (no `fix` field) | rejected |

## Open design questions

- **DQ-oxlint-1 (resolved into ADP-R06):** emit aggregate counts as command-span
  attributes rather than awaiting OTLP metric semantics. Adopted fleet-wide.
- **DQ-oxlint-2:** cross-run diagnostic identity/dedup would need gitlab's
  `fingerprint` (a second parse path). `rule + line + filename_hash` suffices
  now; note only.
