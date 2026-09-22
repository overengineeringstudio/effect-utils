# Nix-store-backed Buck dependency views

Date: 2026-09-22
Host class: x86_64-linux development host (dev3), Nix sandbox enabled, Buck2 2026-08-31-be6971d

## Question

Can Nix realize the digest-pinned pnpm archives while the unchanged declared Buck graph still owns extraction, patching, store-entry assembly, package views, typecheck, bundle, and package production? This probes Q57 Option C and does not make an adoption decision.

## Method

- Scratch revision `52fd104944da62bfc57867d3f14932866938d9cd` adds one Nix fixed-output derivation per unique sidecar SHA-256 and aggregates 671 archive files in an immutable link farm.
- The existing generated `pnpm_package` declarations read `nix_store.root`. The existing fetch rule either retains `actions.download_file` when unset or runs a 37-line Bun helper that copies `<root>/<sha256>.tgz` and re-hashes the bytes before publishing the Buck artifact.
- `from-source.nix` now copies the complete capability projection and invokes the checked-in `.buckconfig`, root `BUCK`, dependency graph, toolchains, and package BUCK files unchanged. It no longer synthesizes a Buck root, dependency stub, prepared `node_modules`, or package-rule rewrite.
- All builds used the same archive root `/nix/store/nl6zws0kvqcxcwh57hm23akl74gwq7pi-buck2-pnpm-archives-d5d8ca7d8565`, `--local-only`, and `--no-remote-cache`.

## Declared input inventory

| Input | Identity / measurement |
|---|---|
| Repository | `52fd104944da62bfc57867d3f14932866938d9cd` |
| Archive set | 671 fixed-output archives; 645,724,000-byte closure |
| Buck2 | `2026-08-31-be6971d47dcc835b7356e1698b23039ffee4f4c2` |
| Prelude | `1f8c24e0b1f85e645011f93a4073b0c6c762d7b1` |
| Capability projection | full `buck2-member.json` projection, not the prior Bun-only stub |

## Result

Cold realization of all 671 Nix archives succeeded in 37.85 s inside the fleet gate. The link farm has 671 direct references, a 2.8 MiB directory footprint, and a 645,724,000-byte closure.

The normal Nix sandbox rebuilt two previously failing products through the real graph:

| Product | Result | Buck commands | Inner Buck wall | Product SHA-256 |
|---|---|---:|---:|---|
| `genie` JavaScript | success | 872 local | 27.0 s | `4e5febf7ce9948a6e4e8d4d8e1cad111f2fecffd542182caf3111a93744678fe` |
| `@overeng/utils` package | success | 792 local | 16.5 s | `5b030580ddc7fbe76380381b261da0b4dc979c24f938e6b2e1e67fb6a9f695ff` |

The standalone root built both targets together with 1,664 local commands in 559.20 s under contemporaneous host pressure. Both artifact hashes exactly matched the Nix sandbox outputs. This timing is a measurement, not an apples-to-apples speed comparison.

Standalone and synthetic composed roots analyzed the same fetch target to the same configured platform hash (`a312ca1b0cfd7c35`) and the same command identity: pinned Bun, helper, archive root, and package SHA-256. A full composed build was not established: two attempts failed before graph execution because the host-wide inotify watch limit poisoned both `notify` and Watchman. The composed graph itself parsed and analyzed after Watchman recovered.

The helper accepted a valid archive and rejected deliberately corrupt bytes with the expected/actual SHA-256. Nix reported `sandbox = true`; the product derivations cannot reach the registry, so success establishes that Buck consumed Nix-realized bytes.

## Upstream download boundary

The pinned Prelude `http_file`/`http_archive` rules pass exactly one URL to `actions.download_file`. The pinned Buck implementation has no artifact input and performs HTTP HEAD/GET; its offline mode only restores a previously populated project-relative `buck-out/offline-cache`. No config-driven mirror or clean Nix archive source exists in this call chain. A dedicated copy/verification action is therefore required.

The existing `package_override` seam validates only an absolute directory and copies it. It does not hash that directory or compare it with the registry archive SHA-256, so it is not the archive-integrity boundary.

## Cache and production implications

- The Nix root path is present in the Buck action command, so equal Nix derivations give stable keys across standalone, composed, and sandbox contexts. Every wrapper must supply the identical config or BUCK-R06 parity is lost.
- The prototype aggregate root changes when any archive changes, invalidating every Nix-backed fetch command. Production must use per-digest store-path config or a generated archive cell so EXEC-R04 remains narrow.
- The copy action is `local_only`; its output is cache-uploadable, but a miss cannot execute remotely because the absolute Nix archive root is not a Buck artifact on a worker. Production adoption is blocked on a remote-capable projected source/CAS form or an explicit exemption from BUCK-R17.
- Product derivations currently depend on the complete 646 MB archive set, not a target-specific subset. Production generation should compute per-product archive closures.
- Nix URL derivation currently repeats registry-key parsing. Production generation should emit URL plus SHA-256 once from the lock projection.

## Conclusion

Option C is technically viable for standalone and sandboxed source reconstruction: the real graph consumes Nix-realized, independently re-hashed archive bytes and reproduces both selected product artifacts exactly. It is not yet an adoptable final design because the aggregate root violates narrow invalidation, the complete archive closure is broader than each product, and the source action is not remote-executable. The production follow-up should retain the verified action boundary while replacing the aggregate absolute root with per-digest Buck-declared inputs.

## VRS Impact

Evidence only for Q57 / BRIDGE-R08. It proves the local and Nix-sandbox mechanism but does not close BUCK-R06 zero-action reuse, EXEC-R04 narrow invalidation, or BUCK-R17 remote execution. No requirement or decision changes.
