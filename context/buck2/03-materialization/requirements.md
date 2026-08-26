# Materialization Requirements

This subsystem owns dependency materialization: how manifest-declared
dependencies become `node_modules` trees for actions and for the editor
surface. It refines BUCK-R08 and BUCK-R11. The transitional pnpm/Nix contract
in `context/dependency-materialization` dissolves against these requirements
as authority transfers (BUCK-R09).

## Assumptions

- **DEPS-A01 Request authority:** Manifests, the lockfile, and declared patches
  are the only hand-authored dependency inputs (BUCK-A04).
- **DEPS-A02 Store supply:** The pnpm content-addressed store supplies package
  bytes; lockfile integrity hashes pin them. Store bytes are trusted at link
  time within the single-operator boundary (BUCK-A05).

## Acceptable Tradeoffs

- **DEPS-T01 Local-only trees:** Materialized trees embed absolute virtual-store
  paths and are not portable across machines; materialization actions are
  `local_only` and cheap to recompute. Cross-machine reuse applies to the
  actions consuming the trees, whose keys hash tree content.
- **DEPS-T02 Transitional root install:** Until the editor-surface transfer
  gate passes ([decision 0015](../.decisions/0015-buck-owned-dependency-surface.md)),
  the root install remains, carried in the deletion ledger.

## Requirements

- **DEPS-R01 Manifest-only inputs:** A materialization action's inputs are
  exactly the workspace manifests, the lockfile, and declared patches. No
  source file is an input; no source edit invalidates a dependency tree.
- **DEPS-R02 Deterministic relocatable output:** Equal manifest input produces
  a byte-stable tree: fixed-path staging, relative symlinks only, and
  normalization of the enumerable impurity set (`.bin` shims, pnpm metadata
  files). Absolute symlink targets are forbidden — they poison action keys.
- **DEPS-R03 Live workspace siblings:** Workspace-internal dependencies resolve
  as symlinks to live member sources, not injected copies, so a sibling edit
  needs no rebuild and no language-server restart.
- **DEPS-R04 Hardlink economics:** Materialized trees hardlink from a shared
  same-filesystem store; per-tree marginal cost is directory entries. Store
  wiring is explicit (`--store-dir`); a cross-filesystem silent copy is a
  defect (BUCK-R08).
- **DEPS-R05 Atomic editor views:** The editor surface flips atomically
  (snapshot + `rename(2)`) with no window in which `node_modules` is absent;
  a live language server survives the flip without restart.
- **DEPS-R06 Loud staleness:** A consistency gate compares the materialized
  surface's manifest fingerprint against the repository's before use; a stale
  surface fails loudly (vision criterion 8). Silent drift is the defect class
  this subsystem exists to eliminate.
- **DEPS-R07 Bounded fan-out:** Materialization keying bounds invalidation: a
  manifest change in one package must not rebuild every package's tree.
  Per-cell pruned-lockfile keying is the accepted mechanism and a transfer
  gate ([decision 0015](../.decisions/0015-buck-owned-dependency-surface.md)).
- **DEPS-R08 Fail-closed offline:** Materialization runs offline against the
  store; a missing package fails the action rather than reaching the network.
  Adding a genuinely new version is an explicit, network-using developer step
  that updates the lockfile.
