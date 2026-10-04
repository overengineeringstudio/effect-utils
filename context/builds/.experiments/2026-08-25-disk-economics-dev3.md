# Dependency disk economics on dev3

Date: 2026-08-25
Host class: x86_64-linux development host (dev3), root ext4 1536 GB used at measurement

## Question

How much disk do dependency surfaces actually cost across worktrees, is pnpm's
dedup working, and would Buck-owned materialization save or add bytes?

## Method

- All sweeps used `du -x` with hardlink-aware accounting: naive per-directory
  sums were compared against combined invocations to expose real sharing.
- Store fragmentation was read from `node_modules/.modules.yaml` across all
  101 worktrees carrying installs, not inferred from config.
- Content-dedup potential was sampled twice with disjoint 4/256 hash-bucket
  samples (6.13x and 6.00x — stable ratio), anchored on 127.0 GB of store
  `files/`.
- pnpm link behavior was probed live: same-filesystem install of
  effect@3.21.4 → nlink=1034, zero new bytes; cross-filesystem (ext4 → ZFS)
  → nlink=1, 15 MB silently copied. The repo's device-ID guard lives in repo
  tooling and was bypassed with two commands.
- Buck materializer behavior was probed on the pinned build (2026-04-14):
  identical 13,481,348-byte rlib at two `buck-out` paths, different inodes,
  both nlink=1, same digest; `materializations = deferred` active; no CAS
  storage, no cross-project or cross-isolation-dir sharing.

## Result

| Consumer (root disk)                          | Size     |
| --------------------------------------------- | -------- |
| /nix                                          | 761 GB   |
| node_modules + all pnpm stores (in .megarepo) | 230.9 GB |
| — node_modules alone (3,195 dirs)             | 136.1 GB |
| — 61 private in-worktree stores               | 114.9 GB |
| — 6 mutually disjoint "shared" stores         | 35.6 GB  |
| Rust target/ (87 dirs)                        | 85.4 GB  |
| buck-out (15 dirs)                            | 7.8 GB   |

- Dedup is fragmented, not absent: 35 worktrees share one store (dedup works
  there), 10 share a different one, 35 carry private per-worktree stores with
  zero cross-worktree sharing, and 80.4 GB of node_modules bytes are
  hardlinked to nothing. Where sharing works, the marginal cost of a second
  worktree is ~145 MiB vs ~1.12 GiB isolated (7.9x, corroborated by the
  repo's own 2026-07-18 storage-sharing benchmark).
- Buck2's disk role at this pin is negative: it never dedups bytes it writes;
  remote-cache hits are full copies per project root x isolation dir. The 99%
  hardlink sharing observed in deploy-tree `buck-out` contents flows through
  the pnpm store (links pnpm created), not through Buck. Two probe scripts
  minting per-invocation isolation dirs (`...-$$-$RANDOM`) had accumulated 47
  stale isolation dirs (~5 GB, each re-expanding the ~23 MB bundled prelude).
- `[buck2] materializations = all` is rejected by the pinned build even though
  its error lists `all` as valid; `-M all` on the CLI works.

## Conclusion

The disk problem is /nix first and store fragmentation second; Buck adoption
does not solve either and adds copies unless constrained. Consequences taken:
BUCK-R08 gives `buck-out` the same anti-duplication obligation the pnpm store
contract already carries; store-per-filesystem consolidation (~95 GB at the
measured 6.0x ratio, one store per filesystem because hardlinks cannot cross
devices and pnpm silently copies instead of failing) and the ~38 GB
`mr store gc` reclaim are roadmap-parked operational work; probe scripts stop
minting per-invocation isolation dirs. /nix (761 GB) needs its own scheduled
investigation under the store GC lock.

## VRS Impact

Grounds BUCK-R08 (disk anti-duplication, including the buck-out obligation —
the pinned Buck2 has no content-addressed storage or hardlinking of its own)
and the roadmap's pnpm store-consolidation item. Establishes that dependency
disk economics flow through the shared pnpm store, not through Buck.
