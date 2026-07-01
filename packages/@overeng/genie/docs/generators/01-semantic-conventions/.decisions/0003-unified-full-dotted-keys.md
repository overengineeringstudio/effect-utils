# 0003 — One namespaced semconv key per concept (registry key dotted; metric wire underscore)

**Status:** Accepted. Two separable sub-decisions: **(A) namespacing** — strong, the core
decision; **(B) metric wire rendering** — defaults to underscore. Transition owned by
[0004](./0004-metric-label-migration.md).

## Context

A concept can appear on more than one signal — the invoked Restate service is a span
attribute AND a metric label. Two orthogonal questions hide here, and an earlier draft
conflated them:

- **(A)** Does the concept have ONE namespaced key (`restate.service`) reused on every
  signal, or per-signal keys (span `restate.service` vs a bare metric label `service`)?
- **(B)** How is that key *rendered on the metric wire* — the default underscore mapping
  (`restate_service`) or dotted-UTF-8 (`restate.service`)?

## Decision

**(A) One namespaced semantic-convention key per concept, used on every signal.** The
registry defines `restate.service` once; the span and the metric both reference it. This is
the core, strong decision.

Rationale (OTel-native, and it applies to the *registry key*):
- **Same concept ⇒ same key.** A convention registry exists so one attribute is reused
  across spans/metrics/logs; emitting `restate.service` on the span but `service` on the
  metric for the identical concept is the drift the registry abolishes.
- **Namespacing resolves a real ambiguity.** A bare `service` collides with OTel's resource
  attribute `service.name` (the producing process). `restate.service` (the invoked service)
  is a distinct domain concept; cross-cutting process identity stays on `service.name`
  (resource). Namespacing separates them.

**(B) The metric wire renders the key as underscore (`restate_service`) by default.** The
registry key stays dotted (`restate.service`); the OTLP→Mimir default translation strategy
(`UnderscoreEscapingWithSuffixes`) maps it deterministically to `restate_service`. This
keeps 100% of (A)'s semantic wins — `restate_service` is equally namespaced and equally
collision-free with `service_name` — while avoiding the dotted-UTF-8 tax (quoted PromQL
selectors everywhere, Grafana template-var/regex assumptions, and silent
`restate.service`/`restate_service` split-brain if any hop drops the UTF-8 exporter setting).

Dotted-UTF-8 on the wire is a *separately-decidable, later* opt-in (requires fleet-wide
`NoUTF8EscapingWithSuffixes` + Mimir UTF-8), not a prerequisite and not more "OTel-native" —
the OTel value lives in the registry key, not the transport rendering.

## Consequences

- Existing metrics that emit a bare `service` label still need to move to the namespaced key
  — but this is a projection cutover bounded by retention, not a durable-state migration; see
  [0004](./0004-metric-label-migration.md).
- One catalog entry per concept (SC-R15 satisfied by construction); metric-label
  cardinality/privacy policy applies to that single entry.
- No UTF-8 dependency: works on any Mimir; queries use plain `restate_service` selectors.

## Alternatives rejected

- **Per-signal keys (short-key metric-label namespace):** permanently splits one concept
  across two keys and re-introduces the `service`/`service.name` ambiguity. Its only
  advantage (no cutover) is addressed by 0004's retention-first approach instead.
- **Dotted-UTF-8 on the metric wire (as the default):** buys nothing semantic over
  underscore, imposes a permanent fleet-wide ergonomic/tooling tax and split-brain risk.
  Deferred as a later, independent opt-in.
