# 0032 Devenv Verbs over a Buck Aggregate

Status: accepted

## Context

The repository currently has two overlapping check surfaces: devenv
`check:quick`/`check:all` aggregate repository gates, while `buck2:check` owns
admitted TypeScript targets and surviving Buck product evidence. The OQ1 bakeoff
asked whether one Buck aggregate should sit behind the existing devenv verb or
whether `buck2 test //...` should replace the devenv fan-in.

The 2026-09-12 experiment could not produce valid speed samples because the
single-member projection failed before action execution. It did establish that
`buck2 test //...` is not equivalent: admitted TypeScript packages expose
`typecheck` and `dist`, not `TestInfo`, and the recursive pattern discovers
unrelated tests. It also established the concrete residual-gate and telemetry
cost of deleting the outer task graph.

## Evidence and Argument

- Johannes accepted option A in q15 on 2026-09-12: keep the devenv verbs over
  one scoped Buck aggregate.

## Options

| Option                        | Shape                                                                                        | Benefits                                                                                                                                                                                           | Costs                                                                                                                                                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — retain devenv entry point | `devenv tasks run check:quick` depends on one scoped Buck aggregate plus residual task gates | preserves `check:quick`/`check:all`, task dependencies and status caching, Nix/lint/workspace/trace-audit/Weaver fan-in, pre-commit and skill ergonomics, and existing OTLP `span.label` semantics | immediate prototype adds 43 lines; keeps devenv evaluation and shell-entry overhead; speed is not yet measured                                                                                                       |
| B — direct Buck entry point   | delete local devenv check fan-in and run `buck2 test //...`                                  | immediate prototype net +15 lines; direct Buck target/action ergonomics and native event logs                                                                                                      | does not run the admitted TypeScript typecheck/dist surface, discovers unrelated tests, removes residual gates from the entry point, changes hooks/skills/CI callers, and has no repository Buck-to-OTLP export path |

## Decision

Select option A. Devenv owns the stable repository check interface and the
residual task graph. Buck owns deterministic admitted work behind one explicitly
scoped aggregate. `mr:*` remains outside the measured aggregate until the
composition-root defect is resolved; this decision does not decide cache
posture.

Do not use `buck2 test //...` as an alias for the admitted aggregate. If Buck
gains a typed aggregate that executes the same typecheck, dist, and test surface,
a working single-member capability projection, and an OTLP path with stable
`service.name` and `span.label` semantics, repeat the speed matrix with at least
five samples per workload before reconsidering the outer verb.

## Consequences

- `AGENTS.md`, skills, the pre-commit hook, and generated CI may continue to
  name `check:quick` and `check:all`.
- Each admitted deterministic producer must move behind the scoped Buck
  aggregate so the devenv entry point does not run duplicate producers.
- Nix checks, lint, workspace and generated-file checks, trace-audit, Weaver,
  and live lanes remain explicit devenv tasks rather than being disguised as
  Buck tests.
- The losing direct shape would save 28 net prototype lines now. Deleting the
  exported 110-line shared check module is not available without a separate
  consumer migration.
- Speed remains unresolved. Failure elapsed times are not benchmark samples.

Evidence: [2026-09-12 check-entry bakeoff](../.experiments/2026-09-12-check-entry-bakeoff.md).

## Amendment 1 (2026-09-14)

Evidence after acceptance: on a contended host the devenv _evaluation_ step —
not any task — stalled 20–60 min for five workers while every producer invoked
directly completed in seconds; dotfiles decision 0027 measured the same cost
class as our own Nix configuration (shell entry 229 s → 17.8 s after four fixes;
devenv's fixed overhead 254 ms). The verb decision stands (q25, 2026-09-14) with
two budgets attached: warm shell entry ≤ 20 s and task-run overhead ≤ 2 s,
measured per repository at n ≥ 3 on a host below load 16. Each repository
carries a `devenv-eval` residual ledger row whose dissolution is meeting those
budgets by removing the cost at its source (task/shell closure decoupling,
filtered source coercion, a recursive-input budget gate). While that row is
open, a change may be verified with the same producer the task wraps, invoked
directly, and must say so in its PR body; this is not a second verb.

## Amendment 2 (2026-09-23)

The repository-wide TypeScript authority transfer is complete. The root
`//:quick` and `//:all` targets are now the scoped aggregates described by this
decision: `check:quick` depends on `buck2:quick`, while `check:all` depends on
`buck2:all`. The old root TypeScript solution and its `ts:*` task producer are
deleted. Cross-cell provider identity remains a separate
`buck2:providers:check` prerequisite because it audits configuration rather than
producing admitted artifacts.
