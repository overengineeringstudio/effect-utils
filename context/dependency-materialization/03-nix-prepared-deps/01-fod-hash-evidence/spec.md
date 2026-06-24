# FOD Hash Evidence Spec

This document specifies FOD hash evidence. It builds on
[requirements.md](./requirements.md).

Status: **Draft**

## Requirement Trace

| Section               | Requirements                                                       |
| --------------------- | ------------------------------------------------------------------ |
| Producer Target Shape | DMP.NIX.FOD-R05, DMP.NIX.FOD-R06, DMP.NIX.FOD-R08                  |
| Measurement Evidence  | DMP.NIX.FOD-R01, DMP.NIX.FOD-R02, DMP.NIX.FOD-R03, DMP.NIX.FOD-R04 |
| Reconciliation        | DMP.NIX.FOD-R03, DMP.NIX.FOD-R04, DMP.NIX.FOD-R07                  |

## Producer Target Shape

Prepared-deps producers expose hash repair targets through evaluated package
metadata. This is a generated contract derived from the same Nix inputs that
define the fixed-output derivation; it is not a separate checked-in witness
file.

```json
{
  "schemaVersion": 1,
  "kind": "dependency-fod-hash-repair-target",
  "producer": "effect-utils.mk-pnpm-cli",
  "subject": {
    "packageName": "@overeng/notion-cli",
    "packageDir": "packages/@overeng/notion-cli"
  },
  "attrName": "root",
  "installDir": ".",
  "lockfilePath": "pnpm-lock.yaml",
  "memberDirs": ["."],
  "profileKey": "55d476...",
  "declaredHash": "sha256-...",
  "depsDrvPath": "/nix/store/...-pnpm-deps-...drv",
  "hashPath": ["depsBuilds", ".", "hash"],
  "inputs": {
    "manifests": ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]
  },
  "freshness": {
    "manifestDigests": {
      "pnpm-lock.yaml": "787702..."
    }
  },
  "traits": ["nixPreparedDeps"]
}
```

`hashPath` names the source declaration relative to the package's `depsBuilds`
argument. Repair tooling may use it to update the committed hash, but the
evaluated target remains the source of repair identity.

## Measurement Evidence

Hash measurement evidence is produced by a repair or verification run after it
rebuilds the direct prepared dependency artifact on the covered systems. It is
run evidence, not an additional source file that package authors maintain.

```json
{
  "schema": "dependency-fod-hash-evidence/v0",
  "targetKind": "dependency-fod-hash-repair-target",
  "profileKey": "55d476...",
  "directAttr": "packages.aarch64-darwin.notion-cli.passthru.fodHashRepairTargets[0]",
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
