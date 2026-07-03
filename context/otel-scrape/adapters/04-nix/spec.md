# Spec: nix adapter (candidate, build lane)

This document specifies _how_ the `nix` adapter works. It builds on its
[requirements.md](./requirements.md) (the nix-specific constraints), the fleet
[../spec.md](../spec.md), and the parent adapter contract
[../../spec.md](../../spec.md). It is a **phase-lane** adapter for the Nix
_build_ path — explicitly not a `check:quick` deliverable.

## Status

Candidate (ADP-R05), gated on the source-stability DQ. Serves `nix:build` /
`nix:flake:check` / full `nix:check`, none of which are in `check:quick`.

## Sources of truth

| Concern                    | Source of truth                                                                                                                                                                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Structured-source contract | `nix … --log-format internal-json` (Determinate Nix 3.17.3 / nix 2.33.3); `@nix {json}` activity stream — de-facto schema (consumed by nix-output-monitor), not versioned (DQ-nix-1). Captured: [../.experiments/0004-nix-internal-json.md](../.experiments/0004-nix-internal-json.md)                  |
| Adapter implementation     | **planned** in `packages/@overeng/otel-scrape/src/lib.rs` — `NIX_ADAPTER` const, `nix_adapter()`; side-channel stderr/`json-log-path` reader (`StdoutMode::Inherit`, no re-render) with start/stop → `AdapterOutput::Span` and progress-drop. Not yet implemented                                       |
| Telemetry constants        | **planned** `context/otel-scrape/telemetry-registry.json` — spans `nix.build`/`nix.substitute` (or `nix.activity`); attrs `otel_scrape.adapter.nix.*` (ADP-R06) → `src/telemetry_registry.gen.rs` (genie)                                                                                               |
| Call-site wiring           | **planned** `nix/devenv-modules/tasks/lib/trace.nix` + `nix/devenv-modules/tasks/shared/nix-cli.nix` (build-lane tasks `nix:build`/`nix:flake:check`). The `nix:check:quick:*` fingerprint tasks (fork `nix-hash`) get **no** adapter (ADP.NIX-R01)                                                     |
| Governing decisions        | parent [0012](../../.decisions/0012-adapter-admission-policy.md), [0017](../../.decisions/0017-adapter-structured-source-and-presentation.md); fleet [0001](../.decisions/0001-adapter-fleet-audit-and-candidate-ranking.md), [0002](../.decisions/0002-aggregate-counts-as-command-span-attributes.md) |

## Not the `nix:check:quick` lane (mechanism for ADP.NIX-R01)

The `nix:check:quick:*` tasks do **not** run `nix`. They run a `writeShellScript`
(`check-lockfile-hash`, `nix/devenv-modules/tasks/shared/nix-cli.nix`) that forks
`nix-hash` + jq/perl/grep to compare stored fingerprints against
`pnpm-lock.yaml`/`package.json`. There is no flake evaluation, no store activity,
and the child program is a shell script — an adapter keyed on `nix` would never
fire. Each task's ~70ms is already captured by its `devenv.task.exec` span and
the duration-trends dashboard. Verdict for that lane: **no adapter** (decision
0001). A trivial `nix eval` likewise emits an empty internal-json stream.

## Source (ADP-R01 phase lane)

- **Flag:** `--log-format internal-json` — a `@nix {json}` NDJSON activity stream
  on **stderr** while the command result stays on stdout → **side-channel**, so
  no re-render is needed (R30 satisfied, unlike the diagnostics adapters).
  Determinate Nix additionally offers `json-log-path = <file>`, an even cleaner
  file side-channel (already configured in this environment).
- **Schema:** `action` ∈ {`start`, `stop`, `result`, `msg`}. A `start`
  (`id`, `type`, optional `parent`/`fields`/`text`) paired with its `stop` (`id`)
  is a lifecycle activity with stable identity → span-worthy. `result` lines are
  progress ticks (byte counters) → drop. `msg` lines are log lines → events at
  most. `start.type` is a Nix `ActivityType` (105 build, 108 substitute, 100
  copyPath, 101 fileTransfer, 109 queryPathInfo, …).

## Records (classification ladder)

| Record                                                | Kind             | Derivation                                                                                     |
| ----------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------- |
| per built/substituted path                            | Span             | `start`/`stop` pair where `type` ∈ {105 build, 108 substitute, 100 copyPath, 101 fileTransfer} |
| downloads / narinfo queries / `msg`                   | Event            | `type` 101/109, `action:"msg"`                                                                 |
| paths built/substituted/downloaded, bytes transferred | Metric→span-attr | counts + `result.fields` (ADP-R06)                                                             |
| all `action:"result"` progress                        | (dropped)        | pure noise; a captured trivial build had 17 start/stop vs 138 result lines                     |

## Public-safe disposition (realizes ADP.NIX-R03)

- **Must-drop / hash:** store paths and drv paths (`/nix/store/<hash>-<name>`) —
  local paths **and** the `<name>` suffix can be a private package name, so hash
  the whole activity identity, not just the `/nix/store/HASH` prefix.
  Substituter **hostnames** (private cache infra) → drop. `json-log-path` value →
  local path, drop.
- **Public-safe:** activity types, counts, durations, byte totals, build/
  substitute cardinality.

## Registry additions

`nix.build` / `nix.substitute` (or one `nix.activity` span named by type) span
names; `otel_scrape.adapter.nix.*` count attributes (ADP-R06).

## Open design questions

- **DQ-nix-1 (R08 stability):** internal-json is a de-facto contract (consumed by
  nix-output-monitor) but **not a versioned public schema**; Determinate Nix 3.x
  may diverge from upstream `ActivityType` numbering. Does it clear R08's
  "declared, stable" bar, or is it best-effort until pinned? This gates
  admission.
- **DQ-nix-2:** prefer the `json-log-path` file side-channel (already configured)
  over stderr parsing? The file tee avoids interleaving with the child's own
  stderr.
- **DQ-nix-3:** hash the whole `<hash>-<name>` NAR identity, or keep the opaque
  hash prefix and drop only the `<name>` suffix (the leak vector)?
