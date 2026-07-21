# 0002 Workspace-Relative Store Is The Default Location

Status: accepted

## Context

The CI pnpm store/home/state can live under a runner-temp path (per-job,
outside the workspace) or at a workspace-relative path. The setup/restore/save
steps are called argument-free by every consumer, so the default location is
what actually ships fleet-wide.

## Decision

Default the store, home, and state to stable workspace-relative paths, set in
the shared atoms.

## Rationale

- One addressable location across a job's steps and across save/restore, keyed
  by the composed cache key.
- Changing an atom default propagates to every argument-free caller on repin
  with no per-repo edit — the auto-converging half of the contract.
- It makes the restore-after-checkout ordering invariant explicit rather than
  incidental: a gitignored workspace store is wiped by the pre-checkout clean, so
  restore must follow checkout (`DMP.CICACHE-R02`).

## Consequences

- Consumers must order restore after checkout; the invariant is documented in
  the spec and enforced by the setup step ordering.
- The first rollout of the workspace-relative default is a one-time cold store
  rebuild per consumer, acceptable per `T01`.
- Home was already workspace-relative; this aligns store and state with it.
