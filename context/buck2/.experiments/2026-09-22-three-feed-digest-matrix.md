# Three-feed product digest matrix

Date: 2026-09-22

## Question

Do the configured private CAS, canonical npm registry, and Nix-store archive
projection feed the same immutable inputs into the real 21-product Buck graph?

## Environment

The `/srv/bulk` checkout is not valid for timing evidence: its 4,352-entry
pruned walk took 60.09 seconds and an unpruned walk exceeded 300 seconds. The
same detached revision (`b9f2a8f9ff`) under `/home/schickling` contained 4,349
pruned entries and walked in 0.17 seconds. A notify-backed Buck daemon connected
there in 0.054 seconds. The checked-in capability projection was copied into the
detached control root; no watcher override was used.

## Method

The exact 21 targets from `nix/buck2-products/cache-targets.json` were built in
fresh isolation directories with remote cache and remote execution disabled:

1. `acq-cas`, using the tracked digest CAS origin.
2. `acq-registry`, overriding `archive_origin.url_prefix` to empty.
3. `acq-nix`, setting `nix_store.root` to the realized
   `.#buck2-pnpm-archives` link farm.

Every output was SHA-256 hashed. The sorted 21-row sets were compared with
`diff -u`; both comparisons were empty. Each daemon was killed after its feed.

## Result

All 21 product digests are identical across all three feeds.

- CAS: 1,669 local command actions, 138 MiB downloaded, build succeeded.
- Registry: 1,669 local command actions, 138 MiB downloaded, build succeeded.
- Nix-store projection: 2,445 local command actions (including verified copy
  actions), build succeeded.
- Digest rows: 21 in every feed; CAS-to-registry diff empty; CAS-to-Nix diff
  empty.

The acquisition actions intentionally differ because origin URL or Nix-store
path enters their identity. The product graph converges on verified archive
content and produces identical outputs, which is the decision-0038 contract.
