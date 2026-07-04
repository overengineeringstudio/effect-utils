# Spec: otel-core

How the shared Rust primitive library realizes the primitives every `otel-utils`
bin composes. Builds on [requirements.md](./requirements.md) and refines the
family composition contract [../spec.md](../spec.md) — which is the single
normative home for the primitive inventory and the mint/join precedence. This
spec details the library's realization; it references those rather than
restating them.

## Status

Draft.

## Scope

**Defines:** the Rust package boundary; the primitive module layout; the
extraction path from `otel-scrape`; the CAS realization boundary; the state-dir
on-disk shape.

**Does not define:** the primitive contracts themselves (see
[../spec.md](../spec.md#primitive-inventory)); any bin's CLI surface or adapter
registry.

## Package Boundary

`otel-core` is a Rust library crate under `packages/@overeng/otel-core`. It
follows the `otelite`/`otel-scrape` pattern: committed Cargo metadata,
package-local Nix build file, flake outputs where a build artifact is exposed,
and devenv quality-gate integration. It is a library, not a bin — the bins
(`otel-wrap`, `otel-scrape`) depend on it; `otelite` depends on it for the span
model + serializer seam.

## Module Layout

Each module is the realization of one primitive; the contract for each lives in
[../spec.md](../spec.md#primitive-inventory).

```
otel_core::wrap            spawn/capture/passthrough + lifecycle span + context export
otel_core::span            the span model (in-memory + persisted-open-span shape)
otel_core::export          OTLP/HTTP-JSON hot path + serializer seam
otel_core::context         traceparent mint/join precedence + child env keys
otel_core::trust           trust-gate (public-safe default; per-named-sink assertion)
otel_core::content_address CAS realization (mirrors the top-level contract)
otel_core::build_id        shared build/version identity
otel_core::state_dir       state-dir contract: cas/ + sessions/ passive stores
otel_core::surface         terminal-only trace-url surfacing
otel_core::render          terminal-only adapter re-render
```

`export` and `span` (attribute-carrying) consume the generated typed Rust encoder
(family decision 0003); they are registry-agnostic (requirement R02) — they
encode attribute data, not a fixed vocabulary.

## Extraction Path

`otel-core` is extracted from `otel-scrape`'s private implementation. The order
is a dependency layering, not a schedule:

| Layer | Primitives | Dependency |
| ----- | ---------- | ---------- |
| Registry-agnostic | `content_address`, `context`, `wrap` | Extract cleanly; no encoder dependency. |
| Weaver-native | `export`, `span` (vocabulary), `trust` | Fold in behind the generated Rust encoder (decision 0003). |

The registry-agnostic primitives carry no telemetry vocabulary and move first
because they have no encoder dependency. The weaver-native primitives encode
attributes and so land once the generated encoder exists. `otel-scrape` consumes
`otel-core` in place of its private modules as each primitive lands; behavior is
preserved by the existing `otel-scrape` conformance tests.

## CAS Realization Boundary

`otel_core::content_address` is the shared Rust realization that
[otel-scrape decision 0009](../otel-scrape/.decisions/0009-rust-cas-module-boundary.md)
deferred until a second Rust consumer existed. The family satisfies that trigger,
so the wrapper-private `otel_scrape::content_address` module is promoted into
`otel-core` where both `otel-scrape` (artifact lane) and `otel-wrap` (state-dir)
consume it.

The realization mirrors the top-level [content-address contract](../../content-address/spec.md)
— descriptor, object path, `cas:` URI, manifest, pin — and carries the same
conformance vectors (fixed digest / URI / manifest / pin-name). The **contract
stays top-level and domain-general**; `otel-core` does not absorb it, and the TS
`@overeng/content-address` package remains the reference implementation. Two
implementations, one contract, conformance-vector-bound.

## State-Dir On-Disk Shape

`otel_core::state_dir` owns the one state-dir contract (family decision 0007).
Two passive stores, no daemon:

```
<state-dir>/
  cas/
    <digest-derived object paths>      # content-addressed, immutable, write-once
    <manifest + pins>
  sessions/
    <session-id>                        # a persisted open span (span model),
                                        # identity-keyed, mutated until closed
```

- `cas/` uses `content_address` object paths; objects are write-once and pinned.
- `sessions/` holds one persisted open span per session/root id, written by
  `otel-wrap root begin`, mutated in place, and closed by `otel-wrap root end`.
  It reuses `otel_core::span`, **not** CAS — its addressing is identity-keyed and
  mutable, the opposite of CAS's content-keyed write-once model.

Both stores are read/written by short-lived processes. The library provides the
open/mutate/close and read/write/pin operations; it holds no resident state and
runs no supervisor.

## Reused-and-Referenced Contracts

- Mint/join precedence, trust-gate rule, exporter seam, and the primitive
  inventory: [../spec.md](../spec.md). This spec does not restate them.
- CAS contract: [../../content-address/spec.md](../../content-address/spec.md).
- Telemetry vocabulary + generated encoder: the weaver `*.contract.ts` seams and
  family decision 0003.
