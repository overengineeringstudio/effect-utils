# DELTA-001: Imported research uses a parallel companion taxonomy

Status: open

## Divergence

The verification subtree still contains imported snapshots under `.research/`,
which is not a current VRS companion kind. The snapshots preserve useful source
evidence but deterministic strict validation does not route or inspect them.

## VRS

- The repository VRS contract permits source-backed external facts under
  `.reference/` and project-generated experiments under `.experiments/`.
- [Verification evidence intake](../spec.md) requires imported findings to
  graduate into fixtures, focused experiments, benchmarks, pending evidence, or
  explicit rejection rather than remain a parallel authority.

## Implementation

`07-verification/.research/README.md`,
`downstream-dependency-profile-research.md`, and `proof-catalog.md` retain the
historical imported taxonomy. The focused consolidation experiment records
which conclusions have already graduated or been superseded.

## Resolution Approach

Route source snapshots with provenance to `.reference/`; split project-generated
proofs into focused `.experiments/` or executable evidence; then remove the
`.research/` directory and this delta without creating another research ledger.

## Direction

update implementation

## Resolution Signal

- Every retained source fact has reference provenance or focused executable
  evidence.
- No normative decision depends only on `.research/` content.
- The `.research/` directory and this delta are removed.
