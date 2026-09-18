# No-Registry Package Publication Edge

Date: 2026-09-14. Producer: effect-utils. Consumer: dotfiles `@dotfiles/notion-scan`. Package manager: pnpm. Durable origin: immutable GitHub Release assets in `overengineeringstudio/effect-utils`; the Buck action cache is only an accelerator.

## Question

Can one real `@overeng/utils` edge leave source composition and use only Buck-built, content-addressed package assets without adding a package registry or weakening dependency integrity?

## Method

1. Extend `npm_package_product` so package targets consume sibling package descriptors. Pack the three-package runtime closure in dependency order: `@overeng/content-address`, `@overeng/effect-distributed-lock`, and `@overeng/otel-contract`, then `@overeng/utils`.
2. Rewrite runtime `workspace:` and `catalog:` edges to each sibling descriptor's immutable release URL. Reject any remaining `workspace:`, `catalog:`, `link:`, or `file:` runtime edge. Keep peer dependencies unchanged.
3. Extend the existing `nix/buck2-products/publish.sh` publisher. Keep scoped package identity separate from the transport slug. Publish `<sha256>-<slug>.tgz` under `buck2-package-v1-<slug>-<sha256>` as an immutable prerelease.
4. Consume the public `@overeng/utils` URL from dotfiles `apps/notion-scan`. Remove the direct source dependency and generated source-closure entry. Run frozen install twice, typecheck, and the existing unit test.

## Publication Contract

The archive manifest omits `private`, replaces its source exports with verified Buck `dist` exports, and contains no local runtime specifier. The `effect-utils/npm-package-product/v2` descriptor records package name, version, transport slug, Buck target, SHA-256, SHA-512 integrity, dependency release URLs and integrity, and its derived release identity. The tracked product manifest adds the producer commit. Publication refuses dirty worktrees, mismatched existing tags, mutable releases, digest drift, and non-prerelease package releases.

The runtime sibling closure contains exactly three packages: `@overeng/effect-distributed-lock`, `@overeng/otel-contract`, and transitive `@overeng/content-address`. Development-only `@overeng/utils-dev` is not published or recorded as runtime closure.

## Pin Derivation Sketch

1. Read `members.effect-utils.commit` from `megarepo.lock`; reject a non-full commit.
2. Fetch `nix/buck2-products/manifest.json` at that exact public commit.
3. Select the entry whose descriptor `productName` equals the requested package.
4. Verify `entry.producerCommit` equals the locked commit.
5. Re-derive the release tag, asset name, and URL from `transportSlug` plus `sha256`.
6. Verify the descriptor SHA-256 and release SHA-256 binding.
7. Return `{ url: entry.release.url, integrity: descriptor.sha512 }`.
8. Genie writes the URL into the consumer manifest/parent override; pnpm writes and verifies the same SHA-512 in `pnpm-lock.yaml`.
9. A megarepo repin reruns this pure projection. A missing entry or any mismatch fails generation before install.

No implementation is needed for this edge proof. The pure projection is small, but adding it before a second consumer would add standing machinery without amortization.

## Result

Publication succeeded from producer commit `a81f26a433fe751ed9918f9c0bfff6d4744e6c83`. The four public products are:

- `@overeng/content-address`: `d29fd555cf08393c9f1907eb8b76008f69126a4dd4e80d68f72e779489f1e783`
- `@overeng/effect-distributed-lock`: `e1952c9ec4ca3d1dff326ca3ccceab40dea2a17b935a11110401ae95afee857c`
- `@overeng/otel-contract`: `b57fa77ee593e36577b295e03b529e41c4932b5d2b6ddfa2b5fedf60bedd5c75`
- `@overeng/utils`: `7b1c61692ab180d65fe0f4e6f555ee8ad3ea22334ce90ed079254688b6192452`

The public utils URL returned HTTP 200 without authentication. Its fetched SHA-512 was `sha512-xS9ZPedqG53FrL+7s+DGklDQkIt8NcrNyjGZxRH9r17dVWMXBc9pbqfUlFY5iUzqL0ZKBXW9QG0pb+vhmtZoGw==`, equal to the descriptor and consumer lock entry. A second publisher run reused all four verified releases and changed nothing.

The dotfiles consumer is commit `4983ee570a`. It pins the producer commit in `megarepo.lock`, which aligns the starting Effect mismatch from rc.111 to the artifact's rc.112 cohort. The direct source dependency, generated `link:` edge, and utils source-closure entry are absent. Parent-specific overrides carry the utils and three sibling URLs. pnpm has no per-package exception for `blockExoticSubdeps`, so the workspace sets `blockExoticSubdeps: false`; only the six exact parent/package overrides introduce allowed exotic subdependencies.

Direct Genie generation and check passed. The packer suite passed 69 tests. The publisher contract passed. The dotfiles frozen install passed with pnpm 11.8.0, notion-scan typechecking passed, and its focused test passed 28 tests. The repeated frozen install skipped resolution with zero downloads and zero additions, but pnpm's existing injected-workspace cleanup still reported `Packages: -147`; strict filesystem no-op output was not achieved.

The marginal BUCK-R15 ledger is 607 added, 125 deleted, net +482. The 125 deletions are 120 replaced shared-machinery lines plus 5 consumer source-shim, link-edge, and closure-entry lines. Tests, documentation, changelog text, generated outputs, the manifest data, and the experiment record are excluded.

## Conclusion

The no-registry artifact edge works, but it does not pass the marginal machinery gate or a strict second-install filesystem no-op.

## VRS Impact

This experiment proves public, immutable no-registry publication and one artifact-backed consumer edge. It does not admit artifact-default composition: the marginal machinery gate remains positive, and pnpm's repeated injected-workspace cleanup prevents a strict second-install filesystem no-op. It does not amend requirements or accepted decisions.
