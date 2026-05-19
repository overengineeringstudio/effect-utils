# CI Measurements

This document specifies the shared CI measurement architecture used by generated workflows.

## Status

Active.

## Measurement Classes

| Class | Examples | Primary Question | Gate Model |
| --- | --- | --- | --- |
| `deterministic` | Nix closure size, source lines, file counts | Did a structural quantity exceed its budget? | Budget/diff against a comparable baseline. |
| `wall-clock` | Devenv shell eval, task runtime, CLI command latency | Did this PR make this operation slower on the same runner conditions? | Paired same-run base/head samples before merge blocking. |
| `diagnostic` | OTEL-traced shell eval, host context, trace breakdowns | Where did time go? | Never merge-blocking; explains measurements. |

The class is part of the observation contract through `measurementKind`.
The comparison policy is part of the gate contract through `comparisonMode`.

## Observation Contract

Every observation has a stable `id`, human `label`, semantic `group`/`path`,
numeric `value`, `unit`, `measurementKind`, and a gate `policy`.

```json
{
  "id": "devenv.shell_eval_warm.duration",
  "label": "Warm shell eval",
  "measurementKind": "wall-clock",
  "unit": "seconds",
  "value": 6.067,
  "policy": {
    "enabled": true,
    "comparisonMode": "paired",
    "minPairedSamples": 5,
    "minCurrentSamples": 5
  }
}
```

## Gate Semantics

Deterministic observations use `comparisonMode: "budget"`.
They require a comparable baseline and then evaluate configured absolute and
relative budgets. Historical variance is not treated as statistical evidence.

Wall-clock observations use `comparisonMode: "paired"` for enforced gates.
They need same-run base/head evidence before they can block a merge. Historical
baselines remain useful for trend context, but they do not prove PR causality.

Historical wall-clock comparison may be used as an advisory transition mode.
It can warn, visualize trends, and guide investigation, but it must not be the
required merge gate for noisy runner-dependent timings.

Diagnostic observations set `enabled: false` or `measurementKind: "diagnostic"`.
They appear in reports, but their impact is rendered as `diagnostic` and they
are excluded from actionable impact charts.

## Data Flow

```text
probe execution
  -> measurements.json artifact
  -> comparison engine
  -> PR summary/comment + SVG asset
  -> optional branch-protection gate
```

The artifact is the source of truth. OTEL traces and host context are evidence
attachments, not the canonical numeric store. PR comments are projections of
the artifact and can be regenerated.

## Wall-Clock Soundness

Wall-clock timings on CI runners are noisy, often non-normal, and affected by
load, caches, CPU frequency, storage, network fetches, and process scheduling.
For merge-blocking use, same-run paired measurement is required:

```text
base warmup
head warmup
base sample 1
head sample 1
head sample 2
base sample 2
...
```

The comparison operates on per-pair deltas. A wall-clock row becomes gateable
only when the configured minimum paired sample count is present. Until then,
the row is partial/advisory even if the historical raw delta is large.

## Deterministic Measurements

Nix closure size and source shape are not statistical performance probes. They
should use explicit budgets and semantic buckets. A closure-size regression is
actionable because the same installable and lock graph should produce a stable
closure. Source-shape growth is an architecture signal and should remain
advisory unless a repo defines an explicit owner-approved budget.

## Visualization

Reports must distinguish raw movement from actionable evidence.

- Raw delta and percentage are always shown.
- Actionable impact is only shown for gateable rows.
- Diagnostic rows render as `diagnostic`, not `0.00x`.
- Non-gateable paired wall-clock rows render as needing paired evidence.

This prevents a large historical wall-clock delta from looking like a proven
PR regression when the measurement lacks causal evidence.
