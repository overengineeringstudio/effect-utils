# 0007 — Multi-language targets (TS + Rust) and the first Rust consumer

**Status:** Accepted.

## Context

Layer 1 can render multiple language bindings (GEN-R06). We need to decide the initial target
set and — to keep the Rust target honest rather than speculative — a real first Rust consumer.

## Decision

**Target set: TS name constants + Rust bindings from the start** (not TS-only). The
Effect-idiomatic ergonomics come from Layer 2 (authored Schemas), so there is no separate
*generated* Effect target; the generated targets are for consumers: TS name constants/unions
(query/dashboard/consumer code) and Rust const modules (Rust consumers).

**Upstream dependency (Q7=A): pinned + Nix-hermetic.** The upstream OTel semconv registry is
pinned to an exact `@vX.Y.Z[model]` (SC-A03) and materialized as a Nix FOD input so the weaver
gate runs against a local, deterministic, **offline** copy — no network at check time. Refresh
on bump via `/sk-evergreen`. (Evidence gap: if weaver `registry check` only accepts a git-URL /
released-manifest `registry_path`, degrade to a pinned tag + a warmed `~/.weaver/vdir_cache`;
the hermetic-local-path form must be confirmed against the pinned weaver.)

**First Rust consumer: `@overeng/otel-scrape`, via a fixture now + migrate later (Q8=A).**
otel-scrape (PR #867) is the only in-repo Rust *producer* of fleet-relevant semconv names
(~25: `otel_scrape.*` spans/metrics/attributes, profile fields, schema tags, consumed at 30+
call sites), it already generates its Rust consts with sha256 freshness gating, and its own
decision 0004 explicitly wants generated bindings over hand-mirrored literals — a proven,
non-speculative target.

- **Now (this work):** develop the weaver Layer-1 Rust emitter against otel-scrape's registry
  as a **test fixture** — proves the emitter against a real 25-name registry without depending
  on #867 landing, and keeps this PR self-contained ("we lead, otel-scrape follows").
- **Later (follow-up epic):** when #867 lands, re-home otel-scrape's bespoke generator
  (its own `telemetry-registry.json` + `genie/otel-scrape-registry.ts`) onto the weaver
  Layer-1 generator (0006's "registry fragment → YAML/TS/Rust"), retiring the bespoke path.
  Tracked as cleanup epic overengineeringstudio/effect-utils#882 (blocked by otel-scrape #866
  and the weaver generator both landing).

## Consequences

- The Rust emitter is validated against a real consumer's names immediately, without coupling
  this PR to #867's merge.
- A follow-up epic owns the eventual consolidation (otel-scrape's bespoke generator → weaver
  Layer 1), so the sibling generator does not become a permanent parallel path.
- otelite is NOT a consumer (OTLP decoder; its produced names are tool-local conventions, not
  shared semconv). The private downstream registry twin is a real cross-repo consumer but
  unsuitable as the in-repo honesty check.

## Alternatives rejected

- **TS-only now (Q6=A earlier):** superseded — a real first Rust consumer (otel-scrape) exists
  and wants this, so building Rust now is non-speculative.
- **Land #867 first / migrate in this PR (Q8 B/C):** couples this PR's timeline to an in-flight
  branch and/or ships a generator we're about to replace; the fixture path avoids both.
- **Upstream fetched-at-gate / not-ref'd (Q7 B/C):** network-flaky gate / abandons portability.
