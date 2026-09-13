# Cross-Repository Reuse Prior Art

Date: 2026-09-13. Research used current official documentation and source at Buck2 `5baef2d`, Bazel `aac8677`, Remote Execution API `76ddd98`, pnpm 12.4.1, npm 11.19.1, Nx 22.7.12, and Turborepo 2.10.12.

This record separates source identity, artifact identity, cache identity, and checkout identity. These mechanisms solve different problems. A cache is not a durable artifact origin, and a checkout is not a package version.

## Buck2 cells and external cells

**Identity.** A normal cell is a directory tree mapped to a contextual alias by the invoking root `.buckconfig`; Buck canonicalizes the path to a global `CellName`. A Git external cell is configured by `git_origin` plus immutable `commit_hash`; branches are rejected. The cell alias is not a repository or release identity ([cell source](https://github.com/facebook/buck2/blob/5baef2de653833fbb26fc5abdc67e813fccd6562/app/buck2_core/src/cells.rs#L24-L78), [external cells](https://github.com/facebook/buck2/blob/5baef2de653833fbb26fc5abdc67e813fccd6562/docs/users/advanced/external_cells.md#L18-L82)).

**Invalidation and cache.** Buck hashes a Remote Execution `Action` containing command digest, input-root digest, outputs, environment, working directory, timeout, and platform. A producer edit invalidates a consumer action only when the edited bytes reach its declared input tree. Cell/package/target names remain in output paths, so equal sources under different target identities do not necessarily share an action key ([action construction](https://github.com/facebook/buck2/blob/5baef2de653833fbb26fc5abdc67e813fccd6562/app/buck2_execute/src/execute/command_executor.rs#L390-L433), [cache model](https://github.com/facebook/buck2/blob/5baef2de653833fbb26fc5abdc67e813fccd6562/docs/concepts/architecture.md#L149-L173), [content-based path limits](https://github.com/facebook/buck2/blob/5baef2de653833fbb26fc5abdc67e813fccd6562/docs/rule_authors/content_based_paths.md#L35-L70)). `instance_name` may select a server-defined storage/cache namespace. Platform is digest material; Buck's use case is request metadata ([RE instance contract](https://github.com/bazelbuild/remote-apis/blob/76ddd98e1f92c0e2e71d0d3aa6906eca31754c03/build/bazel/remote/execution/v2/remote_execution.proto#L1775-L1843)).

**Consumer prerequisites.** Normal cells require a coordinated filesystem composition and root cell map. External cells require root-owned `[cells]` and `[external_cells]` declarations. External cells cannot be transitive or nested and ignore their own cell map ([limits](https://github.com/facebook/buck2/blob/5baef2de653833fbb26fc5abdc67e813fccd6562/docs/users/advanced/external_cells.md#L84-L107)). Local configuration can disable an external origin and point at editable source, but that is a local override, not dependency resolution ([configuration precedence](https://github.com/facebook/buck2/blob/5baef2de653833fbb26fc5abdc67e813fccd6562/docs/concepts/buckconfig.md#L145-L177)).

**Breaking refactor.** Normal composed cells can make a producer and consumer edit atomic only when both repositories are writable in one composition and their independent Git commits are coordinated. An external-cell consumer instead moves its commit pin and adapts labels/API. Buck supplies no cross-repository compatibility protocol.

**Two writers.** Git external-cell population is serialized per commit inside one Buck process, but multi-process safety is undocumented ([implementation](https://github.com/facebook/buck2/blob/5baef2de653833fbb26fc5abdc67e813fccd6562/app/buck2_external_cells/src/git.rs#L216-L319)). The RE protocol permits concurrent identical CAS uploads. It does not define arbitration for competing `UpdateActionResult` values under one action digest ([CAS](https://github.com/bazelbuild/remote-apis/blob/76ddd98e1f92c0e2e71d0d3aa6906eca31754c03/build/bazel/remote/execution/v2/remote_execution.proto#L270-L288), [action result](https://github.com/bazelbuild/remote-apis/blob/76ddd98e1f92c0e2e71d0d3aa6906eca31754c03/build/bazel/remote/execution/v2/remote_execution.proto#L1813-L1843)).

## Bazel Bzlmod and remote cache

**Identity.** Bzlmod resolves a node by module `name + version`; repositories have canonical names and per-consumer apparent-name mappings. The canonical-name format is explicitly unstable ([`ModuleKey`](https://github.com/bazelbuild/bazel/blob/aac8677f8e69e30fb105026ff524e04965640499/src/main/java/com/google/devtools/build/lib/bazel/bzlmod/ModuleKey.java#L30-L132), [repository names](https://bazel.build/external/module#repository_names_and_strict_deps)). The remote cache keys the encoded RE `Action`, not the module version directly ([remote caching](https://bazel.build/remote/caching), [action construction](https://github.com/bazelbuild/bazel/blob/aac8677f8e69e30fb105026ff524e04965640499/src/main/java/com/google/devtools/build/lib/remote/RemoteExecutionService.java#L495-L588)).

**Invalidation and cache.** Module or repository-rule input changes cause source rematerialization; the committed module lock records resolution and extension inputs. `error` lock mode refuses stale/missing data instead of mutating the lock ([repository invalidation](https://bazel.build/external/repo#when-is-the-implementation-function-executed), [lockfile](https://bazel.build/external/lockfile)). An external source edit that reaches the Merkle input root changes the action digest. Repository names can occur in exec paths, so a shared module alone does not prove cross-repository cache reuse.

**Consumer prerequisites.** The root owns `MODULE.bazel`, direct `bazel_dep` edges, registry access, and any root-only archive/Git/local override. A local override target must itself be a Bazel module ([module API](https://bazel.build/rules/lib/globals/module#bazel_dep), [source schema](https://bazel.build/external/registry#source-json), [overrides](https://bazel.build/external/module#non-registry_overrides)). Remote reuse additionally requires a shared endpoint/instance and hermetic tools.

**Breaking refactor.** Publish a module version and update consumer constraints/lock. Root overrides can stage migration. Current Bazel documents `compatibility_level` as a no-op, so it is not a breaking-change gate ([version selection](https://bazel.build/external/module#version-selection), [compatibility FAQ](https://bazel.build/external/faq#compatibility-level)).

**Two writers.** Bazel's download cache uses temporary files and atomic rename if nobody concurrently deletes the cache ([source](https://github.com/bazelbuild/bazel/blob/aac8677f8e69e30fb105026ff524e04965640499/src/main/java/com/google/devtools/build/lib/bazel/repository/cache/DownloadCache.java#L32-L38)). No inspected contract provides merge-safe concurrent `MODULE.bazel.lock` writes. RE action-result arbitration remains server-specific; Bazel recommends restricting cache writers and offers a concurrent-source-change guard ([guidance](https://bazel.build/remote/caching#read-write-remote-cache)).

## pnpm and npm dependency modes

**Identity.** pnpm `workspace:` identifies a package name/range that must resolve inside the current workspace; it refuses registry fallback. npm workspaces save ordinary semver and symlink a matching member. npm 11's package-spec parser has no `workspace:` arm ([pnpm workspaces](https://pnpm.io/workspaces), [npm workspaces](https://docs.npmjs.com/cli/v11/using-npm/workspaces), [parser](https://github.com/npm/npm-package-arg/blob/v13.0.2/lib/npa.js#L397-L426)). `catalog:` is workspace-local version indirection, not artifact identity ([catalogs](https://pnpm.io/catalogs)). Registry identity is scope/name/version; tarball identity is URL/file plus lockfile integrity; a folder is path/source identity ([package specs](https://docs.npmjs.com/cli/v11/using-npm/package-spec), [npm lock](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json)).

**Invalidation.** Workspace and folder edges expose source edits. A registry/tarball edge changes only when the consumer resolution/lock changes; integrity rejects different bytes under a locked resolution. `pnpm pack`/publish rewrites `workspace:` and `catalog:` to ordinary publishable ranges ([publish rewrite](https://pnpm.io/workspaces#publishing-workspace-packages), [catalog publishing](https://pnpm.io/catalogs#publishing)).

**Consumer prerequisites.** Source mode needs a coordinated pnpm workspace/path. Tarball mode needs a reachable immutable origin. Registry mode needs configured scope, registry access, and an artifact whose runtime closure contains no unresolved workspace-only specifiers. pnpm and npm overrides are consumer-root graph rewrites; they do not propagate from dependencies ([pnpm overrides](https://pnpm.io/settings/dependency-resolution#overrides), [npm overrides](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#overrides)).

**Breaking refactor.** Keep producer compatibility, publish a new immutable version, then update each consumer manifest/override and lock. Catalogs reduce repeated range edits inside one repository but do not cross the boundary. A direct URL requires a new URL or new accepted integrity.

**Two writers.** npm's registry contract makes scope/name/version write-once, including after unpublish ([publish](https://docs.npmjs.com/cli/v11/commands/npm-publish)). pnpm lock publication uses a unique temporary file and rename but no compare-and-swap; npm also has no merge protocol. Branch lockfiles avoid some Git conflicts but do not make simultaneous installs transactional ([pnpm settings](https://pnpm.io/settings/store#gitbranchlockfile), [pnpm writer](https://github.com/pnpm/pnpm/blob/v12.4.1/pnpm11/lockfile/fs/src/write.ts#L91-L137)).

## Nx and Turborepo task caches

**Identity.** Nx's computation hash includes project/dependency files, global configuration, external dependency versions, runtime values, and flags; entries contain declared outputs and terminal output ([Nx caching](https://nx.dev/docs/concepts/how-caching-works)). Turborepo combines global and task hashes from configuration, lockfiles, internal-package source, package files, environment, dependency task hashes, and arguments ([Turbo inputs](https://turborepo.com/docs/crafting-your-repository/caching#task-inputs)). Neither cache identity is a dependency publication identity.

**Invalidation.** After a library becomes external, its producer source is no longer an internal source input. The consumer-visible artifact version/lock must change. Omitted inputs can return stale results.

**Consumer prerequisites.** Both need deterministic tasks with complete inputs/outputs, local configuration, and a shared authenticated cache namespace. Nx Cloud or its self-host protocol supplies Nx transport; Vercel or a compatible server supplies Turbo transport.

**Breaking refactor.** Publish a new artifact, update consumer manifest/lock, then let the new external-dependency identity invalidate tasks. Neither tool coordinates publication or adoption.

**Two writers and durability.** Nx's self-host API rejects overwrite with HTTP 409, and its client treats the existing record as winner ([API](https://nx.dev/docs/guides/tasks--caching/self-hosted-caching), [client](https://github.com/nrwl/nx/blob/22.7.12/packages/nx/src/native/cache/http_remote_cache.rs#L174-L204)). Turbo's portable protocol does not define same-hash arbitration ([API](https://turborepo.com/api/remote-cache-spec)). Managed Vercel artifacts expire after seven days, so they cannot be the only origin of durable dependency pins ([retention](https://vercel.com/docs/monorepos/remote-caching)). Nx Cloud retention is undocumented.

## Nix flakes

**Identity.** A locked flake input records an exact source revision and content hash; a package output is selected by flake reference, attribute path, and system. Evaluation/build identity is the realized derivation graph, while the Nix store path content-addresses or input-addresses the realization ([flake reference](https://nix.dev/manual/nix/latest/command-ref/new-cli/nix3-flake), [lock files](https://nix.dev/manual/nix/latest/command-ref/new-cli/nix3-flake-lock), [store model](https://nix.dev/manual/nix/latest/store/store-object)).

**Invalidation.** A consumer lock update changes the input graph; changed derivation inputs produce a different store path. Binary substitution reuses an existing realization with verified NAR hash ([derivations](https://nix.dev/manual/nix/latest/store/derivation), [substituters](https://nix.dev/manual/nix/latest/store/types/http-binary-cache-store)).

**Consumer prerequisites.** Nix with flakes, the producer's flake output for the consumer system, a committed lock, and access to source plus a substituter or local builder. A tarball cache URL is not a portable flake identity ([inputs](https://nix.dev/manual/nix/latest/command-ref/new-cli/nix3-flake#flake-inputs)).

**Breaking refactor.** Keep an old output while publishing the new output, update the consumer input lock/attribute, then remove compatibility after adoption. `--override-input` supports local testing without changing the committed lock.

**Two writers.** Store paths are immutable and builds are serialized per output. Independent lockfile editors still reconcile through Git; no inspected flake contract provides semantic merge or compare-and-swap. Binary caches may reject or accept duplicate uploads by implementation.

## Git submodules, worktrees, and Josh

**Identity.** A submodule is a gitlink containing an exact object ID plus a `.gitmodules` URL/path ([gitlink](https://git-scm.com/docs/gitsubmodules), [configuration](https://git-scm.com/docs/gitmodules)). A worktree is another checkout attached to the same repository's refs and object database; it is checkout identity, not cross-repository dependency identity ([worktree](https://git-scm.com/docs/git-worktree)). Josh computes filtered commit/object IDs from an upstream commit and filter expression ([Josh filters](https://josh-project.github.io/josh/filters.html), [architecture](https://josh-project.github.io/josh/architecture.html)).

**Invalidation.** A submodule crosses the boundary only when the superproject gitlink changes. Worktree edits affect normal Git state and source consumers immediately. Josh maps upstream history incrementally; a changed upstream commit produces a changed filtered history/object graph.

**Consumer prerequisites.** Submodules need recursive initialization and retained producer Git objects. Worktrees require the same repository and refuse the same branch in multiple worktrees by default. Josh needs a proxy/client object database and filter contract.

**Breaking refactor.** Submodules stage producer commit then consumer gitlink/API update. Worktrees provide no independently versioned cross-repository flow. Josh can present a filtered monorepo view, but atomic push is limited to paths derived from the same upstream history; it does not create an atomic transaction across unrelated origins.

**Two writers.** Git ref updates provide the ordinary non-fast-forward arbitration. Neither submodules nor worktrees merge cross-repository commits. Josh relies on upstream Git ref arbitration; its cache is reconstructable filtered Git data, not a dependency origin.

## Unverified questions

1. Multi-process Buck2 population of one external Git cell and competing RE action-result writes for the selected server.
2. Cross-repository action-key equality under the exact Buck2/Bazel rules, paths, toolchains, and server namespace.
3. Concurrent semantic writes to pnpm/npm/Bazel/Nix lockfiles; atomic file replacement alone does not prevent lost updates.
4. Direct-HTTP and private-registry immutability, retention, and writer arbitration for the selected service.
5. Nx Cloud retention and cache-key compatibility across Nx upgrades.
6. Turborepo same-hash arbitration, self-host retention, and cache-key compatibility across upgrades.
7. Nix flake-lock concurrent writer semantics and binary-cache duplicate-upload policy.
8. Producer Git retention sufficient for every historical submodule pin.
9. Josh filtered-object stability across Josh versions and any claimed atomic behavior across unrelated origins.
