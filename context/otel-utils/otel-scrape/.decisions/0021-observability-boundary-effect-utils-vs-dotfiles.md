# 0021 — Observability boundary: effect-utils owns the tool; dotfiles owns the architecture

Status: accepted

## Context

The `otel-scrape` work grew a full observability system spanning several layers:
the orchestration layer (task/shell/eval spans), the command layer (`otel-scrape`
wrapping concrete tools), the adapter layer, the local OTEL stack
(collector/Tempo/Grafana), the traced-run UX (root-trace surfacing, a Grafana
URL), and resource/identity concerns. A critique surfaced that much of this is
fleet/architecture, not tool contract, and that it had accreted inside
`context/otel-utils/otel-scrape/`.

Two inputs settle the boundary:

- **dotfiles#1238** (the endorsed long-term target): retire `otel-span`; **native
  devenv tracing** (`devenv --trace-to` / `DEVENV_TRACE_TO`) owns orchestration
  spans; `otel-scrape` owns concrete command spans; tool-phase spans become
  adapter-owned beneath the command span; delete the file-spool transport.
- **The repo-ownership principle:** dotfiles is the VRS home for high-level
  architecture; effect-utils holds targeted, clearly-bounded tools/building
  blocks that must be shared across megarepos.

## Decision

**effect-utils owns the shared building blocks with a clear tool boundary:**

- `otel-scrape` — the command wrapper + adapter framework (Rust CLI) and its
  contract (`context/otel-utils/otel-scrape/`: wrapper, process observation, CAS, semconv,
  registry, adapters). Agnostic to _who_ provides the task layer.
- `trace.instr` (in `nix/devenv-modules/tasks/lib/trace.nix`) — the thin
  command-instrumentation glue that opts a concrete tool into `otel-scrape`.

`otel-scrape` keeps only its **tool-side** obligations at the seams: it joins a
trace via `TRACEPARENT`, exports `OTEL_TASK_TRACEPARENT` for children (0018), and
surfaces the trace id/URL **when it is the root** (0020). It does not own task
semantics, the stack, or the URL template.

**dotfiles owns the high-level observability architecture** (VRS home there,
alongside #1238):

- the 3-layer target (native-devenv orchestration → `otel-scrape` command spans →
  adapter spans/events), and the `otel-span` → native-devenv migration;
- the OTEL **stack** (collector/Tempo/Grafana), **resource identity** (truthful
  `vcs.*`/`service.version`/`deployment.environment` vs the collector stamping a
  foreign host identity — R1), and the **collector** config;
- the **traced-run UX** — `otel-run`, the root-URL template and Grafana/collector
  coherence (R2). The URL template already belongs to the fleet root-env (R26).

**Fork B (module ownership): the devenv-otel _modules_ move to dotfiles.**
`nix/devenv-modules/otel.nix` (the stack), `otel/otel-span.nix` (retiring), and
`otel/otel-run.nix` (traced-run UX) are fleet-architecture; their target home is
dotfiles. effect-utils is then left with only `otel-scrape` + `trace.instr`.
This is the **target**, executed as part of the #1238 migration — it is **not**
an immediate move: today those modules still live in effect-utils and work, and
they cannot be removed until (a) native devenv tracing is usable and (b) the
stack is provided by dotfiles.

## Evidence

Phase-0 probe (this session): devenv 2.1.2 exposes `--trace-to` with
`otlp-grpc`/`otlp-http-*` formats, but the pinned build lacks the
`otlp-http-json`/`otlp-http-protobuf` cargo features and `--trace-to … tasks run`
emitted **0 bytes** to stderr/file. So the native trace contract is **not usable
in the current build** — the migration is gated on a devenv packaged with OTLP
features. See the dotfiles architecture VRS / #1238 for the migration plan.

## Consequences

- `context/otel-utils/otel-scrape/` is sharpened to the tool boundary; architecture-level
  concerns (stack, identity/R1, traced-run/R2, orchestration, migration) are
  referenced _out_ to the dotfiles observability VRS, not owned here.
- Decisions 0018 and 0020 keep only their otel-scrape tool-side; their
  architecture-side (task-layer source, stack/URL template) is dotfiles-owned.
- The pending fixes R1 (resource identity) and R2 (Grafana coherence) are
  **dotfiles** work, not effect-utils changes.
- The adapter fleet (`context/otel-utils/otel-scrape/adapters/`) is unaffected — it is pure
  tool contract and stays in effect-utils.
