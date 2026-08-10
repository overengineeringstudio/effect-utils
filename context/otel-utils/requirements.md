# Requirements: otel-utils (family)

> Agent-authored draft pending human ratification. These family requirements are
> proposed; treat them as a draft until a human ratifies. Sibling subsystem docs
> (`otel-scrape/`, `otelite/`) are already ratified and are referenced, not
> restated, here.

## Context

- Builds on [vision.draft.md](./vision.draft.md).
- Composes the existing subsystems, each with its own ratified VRS:
  - [otel-scrape/requirements.md](./otel-scrape/requirements.md) — command
    wrapper + adapter registry.
  - [otelite/requirements.md](./otelite/requirements.md) — local OTLP capture /
    receiver.
- Introduces two new subsystems:
  - [otel-core/requirements.md](./otel-core/requirements.md) — the shared Rust
    primitive library.
  - [otel-wrap/requirements.md](./otel-wrap/requirements.md) — the universal wrap
    - root/session bin.
- Builds on top-level domain-general primitives that stay outside the family:
  - [../content-address/requirements.md](../content-address/requirements.md) —
    content-addressed identity contract (reused, not absorbed).
  - `@overeng/otel-contract` and the genie weaver `*.contract.ts` registries —
    the authored telemetry vocabulary.
- The composition (OTEL stack, resource identity, dashboards, migration,
  which-tool-where) is owned by the dotfiles observability VRS, per the amended
  [otel-scrape/.decisions/0021-observability-boundary-effect-utils-vs-dotfiles.md](./otel-scrape/.decisions/0021-observability-boundary-effect-utils-vs-dotfiles.md).

## Assumptions

- **A01 Shared primitives, thin bins:** The exporter, span model, traceparent
  mint/join, trust-gate, CAS, build-id, state-dir, trace-url surfacing, and
  re-render mechanism are shared primitives with one owner (`otel-core`), and
  every bin is a thin composition over them.
- **A02 Weaver is the telemetry SSOT:** Attribute identity and privacy policy are
  authored once in weaver `*.contract.ts` seams; producers derive from generated
  output rather than hand-authoring literals or encoders.
- **A03 W3C context is the only stitching mechanism:** Trace trees are joined
  only through W3C `traceparent` propagation, never through post-hoc
  timestamp/name correlation.
- **A04 Public building block, private consumers:** The family is a public
  repository consumed by private repositories. No sink emits raw identity or
  secrets by default.
- **A05 State is passive:** Durable family state (CAS objects, persisted open
  spans) lives in on-disk stores read/written by short-lived processes; no
  resident process owns it.

## Acceptable Tradeoffs

- **T01 One core owner, some coupling:** Centralizing primitives in `otel-core`
  couples the bins to one library version. This trades independent bin evolution
  for a single coherent contract and no re-implementation.
- **T02 First-party exporter now, SDK-reachable later:** The hot path is a
  first-party OTLP/HTTP-JSON exporter behind a serializer seam. This trades
  full-SDK breadth (metrics/logs, protobuf, batching) for a small, transparent
  trace path that a later `opentelemetry-otlp` adoption can slot behind the same
  seam.
- **T03 Improve weaver rather than route around it:** Rust producers need a typed
  encoder weaver does not yet generate. The family improves the weaver Rust
  target rather than hand-maintaining per-producer encoders — accepting upstream
  generator work as family scope.
- **T04 Two addressing models under one state-dir:** CAS (content-addressed,
  immutable) and sessions (identity-addressed, mutable open spans) share one
  state-dir but keep distinct addressing semantics; the state-dir is a container,
  not a unifying store.

## Requirements

### Family composition

- **R01 Thin bins over otel-core:** Every family bin (`otel-wrap`, `otel-scrape`,
  `otelite`) is a thin composition over `otel-core` primitives. A bin owns its
  role-specific surface (CLI verbs, adapter registry, receiver) and MUST NOT
  re-implement a primitive `otel-core` owns.
- **R02 Single primitive owner:** `otel-core` is the one owner of the shared
  primitive inventory. A primitive has exactly one normative home; bins refine
  and consume it, they do not fork it.
- **R03 Role boundaries:** `otel-wrap` owns universal wrap + root/session;
  `otel-scrape` owns command wrapping + the adapter registry; `otelite` owns
  capture/receiving. Overlapping capability (e.g. emitting a span) is owned by
  exactly one role — a standalone emit-span capability is an adapter concern
  (`otel-scrape`), not an `otel-wrap` verb.

### Universal root model

- **R04 Mint-or-join floor:** The family provides a universal root model: join an
  ambient W3C `traceparent` when one is present; otherwise mint a root.
  `otel-wrap` is the always-available floor for workloads with no orchestrator
  and no build-tool wrapper.
- **R05 Embrace native OTEL where principled:** Where a producer emits a
  principled native OTEL root (devenv, coding-agent runtimes), the family joins
  it rather than minting a competing root. The floor exists for workloads that
  lack one, not to override those that have one.
- **R06 Highest-minter, exactly one root:** The highest participant in the causal
  chain owns the root; nested participants join. Exactly one participant surfaces
  the trace to the operator per trace.

### Weaver-native telemetry

- **R07 Weaver-seam authorship:** All family telemetry vocabulary is authored as
  weaver `*.contract.ts` seams. No bin defines a bespoke registry or hand-authors
  attribute-key literals.
- **R08 Generated Rust consumption:** Rust producers consume generated `constants`
  and a generated typed Rust encoder derived from the registry (carrying the
  registry privacy policy), rather than hand-rolling OTLP attribute encoding.
  Improving the weaver Rust target to emit that encoder is a family requirement,
  not an external dependency.
- **R09 Policy travels with the encoder:** The generated encoder carries the
  registry's privacy policy annotations, so a `drop`/gate decision authored in
  the seam is generated into the producer, not hand-maintained per call site.

### Public safety

- **R10 Public-safe by default:** Every sink across every bin is public-safe by
  default: public-safe program identity, stable hashes as correlation keys, and
  bounded reason codes. Raw argv/cwd/local paths are trust-gated to an
  explicitly asserted-private sink; credentials and payloads never emit to any
  sink.
- **R11 No private leakage into the public tree:** No family doc, fixture,
  generated file, or default-emitted attribute carries private repository names,
  paths, or host identities.

### Reuse discipline

- **R12 Reuse content-address, do not absorb it:** The family reuses the
  top-level `content-address` contract for content-addressed artifacts.
  `otel-core` provides the shared Rust CAS _realization_; the _contract_ stays
  top-level and domain-general (resolves
  [otel-scrape/.decisions/0009-rust-cas-module-boundary.md](./otel-scrape/.decisions/0009-rust-cas-module-boundary.md)).
- **R13 One state-dir contract:** CAS objects and persisted open root/session
  spans share one state-dir contract with two passive stores (`cas/`,
  `sessions/`). Session/root state is a persisted open span reusing the span
  model — identity-addressed and mutable — distinct from CAS's content-addressed
  immutable objects. No session daemon.
- **R14 Reuse before invention:** A bin adds a new primitive to `otel-core` only
  when no existing primitive serves; it does not grow a private copy. Cross-bin
  seams (mint/join precedence, context env keys, trust-gate) are consumed from
  `otel-core`, keeping `otel-wrap` aligned with `otel-scrape`'s existing
  root-or-join rules rather than a divergent copy.
