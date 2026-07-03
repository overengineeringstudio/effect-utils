# Requirements: otel-scrape adapter fleet

Role: this node is the composable-VRS home for the concrete adapter fleet. It
refines the parent adapter contract in
[../requirements.md](../requirements.md) (R07 interface, R08 structured source,
R11 no span inflation, R27 public-safe, R30 presentation, T01/T02 curated /
events-before-spans) and the parent [../spec.md](../spec.md) (Adapter Contract,
Classification Ladder). It does not restate that contract; it constrains how
individual tools are audited, admitted, and shaped into adapters.

## Context

- Builds on [../requirements.md](../requirements.md) and
  [../spec.md](../spec.md).
- Governed by admission decision
  [../.decisions/0012-adapter-admission-policy.md](../.decisions/0012-adapter-admission-policy.md):
  adapters are admitted only through a complete vertical slice, and the CLI must
  not accept candidate names as placeholders.
- The fleet audit that seeded these requirements is
  [.decisions/0001-adapter-fleet-audit-and-candidate-ranking.md](.decisions/0001-adapter-fleet-audit-and-candidate-ranking.md).

## Assumptions

- **ADP-A01 Two instrumentation paths:** A task gets sub-trace detail either by
  a tool self-instrumenting (native OTEL — e.g. `tsgo`, and the first-party
  `mr`/`genie` tools) or by an `otel-scrape` wrapper. Adapters exist only for
  the second: third-party tools with no first-class OTEL.
- **ADP-A02 Wrapping is not adapting:** `trace.instr { adapter = "none" }`
  (decision [../.decisions/0018-devenv-task-cooperation.md](../.decisions/0018-devenv-task-cooperation.md))
  already yields a timed, named, pass/fail command span with zero adapter code.
  "No adapter" therefore never means "no telemetry."

## Acceptable Tradeoffs

- **ADP-T01 Cheap span over rich adapter:** For a tool with no declared
  structured source, the fleet prefers the free `adapter = "none"` command span
  over a human-text scraper. Pass/fail + duration is an acceptable ceiling.
- **ADP-T02 Candidate specs precede support:** A tool may carry a full leaf spec
  while still listed as a *candidate* (not supported). The spec is the vertical
  slice; listing follows implementation (ADP-R05).

## Requirements

### Diagnostics lane vs phase lane

- **ADP-R01 Source-kind classification:** Each audited tool is classified by the
  *kind* of declared structured source it exposes, independently of the
  diagnostics lane: a **diagnostics** source (per-item findings → events +
  counts, e.g. oxlint `--format=json`, deadnix `--output-format json`) or a
  **phase/lifecycle** source (start/stop activities → phase spans + aggregate
  metrics, e.g. pnpm `--reporter=ndjson`, nix `--log-format internal-json`).
  refines: [../requirements.md](../requirements.md) R08. A tool absent from the
  diagnostics lane (per the parent source audit) may still qualify for the phase
  lane; the two verdicts are separate.

### Admission and ranking

- **ADP-R02 Vertical-slice leaf:** A candidate adapter's leaf spec MUST pin its
  declared source flag, the source schema, stdout ownership (needs-render vs
  side-channel, R30), the derived record set mapped to the classification
  ladder, the public-safe field disposition (R27), degradation behavior, and the
  `telemetry-registry.json` additions it requires. refines: 0012.
- **ADP-R03 Conservative record derivation:** An adapter MUST NOT promote
  per-item lines (per-package progress, per-file findings) into spans; spans are
  reserved for records with a start/stop pair and stable identity (R11, T02). A
  finding or a single output line is at most an event.
- **ADP-R04 OTLP-survival ranking:** Candidate ranking weighs what survives to
  OTLP *today*. Phase spans export unconditionally; count metrics are currently
  OTLP-dropped (see ADP-R06), so a count-only adapter's live value is contingent
  until ADP-R06 resolves. A leaf MUST state its post-filter OTLP surface plainly.
- **ADP-R05 Candidate vs supported listing:** Until a leaf's vertical slice is
  implemented and its registry entries generated, the tool is listed as a
  *candidate* in the fleet matrix and its adapter name is rejected by the CLI
  (0012). Leaves for `pnpm`, `deadnix`, and `nix` are candidates.

### Aggregate representation (cross-cutting)

- **ADP-R06 Aggregate counts as command-span attributes:** An adapter's
  run-level aggregate counts (diagnostic totals, packages resolved/downloaded,
  store-hit ratio) SHOULD be attachable to the wrapper command span as
  attributes ("aggregate statistic" ladder row), so they reach OTLP without
  waiting for adapter-metric OTLP semantics. See
  [.decisions/0002-aggregate-counts-as-command-span-attributes.md](.decisions/0002-aggregate-counts-as-command-span-attributes.md).
  This is what flips count-bearing candidates (deadnix, pnpm) from
  summary-only to trace-visible.

### Testing safety

- **ADP-R07 Workspace-mutating tools are audited in isolation:** A tool that
  mutates workspace state as a side effect of running (package managers walking
  up to a workspace root; formatters writing in place) MUST be audited only
  with its mutation disarmed — read-only/check flags, `--ignore-workspace`, and
  an out-of-workspace store/target. Git-worktree isolation does NOT contain
  gitignored install state (`node_modules`, `.devenv`), so it is not sufficient
  on its own for pnpm. See
  [.experiments/0002-pnpm-ndjson-and-isolation-hazard.md](.experiments/0002-pnpm-ndjson-and-isolation-hazard.md).
