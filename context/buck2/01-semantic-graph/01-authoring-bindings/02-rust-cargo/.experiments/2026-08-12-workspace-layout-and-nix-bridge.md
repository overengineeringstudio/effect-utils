# Workspace Layout and Nix Bridge

## Status

Passed on 2026-08-12 for workspace placement and the supported stage-0 Nix
bridge. Package-local Nix invalidation from a shared lock is disproved.

## Question

Where should the mixed-repository Cargo workspace live, and can stock Nix
consume one workspace lock without duplicating Cargo resolution semantics?

## Method

Cargo 1.95 disposable fixtures compared repository-root and `rust/` virtual
workspaces. Controls exercised member discovery, unlisted path dependencies,
member-local commands, packaging, and toolchain discovery. A separate Nix
fixture built one member through pinned nixpkgs `buildRustPackage`, then added a
dependency reachable only from the other member and compared the unaffected
Cargo closure with Nix derivation plans.

## Result

| Control                                                      | Result                                                         |
| ------------------------------------------------------------ | -------------------------------------------------------------- |
| Member metadata, check, and package in both layouts          | Passed                                                         |
| Unlisted in-repo path dependency with root workspace         | Silently became a workspace member                             |
| Same dependency with dedicated `rust/` workspace             | Remained outside until explicitly linked                       |
| Member without explicit link to dedicated workspace          | Failed inheritance                                             |
| Repository-root toolchain discovered from member             | Passed                                                         |
| Toolchain only under `rust/` discovered from external member | Failed                                                         |
| Stock Nix build of selected shared-workspace member          | Passed in 13.93 s                                              |
| Unrelated member dependency change                           | Unaffected Cargo closure digest stayed identical               |
| Nix vendor derivation after that change                      | Changed; 69 derivations built and 63 paths fetched in the plan |

nixpkgs `importCargoLock` vendors every sourced package in the lock and its
setup hook compares the source and vendor lock bytes. Neither Cargo nor
`buildRustPackage` exposes a safe package-specific lock projection. Hand
pruning would need to reproduce feature, target, host, build, proc-macro,
source, and workspace-inheritance resolution and is rejected as a second
resolver.

## Conclusion

Mixed megarepos use `rust/Cargo.toml`, exact member paths, explicit
`package.workspace` links, repository-root `rust-toolchain.toml`, and standard
task wrappers. The stage-0 Nix bridge uses stock workspace-aware
`buildRustPackage`, a shared vendor derivation, and narrowly filtered source
code. Its complete-lock invalidation is an acknowledged system-packaging cost;
Buck remains the fine-grained repo-local builder.

The long-term bridge is a durable, digest-pinned Buck product imported by Nix.
That migration is per CLI and platform, after portable-static or explicit
dynamic-native realization passes ABI, runtime, provenance, rollback, and
cross-architecture controls.

## VRS Impact

Refines `BUCK.GRAPH.BIND.RUST-R12` and decision 0003 with the proved supported
bridge, rejects custom projected locks, and selects the dedicated mixed-repo
workspace boundary.
