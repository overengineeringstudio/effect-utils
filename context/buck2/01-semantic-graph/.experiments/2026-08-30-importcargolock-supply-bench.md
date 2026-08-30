# importCargoLock Supply Bench

Date: 2026-08-30 — Host: dev3 — Linux x86_64 — flake at 4156637c9.

## Question

Is the Nix `importCargoLock` vendor supply sound as the permanent Rust
third-party source mechanism, and what does it require under composition?

## Method

Traced the mechanism (`flake.nix` `buck2-rust-vendor`, the devenv
materialization task, Reindeer `[vendor]` mode, `precise_srcs`), measured store
paths, file counts, and rebuild identity with an unchanged lockfile, checked
every `.nix` file for hand-maintained hashes on this path, and analyzed the
locked cp-a member case against decision 0020 Amendment 2 and the mr projection
schema (`member-mount-cp-a.ts`, `member-mount-r6.ts`).

## Result

- No hand-maintained hash exists: per-crate derivations embed `Cargo.lock`
  checksums verbatim; crate store paths are independent and substitutable.
- The vendor directory is a symlink farm over `/nix/store` (237 crates,
  12,300 files, 274 MB content); materialization is a symlink swap.
- Defect: the derivation input is `self.outPath`, so the vendor path rebuilds
  on every working-tree change (14 store paths against 5 lock changes ever)
  and drags a ~3 GB whole-repo closure (~276 MB with an isolated lock path);
  the farm derivation can never be substituted in CI.
- Composition: `projectIgnore` does not cover the vendor dir and must not
  (2,742 declared source inputs), yet git ignores it — a pristine locked
  member lacks the dir and fails, and materializing it into the source is
  refused at admission (ignored bytes). Neither overlay (needs a Buck target)
  nor capability (needs an executable) can declare a source tree; the copy
  rail itself is mechanically compatible (Nix dirs at 0444/0555).
- The published symlink target is an absolute machine-local `/nix/store` path —
  dangling on any consumer host without those crate paths.
- Buck never built a vendored crate target on this branch; whether
  `precise_srcs` resolves through a symlinked source directory is unexercised.

## Conclusion

The Nix supply has zero hash maintenance and no crawl cost, but is structurally
incompatible with locked members without a new mr source-projection type, and
carries an input over-capture defect and machine-local symlinks. Keeping it
means a second dependency-supply mechanism beside the JS closure.

## VRS Impact

Grounds [decision 0023](../../.decisions/0023-buck-fetched-rust-crates.md)'s
rejection of the vendor option; the over-capture defect is moot once
`buck2-rust-vendor` is deleted.
