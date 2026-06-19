# Decision 0001 — Add-only scope, hybrid source of truth, in `notion-cli`

**Status:** accepted (grill-vrs session, derived from issue #803 + experiment 0001).

## Context

Issue #803 sketched a full convergence engine for native `status` options _and_
groups (colors, regrouping, renames, destructive policy). Experiment 0001 showed
the Notion API (2026-03-11) is effectively add-only for `status`: most of that
engine would be un-applyable.

## Decisions

1. **Scope = drift-gate + add-only apply.** Comprehensive drift detection (fully
   feasible, read-only) plus a narrow apply that only creates missing options.
   Rejected: full convergence engine (mostly dormant fail-closed diagnostics),
   diff-only with no apply (loses the one safe write), and defer/reject.

2. **Source of truth = hybrid.** Committed `.gen.ts` is the drift oracle (captures
   colors/groups/ids for free); an opt-in `statusProperties` config block is the
   authored apply intent (a derived file can't express not-yet-existing options).
   Rejected: config-only (forces hand-maintaining un-applyable colors/groups just
   for drift) and file-only (can't author ahead of live → neuters apply).

3. **Home = `@overeng/notion-cli`**, planner as a testable module beside
   `diff.ts`/`codegen.ts`; reuse the observe→classify→verify pattern and the
   fake-gateway test style, not the page-value-specific guards of
   `notion-property-write`. Rejected: new dedicated package (ceremony for modest
   scope; extract later if it grows) and folding into `notion-datasource-sync`
   (mixes page-value sync with schema-definition concerns).

4. **Apply UX = single `apply --dry-run`, loop-closing.** introspect → classify →
   (dry-run prints plan) → create missing → read-after-write verify → regenerate
   `.gen.ts` so `diff` ends clean. Fail-closed on extra remote options; color/
   group/rename surfaced as UI-action-required, never attempted. Rejected:
   separate `plan`/`apply` verbs without auto-regenerate (extra manual step,
   drift window) and a narrow `converge-status` verb (doesn't generalize).

## Consequence

Smaller, honest scope that leans on existing surfaces. The design is asymmetric
by construction (full detection, narrow convergence) and pinned to a
version-dependent external capability matrix (experiment 0001 / requirement A1).
