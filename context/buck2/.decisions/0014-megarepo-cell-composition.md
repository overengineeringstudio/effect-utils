# 0014 Megarepo Cell Composition with a Product Bridge at the Nix Boundary

Status: accepted

## Context

The prior architecture had only one cross-repository mechanism: the
`BuildProduct` -> Nix import bridge. Library-level consumption between megarepo
members (dotfiles importing effect-utils TypeScript or Rust sources) would have
crossed a package/import cycle — exactly the coarse-invalidation shape the
adoption exists to remove. Megarepo already materializes member sources into
composed worktrees, and Buck cells exist to compose independent source trees
into one graph.

## Evidence and Argument

A two-member composition prototype
([05-composition/.experiments/2026-08-25-cell-composition-key-stability.md](../05-composition/.experiments/2026-08-25-cell-composition-key-stability.md))
proved: cross-cell target deps and cross-cell rule loads work with the bundled
prelude declared only at the root; invalidation propagates correctly across
cells; and — the load-bearing claim — action digests are byte-identical between
a single-member composition root and a full composition, verified at the
digest level against a live remote cache in both directions.

The same prototype established what breaks key stability: member mount path,
member cell name, platform _label_ (content equality is insufficient),
isolation dir, and absolute symlinks all enter action identity through
project-relative command lines and output paths. A member built from a bare
checkout as its own project root shares nothing. Relative-symlink forests
(pnpm shape) are key-safe; absolute symlink targets and per-worktree toolchain
paths split the namespace silently.

## Options

| Option                                     | Tradeoff                                                                                      | Outcome  |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- | -------- |
| Cells for source deps + bridge for Nix     | Full cross-member incrementality and shared cache keys; requires composition-shape discipline | Accepted |
| Product bridge only                        | Cleanest isolation; hot-path library deps pay package->import cycles                          | Rejected |
| One permanent mega-graph over megarepo-all | Maximal sharing; couples every repo's builds to composition state, untested                   | Rejected |

## Decision

A composed megarepo worktree is one Buck2 project; each member is a cell.
Cross-member library dependencies are direct target deps. The product bridge
remains solely for the system boundary (tools and binaries entering Nix
closures). Every build — including single-repo CI and external standalone
consumers — runs from a synthesized composition root; megarepo materializes
members and genie projects the root configuration. The key-stability
discipline (canonical mounts, canonical cell names, shared platform labels,
fixed isolation dir, no member `.buckroot`, `/nix/store` tool paths, real
directories, full detector coverage) is normative in
[05-composition](../05-composition/requirements.md).

## Consequences

- Adoption in effect-utils pays off directly in every consumer; dotfiles
  consumes member targets from cache (vision criterion 6).
- There is no bare-checkout build shape inside the shared cache namespace;
  megarepo/genie enforce the canonical shape.
- Members must not ship `.buckroot`; a cwd inside a member must not silently
  become its own project root.
