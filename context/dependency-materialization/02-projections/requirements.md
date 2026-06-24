# Projection Requirements

## Context

Projection is deterministic state derived after dependency data exists. It
includes `node_modules/.bin` entries, workspace package links, and local
metadata needed for tools to execute against a realized dependency graph.

Projection refines DMP-R05 through DMP-R08. Prepared dependency artifacts are
data; projections are recreated and checked by effect-utils-managed steps.

## Assumptions

- **A01 Data exists first:** Projection never resolves dependencies. It operates
  on dependency data already materialized by live pnpm or restored from Nix.
- **A02 No package code:** Projection reads package metadata and filesystem
  state but does not execute package code or lifecycle scripts.

## Acceptable Tradeoffs

- **T01 Minimal bin semantics:** The first bin projector may implement only the
  manifest-based semantics needed by managed workspaces.
- **T02 Deterministic overwrite:** Projection may replace stale files it owns
  instead of preserving unknown local mutations.

## Requirements

### Must own executable projection

- **DMP.PROJ-R01 Bin ownership:** `node_modules/.bin` is profile-owned
  projection state, not dependency data.
- **DMP.PROJ-R02 Manifest source:** Expected bins must be derived from package
  manifests and realized package roots.
- **DMP.PROJ-R03 No lifecycle execution:** Projection must not run `preinstall`,
  `install`, `postinstall`, `prepare`, `pnpm rebuild`, or package-manager
  build approval paths.
- **DMP.PROJ-R04 Target validation:** A bin entry may be created only when its
  target file exists in dependency data or an explicit Nix/native integration.

### Must be deterministic and diagnosable

- **DMP.PROJ-R05 Stable output:** The same dependency data and projection policy
  must produce the same projection files.
- **DMP.PROJ-R06 Owned overwrite:** Stale projection files owned by the profile
  must be repaired deterministically.
- **DMP.PROJ-R07 Report:** Projection must emit a report that doctor, repair,
  and benchmarks can consume.
- **DMP.PROJ-R08 Prepared-deps exclusion:** Prepared dependency FOD validation
  must reject archived `.bin` projections by default.
