# Execution model: orchestrator drives per-milestone implement → adversarial review → refine → commit/push

Status: proposed

Each implementation phase is one milestone. The orchestrator (main agent)
validates, routes, and keeps the epic and decision log current, but does not
write production code. Per milestone:

1. Spawn implementation sub-agent(s) scoped to the phase's primary file areas.
2. Gate locally: `dt check:quick` then `dt check:all --no-tui` (plus targeted
   live where the phase's correctness is live-only).
3. Spawn independent review/critique sub-agent(s) (adversarial: correctness,
   VRS-trace, simplicity, fail-closed coverage). The review agent is distinct from
   the implementation agent.
4. Refine from review; re-gate.
5. Commit + push; update the #775 epic checklist and the decision log if a new
   decision arose.

`axe work` records milestone start/update/handoff. Epic checkboxes are the
durable public progress surface.

This process follows directly from the user's instruction: "you only orchestrator,
validate and manage the plan… on each milestone commit and push and have sub
agents review, verify, critique and refine."

## Considered Options

| Option                                                                             | Result   | Reason                                                                                                                                                       |
| ---------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Orchestrator + per-milestone implement → adversarial review → refine → commit/push | Selected | Maximizes throughput via parallelism; keeps main context clean; adversarial review catches correctness and VRS-trace issues; directly from user instruction. |

## Consequences

The main context remains focused on orchestration rather than implementation
details. Each milestone is independently verified before the next begins.
Independent review agents cannot be influenced by the same reasoning that
produced the implementation.
