# 2026-07-02 — Metric-label dual-emit bridge (OTTL), generated from a registry annotation

Durable record distilled from `tmp/weaver-experiment/proto/bridge/` (deletable). Validates the
central-collector dual-emit bridge of decision 0004 (its infra realization is tracked
downstream/private) — that a metric-label rename can be a zero-downtime, scoped, generated
transform.

## Hypothesis

A metric-label rename (`service` → `restate.service`, wire `restate_service`) can be bridged
by a central collector OTTL `transform` that COPIES the old attribute to the new one (both on
the wire) during a window, SCOPED to named metrics so unrelated datapoints are untouched — and
that transform config can be GENERATED from a registry `bridge` annotation, not hand-written.

## Method

A generator (`generate.ts`) takes `{ newKey, was, context: 'datapoint'|'resource', scopeMetrics }`
+ a phase (`dual-emit` | `sunset`) and emits a runnable collector transform config (both an
OTel-Collector YAML and a River-config `transform` block). The
GENERATED config was run unmodified; an OTLP/HTTP JSON payload with a SCOPED metric
(`restate.invocations`, datapoint attr `service=checkout`) and an UNSCOPED metric
(`unrelated.thing`, `service=other`) was POSTed; output inspected via file/debug exporters.

## Results (✅ — identical on both a real OTel Collector (YAML) and a River-config collector)

- **dual-emit:** the scoped `restate.invocations` datapoint ends with BOTH `service=checkout`
  and `restate.service=checkout`; `unrelated.thing` keeps ONLY `service` — **scoping holds**
  (the over-broad-rewrite risk is handled by the `where metric.name == …` guard derived from
  `scopeMetrics`).
- **sunset / contract form:** a second statement `delete_key(datapoint.attributes, "service")
  where metric.name == "restate.invocations"` drops the old key → the scoped datapoint ends
  with ONLY `restate.service`; unscoped untouched. This is the copy→rename contraction.
- **generation path proven:** every OTTL statement the collectors ran came from the generator;
  the scope guard (single → bare clause, multi → `(metric.name=="a" or "b")`) and the attribute
  paths (from `context`) are derived from the annotation.

## Load-bearing findings

- **OTTL context syntax differs by collector.** The OTel Collector accepts the context-inferred
  flat form (statement strings, no `context:`) with qualified paths. a River-config collector's transform block REQUIRES the `context` attribute in the `metric_statements`
  block. Emitting `context = "datapoint"` + **qualified** `datapoint.attributes[...]` /
  `metric.name` runs warning-free on the River collector AND makes the statement body **byte-identical**
  across both collectors — only the `context =` wrapper differs. The generator emits this form.
- **`resource_to_telemetry_conversion` not needed** for a datapoint attribute
  (`datapoint.attributes["service"]` resolves directly). If the source is resource-level, set
  `context: 'resource'` (generator supports it) and revisit conversion at the export stage.
- **`error_mode`**: `propagate` was used for the proof (surfaces failures); production dual-emit
  should use `ignore`/`silent` so a malformed datapoint can't tank the pipeline.

## Conclusion

The scoped dual-emit bridge works end-to-end and is cleanly **generatable from a registry
annotation** — so it is another *derived target* of the generator (config produced here;
executed by downstream (private) infra). Folded into decision 0004 as the `bridge` annotation → collector
OTTL fragment; the running/deployment is out of scope for this repo.
