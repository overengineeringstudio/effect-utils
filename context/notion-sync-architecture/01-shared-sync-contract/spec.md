# Spec - Shared Sync Contract

This document specifies the mechanism-free sync contract vocabulary. It builds
on [requirements.md](./requirements.md).

## Status

Draft. The shared sync contract currently contains vocabulary and invariants
only.

## Contract Shapes

Candidate contract shapes:

- `SurfaceIdentity`
- `DigestSpace`
- `BaseSnapshot`
- `DesiredSnapshot`
- `ObservedSnapshot`
- `Checkpoint`
- `GuardResult`
- `ConflictResult`
- `FallbackReason`
- `MutationCommand`
- `ApplyResult`

No package is required to share a planner, renderer, cache, database, or gateway
implementation by this spec.
