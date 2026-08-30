# 0023 Buck-Fetched Rust Third-Party Crates

Status: accepted

## Context

Phase 5 selected one strict whole-workspace Reindeer graph (decision 0017
Amendment 1). Third-party sources were supplied by Nix: `buck2-rust-vendor`
(`rustPlatform.importCargoLock`) realized the crate set and a devenv task
symlinked it to `rust/third-party/vendor`, which Reindeer consumed in vendored
mode. Decision [0022](./0022-lockfile-derived-declared-closure.md) made Buck
fetch the JS dependency closure directly, raising the question whether Rust
should share that supply mechanism.

## Evidence and Argument

Two experiments on 2026-08-30
([non-vendored prototype](../01-semantic-graph/.experiments/2026-08-30-reindeer-nonvendored-prototype.md),
[Nix supply bench](../01-semantic-graph/.experiments/2026-08-30-importcargolock-supply-bench.md))
established:

- The vendored shape is structurally incompatible with locked cp-a members:
  the vendor directory is gitignored yet a mandatory Buck input, so a pristine
  member fails at BUCK evaluation and a materialized member is refused at
  admission (decision 0020 Amendment 2). Repair requires a new mr projection
  type — a second supply mechanism beside the JS closure.
- Reindeer `vendor = false` works on the real 241-package workspace with all
  26 fixups: 126 `http_archive` targets whose sha256 comes verbatim from
  `Cargo.lock` (no sidecar), generated BUCK −43% lines, a one-crate bump
  re-runs 4 actions and 8 BUCK lines (vendored: 9 and 82, symlink retargeting
  over-invalidates), and a simulated locked member builds from tracked files
  alone.
- The Nix path additionally over-captured `self.outPath` (vendor path churned
  on every commit; ~3 GB avoidable closure) and published absolute
  machine-local `/nix/store` symlinks.

## Options

| Option                        | Tradeoff                                                                                     | Outcome  |
| ----------------------------- | -------------------------------------------------------------------------------------------- | -------- |
| Buck-fetched crates           | One supply mechanism; composition works from tracked files; buckify gate needs network       | Accepted |
| Nix vendor + new mr projection | Zero-maintenance hashes and offline buckify retained; second mechanism, new projection type  | Rejected |

## Decision

Rust third-party sources are Buck-fetched. Reindeer runs with `vendor = false`
and emits hash-pinned `http_archive` targets from the authoritative
`rust/Cargo.lock`; `buck2-rust-vendor`, the vendor materialization task, the
vendor symlink, and `rust/third-party/.cargo/config.toml` (whose presence
forces vendored mode) are deleted. Network access exists only in fetch actions,
mirroring DEPS-R08; build and buildscript actions stay offline. The generation
gate runs buckify under a pinned cargo home and asserts `Cargo.lock` is
byte-unchanged, because non-vendored buckify is structurally able to rewrite
it. The eight fixups whose keys are inert non-vendored (`extra_srcs`,
`precise_srcs = false` — compensations for vendored-mode source pruning) are
re-verified by building their crates before the graph is admitted.

## Consequences

- Decision 0017 Amendment 1's "network-free during Buck execution" narrows to
  "network only in hash-pinned fetch actions", the same posture as DEPS-R08.
- Decision 0019's temporary complete-lock vendoring is retired without waiting
  for its original portability trigger.
- Fetch URLs are pinned to `static.crates.io` by Reindeer (no mirror knob);
  clean builds issue one HEAD per archive. CI fetch caching shares
  open question DQ1 of the materialization subsystem.
- The Reindeer pin (2026.05.04.00 via nixpkgs) demonstrably supports
  `vendor = false`; an upstream 2026-07 change may affect that mode and gates
  future Reindeer bumps on re-verification.

## Amendment 1

The eight-fixup re-verification required by the Decision is complete
([subsumption probe](../01-semantic-graph/.experiments/2026-08-30-nonvendored-fixup-subsumption.md)):
the generated BUCK is byte-identical with the keys deleted and the full
third-party tree builds green non-vendored. The keys are deleted at the flip,
and the flip adds a lint rejecting `omit_srcs` and `extra_srcs` in a
non-vendored tree, since `unresolved_fixup_error` does not fire on
matched-but-discarded globs. Two further refinements from the cross-check:
the vendored shape's per-commit store-path churn and its symlink
over-invalidation share one root cause (`self.outPath` over-capture in the
vendor derivation), so the composition blocker — evaluation-time failure of
the whole third-party package on a locked member, with the `licenses`-pattern
escape closed — is the load-bearing evidence for this decision, not the churn;
and the 126 `licenses` attributes are dropped by non-vendored Reindeer
(upstream limitation), accepted as a cost.
