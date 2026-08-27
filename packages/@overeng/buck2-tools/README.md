# `@overeng/buck2-tools`

Experimental, fail-closed compilers for the generated Buck2 repository graph.

The first compiler projects an exact task dependency closure from a pnpm 11.8 lockfile-v9
snapshot. It deliberately separates three identities:

- `PackageContentId`: verified normalized final package-tree bytes.
- `PackageContextId`: one reusable local pnpm context with lock-native child locators.
- `TaskClosureId`: task roots plus the resolved locator-to-context graph, platform, and deterministic
  optional omissions.

Resolved child IDs intentionally do not live in shared context records. A child byte change therefore
reuses the unchanged parent record while changing the task-local graph and `TaskClosureId`; dependency
cycles also require no recursive hashing.

This separation lets unrelated lockfile, catalog, override, and package-extension changes leave a
task key untouched. A separate frozen-lock validation gate must prove that those global policies
have already been compiled into the lockfile snapshots before this compiler runs.

## API

```ts
import { compilePnpmTaskClosure, renderPnpmClosureShards } from '@overeng/buck2-tools'

const closure = compilePnpmTaskClosure({
  pnpmVersion: '11.8.0',
  lockfile,
  request: {
    label: '//packages/example:check',
    importerId: 'packages/example',
    mode: 'check',
    platformRole: 'exec',
    platform: { os: 'linux', cpu: 'x64', libc: 'glibc', nodeAbi: '127' },
    roots: [{ alias: 'effect', field: 'devDependencies', reason: 'generated static import' }],
  },
  workspaceLabels: { 'packages/shared': '//packages/shared:lib' },
  normalizedPayloads: {
    'effect@3.21.4': {
      digest: 'sha256:<verified-normalized-tree-digest>',
      materializer: {
        abi: 'pnpm-package-files-v1',
        buildPolicyDigest: 'sha256:<package-specific-policy>',
      },
    },
  },
})

const shards = renderPnpmClosureShards(closure)
```

The caller parses YAML, runs pnpm's frozen-lock/config validation, supplies generated task roots,
and writes returned shards. Every selected contextual dependency path requires a verified
`normalizedPayloads` entry produced after patches and package-specific build policy. Registry
archive integrity alone is not a normalized output-tree digest and is deliberately insufficient.
Workspace links become Buck labels rather than ambient `node_modules` paths.

The caller must derive package-specific materializer policy (for example, whether that package is
allowed to run install/build scripts) before producing the normalized digest. A workspace-wide
`allowBuilds` checksum would be safe but unnecessarily invalidates unrelated package content.

Use `discoverPnpmTaskClosureInputs` before materialization. It shares the authoritative traversal and
returns exact contextual paths, package name/version, patch hash, and source resolution, but no
authoritative IDs. Genie can emit this plan; Buck then materializes and hashes each selected package,
and invokes `compilePnpmTaskClosure` with the verified payload evidence.

## Repository integration

Genie owns this package's manifest and TypeScript project registration. The first package-local
consumer is `@overeng/tui-core`: its generated shard is deliberately a non-authoritative input plan.
It proves exact source census and lock/policy reachability, but cannot become a production closure
until a Buck action materializes every selected package, records verified normalized final-tree
digests, and calls the authoritative compiler. Remote admission remains disabled for that reason.

## Scoped editor publisher

`src/editor-view.ts` publishes and checks the tui-core editor dependency view.
It consumes the built Buck `:editor_inputs` and `:node_modules` artifacts,
uses immutable Nix `cp -al` and GNU `mv --exchange --no-copy`, and retains all
published snapshots and any exchanged root-install directory. Repository tasks
`buck2:tui-core:publish-editor`, `buck2:tui-core:check-editor`, and the
exact-token `buck2:tui-core:recover-editor-lock` are scoped and are not wired
into global checks.
