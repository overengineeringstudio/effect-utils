# Requirements: npm-release

## Context

Constrained by [vision.md](./vision.md); implemented by [spec.md](./spec.md).

## Assumptions

- **A01 Caller-owned plan:** The caller supplies a resolved release plan — which packages, at which version, under which dist-tag. This system never derives one.
- **A02 Credentials at the process edge:** Registry authentication is provided by the environment the caller runs in and is never stored, persisted, or brokered here.
- **A03 npm semantics:** The registry model is npm's — immutable published versions, mutable dist-tags, and SRI tarball digests.
- **A04 Eventual consistency:** A registry may not immediately reflect a successful publish, and propagation delay is not an error.
- **A05 No rollback:** A published version is permanent in practice, so correction can only move forward.

## Acceptable Tradeoffs

- **T01 Non-atomic groups:** Group publication is not atomic and will not be simulated as such. Partial state is expected and is addressed by convergence rather than prevented.
- **T02 Digest scope:** Digest agreement can only be checked for packages this run packed. Packages already present on the registry are verified by version and dist-tag alone.
- **T03 Repair limited to what npm permits:** Correction covers dist-tag moves and publishing missing members. It cannot cover replacing an already-published artifact.

## Requirements

### Must converge on the plan

- **R01 Target state, not transaction:** Running against a plan must drive the registry toward that plan regardless of how far a previous attempt progressed.
- **R02 Idempotent operations:** Every operation must be safe to repeat. Re-running a completed release must perform no writes.
- **R03 No recovery mode:** Resuming an interrupted release must be an ordinary run, not a distinct mode or flag.
- **R04 Existing version is not an error:** Encountering an already-published version must not fail the run by itself; it must be validated rather than rejected.

### Must establish that the release is live

- **R05 Registry-observed completion:** A release must be treated as complete only when the registry serves the intended version, the packed artifact, and a dist-tag resolving to that version.
- **R06 Named dist-tag:** The dist-tag from the plan must be verified, never a fixed assumption of `latest`.
- **R07 Per-package outcomes:** Outcomes must be attributable to individual packages, so a group failure identifies which member disagreed.
- **R08 Actionable reasons:** Every non-success outcome must state the package and the observed versus intended values.

### Must separate recoverable from terminal

- **R09 Distinct outcome kinds:** Registry states that can still converge must be distinguished from states that never will.
- **R10 Terminal digest disagreement:** A registry serving a different artifact under the intended version must fail immediately and must not be retried.
- **R11 Bounded convergence:** Waiting for propagation must be bounded, and exhausting that bound must fail the release.

### Must repair what it detects

- **R12 Correct on detection:** Where npm permits correction, a detected divergence must be corrected within the same run rather than reported for manual action.
- **R13 Repair is verified:** A correction must be followed by the same verification as an initial publish; applying it is not evidence it took effect.

### Must hold uniformly across publishers

- **R14 Single implementation:** Publication semantics — dependency rewriting, packing, publishing, provenance, verification, repair — must be implemented once and shared, not per repository.
- **R15 Provenance by default:** Publishing must emit provenance wherever the execution environment can mint it.
- **R16 Self-consistent artifacts:** Workspace-internal dependency ranges must be rewritten to exact published versions before packing, so a published artifact resolves without the workspace.
- **R17 Onboarding cost:** Adding a publisher must require supplying a plan and credentials only.

### Must be verifiable without a registry

- **R18 Separable judgement:** The decision layer — classifying registry state against intent — must be usable and exhaustively testable without network access, a registry, or a process runtime.
- **R19 Dependency-free core:** The decision layer must not depend on a network client, filesystem, or application framework, so it remains consumable from any runtime.
