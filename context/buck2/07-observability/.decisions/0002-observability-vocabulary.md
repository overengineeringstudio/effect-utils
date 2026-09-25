# 0002 Observability Vocabulary

Status: accepted

Accepted 2026-09-25 (decisions q19, q20, q21; Johannes), against a domain
reference map of the federated vocabularies (buck2, otel-scrape, caller
plumbing, dotfiles observability, OTel semconv, Buck2 upstream; Bazel/BEP as
prior art only).

## Context

The lane needs words for three families: the run hierarchy (what is
correlated), the delivery pipeline (what carries telemetry off-host), and the
derived trace artifacts (what lands in Tempo). The fleet already overloads
"invocation" (Bazel's unit, the Buck log header, a wrapped process, a CI run),
"command" (five senses), "build id" (OTel `app.build_id`, binary fingerprints,
the Buck trace UUID), "evidence" (five senses), "replay" (transport vs.
Buck's Superconsole UI), and "trust" (three gates).

## Evidence and Argument

- OTel CICD semconv (Release Candidate) already defines pipeline run, task
  run, and worker; the dotfiles CI→trace seam (run = root span, jobs =
  children, seeded context) matches it. "CI is unspecial" (BUCK.OBS-R03)
  wants the same unit locally and in CI — the semconv words stretch to cover
  local runs, which the conventions neither forbid nor anticipate.
- Buck upstream owns the domain layer: command, action, executor stage, event
  log, critical/slowest path, final materialization, the `BUCK_WRAPPER_UUID`
  env contract. Borrowing beats coining everywhere it exists.
- No prior word existed for the portable unit or the derived trace; those two
  anchors had to be coined once.

## Options

| Family        | Options considered                                                                                | Outcome                        |
| ------------- | ------------------------------------------------------------------------------------------------- | ------------------------------ |
| Run hierarchy | OTel CICD everywhere / own neutral anchor / keep `ci.*` vendor keys                               | OTel CICD everywhere (q19)     |
| Delivery unit | run record / telemetry bundle / evidence bundle                                                   | run record (q20)               |
| Trace family  | trace view / trace projection / shaped trace; daemon wait / cross-command wait / unattributed gap | trace view + daemon wait (q21) |

Rejected: "evidence bundle" ("evidence" already has five senses; BUCK-R12 owns
the proof meaning), "telemetry bundle" (undersells native evidence), "trace
projection" (two other fleet senses), "shaped trace" (vague), vendor `ci.*`
keys (GitHub-shaped, contradicts BUCK.OBS-R03).

## Decision

The ontology ([ontology.md](../ontology.md)) is normative. In brief:

- **Run hierarchy:** pipeline run, task run, worker (OTel `cicd.*` /
  `cicd.worker.*`) for local _and_ CI runs; provider only as a resource
  attribute. Buck layer keeps upstream words.
- **Delivery anchor:** **run record** (manifest + span spool + native
  evidence) with verbs seal → upload → ingest → archive; **event-log adapter**
  (0011's versioned adapter, qualified) is the converter.
- **Trace family:** **trace view** with **full view** and **critical view**
  (default) followers, plus **view threshold** and **view cap**; **daemon
  wait** for the blocked-on-peer-command concept.
- **Banned words:** "invocation" (except the upstream InvocationRecord
  artifact), "build id" (collides with `app.build_id`; say Buck trace id or
  wrapper trace id), "replay" (Buck owns `log replay`).

## Consequences

- The existing `ci.*` vendor keys and `devenv.task.exec` naming carry a
  migration commitment (open question OQ4), not an immediate rename.
- Every new doc and attribute in this lane uses the qualified forms; the
  flagged ambiguities in the ontology are load-bearing.
