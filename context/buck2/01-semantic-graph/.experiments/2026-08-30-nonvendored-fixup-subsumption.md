# Non-Vendored Fixup Subsumption Probe

Date: 2026-08-30 — Host: dev3 — Linux x86_64 — Reindeer 2026.05.04.00, Buck2 pin 2026-08-22 — snapshot 9877b8b28.

## Question

Are the eight fixups whose keys are silently inert under `vendor = false`
(`extra_srcs` on six crates, `precise_srcs = false` on two) a correctness risk
for the Buck-fetched graph, given that `unresolved_fixup_error` does not fire
on matched-but-discarded globs?

## Method

Generated the non-vendored BUCK twice — once with the eight fixup keys present
and once with them physically deleted — and compared bytes. Then built the
entire third-party tree (`buck2 build //rust/third-party/...`) under
`vendor = false` in a private isolation dir with remote execution disabled.

## Result

- The two generated BUCK files are byte-identical: the keys change nothing.
- The full tree builds: 365 targets, 972 commands, BUILD SUCCEEDED.
- Structural reason: those fixups repair `precise_srcs` UNDER-approximation
  (rustc module tracing misses other-platform files and macro-hidden modules).
  Non-vendored `srcs` is the whole `.crate` archive — an over-approximation
  that subsumes every addition. A fixup that NARROWS srcs would not be
  subsumed; `omit_srcs` is the dangerous key and is unused in all 26 fixups.

## Conclusion

The fail-open concern is benign for this crate set at this lock: the eight
keys are dead configuration under `vendor = false` and are deleted at the
flip. Because `unresolved_fixup_error` cannot police this class, the flip adds
a lint rejecting `omit_srcs` and `extra_srcs` in a non-vendored tree. Gate
restructuring (regenerate-and-diff buckify under a pinned cargo home with a
byte-unchanged lock assertion) remains the only prerequisite.

## VRS Impact

Amends [decision 0023](../../.decisions/0023-buck-fetched-rust-crates.md)
(Amendment 1): fixup re-verification is complete; the migration item becomes
key deletion plus the lint.
