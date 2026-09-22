# 0037 Nix Substitution Is the Distribution Layer

Status: accepted

Accepted 2026-09-19 (decisions q42-q46, oversight seat, confirmed by Johannes).

## Context

Decision 0034 made GitHub immutable releases the durable product origin, the
shared CAS an accelerator, and `pkgs.fetchurl` the only import path; a missing
asset hard-fails an evaluation (BRIDGE-R08 as previously written). Five dotfiles
consumers depend on packages in the private repository `private-shared`, which
must stay private; GitHub release assets for a private repository need a
credential inside every consumer fetch. Johannes asked to keep the
infrastructure simple, follow industry practice, lessen GitHub dependence, treat
published products as an optimization rather than a prerequisite, and use
S3-compatible storage as the agnostic foundation
(`/srv/bulk/coding-agents/_briefs/buck2-infra-options.chatgpt.md`, 2026-09-19).

## Evidence and Argument

- Sandboxed reconstruction works: a plain Nix derivation with filtered source,
  the prepared dependency closure, and the capability projection runs the
  pinned Buck graph for a real product with no sandbox exception (701 MB input
  closure, 0.6 s inner build, 3 local actions)
  ([experiment](../.experiments/2026-09-19-nix-reconstruction-from-source.md), PR #1318).
  The output differs from the published asset by one generated identifier
  because the checked-in manifest lacks producer-commit provenance; the
  same-commit equivalence claim needs that provenance.
- Cachix as origin: the public `overeng-effect-utils` cache's pinned artifact
  URL passes anonymous HTTP, `nix store prefetch-file`, sandboxed
  `pkgs.fetchurl`, a pnpm URL dependency, and Buck2 `http_file`; the private
  `schickling-dotfiles` cache passes daemon-netrc Nix substitution and pnpm with
  a user `.npmrc`, while sandboxed `pkgs.fetchurl` and Buck2 `http_file` fail
  401 ([experiment](../.experiments/2026-09-19-cachix-artifact-origin.md), PR #1315).
- The same private boundary appears with a bazel-remote HTTP CAS behind Basic
  auth ([experiment](../.experiments/2026-09-19-cas-origin-prototype.md), PR
  #1310): it is a property of sandboxed HTTP fetch, not of any origin. Private
  bytes must therefore travel through the Nix store protocol (daemon netrc) or
  a network perimeter, never through a credential inside a build.
- bazel-remote's S3 write-behind is best-effort and may drop uploads; NativeLink
  and bazel-remote object layouts are internal; single-node Garage is
  upstream-labelled test-only; Nix has a native signed S3 binary-cache protocol
  and Cloudflare R2 supports it with lifecycle and bucket locks
  (`/srv/bulk/coding-agents/_reports/s3-foundation-research.md`).
- Remote execution is a separate concern: NativeLink could not be started on
  aarch64 (compiler-rt build failure, dev4 contention); a rerunnable kit exists
  (PR #1317). Nothing in this decision depends on it.

## Options

| Option                                                                                                                                 | Tradeoff                                                                                                                                  | Outcome                                        |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Nix substitution is the distribution layer: per-product sandboxed Buck-invoking derivations, binary caches as origins, rebuild on miss | One protocol for public and private; removes GitHub from the build path; adds a generated derivation per product and pin/retention duties | Accepted                                       |
| bazel-remote tiers plus R2 write-behind as the origin                                                                                  | Transport proven, but durability is a self-built contract over a cache and Nix consumers keep a fetch-only path                           | Rejected                                       |
| Keep GitHub releases, reconstruction as fallback only                                                                                  | Least migration; two mechanisms permanently; GitHub remains a build-time dependency                                                       | Rejected                                       |
| NativeLink as combined cache and origin                                                                                                | No HTTP fetch by digest, no auth roles; adds a gateway rather than removing one                                                           | Rejected for distribution (open for execution) |
| Cachix pins as sole origin without a source recipe                                                                                     | Solves hosting, keeps the hard block on a missing artifact                                                                                | Rejected                                       |

## Decision

1. Every portable Buck product and every published package has a
   genie-generated, sandbox-compatible Nix derivation that invokes the pinned
   Buck graph (the PR #1318 shape). The derivation is the recipe; its output is
   an ordinary store path.
2. Binary caches are the origins: the public `overeng-effect-utils` Cachix cache
   for public products, the private Cachix cache for `private-shared`; a native
   S3/R2 binary cache is the exit path and uses the same protocol.
3. A Nix consumer substitutes the output and, on a miss, rebuilds through the
   same graph at the pinned producer revision; a rebuilt product must
   reproduce the pinned digest or fail (BRIDGE-R08 as amended).
4. A pnpm consumer pins a public product by its Cachix pinned-artifact URL plus
   SHA-512; a private product enters the staged manifest as the Nix-realized
   tarball (`file:`), never through a credential inside the install.
5. A Buck consumer cell fetches public products with `http_file` by digest and
   private products as Nix capabilities.
6. Pins are named by digest and never re-pointed; the publisher verifies the
   pinned path anonymously after publication (public) and records producer
   commit, target, and digest as provenance.
7. The GitHub-releases layer (`nix/buck2-products/publish.sh`, the
   `buck2-product-v3-*` / `buck2-package-v1-*` release namespaces) is retired
   once the first product moves; existing releases stay as history.
8. bazel-remote remains the disposable action cache (REUSE-A02 unchanged).
   Remote execution is decided separately.

## Consequences

- 0034 is amended (Amendment 1): "durable origin" becomes the binary cache plus
  the source recipe; the consumer pin clause gains the substitution form.
- vision.md lines 30-32 and criterion 6, and BRIDGE-R08, are rewritten as
  confirmed in q46.
- New work: generated per-product derivations (genie), Cachix publish/pin
  publisher with provenance, private-shared product lane, retirement of
  `publish.sh`; ledger rows for publication move from GitHub to the cache
  publisher.
- Open: private pnpm `file:` variant (unproven), Cachix retention at our volume,
  R2 exit criteria, remote execution (04-reuse / 02-execution open questions).

## Amendment 1 (2026-09-22)

Decision [0038](./0038-digest-origins-for-acquisition.md) replaces the prepared
dependency tree used by the source recipe with the pinned checked-in graph fed
by independently verified per-digest archive FODs. Clauses 1 and 3 continue to
require a sandbox-compatible source recipe and same-graph reconstruction on a
substitution miss. Clauses 2, 4–8, publication as an optimization, and the
product provenance/digest contract are unchanged.
