# @overeng/notion-property-write

Pure, entrypoint-neutral property-write safety core for Notion sync.

## What It Provides

- `PropertyWriteProof` — a data-only proof carrying hashes and verdicts (never
  live handles or IO) that a higher layer has gathered the evidence needed to
  safely write a single Notion property.
- `DesiredPropertyWrite` — the property edit a caller wants to apply.
- `evaluatePropertyWrite(proof, desiredWrite)` — a pure, synchronous guard
  evaluator that returns the first blocking decision (or `allowed`) from an
  ordered set of property-write invariants.
- `PropertyWriteGuardName` / `PropertyWriteGuardDecision` — the guard
  vocabulary and tagged-union outcome.

## Boundary

This package depends only on `@overeng/notion-effect-schema` plus `effect` as a
peer. It performs no IO: it never fetches a schema, reads a page, or computes a
hash. Proof providers in higher packages (notion-md, notion-datasource-sync)
gather evidence and build a `PropertyWriteProof`; this core just reads the proof
and decides. Keeping it free of any client / HttpClient / `Effect.Service`
dependency is a structural invariant — the same core decides identically for the
standalone and datasource entrypoints.
