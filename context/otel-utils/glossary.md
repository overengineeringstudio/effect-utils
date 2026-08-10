# Glossary: otel-utils (family)

Domain language for the `otel-utils` family. Scope: the composition and its
shared primitives. Subsystem-local terms live in each subsystem's glossary
(`otel-scrape/glossary.md`, `otelite/glossary.md`); this glossary is inherited
downward and adds only the family-level terms.

**otel-core** — The shared Rust primitive library. Single owner of the wrap
primitive, span model, exporter + serializer seam, mint/join precedence,
trust-gate, CAS realization, build-id, state-dir contract, trace-url surfacing,
and re-render mechanism. Every bin is a thin composition over it.

**otel-wrap** — The universal wrap + root/session bin. Two verbs: `otel-wrap
[--root|--join|--attr k=v] -- <cmd>` and `otel-wrap root begin|end`. The
always-available floor for rooting or joining a trace. Subsumes `otel-run` and
`otel-span run`; has no standalone emit-span verb.

**otel-scrape** — The command wrapper + adapter registry bin. Composes core
primitives and adds adapters that derive structure from a tool's machine-readable
output. `nix` is an adapter here, not a separate stack.

**otelite** — The local OTLP capture / receiver bin. The assert/test end of the
family: stands up a real receiver, captures canonical OTLP to files, normalizes
for assertions.

**Adapter** — A first-party `otel-scrape` implementation that derives spans,
events, metrics, and profile links from one tool's structured output. The nix
build → span-forest producer is an adapter.

**Span forest** — The set of nested spans an adapter emits for one workload
(e.g. a nix build's derivations), joined into the enclosing trace tree through
context propagation rather than emitted as a separate trace.

**Root/session bracket** — A persisted open root span opened by `otel-wrap root
begin` and closed by `otel-wrap root end`, spanning multiple process
invocations. Its state is a persisted open span in the `sessions/` store, not a
daemon.

**Trust-gate** — The public-safe-by-default rule shared across every sink: raw
argv/cwd/local paths emit only into a sink an operator explicitly asserts private
by name; credentials and payloads never emit. Trust unlocks identity, not
secrets.

**CAS** — Content-addressed store: descriptor, object path, `cas:` URI, manifest,
pin. Immutable, hash-keyed. Reuses the top-level `content-address` contract;
`otel-core` carries the shared Rust realization. Distinct from the sessions
store's identity-addressed mutable open spans.

**State-dir** — The one on-disk root holding two passive stores: `cas/`
(content-addressed, immutable) and `sessions/` (identity-addressed, mutable open
spans). Read/written by short-lived processes; no daemon.

**Weaver seam** — A `*.contract.ts` file authoring telemetry vocabulary
(attribute identity + privacy policy) for the weaver semconv generator. The
family's telemetry SSOT; Rust producers consume generated constants + a generated
typed encoder rather than hand-rolling OTLP.

**Mint/join precedence** — The single `otel-core` rule for root-or-join: join an
inbound `traceparent`; otherwise mint a root; embrace a principled native OTEL
root rather than competing with it; fall back to the `otel-wrap` floor. Consumed
by every bin so root behavior is one rule, not several.

**Persisted open span** — A span written to the `sessions/` store while still
open, so its `begin` and `end` can be separate process invocations. Reuses the
span model; identity-addressed and mutable — the opposite of CAS.
