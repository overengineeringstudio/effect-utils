# Trace Access Spec

This document specifies PR trace discovery, the review page, stable trace
links, and the agent-facing JSON contract. It builds on
[requirements.md](./requirements.md); [05](../05-ingest-and-archive/spec.md)
owns the ingest index and the `buck2-evidence` binary that serves this surface.

## Status

Draft.

## Scope

**Defines:** read-only resolver routes, review presentation, A/B semantics,
CI link publication, and agent consumption.

**Does not define:** upload admission or fleet service deployment (dotfiles),
trace derivation (01/04/05), index writes and retention (05), or GitHub CI
workflow implementation (genie/workflow-report).

## Resolver and Stable Links

```text
sealed record ── upload/ingest ──> index.sqlite (05)
      │                                │ read only
      └─ seal-time links ──> CI      buck2-evidence resolver
                               sticky comment ──> /pr/<owner>/<repo>/<number>
                               step summary            ├─ HTML review page
                                                       ├─ versioned JSON
                                                       └─ /t/<trace-id> ──> Grafana / pending
```

The tailnet resolver is the canonical entry; it reads indexed IDs and state,
not Tempo search (fresh attribute search can lag tens of minutes). The PR URL
is stable before any upload. Routes below use the same index-backed response;
HTML escapes every evidence-sourced string. Slash-separated `owner` and
`repo` are repository path components, not arbitrary URLs; `number` is a
positive decimal PR number. A trace ID is exactly 32 lowercase hexadecimal
characters (the W3C trace-id shape); reject malformed IDs, never interpolate
them into an unvalidated upstream URL. This route namespace belongs to the
private resolver service, not to a globally registered web protocol.

| Route | Contract |
| --- | --- |
| `GET /pr/<owner>/<repo>/<number>` | PR overview, newest indexed runs first; no matching record means an explicit not-yet-uploaded state. |
| `GET /pr/<owner>/<repo>/<number>.json` | Same identities, status, verdict, comparison, and links as versioned JSON below; not HTML scraped by agents. |
| `GET /run/<run-key>` and `.json` | One indexed run, its jobs and trace links; the run key is the index's opaque URL-encoded identity, including attempt, not a bare provider run number. |
| `GET /compare/<owner>/<repo>/<number>` and `.json` | A/B view computed from PR and eligible main runs indexed for that repository. |
| `GET /t/<trace-id>` | Redirect to Grafana Explore by ID with the indexed time window only after **that view's** by-ID readback; a job's full-view trace may be ready within the job-end target while its distinct shared run/critical trace stays pending until the roster settles and cumulative readback converges. Before readiness display status (`sealed`, `uploaded`, `ingesting`, `missing_spans`, or `pending`) without an empty Grafana result. Unknown ID means no matching sealed record reached the index. |
| `GET /t/<trace-id>/chrome.json` and `/perfetto` | Convert the indexed trace for a one-click Perfetto handoff. The browser opens the Perfetto viewer; this is not public resolver access or a public trace export endpoint. |

No GitHub write token is present on the fleet host. An indexed run and its
trace IDs remain queryable when Tempo's 30-day window expires, but `/t/` must
report expired trace data rather than imply that archive identity grants
live trace retention. Archive re-ingest, if requested, follows 05.

## PR Review Page

```text
verdict + slowest-job critical chain
runs (latest attempt visible) ──> jobs ──> top tasks
     │                             │         │
     └──────── Grafana / Perfetto trace buttons ────────┘
A/B: each task vs median of eligible main runs; main spread = noise band
freeze for review: copy `gh-ci-utils traces <pr> --freeze` -> own Vista context
```

The one-line verdict summarizes direction and meaningful task changes; do
not classify an inside-spread change as a regression or improvement. The
slowest job's chain initially follows task-span dependencies and is labeled
as such; when Buck's action critical path is available, use that path rather
than implying task-span chronology is Buck's action critical path. Runs,
then their jobs, then top tasks remain navigable at phone width, with trace
buttons beside the relevant level. The page is an overview, not an automatic
redirect to Grafana (which is cramped on a phone). The read-only page shows
a copyable `gh-ci-utils traces <pr> --freeze` command, not a publishing
endpoint. An agent or operator executes it in their own Vista context:
the CLI reads the same versioned resolver JSON, constructs and publishes
the frozen Vista review snapshot under that caller's authority. Page
loads, index reads, and ingest never trigger publication.

For each PR run, locate the merge-base revision recorded at seal time. Select
the latest **k=7** indexed main-branch pipeline runs whose revision is at or
before that merge base, never after it. Compare like-for-like job keys
(including matrix dimensions) and task names. For each task, calculate the
median of its eligible main-run durations; display their observed minimum to
maximum as the main spread. A PR duration inside that closed band is marked
`noise`; outside it, show the signed delta from the median and mark it beyond
spread. Show the sample count per task, including when fewer than seven runs
exist or a task is absent in a run; with no matching samples display
`baseline unavailable` instead of a fabricated delta. The run selector must
use recorded revision ancestry/order, not wall-clock proximity alone.

## CI Publication

```text
seal (02) ──> deterministic IDs / PR URL ──> log + provider-neutral summary file
                                        GitHub CI adapter ──> step summary
                                        workflow-report ──> existing sticky comment
```

Seal produces links without waiting for upload; `/t/` can therefore explain
pending status. The uploader writes the summary file when configured, and a
GitHub-specific adapter copies it into the job step summary. On PR runs, CI
adds **one PR-scoped resolver link** to the existing workflow-report sticky
comment (not a new comment per job); fork PRs keep that workflow's no-write
guard. Trace IDs may be printed in public CI text, per the corresponding
fleet observability decision amendment, but the sticky comment needs only
the PR URL. The build/record path never calls the GitHub API.

## Agent JSON Contract

The resolver's `buck2-trace-access/v1` schema is the agent contract, with
JSON served under `.json` next to the HTML routes. Required keys are stable
within v1; optional new fields may be added without changing their meaning.
Clients reject an unknown major schema with a clear compatibility error.
The example values are synthetic; never treat URLs as authentication tokens.

```json
{
  "schema": "buck2-trace-access/v1",
  "repository": "example/project",
  "changeId": "42",
  "status": "ingested",
  "verdict": { "text": "One task faster beyond main spread", "criticalChainKind": "task-spans", "criticalChain": ["prepare", "build"] },
  "runs": [{
    "runId": "ci/provider/example%2Fproject/123/1",
    "attempt": 1,
    "buck2.vcs.merge.revision": "abcdef0123456789abcdef0123456789abcdef01",
    "status": "ingested",
    "trace": { "id": "0123456789abcdef0123456789abcdef", "url": "/t/0123456789abcdef0123456789abcdef" },
    "jobs": [{ "key": "build[os=linux]", "status": "ingested", "durationMs": 120000,
      "traces": [{ "kind": "critical", "id": "0123456789abcdef0123456789abcdef", "url": "/t/0123456789abcdef0123456789abcdef" },
        { "kind": "full", "id": "fedcba9876543210fedcba9876543210", "url": "/t/fedcba9876543210fedcba9876543210" }],
      "topTasks": [{ "name": "build", "durationMs": 90000 }] }]
  }],
  "comparison": { "baselineCount": 7, "tasks": [{ "jobKey": "build[os=linux]", "name": "build",
    "sampleCount": 7, "medianMs": 100000, "spreadMs": [92000, 108000],
    "prMs": 90000, "deltaMs": -10000, "classification": "beyond-spread" }] }
}
```

`status` distinguishes `pending`, `sealed`, `uploaded`, `ingesting`,
`ingested`, `missing_spans`, `incomplete`, and `expired` where the index has
that state. A missing expected job is a job-level error, distinct from spans
lost by Tempo; an attempt without closure **or** with an unsettled expected
job is `incomplete` after its six-hour idle timeout. A shared run trace
must not advertise complete until all expected jobs settle and the
cumulative expected span-ID union
passes readback at the published index generation. `trace` and `comparison`
may be `null` when their inputs are unavailable. HTML and JSON share the
same indexed run selection and A/B classification. `gh-ci-utils traces <pr>`
reads this JSON to print runs/jobs, verdict, top deltas and IDs, with next
`gcx traces get -d tempo <id> --llm -o json` and Perfetto actions.
`gh-ci-utils traces <pr> --freeze` consumes this JSON and publishes via the
invoking agent's or operator's Vista context; it does not POST to the
resolver. The resolver URL is configured, never a hard-coded fleet hostname;
off-tailnet failure states that tailnet access is required. The agent skill
points to these commands, not a second bespoke CLI.

## Conformance

- A read-only page exposes the copyable freeze command; executing it as an
  authorized Vista caller publishes a snapshot from versioned JSON without
  any resolver mutation or implicit page-load publication.
- After a second job's write removes a first job's spans from Tempo, the
  shared run status reverts to `missing_spans`; a missing roster job is
  displayed as an error span and an absent close eventually shows
  `incomplete`.
- An indexed but not yet ingested ID serves pending; complete readback serves
  a working Grafana link; unknown and expired IDs report distinct states.
- A main sample above the merge base never enters the A/B baseline; a PR
  duration within the main spread is noise even when it differs from median.
- An HTML and JSON request for one PR present identical IDs, status and
  comparison; a synthetic evidence field containing markup stays text.
- Evidence: [PR access prototype](./.experiments/2026-09-25-pr-trace-access.md),
  [page variants](./.experiments/2026-09-26-pr-page-variants.md), decisions
  [0001](./.decisions/0001-resolver-and-ci-links.md),
  [0002](./.decisions/0002-review-page-and-baseline.md), and
  [0003](./.decisions/0003-versioned-agent-contract.md).
