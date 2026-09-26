# 0003 Resolver JSON as the Agent Contract

Status: accepted

Accepted 2026-09-26 (Johannes, q41 and q47).

## Context

Agents already use `gh-ci-utils` for CI. The resolver serves the same
indexed facts as HTML without relying on delayed backend search; a scratch
CLI demonstrated compact by-ID discovery.

## Evidence and Argument

The [prototype](../.experiments/2026-09-25-pr-trace-access.md) returned a
run/trace listing in 0.38 s and handed off to `gcx traces get` by ID for
span-level inspection. Parsing rendered HTML or inventing a second Rust CLI
would fragment the access contract.

## Options

| Option | Outcome | Reason |
| --- | --- | --- |
| Versioned resolver JSON + `gh-ci-utils traces <pr>` + skill note | Accepted | Existing CI agent entry point and a durable typed consumer contract |
| New standalone Rust CLI | Rejected | Another command to discover for the same JSON |
| Raw JSON without CLI | Rejected | Agents would repeatedly reinterpret the response |

## Decision

The resolver JSON is the versioned agent contract. `gh-ci-utils traces <pr>`
reads it, prints the PR's runs/jobs, verdict, top deltas, trace IDs, and
next commands for `gcx`/Perfetto. An agent skill note points to this command.
Off-tailnet access fails explicitly instead of reporting no traces.

## Consequences

- The resolver must version and maintain its JSON schema and keep its
  identity/status/comparison consistent with HTML.
- The TS CLI is a consumer of the Rust service's contract, not another
  implementation of its indexing or comparison logic.
