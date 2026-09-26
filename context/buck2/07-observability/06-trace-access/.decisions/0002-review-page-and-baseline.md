# 0002 Review Overview and Main-Run Baseline

Status: accepted

Accepted 2026-09-26 (Johannes, q36; q35 reframed into the variants review).

## Context

A single base-revision main-run A/B is noisy, Grafana is cramped on a
phone, and an automatically frozen Vista artifact is too costly for normal
navigation.
The [variants review](../.experiments/2026-09-26-pr-page-variants.md)
compared real runs at desktop and phone widths.

## Evidence and Argument

The seven-run view identified 12 tasks faster than every main sample and
64 changes within the spread. A one-run comparison incorrectly marked two
inside-spread changes as regressions. The Grafana redirect provided too
little context at phone width, while a task-span chain provided a useful
header only when labeled as a heuristic.

## Options

| Option                                                      | Outcome  | Reason                                                     |
| ----------------------------------------------------------- | -------- | ---------------------------------------------------------- |
| V1 overview plus V4 verdict/chain header; k=7 main baseline | Accepted | Context first, phone-usable, noisy changes distinguished   |
| V1 alone                                                    | Rejected | No concise verdict or critical chain at the top            |
| V4 alone                                                    | Rejected | Jobs and top tasks need another navigation level           |
| Single base-revision main-run A/B                           | Rejected | Two observed false regressions were within the main spread |
| Redirect directly to Grafana                                | Rejected | Weak phone surface and no run overview                     |

## Decision

The PR page leads with a one-line verdict and the slowest job's critical
chain, then presents runs, jobs and top tasks with Grafana and Perfetto
buttons. The chain follows task spans until Buck's action critical path is
available, at which point the action path replaces the heuristic. The A/B
compares each task to the median of seven eligible main runs at or before
the sealed base revision and labels changes within their spread as noise.
Vista is an on-demand “freeze for review” snapshot, not a default view.

## Consequences

- Main-run evidence must be ingested and indexed, including revisions and
  matrix-qualified job identities.
- The comparison reports an incomplete or absent baseline rather than
  quietly substituting a single run for seven.
- A frozen review can outlive Tempo's 30-day window, while ordinary pages
  remain backed by the live index and trace store.

## Amendment 1 — Read-Only Freeze Handoff (q48)

Accepted 2026-09-26 (Johannes). The resolver never publishes a Vista
snapshot or accepts a mutation request. Its PR page offers a copyable
`gh-ci-utils traces <pr> --freeze` command. An agent or operator runs that
command in their own Vista context; it reads versioned resolver JSON and
publishes the frozen review there. Nothing is frozen during page load or
ingest. This resolves the former trace-access DQ1 without giving the
read-only resolver a write authority.

## Amendment 2 — Anchor the Baseline to the Sealed Base Revision

Accepted 2026-09-26 (Johannes; PR #1414 review clarification). The
baseline cutoff is `vcs.ref.base.revision`, the first parent (`HEAD^1`) of
the tested CI merge checkout, **not** a separately calculated git merge-base.
It represents the main state the PR merges into, matches the variants
review's selected base commit, and requires no additional git history.
