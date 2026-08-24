# 0011 Use Direct Buck Invocation and Native Evidence

Status: accepted

## Context

The TypeScript launcher interposed on Buck to add evidence flags and emitted a
custom receipt. The native-evidence design assigns trace roots, retention,
sampling, sanitization, and admission to the calling control plane, while Buck
build reports and event logs remain execution truth. The launcher therefore
duplicated an evidence schema and process boundary without owning a capability
that required interposition.

## Evidence and Argument

The launcher's only functions were adding evidence flags and emitting a custom
receipt; it held no execution authority that required interposition. The
native-evidence design already assigns trace roots, retention, sampling,
sanitization, and admission to the calling control plane, while Buck build
reports and event logs remain execution truth, so a second evidence schema
duplicated a process boundary without owning a capability.

## Options

| Option                                                             | Tradeoff                                                                              | Outcome          |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ---------------- |
| Direct Buck plus caller-owned tracing and native-evidence decoding | Keeps one execution result and lets asynchronous decoding degrade honestly            | Accepted         |
| Retain the TypeScript launcher and custom receipt                  | Preserves an existing integration surface but duplicates evidence and signal handling | Rejected         |
| Replace the launcher immediately with Rust                         | Improves process cost but preserves an unjustified interposition boundary             | Rejected         |
| Add a Rust observer only for a measured native/caller gap          | Adds a boundary only when its capability and parity can be proved                     | Admissible later |

## Decision

Invoke the pinned Buck binary directly. The calling control plane owns the
invocation span and evidence paths; versioned adapters decode Buck-native build
reports and event logs without creating independent build truth. Remove the
TypeScript launcher, custom receipt schema, package registration, and Nix
wrapper together.

An interposed Rust observer is not part of the baseline. It may be admitted for
a named capability gap only after passthrough, cancellation, signal,
stdout/stderr, evidence, sanitization, trace-parenting, and exporter-outage
controls pass. Reimplementing the removed launcher in Rust is not sufficient
justification.

## Consequences

- There is no repository launcher or durable custom receipt to maintain.
- OTLP failure and evidence-decoder limitations cannot rewrite Buck's result.
- Rich version-bound decoding may yield `NO_VERDICT` while stable native
  evidence remains available.
- Future synchronous observation work starts from a measured gap, not from the
  removed launcher API.
