# Projection Requirements

## Context

Projection State is deterministic state derived after Dependency Data exists.
It includes `node_modules/.bin` entries and local metadata needed for tools to
execute against a realized Dependency Graph.

Projection refines DMP-R05 through DMP-R08. Prepared dependency artifacts are
data; projections are recreated and checked by effect-utils-managed steps.

## Assumptions

- **A01 Graph exists first:** The Authoritative Materializer has completed the
  Dependency Graph before projection starts.
- **A02 No package code:** Projection reads package metadata and filesystem
  state but does not execute package code or lifecycle scripts.

## Acceptable Tradeoffs

- **T01 Minimal bin semantics:** The first bin projector may implement only the
  manifest-based semantics needed by managed workspaces.
- **T02 Deterministic overwrite:** Projection may replace stale files it owns
  instead of preserving unknown local mutations.

## Requirements

### Must own executable projection

- **DMP.PROJ-R01 Bin ownership:** `node_modules/.bin` is Projection State owned
  by the Materialization Root, not Dependency Data.
  Refines: DMP-R06.
- **DMP.PROJ-R02 Manifest source:** Expected bins must be derived from package
  manifests and realized package roots.
  Refines: DMP-R07.
- **DMP.PROJ-R03 No lifecycle execution:** Projection must not run `preinstall`,
  `install`, `postinstall`, `prepare`, `pnpm rebuild`, or package-manager
  build approval paths.
  Refines: DMP-R01, DMP-R03, DMP-R17.
- **DMP.PROJ-R04 Target validation:** A bin entry may be created only when its
  target file exists in Dependency Data or an explicit Nix/native integration.
  Refines: DMP-R04, DMP-R07.

### Must be deterministic and diagnosable

- **DMP.PROJ-R05 Stable output:** The same Dependency Graph, Dependency Data,
  and projection policy must produce the same projection files.
  Refines: DMP-R07, DMP-R15.
- **DMP.PROJ-R06 Owned overwrite:** Stale Projection State owned by the
  Materialization Root must be repaired deterministically.
  Refines: DMP-R15.
- **DMP.PROJ-R07 Report:** Projection must emit a report that doctor, repair,
  and benchmarks can consume.
  Refines: DMP-R19.
- **DMP.PROJ-R08 Prepared-deps exclusion:** Prepared dependency FOD validation
  must reject archived `.bin` projections by default.
  Refines: DMP-R05, DMP-R06, DMP-R18.
- **DMP.PROJ-R09 Dependency-edge non-authority:** Projection must not create,
  remove, or retarget Dependency Edges. It may read the realized Dependency
  Graph only to derive Projection State.
  Refines: DMP-R11, DMP-R15.
