# 0011 Use Direct Buck Invocation and Native Evidence

Status: accepted

## Context

The TypeScript launcher interposed on Buck to add evidence flags and emitted a
custom receipt.

## Evidence and Argument

The native-evidence design assigns trace roots, retention,
sampling, sanitization, and admission to the calling control plane, while Buck
build reports and event logs remain execution truth. The launcher therefore
duplicated an evidence schema and process boundary without owning a capability
that required interposition.

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
- Future synchronous observation work starts from a measured gap, not from
  the removed launcher API.

## Amendment 1 — 2026-09-25: the adapter is concrete, and the caller helper

is not an interposer

The observability lane's bakeoffs refined both halves of this decision
([07-observability](../07-observability/spec.md); decisions q10, q11).

- The "versioned adapter" is a **direct-decode Rust crate**: it decodes
  `*_events.pb.zst` directly (zstd + varint-length-delimited protobuf, a
  vendored `data.proto` pinned to the newest fleet producer, critical path
  in-band) rather than consuming `buck2 log show` output, which it keeps
  only as a fallback. It is post-hoc: conversion happens at ingest after the
  command exits, from an explicit per-invocation `--event-log`. This adds no
  observer process — the "admissible later" Rust observer of this decision
  remains unadmitted.
- The caller-side helper — an `otel-span` **buck2 mode** that opens the
  command span, validates the W3C context, exports the caller-derived
  `BUCK_WRAPPER_UUID`, and appends a sidecar line — is environment and span
  preparation only. Buck remains a direct child; nothing interposes on
  stdio, signals, or the result. The interposition bar this decision set is
  unchanged.

Evidence: the
[03-event-log-adapter decisions](../07-observability/03-event-log-adapter/spec.md)
(decode bakeoffs B1/B2/B2b, capture B3/B4) and
[01-run-identity](../07-observability/01-run-identity/spec.md)
(correlation B5).
