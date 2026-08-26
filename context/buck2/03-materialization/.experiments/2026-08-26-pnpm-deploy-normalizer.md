# pnpm Deploy Normalization on the Real 11.8.0 Tree

Date: 2026-08-26
Host class: x86_64-linux development host; pnpm 11.8.0 from the repository Nix/devenv pin.

## Question

Which bytes emitted by the pinned `pnpm deploy` require normalization, and
what is the smallest deterministic, fail-closed transform for the final deploy
tree?

## Method

A scratch workspace outside the repository was staged at the fixed path
`/tmp/effect-utils-pnpm-normalizer-evidence/stage`. It contained only the root
manifest, lockfile, workspace manifest, every workspace `package.json`, and the
declared patch file (50 files). The repository's Nix pin resolved pnpm 11.8.0;
plain `pnpm` was not on `PATH`. The existing self-contained shared store was
passed explicitly:

```text
pnpm --dir /tmp/effect-utils-pnpm-normalizer-evidence/stage \
  --store-dir <shared-store> \
  deploy --filter @overeng/tui-core --prod=false --ignore-scripts \
  --offline --frozen-lockfile \
  /tmp/effect-utils-pnpm-normalizer-evidence/deploy
```

The command reused 74 packages and downloaded zero package payloads. The raw
tree was inspected byte-for-byte for the fixed scratch prefix, all `.bin`
directories were enumerated recursively, every symlink target was resolved,
and pnpm's workspace-injection metadata and virtual-store entries were
inspected. The repo-local normalizer was then run twice on that exact tree. A
path-and-content SHA-256 over every regular file and symlink target was compared
between runs. Retained source fixtures derive directly from the observed tree (with only the shared-store path sanitized) and contain the 7,735-byte
`.modules.yaml`, 2,050-byte `tsc` shim, 2,898-byte workspace-state file, and a
representative root-lock excerpt.

## Result

The observed impurity set and exact treatment are:

| Observed output | Evidence | Transform |
| --- | --- | --- |
| `node_modules/.modules.yaml` | JSON despite its suffix; top-level `prunedAt` was `Wed, 26 Aug 2026 14:59:52 GMT`. | Parse as JSON, delete only `prunedAt`, and serialize with two-space indentation plus one final newline. |
| `node_modules/.pnpm/lock.yaml` | 35.5 KiB install byproduct inside the tree it describes. | Delete it. |
| deploy-root `pnpm-lock.yaml` | The deploy-generated, unpruned lock contained 138 fixed-stage-prefix occurrences and is not a runtime input. | Delete it from the final deploy tree. |
| `node_modules/.pnpm-workspace-state-v1.json` | Contained a millisecond validation timestamp and the absolute staged patch path (one fixed-prefix occurrence). | Delete it; it is pnpm mutation state, not runtime dependency state. |
| recursive `.bin` shims | 19 shims contained 127 fixed-prefix occurrences. Root and nested shims both encoded absolute `NODE_PATH` entries and `cmd-shim-target` comments. | In each shim, replace the absolute deploy `node_modules` and deploy-root prefixes with a path rooted at that shim's runtime `$basedir`. Preserve every other byte. |
| dependency symlinks | All 167 emitted targets were relative and resolvable. `.modules.yaml` listed 41 platform-skipped optional packages, but this Linux deploy emitted zero dangling links. | Remove a dangling symlink only when it is below `node_modules`; then fail if any dangling symlink remains anywhere. A retained focused fixture covers the cross-platform dangling-optional shape. |
| workspace injection | `injectedDeps` was `{}` and no workspace package appeared in the 74-package virtual store because `@overeng/tui-core` currently has no workspace dependency. | No workspace-copy rewrite belongs in this normalizer for this fixture; the separate symlink-back materialization step remains responsible when a package has injected workspace dependencies. |

After normalization, `prunedAt`, both lockfiles, and workspace mutation state
were absent; all 19 shims were stage-prefix-free; all symlinks resolved; and a
full scan found no fixed scratch prefix. The first and second normalized tree
hashes were both
`62c56cb19ce24a43973a8f939034d5b94ef33b3450f69a79fd6dafc7579bb3ea`.
Focused tests also prove idempotence, the required `--tree` / `--stage-prefix`
CLI, residual-prefix failure, and residual-dangling-symlink failure.

The `--offline` run downloaded zero package payloads, but pnpm's supply-chain
policy verification still logged registry request timing warnings. That
behavior is outside tree normalization and remains evidence for the later
offline materialization action check.

## Conclusion

Normalization is one evidence-bounded transform, not a generic metadata
scrubber: remove three deploy-only metadata artifacts, delete the JSON
timestamp field, relativize every recursive `.bin` shim against its own
`$basedir`, prune dangling dependency symlinks, and finally scan the complete
tree fail-closed for the fixed stage prefix and any dangling link. The transform
is deterministic and idempotent on the real pnpm 11.8.0 deploy.

## VRS Impact

Refines [the Materialization Action](../spec.md#materialization-action) with the
observed deploy-root lock and workspace-state deletion, recursive shim scope,
and final fail-closed scans. Grounds DEPS-R02 without changing requirements.
The fixture does not evidence a workspace injected-copy rewrite because
`tui-core` has no workspace dependency; DEPS-R03's symlink-back remains a
separate materialization step rather than guessed normalizer behavior.
