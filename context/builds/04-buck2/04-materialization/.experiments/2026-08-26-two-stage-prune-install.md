# Two-Stage Prune → Canonical Lock → Frozen Install

Date: 2026-08-26
Host class: x86_64-linux development host; Bun 1.3.13 and pnpm 11.8.0 from the repository Nix pins.

## Question

Can a real pinned-pnpm prune produce a small, canonical install descriptor
whose content digest is the only dependency-data bridge into a frozen install,
so broad irrelevant manifest churn reruns only the prune while relevant
dependency churn invalidates the exact target closure (DEPS-R07, DEPS-R08)?

## Method

1. Staged the root manifest, full lock, workspace policy, 47 tracked package
   manifests, and the declared patch at two fixed scratch roots of different
   lengths. Ran immutable pnpm 11.8.0:

   ```text
   pnpm --dir <PRUNE_ROOT> --store-dir <EXPLICIT_WARM_STORE> deploy
     --filter @overeng/tui-core --prod=false --ignore-scripts
     --offline --frozen-lockfile <PRUNE_ROOT>/.deploy
   ```

   Captured the actual
   `<deploy>/node_modules/.pnpm/lock.yaml` as
   `packages/@overeng/buck2-tools/src/__fixtures__/pnpm-install-descriptor/pnpm-11.8.0-tui-core.raw.yaml`.
   Its SHA-256 is
   `ce46eb5ca4b2091b05519b800858e65264ae4f9e993d05841ed133998cac7931`.

2. Used the immutable Bun 1.3.13 runtime selected by the Buck toolchain. Its
   built-in `Bun.YAML.parse` / `Bun.YAML.stringify(value, null, 2)` avoids an
   undeclared parser package in either action. The canonicalizer recursively
   sorted mappings, replaced the fixed stage with literal `file://<WS>`, and
   removed only `packages.*.peerDependencies`. Golden variants differed in
   both scratch path and peer range; the exact common output fixture SHA-256 is
   `5486bc6e827b13003495025f80e40bfff250dd840f47a4f36d5ddb560a774d24`.

3. Derived `effect-utils/pnpm-install-descriptor/v1` from the canonical lock,
   target manifest, workspace policy, declared patch map, and only reachable
   `file:` workspace manifests. The descriptor rejects unresolved `file:` and
   patch references. Golden descriptor, aligned package manifest, and replay
   workspace fixture hashes are respectively
   `4e1f4d39ee3add4707be064e2abdd4c3c31b3977710e9d3da625831c0833945a`,
   `f031cc31080a2af9accb709f8738d426914a1859a1b0ba9c0ddfac04d622b5e0`,
   and `a3e74c1207fb59fcbd25ec9abc0ef2c09a15af98fa5d537e8aaa80d1474e50d5`.

4. Rehydrated the placeholder at a different fixed install root and ran the
   descriptor's exact argv:

   ```text
   pnpm --dir <INSTALL_ROOT> --store-dir <EXPLICIT_STORE> install
     --prod=false --ignore-scripts --offline --frozen-lockfile
   ```

   Normalized both the real-deploy oracle and frozen-install tree with the
   production normalizer, compared paths, file digests, modes, and symlink
   targets, and ran the materialized `node_modules/.bin/vitest --version`.

5. Built the unchanged public targets locally with remote lookup disabled.
   Read Buck `what-ran` records for baseline/no-op, an irrelevant manifest
   probe outside the tui-core closure, and a relevant direct dependency probe.
   Both probes were restored after their build. Stage-1 output hashes before
   and after the irrelevant probe were compared.

6. Invoked Stage 2 against an existing but empty explicit store, retaining
   `--offline` and `--frozen-lockfile`.

## Result

### Canonical bytes and schema

- Both real path-length deploys produced the same raw tui-core lock SHA-256.
- The combined path/peer-range golden variants produced byte-identical
  canonical output. A second canonicalization was also byte-identical.
- Golden assertions retain the full contextual snapshot key and its resolved
  peer suffix, retain snapshot peer data and `peerDependenciesMeta`, and remove
  only package declarations' `peerDependencies`.
- Malformed required lock sections and stage-replacement key collisions fail.
- The real Stage-1 descriptor TREE is 40,008 bytes. Baseline canonical lock,
  descriptor, aligned manifest, and workspace-policy SHA-256 values were:

  ```text
  pnpm-lock.yaml          3cc7c91543551cafb4cf478a7ff35efcc0ea359582626e47d520737eb3205b8e
  install-descriptor.json 2a098107fd2083a95f7f00d409713c7ce4de92e590c402da7733b9d096187467
  package.json            a65af4fbaf280a3fc0c09721930a5d6231d9f02c01dfcbcba73a31d03be6ab46
  pnpm-workspace.yaml     54d1ccf9aaabdc86ab1a4e3e1bbbc540c60d2a10fe5bb0a8fa56941c6f00674b
  ```

### Frozen replay parity

The normalized deploy oracle had 6,081 entries and the production Stage-2
install had 5,950. The Stage-2 set contained no additional runtime entry. The
one differing Stage-2 record was `.modules.yaml`, whose metadata truthfully
records the platform omissions. The oracle-only set contained exactly 131
filesystem entries, all belonging to foreign-platform optional package
materialization. Manifest digests (including that allowed difference) were:

```text
real-deploy oracle 8a7b68eb1cfd0e2bb8a9b0908a989948c4338ba4805fda9e222309831f417567
frozen Stage 2     103070da67017c08a7bc2df2097d6031adf4f1a974a2034661889d58e865c9da
```

Executable smoke returned `vitest/4.1.9 linux-x64` successfully.

### Buck action boundary

The first `//packages/@overeng/tui-core:node_modules` build ran exactly two
local actions: `pnpm_pruned_lock` then `pnpm_node_modules`. Stage 2's command
contained only the Stage-1 `pnpm_install_descriptor` artifact plus the pinned
Bun/pnpm, descriptor module, normalizer, explicit store, and output path; it
contained none of the root lock, root/workspace manifests, all-manifest map, or
full patch map.

A complete warm `:dist` no-op emitted zero `what-ran` records. Adding a JSON
field to `packages/@overeng/notion-core/package.json` emitted exactly one
record, `pnpm_pruned_lock`; `pnpm_node_modules`, `package_tree`, `tsgo_emit`, and
`tsgo_typecheck` emitted zero records. The four Stage-1 file hashes above were
unchanged.

Adding `picocolors@1.1.1` consistently to tui-core's manifest and root-lock
importer emitted exactly the target closure: `pnpm_pruned_lock`,
`pnpm_node_modules`, `package_tree`, and `tsgo_emit`; building `:typecheck`
then emitted `tsgo_typecheck`. All succeeded. Restoring the dependency emitted
the same five-action closure back to the baseline.

### Offline failure

Stage 2 with an empty explicit store failed with
`ERR_PNPM_NO_OFFLINE_TARBALL` for the first missing integrity-addressed package.
The command made no network fallback and removed its incomplete output.

## Conclusion

The literal two-action reading of DEPS-R07 is implemented and observed. A real
prune remains broad and authoritative, but only its 40 KiB canonical descriptor
digest crosses into the expensive Stage-2 TREE. Irrelevant broad churn therefore
pays only for prune; relevant dependency churn still reaches every affected
consumer. Frozen replay matches the accepted deploy oracle except for the
one-way foreign-platform optional omission allowed by DEPS-T01, and the store
remains a byte source rather than dependency authority.

## VRS Impact

- The implementation now conforms to DEPS-R07's prune-then-install action
  boundary and DEPS-R08's offline fail-closed behavior.
- `spec.md` now records the exact descriptor schema, canonicalization,
  Stage-2 argv, action inputs, and only allowed replay difference.
- No requirement or accepted decision changed.
