# Materialization Requirements

This subsystem owns dependency materialization: how manifest-declared
dependencies become `node_modules` trees for actions and for the editor
surface. It refines BUILD.BUCK-R08 and BUILD.BUCK-R11. The transitional pnpm/Nix contract
in `context/dependency-materialization` dissolves against these requirements
as authority transfers (BUILD.AUTH-R09).

## Assumptions

- **BUILD.BUCK.MAT-A01 Request authority:** Manifests, the lockfile, and declared patches
  are the only hand-authored dependency inputs (BUILD.BUCK-A04).
- **BUILD.BUCK.MAT-A02 Package supply:** Registry tarballs fetched by Buck supply package
  bytes; lockfile integrity hashes pin them through a generated, freshness-gated
  sha256 sidecar. Digest verification establishes byte identity, not writer trust:
  shared-cache use follows the mitigated-writer policy (BUILD.BUCK-A05) and
  audited hermetic-lane admission. No ambient package store exists.

## Acceptable Tradeoffs

- **BUILD.BUCK.MAT-T01 Local-only assembly:** Assembled trees are relocatable, but
  assembly hardlinks from extract artifacts and is therefore `local_only` and
  cheap to recompute. Fetch and extract actions, and the actions consuming the
  trees, reuse across machines through the shared cache.
- **BUILD.BUCK.MAT-T02 Transitional root install:** Until the editor-surface transfer
  gate passes ([decision 0015](../../.decisions/0015-buck-owned-dependency-surface.md)),
  the root install remains, carried in the deletion ledger.

## Requirements

- **BUILD.BUCK.MAT-R01 Manifest-only inputs:** A materialization action's inputs are
  exactly the workspace manifests, the lockfile, and declared patches. No
  source file is an input; no source edit invalidates a dependency tree.
- **BUILD.BUCK.MAT-R02 Deterministic relocatable output:** Equal lockfile input produces
  a byte-stable tree by construction: layout is derived from the lockfile, links
  are relative, and no package-manager metadata or generated shim needs
  normalization. Absolute symlink targets are forbidden — they poison action
  keys.
- **BUILD.BUCK.MAT-R03 Live workspace siblings:** Workspace-internal dependencies resolve
  as symlinks to live member sources, not injected copies, so a sibling edit
  needs no rebuild and no language-server restart.
- **BUILD.BUCK.MAT-R04 CoW economics:** Assembled trees clone from Buck extract
  artifacts with copy-on-write reflinks where the filesystem supports them,
  and fall back to plain copies where it does not; assembled files always
  carry independent inodes. Hardlink sharing into assembled trees is
  rejected — shared inodes let a write through an assembled tree corrupt the
  extract artifact (decision
  [0025](../../.decisions/0025-cow-reflink-local-disk-economics.md)). A
  cross-mount silent copy remains a defect (BUILD.BUCK-R08); mount identity, not
  `st_dev`, is the test. Published editor views are read-only.
- **BUILD.BUCK.MAT-R05 Atomic editor views:** The editor surface flips atomically
  (snapshot + `rename(2)`) with no window in which `node_modules` is absent;
  a live language server survives the flip without restart.
- **BUILD.BUCK.MAT-R06 Loud staleness:** A consistency gate compares the materialized
  surface's manifest fingerprint against the repository's before use; a stale
  surface fails loudly (vision criterion 8). Silent drift is the defect class
  this subsystem exists to eliminate.
- **BUILD.BUCK.MAT-R07 Bounded fan-out:** Materialization keying bounds invalidation
  literally: a manifest change in one package must not rebuild every package's
  TREE — bounded action count and no per-touch rewrite of every tree, not
  merely no downstream cascade. The mechanism is structural: one fetch and one
  extract target per package version and one assembly target per importer, so a
  lockfile change re-runs only the changed packages' extractions and the
  affected importers' assemblies
  ([decision 0022](../../.decisions/0022-lockfile-derived-declared-closure.md)).
- **BUILD.BUCK.MAT-R08 Fail-closed fetch:** Network access exists only in hash-pinned
  fetch actions; extraction and assembly run offline, and a missing or
  mismatched package fails the action rather than falling back. Adding a
  genuinely new version is an explicit developer step that updates the
  lockfile and regenerates the sidecar.
