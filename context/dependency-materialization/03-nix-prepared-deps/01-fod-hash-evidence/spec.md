# FOD Hash Evidence Spec

This document specifies FOD hash evidence. It builds on
[requirements.md](./requirements.md).

Status: **Draft**

## Requirement Trace

| Section               | Requirements                                                       |
| --------------------- | ------------------------------------------------------------------ |
| Producer Target Shape | DMP.NIX.FOD-R05, DMP.NIX.FOD-R06, DMP.NIX.FOD-R08                  |
| Measurement Evidence  | DMP.NIX.FOD-R01, DMP.NIX.FOD-R02, DMP.NIX.FOD-R03, DMP.NIX.FOD-R04 |
| Hash Authority        | DMP.NIX.FOD-R01, DMP.NIX.FOD-R03, DMP.NIX.FOD-R04, DMP.NIX.FOD-R08 |
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

## Hash Authority And Proof Lanes

The authored hash location records the selected hash for each direct prepared
dependency artifact. `shared` is the preferred steady state when every covered
system measured for the artifact produces the same output hash. `split` is
reserved for measured platform divergence.

Hash proof has two independent lanes:

- structural proof validates that every prepared artifact has a canonical hash
  location, direct rebuild attr, covered-system metadata, and complete evidence
  shape;
- value proof realizes the direct prepared artifact for covered systems and
  compares the produced hash to the authored selected hash.

Structural proof can make missing evidence red by construction, but it cannot
prove that a syntactically valid hash value is current. Value proof is the
authority for current bytes.

A previously shared artifact that starts requiring split hashes after a builder
or normalization change is a regression signal until the prepared tree is
inspected. Accepting a split requires measured outputs and evidence explaining
which covered systems diverged.

## Reconciliation

Hash reconciliation rebuilds the direct prepared dependency artifact for each
covered system, records the measured output, and only then selects shared or
split hash mode. Missing systems are evidence, not absence.

## Completeness As Shared-Hash Soundness

Traces: DMP.NIX.FOD-R03, DMP.NIX-R03.

A shared FOD hash across covered systems is sound only if the prepared tree is
host-invariant. For a root that carries optional native bindings, host-invariance
holds **iff** the binding closure is complete across all declared triples: under
`all-declared-triples` completeness, pnpm materializes the same union of platform
bindings regardless of the building host, so the recursive output hash is
identical cross-host.

This makes the completeness assertion (`02-native-node-packages`,
`DMP.NIX.NATIVE-R08`) the eval-time soundness guard for `DMP.NIX.FOD-R03`: it
fails exactly on the host-variant tree that would make a shared hash unsound. The
per-system split hash (`DMP.NIX.FOD-R04`) remains the sanctioned fallback for a
future family that cannot achieve all-triple coverage (`build-platform` mode).

Cross-system equality itself stays measured evidence, not an in-FOD assertion:
realize the artifact on each covered system and confirm equal output hash
(`DMP.NIX.FOD-R03`), rather than attempting cross-system comparison inside one
FOD build.
