# Production cp-a Member End to End

Date: 2026-08-30 — Host: dev3 — Linux x86_64 — Buck2 pin 2026-08-22.

## Question

Can the production composition path acquire a fresh workspace with a writable owned member, materialize the real effect-utils commit as a read-only `cp -a` member, and build a real effect-utils Buck target?

## Method

Built the branch's exact `.#megarepo` package and ran it against an isolated canonical-store fixture outside the source repository. The fixture used a minimal writable owned member and locked effect-utils commit `5dd8c4f4b1b178bfdcb6787277c6674d1797d69a` as the non-ignored platform-hub member. The immutable source used canonical R6 modes. Dry-run and apply used the production CLI, Nix capability resolver, cp-a runtime, root publisher, and Buck 2026-08-22.

The run uncovered three production-only gaps hidden by prior fixtures and the owned-effect-utils production run:

1. A fresh workspace tried to build dist overlays before publishing its first Buck root authority. The apply path now bootstraps a `Create` root before overlays while preserving overlay-before-root ordering for updates.
2. Resolved capability projections used writable file modes, so the real cp-a runtime rejected them as non-R6 input. Projection files now use 0444/0555 modes, directories use source-mode 0755, and release restores owner-writable directories before cleanup.
3. Repository identity included the synthetic `.buck2` capability namespace container, adding one entry to the mounted repository identity. R6 repository scans now omit that container while continuing to scan non-capability siblings.

After these fixes, production dry-run passed, owned acquisition completed through real cp-a source/capability validation, and the real overlay Buck build started. It then failed after 46 seconds at `remote_action_cache` with `No engine address`: the CI/off-tailnet `BUCK2_NO_REMOTE_CACHE=1` toggle is a devenv shell-entry action, but composition executes the first overlay before any shell entry can materialize or remove root-local cache configuration.

## Result

- Production dry-run: PASS.
- Real immutable effect-utils cp-a source validation: PASS.
- Real capability projection R6 validation: PASS.
- Real cp-a candidate repository/capability identity postcondition: PASS.
- Fresh-root Buck bootstrap reached the real `effect_utils//packages/@overeng/tui-core:dist` overlay build: PASS.
- Complete target build: BLOCKED by the first-composition cache-toggle lifecycle gap.

Focused regression suites pass: composition apply (14), capability resolver (20), R6 scanner plus cp-a lifecycle (50).

## Conclusion

The real cp-a path is no longer only fixture-proven: production acquisition reaches a real effect-utils Buck action through a read-only member. The Phase-2 production-gate item remains open because the action did not complete. The next fix must make off-tailnet cache policy available before the first overlay action without weakening the hard-fail cache contract or adding a second Buck authority path.

## VRS Impact

No requirement or decision changes. The evidence narrows the remaining Phase-2 gate to cache-policy lifecycle ordering. Decision 0020's cp-a mechanism and R6 identity model remain intact.
