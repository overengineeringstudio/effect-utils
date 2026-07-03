# Spec: pnpm adapter (candidate)

This document specifies *how* the `pnpm` adapter works. It builds on its
[requirements.md](./requirements.md) (the pnpm-specific constraints), the fleet
[../spec.md](../spec.md), and the parent adapter contract
[../../spec.md](../../spec.md). pnpm is the reference **phase-lane** adapter.

## Status

Candidate (ADP-R05) — CLI must not accept `--adapter pnpm` until this slice
lands. Ranked first among candidates (decision
[../.decisions/0001-adapter-fleet-audit-and-candidate-ranking.md](../.decisions/0001-adapter-fleet-audit-and-candidate-ranking.md))
because its value is phase **spans**, which export regardless of the adapter-
metric OTLP gap.

## Sources of truth

| Concern | Source of truth |
| --- | --- |
| Structured-source contract | `pnpm install --reporter=ndjson` (pnpm 11.8.0); bunyan events from `@pnpm/core-loggers` (flag declared+stable, payload de-facto — DQ-pnpm-1). Captured: [../.experiments/0002-pnpm-ndjson-and-isolation-hazard.md](../.experiments/0002-pnpm-ndjson-and-isolation-hazard.md) |
| Adapter implementation | **planned** in `packages/@overeng/otel-scrape/src/lib.rs` — `PNPM_ADAPTER` const, `pnpm_adapter()`, `pnpm_render()`; phase-span emission (new `AdapterOutput::Span` OTLP path); dispatch arms mirroring `OXLINT_ADAPTER` but `StdoutMode::CaptureSilent` + a streaming NDJSON parser. Not yet implemented |
| Telemetry constants | **planned** `context/otel-scrape/telemetry-registry.json` — spans `pnpm.resolve`/`pnpm.import`; attrs `otel_scrape.adapter.pnpm.*` (ADP-R06) → `src/telemetry_registry.gen.rs` (genie) |
| Call-site wiring | **planned** `nix/devenv-modules/tasks/lib/trace.nix` (`instrChildFlags`: `pnpm → --reporter=ndjson`) + `nix/devenv-modules/tasks/shared/pnpm.nix` (task `pnpm:install`). `lint:check:lockfile` in `lint-oxc.nix` stays command-span-only (ADP.PNPM-R05) |
| Governing decisions | parent [0012](../../.decisions/0012-adapter-admission-policy.md), [0017](../../.decisions/0017-adapter-structured-source-and-presentation.md), [0015](../../.decisions/0015-trust-assertion-is-per-named-sink.md); fleet [0001](../.decisions/0001-adapter-fleet-audit-and-candidate-ranking.md), [0002](../.decisions/0002-aggregate-counts-as-command-span-attributes.md) |

## Reconciliation with the parent source audit

The parent audit (`../../spec.md` structured-source survey, `.experiments/0008`)
correctly bucketed pnpm as having **no per-diagnostic structured source** — that
is unchanged. This adapter is a **phase/lifecycle** adapter, not a diagnostics
one (ADP-R01): the two lanes are separate, and 0012's package-manager admission
condition ("prove the adapter avoids debug-log parsing") is now met by a
*documented named reporter*, not `--loglevel debug` scraping.

## Source (ADP-R01 phase lane)

- **Flag (declared):** `--reporter=ndjson` — bunyan-style NDJSON on stdout,
  events keyed by `name`. The flag is stable; the per-event *payload* schema
  (`@pnpm/core-loggers`) has no published stability contract (DQ-pnpm-1).
- **stdout ownership:** needs-render. ndjson goes to stdout (stderr empty),
  replacing pnpm's human progress; there is no side-channel flag. The adapter
  injects the reporter (gated by ADP.PNPM-R02), consumes it, and re-prints a
  compact line, e.g. `pnpm: resolved 2, reused 0, downloaded 2, +2 (resolve
  618ms · import 45ms)`.
- **detect (realizes ADP.PNPM-R05):** `process.executable.name == "pnpm"` and
  argv contains `install`/`i`/`add`/`update` (not `pnpm ls`/`run`).

## Records (classification ladder)

| Record | Kind | Derivation |
| --- | --- | --- |
| `pnpm.resolve` | Span | `pnpm:stage` pair `resolution_started`→`resolution_done` |
| `pnpm.import` | Span | `pnpm:stage` pair `importing_started`→`importing_done` |
| packages_resolved / _downloaded / _found_in_store / store_hit_ratio | Metric→span-attr | accumulated from `pnpm:progress.status` (ADP-R06) |
| added / removed | Metric→span-attr | `pnpm:stats` |
| lockfile-verification / outdated-lockfile error | Event | `pnpm:lockfile-verification`, `ERR_PNPM_OUTDATED_LOCKFILE` (one, not per-package) |
| (rejected) | Span | never a span per package — `pnpm:progress`/`pnpm:link` fire per package (R11/T02 inflation) |

`pnpm:execution-time` is redundant with the wrapper `wallMs` — drop.

## Public-safe disposition (realizes ADP.PNPM-R03)

Field-level mechanism for the identity gate. **Public-safe** (any sink): stage
names, phase durations, all counts, store-hit ratio,
`lockfile-verification.status`, `currentLockfileExists`. **Dropped by default:**
`hostname` (on every line), `pid`, and all local paths (`prefix`, `storeDir`,
`virtualStoreDir`, `lockfilePath`, `workspacePrefix`, `to`); the gated package-
identity fields are `packageId`, `requester`, `wanted`, `realName`. No
credentials appear in the stream.

## Scope: two tasks, one adapter (mechanism for ADP.PNPM-R05)

- **`pnpm:install`** (cold/changed): full value — resolve/import spans + counts.
  This is where the ~4.67s lives and the resolve-vs-import split is useful.
- **`lint:check:lockfile`** (`--frozen-lockfile`, up-to-date): stream is a near
  no-op (~5 lines, no stage/progress/stats); its ~3s is lockfile parse + supply-
  chain verification, which pnpm does not richly instrument. Stays
  command-span-only unless DQ-pnpm-2 resolves otherwise.

## Registry additions

`pnpm.resolve` / `pnpm.import` span names; `otel_scrape.adapter.pnpm.*` count
attributes (ADP-R06). Generated per parent decision 0004.

## Degradation

Unknown `name` or missing field → skip, never crash. If ndjson parse fails,
flush captured bytes (like oxlint). The behavior-preservation constraint
(ADP.PNPM-R04) means the adapter never injects `--config.confirmModulesPurge`;
note that a store/linker change in non-TTY CI aborts with
`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` (DQ-pnpm-5) — that is passed
through, not silently resolved.

## Open design questions

- **DQ-pnpm-1:** payload stability (R08) — pin pnpm version + a decode-guard.
- **DQ-pnpm-2:** is the frozen `lint:check:lockfile` worth wiring at all given
  its near-empty stream? Default: no, target `pnpm:install`.
- **DQ-pnpm-4:** confirm package-identity fields dropped from summary by default,
  surfaced only under `--trusted-sink`.
