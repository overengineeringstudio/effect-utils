# Tui-Core Scoped Editor Publisher

Date: 2026-08-27 — Host: dev3 (x86_64-linux) — Buck2 2026-08-22 — Bun 1.3.13.

## Question

Can the Buck-owned tui-core dependency surface be published through a stable,
scoped two-hop editor view without an absent-path window, byte copies, silent
staleness, global task edges, or deletion of the previous dependency surface?

## Method

1. Generated `//packages/@overeng/tui-core:editor_inputs` from the
   `PnpmNodeModulesInfo.editor_inputs` Stage-1 descriptor and audited the
   `:node_modules` providers.
2. Ran focused package tsgo, nine publisher unit/integration tests under pinned
   Bun, targeted oxlint/format, Genie freshness, and strict VRS validation.
3. Ran the scoped publish task against real tui-core Buck outputs. The task used
   a private Buck isolation, scratch under ignored `.devenv`, pinned Nix
   Buck/Bun/coreutils, and removed its scratch, daemon, and isolation output.
4. Forced a genuine descriptor change by atomically adding the temporary
   `editorAtomicityProbe` field to tui-core's generated package manifest. A
   fresh isolated Buck build produced the exact `:editor_inputs` and
   `:node_modules` artifacts; the publisher consumed those artifacts without
   altering them. The manifest was then restored byte-for-byte and the
   canonical artifacts were rebuilt and republished.
5. During each changed publication, a Bun control called `realpath` on
   `packages/@overeng/tui-core/node_modules` every 50 ms. This interval was only
   the observer schedule; publisher correctness used no sleep or timeout.
   Before and after state recorded both symlink texts, the first-hop lstat
   identity, current target, and legacy entry list.

## Result

- `audit providers` retained `DefaultInfo.default_outputs = node_modules` and
  `PnpmNodeModulesInfo.node_modules` plus `toolchain_identity`, while adding
  `editor_inputs = pnpm_install_descriptor`. The stable
  `//packages/@overeng/tui-core:editor_inputs` label built successfully.
- The canonical real publication record is:
  - editor-input fingerprint
    `d5d7ed53593fa1bf5eafff0b33e0e01942b6f6de6ca5e4e4203ef1950b55fc6a`;
  - node_modules tree digest
    `dd86e41a8ab53247bce2656dae44a4d61c57d1f8b33df56acdfca8740f6caa1e`;
  - first hop `../../.editor-view/tui-core/node_modules`;
  - current pointer
    `.store/tui-core-d5d7ed53593fa1bf5eafff0b33e0e01942b6f6de6ca5e4e4203ef1950b55fc6a`.
- Initial adoption exchanged and retained the previous directory as
  `.legacy/node_modules-77e3c1bc72c94b1c9012575a3f561009`.
- The forced descriptor build published fingerprint
  `0b4cfe6fbbb2d6d5226ac5c888056fe1c14878d1cf6d978c18628dd4f1c2aabc`.
  The observer collected 511 samples at 50 ms with zero resolution failures
  and observed both complete old and new snapshot paths. The literal first hop,
  its identity `65024:86801685:41471`, and the legacy entry list were unchanged.
- After exact manifest restoration, the reverse publication collected 545
  samples at 50 ms with zero failures and observed both complete snapshot
  paths. The canonical fingerprint was restored, both snapshots remained in
  `.store`, and the same legacy directory remained retained.
- Focused validation passed: package tsgo; 9/9 pinned-Bun tests; targeted oxlint
  with zero warnings/errors; targeted formatting; Genie freshness; strict VRS;
  Buck target/provider/build; real scoped publish, check, and token-gated lock
  recovery.
- No live editor or language-server process was held open. This is a resolver
  atomicity control, not the real-editor soak reserved for the next gate.

## Conclusion

The scoped publisher satisfies the mechanical cutover boundary: the first hop
is adopted once without absence, every later refresh is a same-directory atomic
rename of the second hop, candidates and private Buck state are cleaned,
records and paths fail closed, content identity is deterministic, retries are
idempotent, and old snapshots plus the exchanged root install are retained.
The resolver control observed no partial or missing state across two real
fingerprint changes.

## VRS Impact

Validates DEPS-R04, DEPS-R05, and DEPS-R06 for the scoped tui-core publication
mechanism and the Editor Surface/Staleness Gate sections of the materialization
spec. No requirement change. The real-editor soak remains deliberately
unvalidated here.
