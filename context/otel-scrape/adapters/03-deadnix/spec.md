# Spec: deadnix adapter (supported)

This document specifies _how_ the `deadnix` adapter works. It builds on its
[requirements.md](./requirements.md) (the deadnix-specific constraints), the
fleet [../spec.md](../spec.md), and the parent adapter contract
[../../spec.md](../../spec.md). It mirrors the oxlint diagnostics adapter
([../01-oxlint/spec.md](../01-oxlint/spec.md)), thinner.

## Status

Active (supported). Implemented as a module (`src/adapters/deadnix.rs`) on the
adapter framework — a complete vertical slice (parent 0012): declared source,
records, privacy boundary, degradation, registry entry, and `tests/cli.rs`
coverage. At parity with oxlint: its `deadnix.findings` count is a summary metric
(OTLP-dropped until ADP-R06 exposes it as a command-span attribute); per-finding
events reach OTLP. Its OTLP surface is materially thinner than oxlint's (no
rule/severity/kind field); this leaf is honest about that.

## Sources of truth

| Concern                    | Source of truth                                                                                                                                                                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Structured-source contract | `deadnix --output-format json` (deadnix 1.3.1); NDJSON schema owned by deadnix upstream. Captured: [../.experiments/0003-deadnix-json.md](../.experiments/0003-deadnix-json.md)                                                                                                                         |
| Adapter implementation     | `packages/@overeng/otel-scrape/src/adapters/deadnix.rs` — `DeadnixAdapter` impl of `ToolAdapter` (NDJSON stream parse + render); registered in `src/adapters/mod.rs` (`ADAPTERS`)                                                                                                                       |
| Telemetry constants        | `context/otel-scrape/telemetry-registry.json` — metric `deadnix.findings` (mirrors `oxlint_diagnostics`; reuses the adapter-event attrs) → generated `src/telemetry_registry.gen.rs` (genie)                                                                                                            |
| Call-site wiring           | `nix/devenv-modules/tasks/lib/trace.nix` (`instrChildFlags`: `deadnix → --output-format json`) + `nix/devenv-modules/tasks/shared/lint-nix.nix` (task `lint:nix:deadcode`, the `deadnix` guard)                                                                                                         |
| Governing decisions        | parent [0012](../../.decisions/0012-adapter-admission-policy.md), [0017](../../.decisions/0017-adapter-structured-source-and-presentation.md); fleet [0001](../.decisions/0001-adapter-fleet-audit-and-candidate-ranking.md), [0002](../.decisions/0002-aggregate-counts-as-command-span-attributes.md) |

## Source (ADP-R01 diagnostics lane)

- **Flag (declared, stable):** `-o json` / `--output-format json` (enum
  `[human-readable, json]`). Output is **NDJSON** — one JSON object per file,
  newline-separated (not a top-level array). A file with no dead code emits zero
  bytes.
- **stdout ownership:** needs-render. JSON goes to stdout (stderr empty),
  replacing the human report — same as oxlint. Adapter captures, parses, renders
  a compact summary.
- **Exit code:** 0 by default even with findings; `--fail` makes it exit 1 (the
  adapter injects neither `--fail` nor `--edit` — ADP.DEADNIX-R01).
- **Schema (per-file object):** `{ file: string, results: [{ line, column,
endColumn, message }] }`. There is **no** `severity`, `code`, `rule`, or
  `kind` field — all findings are conceptually warnings.

## Records (classification ladder)

| Record                        | Kind             | Derivation                                                                                                                                    |
| ----------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| per finding                   | Event            | `{ filename_hash = hash(file), line }`. Severity is a synthesized constant `"warning"` (deadnix has none) or omitted — carries no information |
| `deadnix.findings`            | Metric→span-attr | sum of `results.len()` across objects (ADP-R06)                                                                                               |
| `deadnix.files_with_findings` | Metric→span-attr | object count (optional, DQ-deadnix-3)                                                                                                         |
| (none)                        | Span             | a finding has no lifecycle (T02)                                                                                                              |

## Public-safe disposition (realizes ADP.DEADNIX-R02)

| JSON field            | Disposition                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `file`                | local path → **hash** (`hash_path_identity`), never raw in a sink                                                  |
| `line`                | public-safe integer → keep                                                                                         |
| `column`, `endColumn` | `endColumn − column` leaks identifier length → **drop from sinks**, render only                                    |
| `message`             | contains the dead symbol's source name after `": "` → **drop from every sink incl. summary**; terminal render only |
| severity              | not in JSON; synthesized constant if emitted                                                                       |

## The thinness (ADP-R04 honesty)

After R27 drops message + path, deadnix has no rule/severity/kind field, and no
spans, what lands in OTLP is: _N `"warning"` events, each a hashed filename + a
line number_, plus the `findings` count via the span-attribute path (ADP-R06).
Without ADP-R06 the count is summary-only and the OTLP surface is barely above
the `adapter = "none"` tools. This is why deadnix ranks below pnpm and ships
paired with ADP-R06.

## Implementation notes (mirror oxlint, differ on parse)

Parser differs from oxlint: NDJSON, so stream-deserialize concatenated objects
(`serde_json::Deserializer::from_slice(...).into_iter::<DeadnixFile>()`) and
handle the empty-stdout (no-findings) case → total 0, no events. Ownership =
`ThisWrapper`; raw-flush fallback on parse failure (like oxlint). Registry: add
`deadnix.findings` (+ optional `deadnix.files_with_findings`) mirroring
`OXLINT_DIAGNOSTICS`.

## Open design questions

- **DQ-deadnix-1 (kind in sinks):** deadnix exposes no machine kind; splitting
  the `message` prefix ("Unused let binding" vs "lambda argument") is human-text
  parsing (R08-barred) and risks leaking the symbol name. Sink records carry no
  derived kind — at most a single constant category `deadnix.dead-code`. Promote
  a real kind only if deadnix adds a machine-readable field upstream.
- **DQ-deadnix-2 (severity):** emit constant `"warning"` for oxlint event-shape
  parity, or omit (it carries no information). Lean omit-or-document-as-constant.
- **DQ-deadnix-3:** is `files_with_findings` worth a second count, or does
  `findings` + per-event hashed-file suffice?
