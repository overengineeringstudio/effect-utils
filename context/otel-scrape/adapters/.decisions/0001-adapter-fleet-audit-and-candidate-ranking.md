# 0001 - Adapter fleet audit and candidate ranking

Status: accepted

## Context

A trace of `check:quick` showed most `devenv.task.exec` spans with no command
sub-span, prompting the question "are we missing a lot of adapters?" Six tools
that each take >10ms and lack first-class OTEL were audited (experiments 0001-
0005 in this node): pnpm, oxfmt, nixfmt, deadnix, `nix` (eval/build), and the
existing oxlint reference adapter.

## Evidence and Argument

The premise ("missing a lot of adapters") is mostly **not** borne out. The audit
partitions the tools three ways:

1. **No declared structured source → not an adapter.** oxfmt and nixfmt are
   pass/fail `--check` tools; their only machine output is a path list or human
   stderr whose sole public-safe residue is one count already implied by the
   exit code. `nix:check:quick:*` does not even run `nix` (it forks `nix-hash`).
   These need the free `adapter = "none"` command span, not an adapter.

2. **Declared source exists → candidate, ranked by what survives to OTLP.**
   Adapter-derived metrics are OTLP-dropped today (summary-only), so ranking
   weighs live surface (ADP-R04):
   - **pnpm — robust, scope-narrow.** `--reporter=ndjson` yields `pnpm.resolve`
     / `pnpm.import` phase **spans** that export regardless of the metric gap.
     But value is confined to `pnpm:install`; the frozen `lint:check:lockfile`
     stream is near-empty.
   - **deadnix — worthwhile but thinnest, contingent on ADP-R06.** JSON findings
     have no lifecycle (no spans), no rule/severity/kind field, and R27 drops
     message + path. Post-filter OTLP surface is N "warning" events with a
     hashed filename + line, plus a count that only reaches OTLP via the
     span-attribute path. Materially thinner than oxlint, not a co-equal.
   - **nix (build) — worthwhile, out of `check:quick` scope.** `--log-format
     internal-json` gives real build/substitute spans, but only on the build
     lane (`nix:build` / `nix:flake:check`), and its schema stability is a DQ.

3. **First-party tools self-instrument.** The asset-import guard and any bespoke
   check emit their own spans natively if detail is wanted; they are not adapter
   work.

The single highest-value, lowest-cost outcome is orthogonal to new adapters:
wrap the slow un-adapted tasks (oxfmt ~1.86s, nixfmt ~0.45s, asset-import
~2.4s) with `adapter = "none"` for a timed pass/fail command span, available
now.

## Options

| Option | Consequence |
| --- | --- |
| Build an adapter for every >10ms tool | Manufactured ceremony; formatters/`nix-hash` have nothing structured to emit; violates R11/T02. |
| Rank candidates by OTLP-survival, wrap the rest with `none` | Effort tracks real signal; the cheap win ships first; count-bearing adapters unblocked by ADP-R06. |
| Defer all package-manager work (status quo of 0012 lane 5) | Misses the proven pnpm phase-span source that already clears 0012's structured-source condition. |

## Decision

Adopt the OTLP-survival ranking. Update the parent
[../.decisions/0012-adapter-admission-policy.md](../.decisions/0012-adapter-admission-policy.md)
candidate queue with the audited results:

- `pnpm` — promote to first candidate to implement (phase-lane source
  `--reporter=ndjson`; 0012 lane-5 structured-source condition is met). Scope to
  `pnpm:install`; leave `lint:check:lockfile` command-span-only (leaf 02 DQ).
- `deadnix` — candidate, implement together with ADP-R06 (its counts are its
  main value and are OTLP-dropped without it).
- `nix` (build lane) — candidate, gated on the internal-json stability DQ; not a
  `check:quick` deliverable.
- `oxfmt`, `nixfmt` — not adapters; wrap with `adapter = "none"`.

New adapter names stay rejected by the CLI until their vertical slice lands
(0012 unchanged on that point).

## Consequences

- The fleet grows by ~2-3 adapters, not "a lot"; the trace looks bare mostly
  because `check:quick` is dominated by pass/fail checks, by design.
- ADP-R06 (aggregate counts as span attributes) becomes a prerequisite for the
  deadnix and pnpm-count value, tracked as its own decision (0002).
- The `adapter = "none"` wrap for slow un-adapted tasks is a separate, shippable
  follow-up independent of any adapter implementation.
