# Reindeer Non-Vendored Prototype

Date: 2026-08-30 — Host: dev3 — Linux x86_64 — Reindeer 2026.05.04.00 (nixpkgs), Buck2 pin 2026-08-22 — snapshot 9877b8b28.

## Question

Does Reindeer `vendor = false` produce a working, hash-pinned, composition-safe
third-party graph for the real five-member Rust workspace, and how does it
compare to the vendored shape?

## Method

Copied the real `rust/` workspace (241 lock packages, 26 fixup dirs, 17
buildscript policies) into scratch, reproduced the committed vendored BUCK
byte-for-byte as a control, then regenerated with `vendor = false` after
removing `rust/third-party/.cargo/config.toml` (its `[source.vendored-sources]`
stanza forces vendored mode regardless of config — Reindeer `main.rs:243-251`).
Built a leaf crate and a build-script crate in both variants under a private
isolation dir with remote execution disabled; measured target counts, generated
lines, `what-ran` action counts on a one-crate lock bump, `uquery inputs()`
source counts, a simulated tracked-files-only cp-a member build, cold-cargo-home
buckify behavior, and symlink-retarget invalidation. Host load ~244/32 with
disk at 97%, so wall-clock was deliberately not measured; all results are
countables.

## Result

- Non-vendored buckify: exit 0 on all 241 packages with all 26 fixups; 126
  `http_archive` targets with sha256 verbatim from `Cargo.lock`; zero git deps.
  Generated BUCK 3,317 lines / 84,839 bytes versus 5,824 / 231,895 vendored.
- Both variants build the leaf and the build-script crate; warm no-op is zero
  actions in both.
- One-crate bump (memchr 2.8.3→2.8.2): 4 actions and 8 changed BUCK lines
  non-vendored; 9 actions and 82 lines vendored — the five extra re-runs are
  the vendor symlink retarget (Buck digests the external symlink target
  string; decision 0020's content-blindness, here as over-invalidation, also
  reproduced directly with a byte-identical retarget re-running 8 actions).
- Simulated locked member (tracked files only): non-vendored BUILD SUCCEEDED;
  vendored fails at BUCK evaluation coercing `licenses` against the absent
  gitignored `vendor/`.
- `uquery inputs()`: 3,198 source files vendored, 0 non-vendored.
- Eight fixups (`extra_srcs` on six crates, `precise_srcs = false` on two) use
  keys that are silently inert non-vendored; `unresolved_fixup_error = true`
  does not fire on this class.
- Non-vendored buckify omits `--frozen --locked --offline`, may rewrite the
  lockfile (did not here with a warm cargo home), and with a cold cargo home
  downloaded 371 MB from crates.io while exiting 0.
- Fetch URLs are hardcoded to `static.crates.io`; `http_archive` carries no
  size, so a clean build issues one HEAD per archive even on CAS hits.

## Conclusion

Non-vendored Reindeer is viable on this workspace, halves the generated graph,
invalidates more precisely, needs no hash sidecar, and is the only shape that
builds from a locked cp-a member's tracked files. Its costs are gate-side:
buckify needs network and a pinned cargo home plus a lock-unchanged assertion,
and the eight inert fixups need build verification.

## VRS Impact

Grounds [decision 0023](../../.decisions/0023-buck-fetched-rust-crates.md);
narrows decision 0017 Amendment 1 (Amendment 2) and retires decision 0019's
vendoring (Amendment 1).
