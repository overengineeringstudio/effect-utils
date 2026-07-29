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

## Amendment (otel-utils consolidation, 2026-07-04)

The original decision above stands, but the boundary is **sharpened** and one of
its premises is **inverted**. Both changes flow from the `otel-utils` family
consolidation (family VRS at `context/otel-utils/`; epic
schickling/dotfiles#1250, which supersedes #1238 and #1246).

**Boundary sharpened (unchanged in spirit, wider in scope).** effect-utils owns
the whole `otel-utils` **family** of building blocks, not just `otel-scrape`:
`otel-core` (the shared Rust primitive lib), `otel-wrap` (universal wrap +
root/session), `otel-scrape` (command wrapper + adapters), and `otelite`
(receiver). dotfiles owns the **composition** — folded into the existing
`context/observability/` (**no silo**: the `devenv-otel`/`nix-trace` VRS silos
retire into it): stack, truthful resource identity, dashboards, migration, and
which-tool-where. `content-address` stays a top-level domain-general primitive
the family reuses.

**Premise inverted (native-devenv-first → otel-wrap floor).** The original
decision (and #1238) made **native devenv tracing** the orchestration root and
gated the `otel-span` migration on it. The Phase-0 evidence above confirmed that
build emitted **0 bytes** — the migration was blocked. The consolidated design
inverts this: `otel-wrap` is the **universal floor** (join ambient `TRACEPARENT`
→ embrace native OTEL where principled → `otel-wrap` mints otherwise; family
decision 0006). Consequences:

- `otel-span` and `otel-run` are **retired by replacement with `otel-wrap`**, not
  merely moved to dotfiles. The task-layer floor becomes
  `otel-wrap --attr task.name=… -- <task-body>`, and the file spool is dropped.
  This is **not** blocked on native devenv OTLP; `devenv --trace-to` becomes a
  later optional upgrade the root model already admits.
- **`nix-trace` is superseded**: `nix` becomes an `otel-scrape` **adapter**
  (span-forest emission), retiring the separate `nix-trace` crate, Home Manager
  module, and `service.name=nix` peer identity. The nix adapter's telemetry
  namespace is an open question (family `open-questions.md` DQ1: extend the
  existing `nix.*` seam owned by `megarepo/nix.contract.ts` under SC-R09
  uniqueness, or take a distinct namespace).
- The Fork-B module moves this decision anticipated (`otel.nix`, `otel-span.nix`,
  `otel-run.nix` → dotfiles) are subsumed: `otel-span.nix`/`otel-run.nix` retire
  into `otel-wrap` rather than relocating, and the stack module folds into
  `context/observability/`.
- The tool-side seams this decision kept for `otel-scrape` (join via
  `TRACEPARENT`, export `OTEL_TASK_TRACEPARENT`, root-surface when root) are now
  `otel-core` primitives shared across the family, so `otel-wrap` and
  `otel-scrape` follow one mint/join precedence, not two.

## Amendment (shared devenv adapter, 2026-07-29)

The 2026-07-04 premise inversion is superseded for devenv orchestration. Native
devenv 2.1.2 now emits usable OTLP root, evaluation, and aggregate task spans.
The effect-utils-owned `devenvModules.observability` module is the single shared
repository adapter: it composes native devenv with otelite capture and provides
the reusable profile/verification tasks adopted by consumers.

`otel-wrap` remains the generic floor only where no native orchestrator exists;
it does not wrap devenv tasks. The module's effect-utils status/exec producer is
a narrow compatibility bridge, not competing orchestration. It remains until
[cachix/devenv#3037](https://github.com/cachix/devenv/issues/3037) exposes native
phase children without coupling OTLP detail to global CLI verbosity.

The stack and fleet-wide deployment policy remain dotfiles-owned. The reusable
adapter belongs in effect-utils because it is consumer-independent composition
over effect-utils' otelite and task modules.
