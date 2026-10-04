# Read-Only pnpm Store and `--frozen-store`

Date: 2026-08-30 — Host: dev3 (Linux x86_64) and a macOS arm64 host — pinned pnpm 11.8.0.

## Question

Why does the frozen offline install fail against a read-only store inside a
locked member, and can the pinned pnpm read a fully immutable store?

## Method

Reproduced the production failure in scratch with a six-case store-permission
matrix under the production argv, then re-ran with `--frozen-store` (added in
pnpm 11.7, present in the 11.8.0 pin) on both the install action and the
non-legacy injected `deploy` path. Read the mechanism out of the pinned bundle.
Verified the `st_dev` same-filesystem guard against dev3's `/nix/store` bind
mount. Compared against pnpm 12.1.0 and Bun 1.4.0 on the same matrix. A macOS
host re-derived the two stale FOD hashes found on the branch.

## Result

- The write is incidental: SQLite in WAL mode must create `index.db-wal` and
  `-shm` in the store directory at open, and `registerProject` symlinks into
  `v11/projects/`; `index.db` itself is never written on the frozen path.
- `--frozen-store` opens the index through an immutable SQLite URI, prepares
  only read statements, skips `registerProject`, and succeeds against a fully
  read-only store on install and on injected deploy, with hardlinks intact and
  the pruned lockfile byproduct produced. Node ≥ 22.15 is satisfied by the pin.
- The store path `repos/effect-utils/.devenv/pnpm-store-pure-v1` does not exist
  in a locked member (clean commit sources carry no `.devenv`; R6 mode policy
  rejects a live 0644 store), so `requireWarmStore` fails before pnpm runs;
  relocation would be required in addition to the flag.
- The same-filesystem guard compares `st_dev`, which is equal across a bind
  mount of one filesystem while `link(2)` returns EXDEV; pnpm then silently
  copies (BUCK-R08 violation).
- pnpm 12.1.0 keeps lockfile v9 and store v11, retires no normalizer transform,
  rejects `--prod=false`, and ships native binaries. Bun 1.4.0 needs a writable
  cache root and silently dropped a `patchedDependencies` entry on the real
  manifests with exit 0.
- Two FOD hashes (tui-stories, notion-md) were stale on both platforms with
  identical values; one lockfile-touching commit staled all lockfile-derived
  hashes and the refresh cascade missed two.

## Conclusion

The ambient-store design is repairable with `--frozen-store` plus store
relocation plus a mount-aware guard, at ~150–250 lines. That bounds the cost of
keeping the design; it does not remove the mutable-store state class, which
[decision 0022](../../.decisions/0022-lockfile-derived-declared-closure.md)
dissolves instead. `mkSharedHash` is defined separately in five build files and
asserts cross-platform sharing without enforcing it.

## VRS Impact

Informs decision 0022 (option "ambient store, repaired"). Corrects DEPS-R04 and
decision 0015's "same-filesystem" wording to same-mount for as long as any
hardlink-from-store path survives. The 2026-08-30 production cp-a record's
conclusion is superseded: the remaining run needs neither a shared-cache
precondition nor a writable projection.
