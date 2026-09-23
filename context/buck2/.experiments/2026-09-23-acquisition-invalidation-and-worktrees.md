# Acquisition invalidation and physical worktrees

Date: 2026-09-23

## Environment

Both experiments used detached physical worktrees on local disk at
`3ce4b75a10`. The bulk-backed checkout is excluded from timing conclusions
because its measured filesystem walk is approximately 350 times slower. Each
root used the checked-in capability projection, notify watcher, private
archive-origin posture, fresh `pair` isolation, and no remote execution or action
cache.

## Two-worktree sample

The same Genie candidate was built independently in two physical worktrees.
Both performed 587 local command actions, downloaded 50 MiB, and produced
SHA-256 `66838fbd49a6f7fe3fcc53c73dacc46a1486e05238ff0368d826a932fb520861`.

| Worktree | Wall time | Physical `buck-out/pair` | Apparent size |
| --- | ---: | ---: | ---: |
| A | 21.27 s | 492,331,008 B | 383,718,725 B |
| B | 22.71 s | 490,565,632 B | 381,974,980 B |

The private archive CAS avoids registry authority but does not eliminate
per-worktree output materialization: the second fresh root still transferred 50
MiB and occupied about 491 MB physically. This is the measured cost of isolated
worktrees without a shared action cache.

## Content-changing mutation

The real `effect@4.0.0-rc.112` archive was unpacked, a new
`package/acquisition-proof.txt` file was added, and it was repacked. The fixture
was seeded under its truthful SHA-256 and size, then the generated declaration
in the disposable root was pointed at it. A second warm mutation appended
additional content and changed the archive from
`cbf082…`/8,923,169 B to `765d8c…`/8,923,173 B.

The warm baseline for Genie plus the otel-contract package executed 798 local
commands. After the second content mutation, Buck observed only the dependency
BUCK change and executed 45 local commands, downloading 17 MiB. `log what-ran`
contained the mutated Effect extraction, its exact store entries/views, and the
resulting package-tree/emit/product consumers. The remaining 753 warm-baseline
commands did not rerun. Both requested products completed successfully.

This is a real archive-content transition rather than the earlier trailing-byte
probe. It demonstrates dependency-directed invalidation while also making the
cost visible: changing a high-fanout dependency intentionally reaches several
package views and their consumers, but not the complete build graph.
