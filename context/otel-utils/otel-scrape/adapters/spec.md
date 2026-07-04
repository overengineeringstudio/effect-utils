# Spec: otel-scrape adapter fleet

This document specifies the concrete adapter fleet and its support matrix. It
builds on [requirements.md](./requirements.md) and the parent adapter contract
in [../spec.md](../spec.md).

## Status

Draft. Supported baseline (`oxlint`, `vitest`, `node-cpuprofile`) is Active;
`pnpm`, `deadnix`, and `nix` are documented candidates (ADP-R05).

## Scope

**Defines:** the per-tool support matrix, the source-kind classification of each
audited tool, the "no adapter — wrap instead" outcome, and the aggregate-count
representation shared across adapters. Each admitted/candidate adapter has a leaf
spec under a numbered subdirectory.

**Does not define:** the wrapper contract, classification ladder, context
propagation, or semantic conventions (parent [../spec.md](../spec.md)); nor the
Rust implementation of any single parser (the leaf specs plus
`packages/@overeng/otel-scrape`).

## The two ways a task gets sub-traces

```
task span (devenv.task.exec, via otel-span)
├── native OTEL          tool self-instruments      → tsgo, mr, genie   (no adapter)
├── adapter="none"       wrapper command span only  → any clean command (no parser)
└── adapter=<tool>       wrapper span + parsed records → oxlint, vitest, node-cpuprofile, [pnpm, deadnix, nix]
```

The headline outcome of the fleet audit (decision 0001): most un-adapted slow
tasks do not need an adapter — they need the **`adapter = "none"`** wrap, which
is available today with zero adapter code and turns an untraced command into a
timed, named, pass/fail command span (ADP-A02, ADP-T01).

## Support matrix

Traceability: rows map to the classification (ADP-R01), admission (ADP-R05), and
OTLP-survival (ADP-R04) requirements.

| Tool                    | Source-kind | Declared source                       | Records (post-R27)                              | OTLP today                                | Status                                                        | Leaf                                               |
| ----------------------- | ----------- | ------------------------------------- | ----------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------- |
| oxlint                  | diagnostics | `--format=json`                       | events (severity/rule/hashed-file/line) + count | events ✓, count metric ✗ (ADP-R06)        | **supported**                                                 | [01-oxlint](./01-oxlint/spec.md)                   |
| pnpm                    | phase       | `--reporter=ndjson`                   | `pnpm.resolve`/`pnpm.import` **spans** + counts | spans ✓, counts via ADP-R06               | **candidate**                                                 | [02-pnpm](./02-pnpm/spec.md)                       |
| deadnix                 | diagnostics | `--output-format json`                | events (hashed-file/line) + count               | events ✓ (thin), count metric ✗ (ADP-R06) | **supported**                                                 | [03-deadnix](./03-deadnix/spec.md)                 |
| nix (build)             | phase       | `--log-format internal-json`          | build/substitute **spans** + byte/path counts   | spans ✓                                   | **candidate**                                                 | [04-nix](./04-nix/spec.md)                         |
| vitest                  | phase/test  | `--reporter=json` (side-channel)      | `tests`/`failures` metrics                      | metric via ADP-R06                        | **supported**                                                 | [05-vitest](./05-vitest/spec.md)                   |
| node-cpuprofile         | profile     | `.cpuprofile` artifact                | profile link (CAS)                              | link ✓                                    | **supported**                                                 | [06-node-cpuprofile](./06-node-cpuprofile/spec.md) |
| vite (build)            | profile     | `--profile` → `.cpuprofile`           | profile link (reuses node-cpuprofile CAS lane)  | link ✓                                    | **deferred** (use node-cpuprofile today; not a hot path here) | audit row                                          |
| oxfmt                   | none        | — (only `--list-different` path list) | none beyond exit code                           | —                                         | **no adapter → `none`**                                       | audit row                                          |
| nixfmt                  | none        | — (exit code + human stderr)          | none beyond exit code                           | —                                         | **no adapter → `none`**                                       | audit row                                          |
| nix (`nix:check:quick`) | n/a         | runs `nix-hash`, not `nix`            | none                                            | —                                         | **no adapter** (already task-span timed)                      | audit row                                          |
| asset-import guard      | first-party | (bash/awk)                            | —                                               | —                                         | native self-instrument if wanted                              | audit row                                          |

`vitest` and `node-cpuprofile` are supported adapters that predate this audit;
their leaves (05, 06) are documented from the implementation
(`packages/@overeng/otel-scrape/src/lib.rs`) rather than re-investigated, and
cover the current run-level records only. Numeric leaf prefixes encode reading
order within the fleet (reference diagnostics adapter first, then the audited
candidates, then the remaining supported adapters), not a hard dependency DAG —
adapters are siblings under one contract.

### Rejected-with-rationale rows (do not re-propose)

- **oxfmt / nixfmt:** formatter `--check` is pass/fail; the only machine output
  is a path list (`oxfmt --list-different`) or human stderr (`nixfmt`), whose
  sole public-safe residue is a single count already implied by the exit code.
  A full adapter incurs the R30 re-presentation obligation to surface one count.
  Verdict: `adapter = "none"` command span, not an adapter. Evidence
  [.experiments/0005-formatters-no-structured-source.md](.experiments/0005-formatters-no-structured-source.md).
- **`nix:check:quick:*`:** these tasks run a `writeShellScript` forking
  `nix-hash` + jq/perl, not `nix` — an adapter keyed on `nix` would never fire,
  and each task's duration is already captured by its `devenv.task.exec` span
  and the duration-trends dashboard. Verdict: nothing to add. (The `nix` _build_
  lane is a separate candidate — leaf 04.)

## Implementation layout

Each adapter is a self-contained Rust module implementing a shared trait, so
adapters are developed and maintained independently:

```
packages/@overeng/otel-scrape/src/adapters/
  mod.rs              ToolAdapter trait + AdapterPrep + the ADAPTERS registry
                      (adapter_for / adapter_names / prepare)
  oxlint.rs           OxlintAdapter          (diagnostics, needs-render)
  vitest.rs           VitestAdapter          (side-channel)
  node_cpuprofile.rs  NodeCpuProfileAdapter  (profile artifact)
  <tool>.rs           one file per adapter
```

`ToolAdapter` methods: `name`, `stdout_mode(nested)`, `ownership(nested)`,
`structured_source(child)`, `parse(source, ownership)`, and the injection/
lifecycle hooks `prepare(config) -> AdapterPrep`, `discover_artifacts(child)`,
`cleanup_artifacts(child)`, `cleanup_structured_source(child)` — all defaulted
except `name`/`parse`, so an adapter overrides only what it uses. `lib.rs`
dispatch is registry-driven (`adapter_for(...).map_or(default, |a| a.method(...))`)
with no per-name `match`, so adding an adapter requires three inputs: one
`src/adapters/<tool>.rs`, one `ADAPTERS` entry, and its
`telemetry-registry.json` entries. `lib.rs` is untouched. Injection is dynamic
via `prepare` (no static `child_flags`), so a tool's format flag is supplied only
when otel-scrape is engaged.

## Aggregate counts as command-span attributes

Adapter-derived **metrics** are currently written to the summary but dropped
from OTLP export (`lib.rs` `otlp_span_events` no-ops `AdapterOutput::Metric`).
Rather than block count-bearing adapters on adapter-metric OTLP semantics, an
adapter attaches its run-level aggregates to the wrapper command span as
attributes (the classification-ladder "aggregate statistic" row surfaced on the
owning span). Examples: `otel_scrape.adapter.oxlint.diagnostics`,
`…deadnix.findings`, `…pnpm.packages_downloaded`, `…pnpm.store_hit_ratio`. This
makes counts trace-visible today and defers the metric-point question without
blocking the fleet. Normative in ADP-R06 / decision
[.decisions/0002-aggregate-counts-as-command-span-attributes.md](.decisions/0002-aggregate-counts-as-command-span-attributes.md).

## Open design questions

- **DQ1 (fleet-wide):** How do adapter metrics map to OTLP — metric points, or
  the span-attribute shortcut (ADP-R06) only? ADP-R06 unblocks the common case;
  a full metric-point path is still unspecified. Resolving DQ1 upgrades the
  deadnix/pnpm count surfaces from "via span attribute" to first-class metrics.
- **DQ2:** Is `--log-format internal-json` a "declared, stable" source per R08,
  or best-effort until pinned? Determinate Nix may diverge from upstream
  `ActivityType` numbering (leaf 04 DQ).
- **DQ3:** Parent [../spec.md](../spec.md) has no pointer to this `adapters/`
  tree yet (its file is under concurrent edit for an unrelated decision-0020
  change). A one-line reference from the parent Adapter Contract section should
  be added when that edit settles. Tracked in the worklog.
