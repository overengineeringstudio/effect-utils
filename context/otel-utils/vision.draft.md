# Vision: otel-utils (family)

> Agent-authored draft, pending human ratification into `vision.md`.
> Per VRS rules `vision.md` is human-only; this draft holds the proposed family
> vision until a human ratifies it. Do not treat this file as the protected
> vision anchor.

## The Problem

- **Problem 1 — OTEL tooling is fragmented into parallel stacks:** Command
  wrapping, root/session minting, build-tool observation, and local capture each
  grew as a separate tool with its own exporter, its own context handling, and
  its own idea of identity. The same primitives — OTLP export, a span model,
  traceparent mint/join, content-addressed artifacts — are re-implemented per
  tool instead of shared.
- **Problem 2 — There is no single composition contract:** The tools overlap at
  the seams (who mints the root, who owns which span level, which env carries
  context) but nothing states the composition once. Coherence is maintained by
  convention and re-derived per integration.
- **Problem 3 — Universal coverage has no floor:** Not every workload runs under
  a build-tool wrapper or an orchestrator. Bare shell commands, agent Bash
  calls, and CI steps have no minimal, always-available way to root or join a
  trace, so coverage is patchy exactly where causation is hardest to
  reconstruct.
- **Problem 4 — Telemetry vocabulary is hand-authored per producer:** Each
  producer hand-rolls attribute keys and OTLP encoding. There is one authored
  registry contract (weaver `*.contract.ts` seams), but its Rust target emits
  names only, so Rust producers hand-encode and drift is caught only at runtime.
- **Problem 5 — Session/root state has no shared home:** Persisting an open root
  span across process boundaries (so `begin` and `end` are separate
  invocations) and storing content-addressed artifacts are both durable-state
  needs, solved ad hoc per tool rather than by one state-dir contract.

## The Vision

- **One composable OTEL stack.** A shared Rust library, `otel-core`, owns the
  primitives; thin role bins compose them. `otel-wrap` is the universal wrap and
  root/session floor, `otel-scrape` is the command wrapper plus adapter
  registry, `otelite` is the capture/receiver end. Each bin is a thin
  composition over `otel-core`, not a parallel re-implementation. (Problems 1, 2)
- **A universal root model.** Join an ambient `TRACEPARENT` where one exists;
  embrace native OTEL roots where a producer emits them principled; fall back to
  `otel-wrap` as the floor everywhere else. One workload becomes one trace tree
  regardless of how deep or heterogeneous the process fan-out. (Problems 2, 3)
- **Weaver-native telemetry.** All family telemetry is authored as weaver
  `*.contract.ts` seams; Rust producers consume generated constants and a
  generated typed Rust encoder rather than hand-rolling OTLP. Improving weaver's
  Rust target is a first-class family goal, not incidental. (Problem 4)
- **A shared, passive state-dir.** One state-dir contract holds content-addressed
  artifacts (`cas/`) and persisted open root/session spans (`sessions/`). Both
  are passive on-disk stores read and written by short-lived processes; there is
  no session daemon. (Problem 5)
- **Public-safe by construction.** The family is a public building block used by
  private repos. Public-safe identity is the default at every sink; raw
  identity is trust-gated, and secrets never emit.

## What This Is Not

- Not a telemetry backend, collector, dashboard, or alerting system.
- Not a second telemetry schema alongside the weaver `*.contract.ts` registries.
- Not a session daemon or resident agent — session/root state is passive files.
- Not the fleet composition. effect-utils owns the building blocks; the
  composition (stack, identity, dashboards, which-tool-where) lives in the
  dotfiles observability VRS.
- Not a new home for content-addressing. `content-address` stays a top-level
  domain-general primitive the family reuses.

## Success Criteria

1. A new OTEL producer is built by composing `otel-core` primitives, not by
   re-implementing an exporter, span model, or context handling.
2. One workload across agent / shell / CI / build tool / nix yields one trace
   tree, with no separate per-tool export stack.
3. A bare command anywhere can root or join a trace through `otel-wrap` with no
   orchestrator and no build-tool wrapper present.
4. Family telemetry is authored once as weaver seams; Rust producers consume
   generated constants and a generated encoder with no hand-rolled OTLP.
5. Content-addressed artifacts and persisted open spans share one state-dir
   contract, with no daemon and no second addressing scheme.
6. Public-safe identity holds at every sink by default across every family bin.
