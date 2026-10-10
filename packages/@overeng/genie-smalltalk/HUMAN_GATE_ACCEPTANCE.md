# Human gate isolated-daemon acceptance

This plan covers the q161 human-gate edges for DSL-authored `kind: 'human'` gates. It is checked against native Smalltalk revision [`d5e230201e6593a1aac00f9ff8929d0132faab49`](https://github.com/compoundingtech/smalltalk/tree/d5e230201e6593a1aac00f9ff8929d0132faab49) (abbreviated `d5e2302` below). Only behavior that the native daemon implements is tested. Blocked edges are listed here; there are no skipped placeholder tests that pretend to cover them.

## Fixture boundary

The four `isolated human gate:` cases in `src/mod.unit.test.ts` require
`ST_FIXTURE_BIN`, built from exact native revision `d5e2302` with the upstream
`test-support` feature and distinct `st3-fixture` binary target. The existing
production conformance round-trip is independently enabled by `ST_BIN`. Each case:

- starts its own `st up` with precreated private (0700) state, PTY and HOME/XDG directories, Unix and client-gateway sockets, and a private (0600) `st3/config.toml` selecting only those paths. It removes them afterwards and never contacts a production daemon;
- authors a mission through the DSL. The mission has an agentless `authorize` step with an approve-mode human gate (`reviewer: person('person/genie-human-gate-test')`, explicit question), followed by a `risky` step assigned to an imported worker that `dependsOn` `authorize` being `completed`. Fixture seats run `command "true"`, `restart "never"` and `rollout "manual"`, so no worker claims or performs anything;
- uses a dedicated fixture person configured only in that private daemon, not Johannes or a production person. Human-gate mutations explicitly name `--as person/genie-human-gate-test`. Under Johannes's R1 decision this is an **attributed record**, not a person credential; the fixtures do not claim credential-level security (stricter authentication: [smalltalk#2184](https://github.com/compoundingtech/smalltalk/issues/2184));
- reads the real request and episode IDs from the daemon: `/v1/reviews` gives the `gate.requested` claim ID and its `gate-operation/...` subject, `/v1/claims/by-id` gives the binding fields, and `st alerts ls --json` gives the `attention/...` card ID and episode. Waits are bounded polls (100 ms interval, 20 s deadline, 90 s for the timeout case) for a specific observed condition. Elapsed time never stands in for that condition.

### Ancestry-bound actor requirement

Production `st` serves the local socket with `serve_unix_bound_with_ready`.
A managed caller cannot name a person in an `actor` body or on `/v1/reviews/`
([api.rs](https://github.com/compoundingtech/smalltalk/blob/d5e230201e6593a1aac00f9ff8929d0132faab49/crates/st3/src/api.rs#L5961-L5986),
[guard](https://github.com/compoundingtech/smalltalk/blob/d5e230201e6593a1aac00f9ff8929d0132faab49/crates/st3/src/api.rs#L6206-L6284)).
An isolated config alone does not authorize a managed agent to speak as its
fixture person.

These **gate-semantic tests** instead use upstream's explicit test-support
primitive. Only the separately compiled `st3-fixture` binary initializes the
process-local fixture state; production `st` has no environment/argument switch
([test_support.rs](https://github.com/compoundingtech/smalltalk/blob/d5e230201e6593a1aac00f9ff8929d0132faab49/crates/st3/src/test_support.rs#L1-L18),
[main.rs](https://github.com/compoundingtech/smalltalk/blob/d5e230201e6593a1aac00f9ff8929d0132faab49/crates/st3/src/main.rs#L4646-L4650)).
That native test mode deliberately disables host ancestry for its test listener
([api.rs](https://github.com/compoundingtech/smalltalk/blob/d5e230201e6593a1aac00f9ff8929d0132faab49/crates/st3/src/api.rs#L5778-L5784)).
It is confined here to fresh private daemons with a synthetic person. No
environment identity clearing, production-listener fallback or real person
impersonation is used. `withIsolatedSt` explicitly selects `production` or
`fixture`; neither mode falls back to the other.

**This proves gate semantics, not production person authentication.** The
production `ST_BIN` round-trip preserves and records the managed caller's own
`ST_AGENT`. Stronger person-only approval remains [smalltalk#2184](https://github.com/compoundingtech/smalltalk/issues/2184).
To exercise actual production person attribution, a genuine operator shell
outside managed ancestry or an authenticated paired person session is still
required; the test-support binary provides no evidence for that boundary.

## Command

From the worktree root on the designated verification host, wait for five-minute
load below 80 and disable Nix remote builders. Supply the separately built,
pinned fixture binary explicitly; do not substitute it for the production binary:

```sh
NIX_CONFIG='builders =' ST_BIN=/path/to/production-st \
  ST_FIXTURE_BIN=/path/to/d5e2302-test-support/bin/st3-fixture \
  gate-slot --class gate -- devenv shell -- \
  bash -c 'cd packages/@overeng/genie-smalltalk && vitest run src/mod.unit.test.ts'
```

This runs the pure/type authoring assertions, round-trip and four real
human-gate fixtures. The source-side dependency view must be materialized first
through the repository's `buck2:editor:publish` task when it is absent.
Leave both binary variables unset for the pure authoring suite. `ST_BIN` alone
enables production conformance; `ST_FIXTURE_BIN` alone enables the four synthetic
human-gate semantic cases. Required `check:quick` and focused package typecheck
remain independent pre-ready checks.

## Edge matrix

The table describes implemented fixture assertions, not an execution receipt.
Record actual pinned-binary run results against the exact PR head in the PR.

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
