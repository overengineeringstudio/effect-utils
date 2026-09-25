# Megarepo Requirements

Status: ratified.

The "why" of this sub-VRS is [vision.md](./vision.md). In one line: megarepo
(`mr`) exists so that several independently
developed git repositories can be worked on as one environment without any of
them having to know it — arranging them on disk from a declared intent. Every requirement below is
derived from an already-ratified source (a migrated decision record, a buck2
decision that names `mr`, or an observable contract of the shipped tool); the
derivation is cited per requirement. Nothing here is new policy.

## Context

- The composition contract this tool serves is
  [../buck2/05-composition/requirements.md](../buck2/05-composition/requirements.md)
  (`COMP-R*`). Those requirements constrain `mr` and are **referenced, never
  restated**: that source mounts are never Buck cells belongs there. This
  document covers only what `mr` owns and 05-composition does not say.
- Terms: [ontology.md](./ontology.md). Mechanism: [spec.md](./spec.md).
- Decision records: [.decisions/](./.decisions/), migrated from the package on
  2026-08-31.

## Assumptions

- **MR-A01 Composition contract upstream:** The Buck-facing correctness
  requirements are owned by `COMP-R*`. `mr` is an implementation of them plus
  the obligations here; where the two appear to conflict, `COMP-R*` wins and
  this document is wrong.
- **MR-A02 Host-global shared store:** The store is shared by every megarepo on
  the host, and other workspaces are assumed to exist and to be invisible at
  the moment any given command runs.
- **MR-A03 Two-file configuration:** `megarepo.kdl` carries intent and is
  hand-written; `megarepo.lock` carries resolved state and is written only by
  `mr`. No requirement below assumes the tool may edit intent.

## Acceptable Tradeoffs

- **MR-T01 Registry is a cache:** The liveness registry is a cache, not an
  authoritative index — a workspace contributes only after running an `mr`
  command. The cost is over-retention of store worktrees; it is accepted
  because the failure direction is keeping disk, not losing work.
- **MR-T02 Legacy mount shape retained:** Retired with the composed workspace shape
  (principal q5, 2026-09-25).
- **MR-T03 Reclamation lags:** Grace windows and archive retention mean the
  store holds reclaimable bytes for weeks. Accepted: the alternative is
  deleting on weaker evidence.

## Requirements

### Must apply the lock exactly, or refuse

- **MR-R01 Pinned-materialization postcondition:** When `mr apply` completes
  successfully, every `refs/commits/<sha>` worktree it was responsible for is
  at the sha the lock records. A pinned materialization left drifted is an
  error naming both revisions and a non-zero exit, never a silent skip. Branch
  worktrees are excluded, because co-development deliberately moves `HEAD`
  ahead of the lock. (Decision
  [0009](./.decisions/0009-apply-drift-postcondition.md).)
- **MR-R02 Canonical source admission:** Retired with the composed workspace shape
  (principal q5, 2026-09-25).
- **MR-R03 Atomic workspace application:** Retired with the composed workspace shape
  (principal q5, 2026-09-25).
- **MR-R04 Mount identity is verified, not assumed:** Retired with the composed workspace shape
  (principal q5, 2026-09-25).
- **MR-R05 Overlay surface is declared:** Retired with the composed workspace shape
  (principal q5, 2026-09-25).

### Must never lose work

- **MR-R06 Cross-megarepo liveness veto:** A store worktree present in any
  registered workspace's live set is never deleted, regardless of how
  reclaimable it independently looks. Before destructive work every registered
  workspace is reconciled from disk, an unreadable workspace keeps its
  last-known paths, and the veto is re-checked under lock immediately before
  acting. (Decisions
  [0001](./.decisions/0001-reclaim-cold-worktrees-in-default-gc.md),
  [0008](./.decisions/0008-ref-mismatch-clean-archive.md).)
- **MR-R07 Reclamation requires positive evidence:** Deletion is gated on
  evidence, in order — default-branch guard, liveness veto, staleness
  (GitHub PR merged or closed), lossless floor, grace timers — and capture is
  two-phase: archive first, reap only after the retention TTL. Any absent,
  unavailable, or failed signal resolves to keep. A dry run persists no
  observations, and a first real run against an empty ledger archives nothing.
  (Decision 0001.)
- **MR-R08 Ambiguity is archived, never repaired:** A `ref_mismatch` worktree
  may be archived only on a path distinct from the `mr store fix` repair
  behavior, which mutates branch identity. That path requires the stronger
  clean/lossless floor in place of the PR-state signal, preserves both the path
  ref and the actual `HEAD` branch in the archive record, and deletes neither
  branch ref. (Decision 0008.)

### Must stay operable at fleet scale

- **MR-R09 Bounded memory and measured concurrency:** `mr store gc` and
  `mr store status` run in bounded memory over a store of any size: large
  subprocess output is streamed or parsed incrementally, dirt is a bounded
  signal rather than a full file list, and per-repo work is
  process-and-discard. Repo concurrency is bounded and its default is set by
  measurement, not by guess, with the operating point verifiable from
  telemetry. (Decision
  [0007](./.decisions/0007-bounded-memory-and-throughput.md).)
- **MR-R10 Non-determinism is injected:** The boundaries that make safety
  results host-dependent — wall-clock time and GitHub PR state — are injected
  services, so every gate above is testable deterministically and no test
  depends on host git configuration, host identity, or platform path
  resolution. (Decision
  [0006](./.decisions/0006-test-contract-and-validation.md).)
- **MR-R11 Standalone worktree is the only development context:** A
  development or agent worktree is a standalone worktree; `mr` creates no
  composed workspace (principal q5, 2026-09-25, superseding the declared
  exception of buck2 decision
  [0027](../buck2/.decisions/0027-composed-default-worktrees.md)).
- **MR-R12 Routine application is shape-preserving:** Retired with the composed workspace shape
  (principal q5, 2026-09-25).
- **MR-R13 Explicit composition happens directly at creation:** Retired with the composed workspace shape
  (principal q5, 2026-09-25).