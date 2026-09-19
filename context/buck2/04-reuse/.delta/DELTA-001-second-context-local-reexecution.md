# DELTA-001: Second context re-executes unchanged actions

Status: open

## Divergence

BUCK-R06 and REUSE-R02 require an unchanged admitted target to re-execute zero
actions in a second same-platform context at the identical revision. The S8
sandbox proof at `f8528ed38e` re-executed 633 actions locally. A controlled
normal-then-sandbox pair at `948d397a2e` reduced that result to the one failing,
non-cacheable `tsgo_typecheck` action, but the required zero-local result still
does not hold.

## VRS

- [BUCK-R06](../../requirements.md) defines any same-platform local
  re-execution at an identical revision as a key-stability regression.
- [REUSE-R02](../requirements.md) requires zero local re-execution and requires
  the violation to be triaged as a defect rather than accepted as noise.
- [The S8 experiment](../../.experiments/2026-09-18-standalone-buck-root.md)
  records the sandbox boundary, event-log summary, action classes, and the
  informational aarch64 observation.
- [The follow-up experiment](../../.experiments/2026-09-19-second-context-key-stability.md)
  records the controlled run order and identical remaining action digest.

## Implementation

The controlled normal-context build reported 648 cached and 547 local actions.
After that build populated the shared cache, the fresh sandbox reported 1,192
cached and one local action. The five previously missed classes other than
`tsgo_typecheck` reused the cache completely.

The remaining local action is `megarepo:typecheck`. It reaches the pre-existing
`preferSchemaOverJson` warning, which tsgo treats as exit 2 in both contexts.
The normal and sandbox cache queries have the identical remote action digest
`76ecc7d96ba19cabf193f3e0fc6f48509e214e0b4b1560f75c5dca70c2cf5297:142`,
and their command arrays are byte-for-byte equal. No context-dependent declared
input was found. The action runs again because the failed normal execution does
not provide a successful cache entry.

## Direction

update implementation

## Resolution Signal

- Repeat the S8 sandbox boundary at an identical revision with a warm shared
  cache.
- The unchanged `//:quick` target reports zero local actions across every
  admitted action class.
- The run reaches green within the BUCK-R07 fresh-context budget.
- Record the stable identity mechanism and remove this delta.
