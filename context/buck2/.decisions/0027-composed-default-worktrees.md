# 0027 Composed Default Worktrees

Status: accepted

## Context

All Buck execution — `buck2:check`, dist publication, editor views — requires
a composed workspace, yet no live development worktree is composed: the
day-to-day developer and agent loop pays legacy cost, produces no cache
population, and Phase-3 admissions would deliver value only in CI gates. The
composition mechanics are proven (production cp-a gate; fresh warm-cache
composition 30.6 s; unchanged no-op 0.20 s; 100% cross-worktree cache hits),
but multi-root ergonomics under many simultaneous compositions is unproven
(observed 69 s daemon cold-connect per fresh root; no N-root soak).

## Evidence and Argument

The alternative — keeping composition for gates only until Phase 4 forces the
flip — means all 36 Phase-3 admissions run with no local beneficiary and no
incremental soak, surfacing composition bugs late and all at once. Agent
worktree churn is the natural soak volume. Johannes resolved the structured
questions on 2026-09-01: flip the default for everyone (not agents-first), and
ratify at full depth in one motion rather than deferring the requirement until
after a soak.

## Options

| Decision        | Selected                                        | Alternatives rejected                                                                                              |
| --------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Default shape   | Composed-by-default after the #1056 stack lands | Agents-first (two workflow shapes to support); gates-only until Phase 4 (no local beneficiary, late bug surfacing) |
| Normative depth | Requirement now, riding #1056 sign-off          | Decision + contract rev 4 only, requirement after soak                                                             |

## Decision

Composed workspaces become the default development and agent worktree shape
for Buck-admitted repositories once the #1056 stack lands: worktree creation
tooling produces a composed workspace by default, a standalone worktree is a
declared exception, and the agent workflow contract advances to rev 4 ("your
worktree is a composition root"). The megarepo VRS carries the corresponding
requirement (MR-R11), riding the #1056 requirements sign-off event. Stale
experimental composition roots are garbage-collected.

The multi-root soak — N simultaneous composed worktrees under real use — is
the named hardening gate. If it fails, this decision is amended with the
evidence rather than silently rolled back.

## Consequences

- Phase-3 admissions pay off immediately in every worktree, and real work
  populates the shared cache continuously.
- Every session inherits the composition failure surface (daemon, watchman,
  mount lifecycle); defects surface early, while the admitted surface is
  small.
- Worktree tooling and agent skills must switch defaults in the same motion
  as the flip.
- Per-root disk cost multiplies by live worktrees until decision 0025's CoW
  economics are deliverable on the host filesystem.
