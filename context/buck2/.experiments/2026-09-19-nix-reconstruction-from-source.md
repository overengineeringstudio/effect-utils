# Nix reconstruction of a Buck2 JavaScript product

Date: 2026-09-19
Host class: x86_64-linux development host (dev3), Nix sandbox enabled, Buck2 pin 2026-09-01

## Question

Can a Nix derivation rebuild a real Buck2 product from repository source and a
prefetched dependency closure, without `sandbox = false`, ambient repository
state, or network access? This is evidence for reframed question q44; it makes
no infrastructure or publication decision.

## Method

- `oxc-config` was the smallest real JavaScript product in the checked-in
  manifest: 64,568 published bytes, target
  `effect_utils//packages/@overeng/oxc-config:oxc-config-candidate`
  ([manifest](../../../nix/buck2-products/manifest.json)).
- [`from-source.nix`](https://github.com/overengineeringstudio/effect-utils/pull/1321) filters the
  repository to the root/Buck rules, package tools, and package source. It takes
  the existing `oxc-config` prepared pnpm fixed-output derivation as an input.
- At build time it extracts the pinned Prelude, renders the Bun capability with
  its complete Nix closure, projects the prepared tree as the package's
  `node_modules`, and invokes the pinned Buck2 with `--local-only` and
  `--no-remote-cache`.
- The prototype changes only the copied build tree. It does not alter the
  repository BUCK graph or use a daemon/cache outside the derivation.

## Declared input inventory

| Input                      | Identity / measured closure                                                   |
| -------------------------- | ----------------------------------------------------------------------------- |
| Filtered repository source | 3,741,424 NAR bytes                                                           |
| Prepared pnpm tree         | `oxc-config-pnpm-deps-lwdqgrsq-v19-0.0.0`; 48,128,792 NAR bytes; 142 packages |
| Buck2                      | `unstable-2026-09-01`; 185,624,784-byte closure                               |
| Prelude                    | commit `1f8c24e0b1f85e645011f93a4073b0c6c762d7b1`; 4,972,744 bytes            |
| Bun capability             | Bun 1.4.2 plus sorted closure paths; 117,298,760-byte closure                 |
| Build support              | stdenv, bash, GNU tar/gzip, CA bundle, generated closure-info                 |

The union actually available to the final Nix builder was 69 store paths and
701,382,992 NAR bytes. The installed product closure is 64,856 bytes. The
prepared dependency derivation records frozen-lockfile verification, ignored
scripts, 2,868 output files, and a 9.269 s fresh materialization phase.

## Result

`buck2-heavy.sh -- nix build -L .#oxc-config-from-source --no-link
--print-out-paths` succeeded. The successful invocation spent 275.23 s wall
clock behind the shared admission/serialization gate; inside the admitted Nix
build, Buck went from build ID to `BUILD SUCCEEDED` in 0.633 s and executed
three local actions. Cache hits and remote actions were both zero.

The reconstructed current-tree module is 64,565 bytes with SHA-256
`fd5b505b4056d373cd99b4d1264a3f79774381faa9cd06d1b4cb4bcef1ccf03a`.
The checked-in published artifact is 64,568 bytes with SHA-256
`f300c5d6e2faf51f432895a0e74d87e6d76bca1140ad07b31efb887c5d2d78be`.
They are not byte-identical: the only differing region is a generated local
identifier (`localName` versus `localName2`), accounting for all three bytes.
A same-commit comparison cannot be established from the current publication
record: the manifest last changed at `08404000a499` on 2026-09-10, relevant
package/bundler inputs changed afterward, and the descriptor records a target
but no producer commit. This is a provenance gap, not a reconstruction failure.

## Sandbox boundary and iterations

- Nix reported `sandbox = true`. Buck was local-only, remote cache was disabled,
  and the successful build made no registry or release request.
- The first daemon start inherited Nix's `/no-cert-file.crt` network poison and
  failed while constructing Buck's HTTP client, even with remote use disabled.
  The fix was a declared `cacert` input and explicit `SSL_CERT_FILE`; sandbox
  networking remained unavailable.
- Buck's project ignore excludes directories named `node_modules`; a copied
  tree at that name was invisible. Projecting the same immutable input as
  `nix-deps/tree` made it a declared directory source.
- The prepared tree intentionally contains a workspace self-link. It was
  dangling after extracting only the dependency tree, so the adapter removes
  that self-link; the package's source files are separate declared inputs.
- Non-sandbox adapter corrections were also needed: the isolation directory is
  a name, not a path, and the generated cell must load as
  `@capabilities//:defs.bzl`.
- Remaining host facilities are the Nix daemon, Linux process/filesystem APIs
  (including inotify for Buck's `notify` watcher), and derivation-local
  `$TMPDIR`/`HOME`/XDG directories. There is no ambient Git checkout, user
  configuration, watchman service, writable Nix store, or network dependency.

## Prior art

- Mercury Snowydeer converts an already-built Buck artifact to a
  content-addressed Nix store path: it gathers candidate Nix dependencies,
  writes a NAR, scans references, and imports with Lix 2.95's
  `--references-list-json` or `import_ca`
  ([overview](https://github.com/MercuryTechnologies/snowydeer/blob/2deb9e495a6f136302925cc4c061c4f491f85b68/snowydeer/README.md),
  [rule](https://github.com/MercuryTechnologies/snowydeer/blob/2deb9e495a6f136302925cc4c061c4f491f85b68/snowydeer/snowydeer_import.bzl)).
  Its import action is explicitly local-only and non-cacheable. That solves
  Buck-to-Nix export after Buck has run; it does not give Nix a source recipe
  capable of reconstructing a missing Buck product.
- Tweag `buck2.nix` goes the other direction: a local-only Buck action invokes
  ambient `nix build path:<source>#packages.<system>...` and exposes its out-link
  ([rule](https://github.com/tweag/buck2.nix/blob/038b031b84846101030b9d081445003e82e3be5c/flake.bzl),
  [overview](https://github.com/tweag/buck2.nix/blob/038b031b84846101030b9d081445003e82e3be5c/README.md)).
  The post-baseline `nix/buck2-capabilities.nix` projection covers the same
  Nix-to-Buck input purpose more narrowly and more hermetically: Nix realizes
  tools and complete closures before Buck starts, so a Buck action does not
  recursively invoke Nix. Neither mechanism alone supplies the product
  reconstruction recipe proven here.

## Conclusion

Yes: Nix can drive the pinned Buck graph inside its normal sandbox from filtered
source plus prefetched inputs. The prototype therefore removes a missing release
asset as a hard technical blocker. It does not establish byte identity with the
older published artifact; publication needs producer-commit provenance before a
same-commit equivalence claim is testable.

## VRS Impact

Evidence only for q44 (2026-09-19). No requirement or decision changes.
