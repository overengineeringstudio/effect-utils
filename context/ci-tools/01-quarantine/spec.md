# Test Quarantine Specification

This document specifies the quarantine contract and its CLI surface. It builds
on [requirements.md](./requirements.md).

## Status

Active

## Scope

This spec defines:

- the quarantine entry and ledger schemas
- the expiry rule, including malformed dates
- the two resolution guards applied before an announcement
- the announcement channels and their division of labour
- the `ci-tools quarantine` command surface
- what a consuming repository is responsible for

This spec does not define:

- which targets a repository quarantines, or how it composes its test
  invocations — see the consumer's own verification docs
- how a consumer obtains the `ci-tools` binary
- the deploy-preview and workflow-report surfaces ([../spec.md](../spec.md))

## Architecture

```
consuming repository                    ci-tools quarantine
────────────────────                    ───────────────────
ledger (source of truth)  ──JSON──▶  validate  ─────────────▶ exit ≠ 0 when an
  target / reason                                              entry has expired
  issue  / expires                                             (R04, R05)

test invocation fails
  under a stated policy   ──argv──▶  announce  ──┬──▶ job summary file  (R06)
  key + label                                    │
                                                 └──▶ annotation, stderr (R07)
                                        │
                                        └─ resolve: key exists (R03)
                                                    entry.target == label (R02)
```

The consumer decides *whether* a failure is tolerated; this subsystem decides
*what that means* and *what CI is told*. The two commands are independent — a
repository with no tolerated failures still runs `validate`.

## Entry and Ledger

An entry carries exactly the four fields that make a suppression accountable
(R01). All are non-empty; a missing or blank field fails decoding.

```ts
QuarantineEntry = {
  target: NonEmptyString   // what is quarantined — package path, provider key, suite name
  reason: NonEmptyString   // why its failures are currently tolerated
  issue:  NonEmptyString   // issue tracking the underlying problem
  expires: NonEmptyString  // YYYY-MM-DD; past this date the ledger check fails
}

QuarantineLedger = Record<string, QuarantineEntry>   // keyed by quarantine key
```

The ledger reaches this subsystem as a JSON file. A consumer that wants a
compile-time guarantee — a quarantine key being unwritable without a checked-in
entry — keeps a typed source of truth and generates the JSON from it; that is a
consumer concern, not part of this contract.

## Expiry

An entry is expired when its `expires` is lexicographically before today, **or**
when it is not a well-formed `YYYY-MM-DD` date (R05).

The malformed case is not defensive padding. Comparison is lexicographic, so any
free-form string (`'someday'`) sorts above every real date and would never
expire — turning a typo into exactly the permanent, invisible quarantine that
R04 exists to prevent. Failing closed is the only reading that preserves the
requirement.

## Resolution Guards

`announce` resolves a key against the ledger before emitting anything:

| Condition | Result |
| --- | --- |
| key has no entry | error (R03) |
| `entry.target != label` | error (R02) |
| otherwise | announce |

A consumer's type checker may already reject an unknown key, but a cast, a
JavaScript caller, or a hand-written CLI invocation reaches here regardless —
so the guards are enforced at this boundary rather than assumed upstream.

## Announcement Channels

A tolerated failure is announced twice, with different jobs:

| Channel | Content | Role |
| --- | --- | --- |
| Job summary file | `- Quarantined failure: <label> — <reason> Tracking <issue>, expires <expires>.` | Durable record, survives log truncation |
| stderr | `::warning title=Quarantined test failure::<same summary>` | Surfaces in the run's annotations |

Both carry the full summary, so either alone is readable (R06). The summary file
path comes from `--summary-file`, defaulting to `$GITHUB_STEP_SUMMARY`; when
neither is set, only the annotation is emitted.

**The annotation goes to stderr, and that is a workaround.** GitHub documents
workflow commands on stdout, and on a plain shell step that works. stderr is
required only because devenv discards a task's stdout (A04,
[cachix/devenv#3038](https://github.com/cachix/devenv/issues/3038)), which the
upstream reproduction also shows carries no protocol data — task outputs travel
via `DEVENV_TASK_OUTPUT_FILE`.

<!-- TODO(cachix/devenv#3038): when devenv forwards task stdout and the fixed
     version is pinned everywhere, drop T02, restate R07 as "the documented
     stdout channel", and retire `overeng/no-stdout-workflow-command` and
     `lint:nix:workflow-commands`. Tracked in the Blockers database. -->

Announcement failure is fatal (R08): the caller is expected to propagate a
non-zero exit rather than continue tolerating the failure.

## Command Surface

```
ci-tools quarantine validate --ledger <path> [--today <YYYY-MM-DD>]
ci-tools quarantine announce --ledger <path> --key <key> --label <label>
                             [--summary-file <path>]
```

| Command | Exit 0 | Exit ≠ 0 |
| --- | --- | --- |
| `validate` | no entry expired | an entry expired or malformed; message names each with its issue |
| `announce` | announced on both channels | key unknown, target mismatch, or ledger unreadable |

`--today` exists so the expiry rule is testable without waiting for a date to
pass; it defaults to the current UTC day.

## Consumer Contract

A consuming repository:

1. keeps a ledger and generates the JSON this subsystem reads (A02)
2. decides which invocations are blocking and which are quarantined (A03)
3. runs `validate` as a required check, so expiry is enforced (R04)
4. calls `announce` when a quarantined invocation fails, and fails its own run
   if that call fails (R08)

Requirement trace: R01–R08.
