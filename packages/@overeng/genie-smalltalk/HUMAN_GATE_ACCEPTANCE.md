# Human gate isolated-daemon acceptance

This plan covers the q161 human-gate edges for DSL-authored `kind: 'human'` gates. It is checked against native Smalltalk revision [`d5e230201e6593a1aac00f9ff8929d0132faab49`](https://github.com/compoundingtech/smalltalk/tree/d5e230201e6593a1aac00f9ff8929d0132faab49) (abbreviated `d5e2302` below). Only behavior that the native daemon implements is tested. Blocked edges are listed here; there are no skipped placeholder tests that pretend to cover them.

## Fixture boundary

The tests are the `isolated human gate:` cases in `src/mod.unit.test.ts`. Like the existing conformance round-trip, they run only when `ST_BIN` is set to a binary built from `d5e2302` or a descendant. Each case:

- starts its own `st up` with a temporary state directory, PTY root, Unix socket, client-gateway socket, `HOME` and XDG directories, and removes them all afterwards. It never contacts a production daemon;
- authors a mission through the DSL. The mission has an agentless `authorize` step with an approve-mode human gate (`reviewer: person('person/schickling')`, explicit question), followed by a `risky` step assigned to an imported worker that `dependsOn` `authorize` being `completed`. Fixture seats run `command "true"`, `restart "never"` and `rollout "manual"`, so no worker claims or performs anything;
- passes `--as person/schickling` explicitly on every runtime gate mutation (publish, start, cancel, approve and reject). Under Johannes's R1 decision this is an **attributed record**. It is not a person credential and these tests do not claim credential-level security (stricter authentication: [smalltalk#2184](https://github.com/compoundingtech/smalltalk/issues/2184));
- reads the real request and episode IDs from the daemon: `/v1/reviews` gives the `gate.requested` claim ID and its `gate-operation/...` subject, `/v1/claims/by-id` gives the binding fields, and `st alerts ls --json` gives the `attention/...` card ID and episode. Waits are bounded polls (100 ms interval, 20 s deadline, 90 s for the timeout case) for a specific observed condition. Elapsed time never stands in for that condition.

### Ancestry-bound actor requirement

On Linux, `d5e2302` serves the local socket with `serve_unix_bound_with_ready`. That binds every caller whose process ancestry carries `ST_AGENT=agent/...` ([api.rs `harness_ancestor`](https://github.com/compoundingtech/smalltalk/blob/d5e230201e6593a1aac00f9ff8929d0132faab49/crates/st3/src/api.rs#L5961-L5986)). A bound caller cannot name a person in an `actor` body or on `/v1/reviews/` ([api.rs `guard_bound_request`](https://github.com/compoundingtech/smalltalk/blob/d5e230201e6593a1aac00f9ff8929d0132faab49/crates/st3/src/api.rs#L6206-L6284)). The unbound client-gateway socket uses the restricted fabric router, so it does not provide a supported way around this.

The person-attributed cases therefore:

1. remove `ST_AGENT` from the environment passed to the daemon and CLI, and
2. walk `/proc` ancestry before starting, using the same rule as native `harness_ancestor`. The walk stops, unbound, at the first ancestor whose `environ` or `stat` this user cannot read (`EACCES`, `EPERM` or `ENOENT`), such as a root-owned `sshd`; the daemon runs as the same user and stops at the same place. Any other read error, or a `stat` line that does not parse, fails the fixture. If a readable ancestor carries `ST_AGENT=agent/...`, the tests **fail** with an explicit message; they do not silently skip.

Run them from a shell that no st harness started, such as an operator SSH session on dev3. If the run is launched from an agent seat, the expected result is that precondition failure. These tests do not report it as a gate outcome. The existing agent-catalog round-trip keeps its previous `ST_AGENT` behavior.

## Command

From the worktree root on dev3, in an operator shell outside st harness ancestry:

```sh
ST_BIN=/path/to/st-built-from-d5e2302 devenv shell -- \
  bash -c 'cd packages/@overeng/genie-smalltalk && vitest run src/mod.unit.test.ts -t "isolated human gate"'
```

Leave out `-t` to run the whole conformance file, including the round-trip.

## Edge matrix

| q161 edge | Native `d5e2302` | Acceptance |
| --- | --- | --- |
| Critical silence | Human gates have no TTL. An unanswered request stays pending; [reconcile.rs](https://github.com/compoundingtech/smalltalk/blob/d5e230201e6593a1aac00f9ff8929d0132faab49/crates/st3/src/reconcile.rs#L7788-L7840) holds `Pending` and does not pass. | **Tested** (`critical silence holds readiness…`). The request is observed twice with no `gate.result`. `risky` stays `pending` with no claimant and no report. A wrong person (`person/someone-else`) is refused and records nothing. The named reviewer's approval records one `gate.result` (`actor`, `request`, `verdict: pass`, request evidence). `authorize` completes and `risky` becomes `ready`. Request and card close. A late conflicting reject is refused and the result count stays at one. |
| Critical silence → timeout | An agentless step's `timeout` fails it; it does not approve it ([reconcile.rs](https://github.com/compoundingtech/smalltalk/blob/d5e230201e6593a1aac00f9ff8929d0132faab49/crates/st3/src/reconcile.rs#L7735-L7751)). | **Tested** (`expired agentless checkpoint fails…`, `timeout: '2s'`). The run fails, `authorize` fails, and `risky` is `cancelled` and unclaimed. No `gate.result` exists. Request and card close. A late approval is refused. |
| Rejection | Approve mode: `rejected → fail`, and a reason is required ([api.rs `post_review`](https://github.com/compoundingtech/smalltalk/blob/d5e230201e6593a1aac00f9ff8929d0132faab49/crates/st3/src/api.rs#L11905-L12010)). | **Tested** (`rejection fails the checkpoint…`). Rejecting without a reason is refused. Rejecting with a reason records `decision: rejected`, `verdict: fail` with that reason. The run fails and `risky` is cancelled without being admitted. Card closes. A late approval is refused and the result count stays at one. |
| Stale episode / late decision after cancel | A card is per (owner, reviewer, request); `review_owner` refuses closed cards ([api.rs](https://github.com/compoundingtech/smalltalk/blob/d5e230201e6593a1aac00f9ff8929d0132faab49/crates/st3/src/api.rs#L11818-L11880)). Currency checks reject superseded generation, revision, step definition, attempt, and terminal owners. | **Tested** (`cancellation fences late decisions…`). The old run is cancelled and its request and card close. A fresh run gets a distinct run, request, operation and card. A late approval of the old card is refused, and neither episode gains a result. The fresh episode still needs its own approval, which admits only the fresh `risky`. Old approvals are never replayed. |
| Stale episode after revision or new attempt | Same request binding: `mission_revision`, `step_definition` and `attempt` are hashed into the operation. | **Partly covered.** The tests assert these binding fields against the live run on every episode. They do not drive a revision cutover (`revisions="human-only"` with revision approval) or an agentless retry, because the DSL does not model revision policy or retry. Add these once the DSL exposes them. |
| Approval-dependent readiness | `depends-on { step "authorize" completed }`. Dependencies hold only on completion ([reconcile.rs](https://github.com/compoundingtech/smalltalk/blob/d5e230201e6593a1aac00f9ff8929d0132faab49/crates/st3/src/reconcile.rs#L7590-L7640)). | **Tested** in the silence, rejection, timeout and cancellation cases: `risky` is `pending` before approval, `ready` only after the current approval, and `cancelled` after rejection or timeout. |
| Attention card | Native client attention: `attention_kind: human-gate`, `episode` = request claim, `source_id` = owning step run, `person_id`, `review_mode`, actions. | **Tested**: card ID shape, kind, source, person, mission run, mode, `review.approve`/`review.reject` present and `review.request-changes` absent, `st alerts show` episode/subject/person, and the card leaving the alert list after a decision, timeout or cancel. The rendered card `detail` text and Fractal/stui presentation are **not asserted**; nothing in the native CLI fixes them. |
| Scoped consent reuse | No native standing-consent policy. Delegation is per episode and revision ([store/delegation.rs](https://github.com/compoundingtech/smalltalk/blob/d5e230201e6593a1aac00f9ff8929d0132faab49/crates/st3/src/store/delegation.rs#L139-L233)) and does not provide scope coverage. | **Blocked upstream**: [smalltalk#2205](https://github.com/compoundingtech/smalltalk/issues/2205). |
| Out-of-scope reapproval | Needs a native scope comparison against a standing grant. | **Blocked upstream**: [smalltalk#2205](https://github.com/compoundingtech/smalltalk/issues/2205). |
| Revocation | Delegation policy replacement exists. Revoking standing mission consent and its effect on pending checkpoints does not. | **Blocked upstream**: [smalltalk#2205](https://github.com/compoundingtech/smalltalk/issues/2205). |
| Consultative fallback | No human window or named-agent fallback timer. An explicit delegated episode (`st alerts approve --for person/... --policy --instruction --quote --episode`) exists, but it requires a prior person instruction and does not fire automatically. | **Blocked upstream**: [smalltalk#2204](https://github.com/compoundingtech/smalltalk/issues/2204). The DSL does not expose criticality tiers or windows. |
| Human/fallback race | Needs the fallback above. Native `human_review_answer` picks the reviewer's answer for the request, but there is no fallback contender to race against. | **Blocked upstream**: [smalltalk#2204](https://github.com/compoundingtech/smalltalk/issues/2204). The late-decision refusals above cover only the existing single-answer behavior. |
| Feedback mode | Worker-only (`!agentless`, [mission.rs](https://github.com/compoundingtech/smalltalk/blob/d5e230201e6593a1aac00f9ff8929d0132faab49/crates/st3/src/mission.rs#L1391-L1401)). | Not part of this approve-before-risky-work acceptance. DSL schema and unit tests cover the placement constraint. |

## Out of scope

- Person credential authentication (#2184). The R1 attributed-record boundary is accepted.
- Paired client-v0 sessions and remote/loopback authority. These tests use only the trusted local Unix path. Exercise authenticated clients separately.
- Production daemon mutations of any kind.
