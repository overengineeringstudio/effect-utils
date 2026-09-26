# 0001 Resolver and CI-Owned Links

Status: accepted

Accepted 2026-09-26 (Johannes, q33 and q34).

## Context

Tempo attribute search can lag long after a trace is pushed. A PR needs an
entry point before ingest finishes, without placing a GitHub write credential
on the evidence host. V1 uploads are tailnet-only through federated ephemeral
CI identity and a Tailscale Service app capability; fork ingestion is deferred
([02](../../02-run-record/spec.md)).

## Evidence and Argument

- The [prototype](../.experiments/2026-09-25-pr-trace-access.md) opened the
  index-backed resolver, Grafana and Perfetto by ID, including a pending ID;
  attribute search lagged 45–51 minutes under load.
- The CI workflow already has a writer for its sticky report comment and a
  step summary. IDs are derivable when a record is sealed, before upload.
- The resolver link depends only on repository and PR number; its GitHub
  visibility does not grant tailnet access. A fleet-host GitHub token would
  add a separate write authority and provider-specific ingest behavior.

## Options

| Option                                                                          | Outcome  | Reason                                                                                   |
| ------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| Index-backed tailnet resolver; CI updates its existing comment and step summary | Accepted | Stable PR entry, pending state and existing CI write authority                           |
| Ingester writes a comment after ingest                                          | Rejected | GitHub write credential on the fleet host                                                |
| Resolver without a PR link                                                      | Rejected | Discoverability from the PR conversation suffers                                         |
| Public Funnel upload for fork runs in V1                                        | Deferred | Extra public ingress and credential path; the tailnet-only admission contract is smaller |

## Decision

The resolver is the canonical access point. CI adds one PR-scoped URL to the
existing sticky comment and seal-time trace links to the step summary via a
provider-neutral summary file. The evidence host holds no GitHub write
credential. Fork upload is deferred rather than pretending an unauthenticated
fork can join the trusted tailnet. Trace IDs in public CI text are allowed by
the corresponding dotfiles 0009 amendment; the comment itself only needs the
PR-scoped URL.

## Consequences

- A resolver URL can be printed before a trace is ingested; `/t/<id>` renders
  pending until a complete readback, then redirects to Grafana by ID.
- CI's provider-specific comment/summary glue stays outside the build path.
- Reviewers off the tailnet cannot use these links; fork records remain
  spool-only until an explicitly designed trust and ingress path exists.
