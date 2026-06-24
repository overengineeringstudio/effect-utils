# Buck2 Evidence Spec

This document specifies Buck2 dependency materialization evidence. It builds on
[requirements.md](./requirements.md).

Status: **Draft**

## Requirement Trace

| Section        | Requirements               |
| -------------- | -------------------------- |
| Boundary       | DMP.BUCK-R01, DMP.BUCK-R04 |
| Evidence Shape | DMP.BUCK-R02, DMP.BUCK-R03 |
| Future Builder | DMP.BUCK-R05               |

## Boundary

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

The initial Buck2 target emits evidence. It does not run live dependency
installation or shared-store repair.

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

A future Buck2 action may materialize dependencies only when it:

1. declares the same profile inputs;
2. disables lifecycle scripts by construction;
3. proves output equivalence with the accepted profile realization;
4. has an explicit repair and GC story for mutable state or uses immutable
   outputs only.
