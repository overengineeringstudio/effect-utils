# Buck2 Evidence Spec

This document specifies the current Buck2 dependency materialization evidence
boundary. It builds on [requirements.md](./requirements.md).

Status: **Draft**

## Requirement Trace

| Section        | Requirements               |
| -------------- | -------------------------- |
| Boundary       | DMP.BUCK-R01, DMP.BUCK-R04 |
| Evidence Shape | DMP.BUCK-R02, DMP.BUCK-R03 |
| Future Builder | DMP.BUCK-R05, DMP.BUCK-R06 |

## Current Boundary

```text
package manifests
lockfile
workspace file
toolchain policy
profile policy
        |
        v
dependency-profile.evidence.json
        |
        v
Buck2 task graph
```

The current Buck2 target emits evidence. It does not run dependency installation
or shared-store repair and does not claim build authority for its consumers.

[Decision 0010](../.decisions/0010-select-buck2-build-authority.md) selects
Buck2 as the repo-local build authority. The difference between the current
evidence-only boundary and that decision is recorded in
[DELTA-003](../.delta/DELTA-003-buck2-single-build-authority.md).

## Evidence Shape

```json
{
  "schema": "dependency-profile-evidence/v0",
  "profileId": "pnpm:...",
  "inputs": [
    { "path": "package.json", "sha256": "..." },
    { "path": "pnpm-lock.yaml", "sha256": "..." }
  ],
  "policyDigest": "sha256:...",
  "materializationAuthority": "devenv-pnpm-tasks",
  "buckAuthority": "evidence-only"
}
```

Paths are repo-relative and safe for public artifacts.

## Future Builder

A Buck2 action may materialize dependencies only when it:

1. declares the same profile inputs;
2. disables lifecycle scripts by construction;
3. proves that its output satisfies the accepted consumer contract;
4. uses immutable outputs and keeps mutable caches outside correctness; and
5. is the sole build authority for the consumers in its declared scope.
