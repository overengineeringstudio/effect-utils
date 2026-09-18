# DELTA-001: Second context re-executes unchanged actions

Status: open

## Divergence

BUCK-R06 and REUSE-R02 require an unchanged admitted target to re-execute zero
actions in a second same-platform context at the identical revision. The S8
sandbox proof at `f8528ed38e` re-executed 633 actions locally despite a warm
shared remote cache.

## VRS

- [BUCK-R06](../../requirements.md) defines any same-platform local
  re-execution at an identical revision as a key-stability regression.
- [REUSE-R02](../requirements.md) requires zero local re-execution and requires
  the violation to be triaged as a defect rather than accepted as noise.
- [The S8 experiment](../../.experiments/2026-09-18-standalone-buck-root.md)
  records the sandbox boundary, event-log summary, action classes, and the
  informational aarch64 observation.

## Implementation

A `bwrap` context with a fresh `HOME`, `TMPDIR`, hostname, uid/gid, and
`buck-out` reported 556 cached actions, 633 local actions, 561 other actions,
and zero remote actions. The locally executed classes were `package_tree`,
`pnpm_store_entry`, `pnpm_store_scc`, `pnpm_store_view`, `tsgo_emit`, and
`tsgo_typecheck`.

The sandbox retained the identical source revision, Nix store, Nix database,
system certificates, network, and cache endpoint. The proof was not tuned to
hide local execution. The experiment does not identify the unstable key input;
root-cause investigation is outside S8.

## Direction

update implementation

## Resolution Signal

- Repeat the S8 sandbox boundary at an identical revision with a warm shared
  cache.
- The unchanged `//:quick` target reports zero local actions across every
  admitted action class.
- The run reaches green within the BUCK-R07 fresh-context budget.
- Record the stable identity mechanism and remove this delta.
