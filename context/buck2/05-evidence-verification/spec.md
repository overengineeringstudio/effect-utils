# Buck Evidence and OpenTelemetry Spec

This document specifies the observer and evidence-verification boundary. It
builds on [requirements.md](./requirements.md).

## Status

Draft.

## Scope

**Defines:** native evidence capture, trace shape, signal cardinality,
sanitization, optional observer admission, and verification verdicts.

**Does not define:** consumer dashboards, Collector routing, sampling policy, or
CI admission policy.

## Ownership and Trace Shape

```text
control-plane task span
  `-- buck.invocation
      |-- buck evidence-derived events/spans
      |-- BuildProduct correlation
      `-- evidence normalization

independent Nix import span
  `-- descriptor, payload, runtime-inspection outcome
```

The control plane creates the task span and propagates W3C context. Buck's
invocation is represented by the control plane directly or through an admitted
observer. Its invocation ID is a correlation attribute, not a trace identity.
The control plane and any observer record only claims supported by native
evidence.

## Signals

| Signal              | Required content                                       | Cardinality rule                            |
| ------------------- | ------------------------------------------------------ | ------------------------------------------- |
| Invocation span     | command kind, Buck result, duration, platform class    | bounded attributes                          |
| Span event/link     | target label, invocation ID, evidence location, digest | high cardinality allowed after sanitization |
| Product correlation | descriptor digest and semantic target                  | span only                                   |
| Import span         | validation phase and result class                      | bounded phase/result; digest on span        |
| Metrics             | duration, counts, failure and cache classes            | no labels, paths, IDs, or digests           |

Resource attributes identify the service and admitted build-kernel version.
Repository identity is included only under consumer policy and never leaks a
private value through the public fixture or metric vocabulary.

## Direct Baseline and Optional Observer

The baseline invokes the pinned Buck binary directly, retains native evidence,
and lets the calling control plane record the invocation and decode evidence.
No wrapper is required for aliasing, target selection, policy, or receipts.
An observer is introduced only for a measured capability gap.

```text
observe(buck_binary, argv, trace_context, evidence_paths, export_config)
  -> passthrough Buck result
  + native evidence files
  + best-effort telemetry export outcome
```

The observer adds only the documented Buck flags required to write native
evidence. It does not resolve aliases, choose targets or platforms, alter action
policy, or create a durable build receipt. Telemetry/export diagnostics use a
separate channel and cannot replace Buck diagnostics.

The former TypeScript launcher and its custom receipt are superseded by direct
Buck invocation plus caller-owned tracing and native-evidence processing; see
[decision 0011](../.decisions/0011-direct-native-evidence-observation.md). If a
measured gap later justifies a Rust observer, conformance must prove equivalence
for success, semantic failure, startup failure, signal forwarding,
cancellation, stdout/stderr byte preservation, evidence completeness,
sanitization, inbound context, and exporter outage. The observer remains an
optional observational adapter, not the successor authority to the removed
launcher.

## Evidence Adapter

The adapter has two decoding tiers:

1. Stable build-report fields establish invocation outcome, declared outputs,
   and documented aggregate facts using additive-tolerant decoding.
2. A Buck-version-bound event-log adapter derives richer action, cache, and
   materialization detail. Unknown versions are retained as raw evidence and
   marked unsupported for rich interpretation.

The adapter never treats `what-ran` or `what-materialized` summaries as more
authoritative than the native log from which they derive.

## Verdicts

| Verdict      | Meaning                                                           |
| ------------ | ----------------------------------------------------------------- |
| `PASS`       | All required evidence was observed and the predicate held         |
| `FAIL`       | All required evidence was observed and the predicate did not hold |
| `NO_VERDICT` | Required evidence or decoder support was absent                   |

An exporter outage produces its own telemetry outcome and does not change the
Buck result. If admission requires the missing telemetry or retained evidence,
the control plane maps `NO_VERDICT` to its own hold policy.

## Failure-Capable Verification

The end-to-end suite uses a real Collector-compatible capture path and proves:

- inbound trace context parents the Buck invocation correctly;
- a successful Buck product links to a successful independent import;
- a failing Buck operation remains failing through the direct path and any
  admitted observer;
- exporter failure preserves Buck behavior;
- malformed or absent evidence yields `NO_VERDICT`;
- a descriptor or payload mutation causes Nix import failure;
- high-cardinality and private values do not appear in metric attributes.
