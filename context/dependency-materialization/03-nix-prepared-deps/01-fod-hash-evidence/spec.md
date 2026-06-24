# FOD Hash Evidence Spec

This document specifies FOD hash evidence. It builds on
[requirements.md](./requirements.md).

Status: **Draft**

## Evidence Shape

```json
{
  "schema": "dependency-fod-hash-evidence/v0",
  "profileId": "pnpm:...",
  "preparedArtifactVersion": "v18",
  "directAttr": "packages.aarch64-darwin.my-cli-pnpm-deps",
  "coveredSystems": {
    "aarch64-darwin": {
      "state": "measured",
      "hash": "sha256-..."
    },
    "x86_64-linux": {
      "state": "pending",
      "reason": "remote measurement unavailable"
    }
  },
  "selectedHash": {
    "mode": "shared-pending",
    "hash": "sha256-..."
  }
}
```

`shared` means all covered systems were measured equal. `shared-pending` means
at least one covered system remains pending and tooling must not silently treat
the hash as fully proven. `split` means system-specific hashes are selected.

## Reconciliation

Hash reconciliation rebuilds the direct prepared dependency artifact for each
covered system, records the measured output, and only then selects shared or
split hash mode. Missing systems are evidence, not absence.
