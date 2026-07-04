# 0015 - Trust assertion is per-named-sink; the summary is hard-public-safe

Status: accepted

Refines the trust-gated evidence model of
[0014](./0014-command-identity-and-span-naming.md) (public-safe by default; raw
argv/cwd only into an operator-asserted private sink, requirement R27) by fixing
the assertion's granularity. Owned by [../](../).

## Context

`otel-scrape` writes **two concurrent trust-gateable sinks** in one run: the OTLP
export (a single endpoint today — no multi-OTLP mechanism) and the local summary
(`--summary-out` / `OTEL_SCRAPE_SUMMARY_OUT`, hashes-only today). Both fire on the
same run. The two sinks do not share a trust level: an operator routinely trusts a
private, access-controlled OTLP backend while the **summary is written into a
source tree that may be public** (committed, or attached to a public PR/CI
artifact). So "assert trust" must say _which_ sink — a process-wide switch cannot
express "trust the OTLP backend, not my repo-committed summary".

## Evidence and Argument

- Evidence ([experiment 0006](../.experiments/0006-trust-gate-granularity.md)):
  with a sentinel secret in a wrapped command's argv and both sinks configured, a
  gate scoped in code to the OTLP sink emitted raw `command.argv`/`command.cwd` to
  OTLP while the summary stayed `argv_hash`/`cwd_hash` (sentinel byte-absent from
  the summary); with no assertion, both sinks carried hashes only. The non-leak
  held **only because the gate was scoped to one sink** — the crux of the
  granularity question.
- A process-wide boolean cannot represent the routine mixed-trust case (private
  OTLP backend, public-repo summary), so it either under-shares (blocks the
  private backend the operator does trust) or over-shares (leaks raw into the
  public summary). Naming the sink the assertion covers is the smallest model that
  expresses the real trust topology.
- Naming sinks (`otlp`, `summary`) rather than endpoints keeps the model
  extensible: once multiple OTLP endpoints can coexist, a per-endpoint allowlist
  is an additive refinement of the same named-assertion shape, not a redesign.

## Options

| Option                                                                   | Consequence                                                                                                                                                                                                |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process-wide boolean (`OTEL_SCRAPE_TRUSTED_SINK=true` unlocks all sinks) | Simplest, but leaks raw into the summary (a public-repo footgun) and into any future second/shared OTLP endpoint. Cannot express mixed trust. Rejected as the general design.                              |
| **Per-named-sink assertion (`--trusted-sink <sink>`) (chosen)**          | The assertion names the sink it covers (`otlp`, `summary`); raw reaches only named sinks. The summary is hard-public-safe unless it is itself named. Extends to per-endpoint later without a model change. |
| Per-endpoint allowlist                                                   | The right shape once multiple OTLP endpoints can coexist; unnecessary complexity today (single OTLP target). Deferred until multi-OTLP export exists.                                                      |
| Signed/scoped capability assertion                                       | Overkill for a local wrapper; no current threat it answers.                                                                                                                                                |

## Decision

- The trust assertion **binds to a named sink**: `--trusted-sink <sink>` (e.g.
  `otlp`). A bare `OTEL_SCRAPE_TRUSTED_SINK` env may remain as an ergonomic alias,
  but it is **pinned by invariant to the single OTLP target only — never the
  summary**.
- The **local summary is hard-public-safe by default**: it never honors an OTLP
  assertion. Raw fields enter the summary only under its own explicit
  `--trusted-sink summary`.
- The load-bearing safety property is a **byte-level non-leak invariant**: a
  sentinel secret in argv must be byte-absent from every sink the operator did not
  assert. This is a required regression test, not a review-time promise.

## Consequences

- Requirement R27 and the spec (OTLP Export Boundary, Summary Evidence) state the
  per-named-sink mechanism and the summary's hard-public-safe default; DQ2 is
  closed.
- The non-leak invariant becomes a regression test: sentinel-in-argv + both sinks;
  assert (no assertion) sentinel absent from both, (`--trusted-sink otlp`) sentinel
  present in OTLP but byte-absent from the summary, plus a wrong-sink guard.
- Per-endpoint granularity is deferred to whenever multi-OTLP export lands; the
  named-sink model extends to it without a redesign.
