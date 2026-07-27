# DELTA-001: only the decision layer is implemented

**Status:** Open

## Divergence

[spec.md](../spec.md) specifies a pipeline of rewrite → pack → publish → verify → repair. `@overeng/npm-release` currently implements only §Classification (the `verify` reduction) plus the provenance condition, as pure functions. It performs no IO and cannot publish or repair.

Requirements not yet met: R01–R04 (convergence), R12–R13 (repair), R14–R17 (uniform publication across publishers).

## Why it stands

Two callers exist today and neither can consume an IO-bearing implementation yet:

- `livestore` is on Effect `4.0.0-beta.99` while this repository is on `3.21.4`; the standing rule at that boundary is to isolate rather than cast across majors (see the `react-inspector` catalog exception, #937).
- `livestore-contrib` publishes from a plain Node script and is mid-migration to Effect 4.

Shipping the decision layer first closes the highest-value gap — the unchecked dist-tag, which was missing from two of the three existing implementations — without waiting on the migration, and is the substrate the full pipeline needs regardless.

## Resolution

Closes when the Effect 4 migration lands across effect-utils and its consumers, the pipeline stages are implemented here, and `livestore` and `livestore-contrib` are repointed at it (livestorejs/livestore-contrib#27).
