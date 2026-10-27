# BuildProduct and Nix Import Spec

This document specifies `buck-build-product/v1` and independent Nix import. It
builds on [requirements.md](./requirements.md).

## Status

Draft.

## Scope

**Defines:** portable descriptor identity, payload checks, runtime inspection,
the Nix store import result, and the cache-backed bridge for generated Buck
products.

**Does not define:** cache credentials, cache retention, deployment, activation,
rollback, or health.

## Boundary

```text
Buck action
  -> artifact.tar + buck-build-product/v1 descriptor
       -> independent expected descriptor digest + platform
            -> strict Nix validation and runtime inspection
                 -> immutable Nix store result
```

For generic build products, transport is an input mechanism only. Import accepts
a declared local artifact path or fetched bytes with the same expected digest;
transport identity grants no product authority. Generated JavaScript and package
products use the stricter substitution contract below.

## Import Sequence

1. Validate the exact descriptor schema and canonical descriptor digest.
2. Compare descriptor platform with the independently declared expected
   platform.
3. Obtain payload bytes from exactly one declared path or URL-backed Nix input.
4. Verify payload byte size and SHA-256 SRI digest.
5. Reject unsafe tar entries before extraction.
6. Extract without preserving archive ownership or permissions.
7. Reject unsafe extracted tree content.
8. Dispatch to the exact runtime inspector for the tagged runtime contract.
9. Make the imported tree read-only and expose descriptor identity as Nix
   passthrough metadata.

Every failed step terminates import. No step invokes Buck or a package manager.

## Cache-backed Product Bridge

The generated product inventory is the source of truth for product name,
version, Buck target, and output name. Each inventory entry produces one
sandboxed Nix derivation. The derivation runs the pinned, checked-in Buck graph
against fixed-output archives derived from the reviewed digest/size sidecar and
projects those archives through `nix_store.root`; Buck verifies each projected
archive before extraction. The derivation emits the artifact plus
`effect-utils/buck-product-provenance/v1`.

Npm archive acquisition has one digest authority. Package manifests select
versions, the pnpm lock records registry URLs and integrity, and the generated
`buck2/dependencies/pnpm-lock.sha256.json` sidecar records the reviewed SHA-256
and size of those exact bytes. Nix consumers select archives by package identity
from that sidecar-backed projection. They do not carry hand-maintained URLs,
versions, or hashes beside the lock-derived data.

The cache publisher builds the derivation before it performs any cache mutation.
It validates the provenance commit, target, and artifact digest; rejects a pin
name that already identifies another store path; pushes the store path; and
creates an immutable Cachix pin with the product as an artifact. Anonymous HTTP
download and digest verification complete publication.

`publish.sh --realise-inputs` selects the same inventory and flake attributes as
publication, resolves their derivations with `nix path-info --derivation`, and
realises only each derivation's input references with `nix-store --realise`.
It does not build the selected products or mutate the cache or manifest. The
protected publisher workflow configures anonymous read-only Cachix substitution
(`skipPush: true`), then runs this mode with the same GitHub fetching token and
publication-scope condition as publication, but no Cachix write token. The
publishing Cachix action and its push hook are enabled only after preparation.
Cold substitution and input builds use the job timeout; the unchanged 32-minute
publication step budget covers the product builds and pushes.

Cache-native rows contain exact `name`, `version`, `sha256`, `size`,
`storePath`, `artifactUrl`, and `provenance` fields. The Nix loader validates
every field and treats the recorded store path as the substitution identity.
Nix obtains that immutable path from the configured binary cache. A validation
derivation then checks the artifact digest, size, and provenance before exposing
the product to the consumer.

Product-scoped publication merges by product identity in the
`effect-utils/buck-cache-products/v2` manifest. The publisher validates each
cache row's provenance and preserves unrelated rows. The generated source
derivation remains available as the reproducible publication recipe. It
rebuilds the ordinary graph rather than a synthetic root, prepared dependency
tree, or rewritten package rule. Changing later repository metadata does not
change the identity of an already-published product. The anonymous artifact
URL is an interoperability path, not a second source of product authority.

### pnpm package dependency closure

Published `@overeng/*` `.tgz` products are not transitively self-contained.
Packing writes internal dependencies as ordinary semver ranges
(`workspace:^` becomes `^<version>`), not artifact URLs or bundled dependencies.
These packages are not published to the npm registry; their internal ranges
resolve only through consumer-root overrides.

The supported consumer mechanism is the genie consumer projection: it derives
root-owned pnpm overrides for the whole transitive `@overeng/*` dependency
closure from the pinned producer manifest, mapping each public package to its
`artifactUrl`. Private products use the staged `file:` tarballs described below.
The consumer lock records the resolved tarballs and integrity. A direct URL pin
alone does not supply dependency resolution: a standalone install without the
closure overrides is unsupported and fails with a registry 404 for an unresolved
internal dependency (`ERR_PNPM_FETCH_404`).

This qualifies the pnpm recipe in
[decision 0037, clause 4](../../.decisions/0037-nix-substitution-is-the-distribution-layer.md#decision):
the URL plus integrity identifies one public product, not its dependency closure.
The ordinary-version packing contract in
[decision 0034](../../.decisions/0034-artifact-default-composition-no-registry.md#required-publication-contract)
does not imply registry availability.

Pack-time URL rewriting is not the alternative: pnpm's `blockExoticSubdeps`
rejects transitive exotic sources, and embedding dependency URLs would propagate
dependency digest changes into dependent archive digests. Bundling would likewise
copy shared dependencies into each product and couple their bytes and digests.
Consumer-root overrides instead select shared dependency artifacts in one place
without rewriting or bundling them into every dependent package.

### Consumer pin eligibility

```text
trusted main push -> publish-products -> same-SHA manifest-current output --+
                  -> consumer-smoke  -> successful consumer SHA output ---+
                                                                         |
                                           promote-published <------------+
                                             -> fast-forward published
stale manifest -> publisher manifest PR -> main push
```

Consumers requiring an always-eligible product manifest track `ref published`
rather than `ref main`. `main` may be temporarily non-current after a
product-input merge while its publisher manifest proposal is pending.
`refs/heads/published` only fast-forwards to main commits whose
`buck2-products/manifest-current` status and consumer smoke both succeeded for
that exact SHA. The `promote-published` job declares
`needs: [publish-products, consumer-smoke]`; it performs no Nix evaluation or
build. Before advancing the ref, it checks the publisher's manifest-current
output identifies its own candidate SHA and the successful consumer job's SHA
output identifies that same SHA. A status from another commit cannot satisfy
either gate.

Ref creation and advancement remain restricted to main-push runs in the
upstream repository. Workflow dispatch and pull requests cannot advance the
ref. If the ref is absent, the eligible promotion job creates it at its own
SHA using the App token; no separate human bootstrap push is required.
Promotion requests only `contents: write` for that token. Consumer failure
blocks promotion, never product publication or manifest-current reporting:
`publish-products` does not depend on `consumer-smoke`.

The publisher GitHub App is the sole creation/update actor. The writers
ruleset restricts creation and updates, with only that App allowed to bypass.
A separate history ruleset blocks deletion and non-fast-forward updates
without any bypass actors, including the App. History protection does not
restrict initial ref creation; the App bypasses only the writers ruleset.
See [GitHub's ruleset semantics](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets).

Before each of at most three push attempts, the job refetches the tip.
An absent tip permits creation; an ancestor tip permits a fast-forward push.
A candidate already at or behind the published tip is a successful no-op.
A rejected push retries this comparison, so an intervening ancestor can still
be advanced. Divergence fails loudly, as does exhausting the push attempts
without observing the candidate or a descendant at the published tip.
This ref guarantees manifest eligibility and consumer smoke admission, not
success of unrelated CI checks.

### Consumer smoke fixture

```text
test:consumer-smoke(candidate checkout)
  -> fresh realpath temporary Git consumer
  -> exact candidate effect-utils Nix input
  -> shared pnpm:install
  -> source staging + staged resolver sentinel checks
  -> successful candidate SHA
```

The dedicated `consumer-smoke` CI job runs on trusted main pushes and manual
dispatch on a Linux x86 Namespace runner, with a 10-minute timeout. It invokes
the shared fixture runner directly with the resolved lock-pinned devenv binary,
without evaluating or realizing the repository root's development shell.
The local `test:consumer-smoke` task invokes that same runner.
The timeout is a bound on execution, not a measured runtime guarantee.

The root task calls the fixture runner with a candidate checkout argument.
It defaults to the current root; `CONSUMER_SMOKE_CANDIDATE` selects another
checkout for historical reproduction. The runner snapshots that checkout's
Git-tracked working-tree files, including uncommitted tracked edits, and binds
the consumer's effect-utils path input to that snapshot. Ignored build and
editor state never enters the Nix source input. It never fetches a separate
branch or registry revision. The root task has no Buck or editor bootstrap
dependency.

Each invocation copies the fixture into a fresh temporary directory, resolves
its real path, and initializes it as a Git repository. Consumer install,
staging, and sentinel state are fresh on every invocation; cached tools and
Nix inputs may remain warm. The fixture has no package-registry dependency.
It genuinely runs the shared `pnpm:install` task with
`sourceInputPaths = [ "repos/source/packages/shared" ]` and exercises the staged
resolver. Success requires the actual install to succeed and subsequent
checks to confirm both source staging and resolver sentinel behavior; a
standalone staging command or sentinel alone is not an install proof.
Any failed install or check exits nonzero. The successful consumer SHA output
is emitted only after these checks complete.

The repository root uses `materialize = false`, so a successful root install
does not exercise consumer source staging. This separate fixture supplies
that coverage and is a mandatory publication gate, not an optional substitute
for root checks.

### Consumer from-source identity

Consumer products built from their own repository, rather than imported from
the published effect-utils manifest, use a committed Genie projection of
repository-relative source paths for each Buck target. The projection derives
workspace package directories from the target package's authored transitive
workspace closure (`projectBuckProductSourcePaths`); non-pnpm Buck inputs are
explicit additional paths. Each product passes its projected `sourcePaths` to
`mkBuckProductFromSource` with `repositoryRoot` and the separate
`mkConsumerBuckRoot` derivation as `rootProjection`. Nix evaluates
`lib.fileset.toSource` over only those paths. Root configuration, toolchains,
capabilities, fixed-output lock archives, and Cargo archives remain declared
Nix inputs; neither a checkout copy nor Buck evaluation at Nix evaluation time
determines the fileset.

`mkConsumerBuckRoot` selects the watcher through the named `watcherPolicy`
argument, not a free-form provider string:

| Policy                       | Generated `[buck2] file_watcher` | Input contract                                                                                          |
| ---------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `mutable-checkout` (default) | `watchman`                       | Interactive edits require fail-closed Watchman admission.                                               |
| `immutable-input`            | `fs_hash_crawler`                | Declared inputs do not change during a build or filtered source check; no Watchman service is required. |

Consumers copying a root into a Nix build or immutable source-check sandbox
pass `watcherPolicy = "immutable-input";`. Unknown values fail evaluation with
an error listing the allowed policies. `consumer-root.nix` and `from-source.nix`
share `watcher-policies.nix`; the latter always selects `immutable-input` for
its sandboxed build.

The source-backed product's `effect-utils/buck-product-source-provenance/v1`
contains `sourceDigest` (SHA-256 of the scoped source store path), `target`,
and `productDigest`; it contains no Git revision. Source changes inside the
declared closure change the derivation, while changes outside it do not.
Directory-level package entries deliberately include all files in each closure
package: changes to non-Buck files _within_ that package may still rebuild it.
Consumers that embed a Git build stamp follow the profile selected under
[component identity](../../01-identity/spec.md).
For C, the committed product-rev projection supplies the product's closure
revision and commit timestamp to `cliBuildStamp`; the caller must not inject the
current repository HEAD for every product. `mkBuckProductFromSource` passes this
as `--config build_identity.cli_build_stamp=...` before the Buck build
(`nix/buck2-products/from-source.nix:107–109`). The stamp is a declared build
input: unrelated commits preserve it; relevant closure changes require an
in-PR generated refresh and freshness proof. This describes the required
injection contract, not a claim that every consumer already implements C.
Manifest-bound effect-utils JavaScript products keep their `producerCommit`
and `effect-utils/buck-product-provenance/v1` unchanged (decision 0037).

### Native products

`otelite`, `otel-scrape`, `pingping`, and `typescript-api-server` use the same
source-backed, cache-substituted Nix import as compiled executables. The
generated `nix/buck2-products/native-targets.json` inventory binds each name
to its Buck `build_product` target and `artifact.tar` output; the Rust rows
also declare the `rust` Cargo workspace root. On each host,
`mkBuckProductFromSource { importNative = true; ...; }` builds the declared
target with pinned pnpm archives (and, for Rust, the pinned Cargo archive
projection), then validates the emitted descriptor, payload, platform and
runtime before exposing `packages.<system>.<name>`. The TypeScript API server
has an ELF-static runtime on Linux and Mach-O-dynamic on Darwin; the Rust
products have dynamic runtimes. Genie wrappers bind
`GENIE_TYPESCRIPT_API_SERVER` to that same imported package; the reusable
observability module uses the imported `otelite` for capture.

The TypeScript server's `package_tree_product_executable` consumes
`PnpmDeclaredClosureInfo` from Genie's lock-projected `external_view_` target,
not the workspace `:package_tree` or its shared `:node_modules` view. The
external-only view retains the full pinned external closure and platform gates
but declares no workspace links. `package_anchor = "typescript"` is relative
to its `node_modules`; the executable and support-copy actions declare every
read root needed to resolve the pinned store links. Extraction copies the
platform `@typescript` executable and support files without compiling workspace
declarations or invoking effect-tsgo/fingerprint. Pinned archives, Bun,
action-env, product provenance and native packaging/validation remain required;
the npm package views, emit, typecheck and archive targets are unchanged.

Native shell imports instead use the source-addressed provenance contract
above. Their generated `sourcePaths` declare the Rust crate, workspace profile
and lock, and Reindeer graph; the TypeScript server derives its recursive pnpm
workspace package closure. The ordinary Buck root configuration and shared
rules/runtime files form a separate `rootProjection` input. Rule tests and
generators are excluded from that input. Neither the checkout's store root nor
its Git revision is part of these recipes' identity. Unrelated commits retain
the same per-platform derivation; edits to declared sources, pinned toolchains,
archives or validation contracts invalidate it.

Scoped Rust native products default to an embedded JSON stamp with the shared
`type: "nix"`, `version`, `rev`, and `dirty` fields. `rev` is the first seven
hexadecimal characters of the existing `sourceDigest`, not a Git revision;
`dirty: false` describes the immutable source projection, not checkout
cleanliness. No commit timestamp is invented for this source-addressed policy.
An explicit `product.cliBuildStamp` overrides the default for callers selecting
another identity policy. Buck rules opting into `cliBuildStamp` receive the
stamp through `build_identity.cli_build_stamp`, so unrelated commits cannot
change the embedded native version.

Files passed to build-time helpers must be content-scoped too. The stage-zero
root metadata, Cargo profile reader and descriptor contract are materialized
from their bytes; the Buck launcher has its own scripts fileset. Interpolating
an unchanged file directly below a flake store root would retain the whole
root context and defeat substitution across unrelated commits.

Protected main publishes `ci-test-shell-products` alongside the compiled
imports from native Linux x86_64 and Darwin arm64 runners to the public
`overeng-effect-utils` Cachix cache. This aggregate references the exact retained
shell products, capabilities, Rust support tools, native imports, provider CLIs
(`netlify-cli` and `vercel-cli`), pinned pnpm, and the oxlint plugin wrapper.
The repository shell selects Netlify, pnpm and oxlint from these same flake
packages rather than rebuilding them against devenv's independently locked
nixpkgs. Cachix publishes their transitive store closures, including source
bridge and validator outputs. Source recipes and license policy remain
unchanged; a missing substitute builds the same derivation from source.
The publisher and PR
smoke lanes share `genie/ci-scripts/compiled-products.sh`; only the protected
publisher invokes `--push` with a cache write credential. Linux arm64 is
admitted but has no publisher: consumers build its import from source on a
cache miss. Neither native product lookup nor publication uses GitHub release
assets or a release manifest; the derivation itself is the substitution identity.

The script realizes all inventoried native and compiled imports plus the shell
aggregate in one `nix build --json` invocation. JSON outputs are matched to each
inventory row by its executable, not by result order. Exactly one matching
output is required per product before its `--help` smoke runs; missing or
ambiguous outputs fail the lane. Publication follows successful smoke of every
row and pushes every returned direct output's closure.

### Rust/Cargo archives

`mkBuck2CargoArchives { pkgs; thirdPartyBuckFiles; gitSources ? {}; }` supplies
`nix_store.crates_root` from the Reindeer graphs and their `git-archives.json`
sidecars (BUILD.DIST.NIX-R08). Registry crates and undeclared GitHub repositories use
the reviewed archive URL and SHA-256 unchanged. A consumer declares
`gitSources."owner/repo" = inputs.repo;` both in this Nix archive projection
and in the `buck2-rust-deps` task module for a private Git dependency. The
flake input's `rev` must equal the graph's Cargo-locked 40-hex commit; a plain
Nix path is allowed only in the archive builder's local fixture.

The task module and product builder use the same deterministic Nix source
archive: entries under `<repo>-<rev>`, sorted, fixed timestamp/ownership,
read-only permissions preserving executable bits (`a=rX`), and gzip without
an input timestamp. Symlink targets are preserved, but their header modes are
normalized to `0555`: NAR identity excludes symlink permissions, which differ
between Linux and Darwin. Equal source files are archived independently of
physical hardlinks introduced by store optimisation. The task gate writes a
`source: "nix"` pin
with that archive's SHA-256, skips the unauthenticated GitHub fetch, and on
`check` verifies the current source bytes and revision against the sidecar.
Buck uses the digest as its lookup key and verifies the copied bytes and
source `(repo, rev)` manifest before `extract-git-archive`. An earlier
GitHub-byte pin with an override retains its reviewed lookup digest and checks
the separate source digest manifest. A `source: "nix"` pin without a declared
override fails instead of falling back to an unauthenticated fetch. Neither
mode fetches inside the sandbox. `source` is a repository-local sidecar
discriminator: omission means the reviewed GitHub bytes, `"nix"` means pinned
Nix source bytes, and unknown values are rejected.

### Compiled-executable products

`compiled-executable` refines BUILD.DIST.PRODUCT-R01–R03 and BUILD.DIST.NIX-R05–R09. This
repository owns the inventory's `kind` discriminator: it is lowercase,
hyphenated and exact; unknown values fail import rather than falling back
to `native`. The kind denotes a Bun-compiled native CLI,
not a portable JavaScript module and not a Cargo product. Its Buck target emits
`artifact.tar` and a `buck-build-product/v1` descriptor. The from-source recipe
captures both artifacts and calls `importNative`, reusing the exact descriptor
validation, archive scan, ELF/Mach-O inspection, and dynamic ELF patching path
used by native products. It requires no Cargo workspace root. A generated
inventory binds each compiled product name to its Buck target; each host
derivation imports its own platform tuple. It has no JS/package cache-manifest
row: the immutable imported Nix store path is the distribution unit.

On protected main, the native-and-compiled publisher builds the imported
derivations on the Linux x86_64 and Darwin arm64 runners and pushes them to
Cachix. aarch64 Linux is admitted but unpublished; its consumers build the
imports from source. Pull-request jobs build and smoke the same imports without
a write credential. Darwin builds
run on the macOS arm64 runner; the import inspects but does not strip, patch,
or re-sign Bun's embedded Mach-O ad-hoc signature. The signing inspector
accepts an ad-hoc CodeDirectory with either no CMS wrapper (Bun) or a single
empty CMS wrapper (Apple codesign); a nonempty CMS payload or unsigned
CodeDirectory fails. Linux imports may patch the
ELF interpreter via the existing `elf-dynamic/v1` realization path after the
archive and runtime descriptors have been independently checked.

### Protected publisher identity

```text
protected main publish-products job
  -> CACHIX_AUTH_TOKEN: publish immutable products
  -> GitHub App private key: mint repository-scoped installation token
       -> push automation/buck2-products-manifest
       -> open or update the manifest PR
```

The checked-in [GitHub App registration manifest](./publisher-github-app.manifest.json)
defines `overeng-nix-publisher`, owned by `overengineeringstudio`. Its only
explicit repository permissions are `contents:write` and
`pull_requests:write`; metadata read is GitHub's implicit minimum. It receives
no webhook events and has no webhook delivery. The installation selects
**only** `overengineeringstudio/effect-utils` and
`overengineeringstudio/private-shared`: both trusted Nix publishers propose
manifest PRs, and the identical least-privilege permission set serves both.
Each publisher mints a token with its own repository explicitly selected, never
an installation-wide token or a token for the other repository.

The app ID is repository Actions variable `NIX_PUBLISHER_GITHUB_APP_ID`; the
private key is repository Actions secret
`NIX_PUBLISHER_GITHUB_APP_PRIVATE_KEY`, provisioned independently on each
installed repository from the same 1Password item. Neither the key nor an
installation token is committed. Only the protected-main `publish-products`
job (push or workflow dispatch, never PR) mints the short-lived installation
token with `actions/create-github-app-token`; only its manifest-proposal step
receives that token as `GH_TOKEN`/`GITHUB_TOKEN` for the manifest branch push
and PR creation. The default workflow token has read-only contents permission and
cannot propose the PR. Publication-scope and no-change guards still skip
unnecessary publication and PR updates. If either the app ID variable or key
secret is absent, Cachix publication succeeds and the manifest PR is skipped
with a notice; `GITHUB_TOKEN` is never used to push/create a PR. App-authored
manifest commits trigger the normal PR CI.

Rotate the non-expiring private key by generating a new key in App settings,
replacing its 1Password item and both repositories' Actions secrets, verifying
token minting from both protected jobs, then revoking the old key. On suspected
exposure revoke the affected key immediately; uninstall the app from both
repositories to halt writes while investigating. Installation tokens expire
automatically and must never be saved.

## pnpm runtime closure for executing JavaScript products

```text
declared importer package_tree targets
  -> PnpmDeclaredClosureInfo (views + every reachable declared root)
  -> pnpm_runtime_closure (one relocatable tree + digest descriptor)
  -> mkBuckProductFromSource.runtimeClosureTarget
  -> mkBuck2JavaScriptProductImport.runtimeClosure
       $out/libexec/node_modules -> .pnpm/<primary-view>
       $out/libexec/importers/<name>/node_modules -> .pnpm/<view>
```

The importer map uses caller-owned normalized relative names (`service`, `cli`,
`flakes/vista/blocks`); the primary name is one of them. A `package_tree`
backed by a pnpm view forwards `PnpmDeclaredClosureInfo`, so callers refer to
stable package-tree labels, not lock-derived hashed view labels. The Buck rule
unions their `read_roots` (including workspace package trees, normalized
entries, SCC groups and peer siblings), maps each distinct source artifact to
one `.pnpm/<index>` directory, copies only declared files, and rewrites every
relative symlink to its new internal target. Missing, cyclic, escaping,
absolute, and unsupported file types fail assembly. This materializes the
runtime closure once per declared set, rather than shipping the prepared pnpm
workspace or relying on the original Buck output paths.

The tree contains `descriptor.json` with exact fields
`{schema:\"effect-utils/pnpm-runtime-closure/v1\",digest:<sha256 hex>,
importers:<sorted names>,primary:<name>}`. Its digest is SHA-256 of the
lexicographically sorted directory, regular-file and symlink records
(normalized relative path, executable bit, byte count and bytes or relative
link text), excluding the descriptor itself. Source paths, timestamps and
inode identity are not part of the digest. Because optional native package
entries are selected by the target platform, consumers pin a digest per
platform tuple; a Linux digest does not authorize a Darwin closure. The
descriptor is a repository-local versioned format; unknown fields or schema
versions fail import.

`mkBuckProductFromSource { runtimeClosureTarget = \"//…:runtime_closure\"; … }`
builds the target through the same sandboxed, archive-projected Buck graph as
its JavaScript module and exports `$sourceProduct/runtime-closure`. The Nix
JavaScript product import accepts
`runtimeClosure = { artifact = \"${sourceProduct}/runtime-closure\";
expectedDigest = \"<independently pinned lowercase sha256>\"; };`. It checks
the exact descriptor and recalculates the tree digest before copying the whole
tree under `$out/libexec`; only then does it add `nativeNodePackages` slots
under the primary view's `node_modules`. Each native slot is supplied by a
Nix-owned package (or by the existing normalized-entry package override), not
downloaded or lifecycle-built during import. ESM modules must be installed
beside the primary `node_modules` root; modules using a secondary importer
must have a `node_modules` link to
`$out/libexec/importers/<name>/node_modules` beside their own module path.
`NODE_PATH` alone is insufficient for ESM bare imports. Both the pinned npm
archives and any Nix-native slots are declared inputs, and neither Buck
assembly nor Nix import accesses the network.

## Private pnpm Consumption

Private package products (decision 0037 clauses 4 and 5) reach pnpm and Buck
consumers as Nix-realized tarballs. The consumer never evaluates the producer's
recipe and never holds a cache credential.

```text
producer manifest row (name, version, sha256, size, storePath, provenance)
  -> effect-utils.lib.mkPrivateProductTarballs { pkgs; manifest; schema; }
       storePath with string context  -> Nix daemon substitutes it (private cache netrc)
       fixed-output copy, flat sha256  -> /nix/store/<h>-<sha256>.tgz
       stage        : <safe-name>-<version>-<sha256>.tgz  (pnpm file: staging)
       archiveRoot  : <sha256>.tgz                          (Buck nix_store.product_root)
       archivesByDigest.<sha256>                            (pnpm-archives.nix productArchives)
  -> consumer pnpm task links stage at .devenv/pnpm-product-tarballs
  -> package manifests / root overrides: file:.devenv/pnpm-product-tarballs/<file>
  -> pnpm lock: package key <name>@file:<path>, resolution {integrity, tarball: file:<path>}
  -> Buck sidecar row: productTarball + sha256 + sizeBytes, classification private
```

### Substitution identity

The manifest `storePath` is the only identity a consumer realizes. The
producer's product derivation is input-addressed over the producer's whole
flake source (`root = self`), its `producerCommit` (`self.rev`), and its locked
`effect-utils`/`nixpkgs` inputs. Any other evaluation names a different path:

| Evaluation of the producer recipe                               | Store path    |
| --------------------------------------------------------------- | ------------- |
| producer flake at `producerCommit`, its own lock                | manifest path |
| producer flake at the manifest commit (changes `manifest.json`) | different     |
| consumer input with `follows` overriding producer inputs        | different     |

The manifest commit necessarily differs from the producer commit, so a consumer
pinned to it can never reproduce the recorded path by evaluating the recipe;
`follows` overrides diverge further. Consumers therefore do not use the
producer's flake outputs as product sources.

`mkPrivateProductTarballs` appends store-path string context to the recorded
path. Instantiating the dependent derivation makes the Nix daemon substitute
that path from its configured caches: evaluation-time substitution, never a
build, so it is not import-from-derivation and works without
`builtins.fetchClosure`. Evaluating a private product therefore requires a
daemon that can read the private cache. A fixed-output derivation (flat SHA-256 equal to
the manifest `sha256`) copies `<safe-name>.tgz` after checking its size and
that `provenance.json` equals the manifest provenance, so the consumer-visible
archive is content-addressed by the product digest.

A substitution miss fails evaluation closed (decision 0037 amendment 3); the
error names the product, store path, cache, and producer commit. Recovery is
manual: build the producer flake at `producerCommit` with its own lock (no
`follows`), which recreates the identical input-addressed path through the same
Buck graph (BUILD.DIST.NIX-R08), and push that path to the private cache.

### Manifest row

The loader accepts exactly `{ cache, products, schema }` with the caller-supplied
`schema` (for example `<producer>/buck-cache-products/v1`) and rows with
exactly `name`, `provenance`, `sha256`, `size`, `storePath`, `version`. It
rejects unscoped names, invalid versions, non-lowercase digests, non-positive
sizes, invalid store paths, provenance whose `productDigest` differs from
`sha256`, and duplicate names or digests.

### pnpm staging and lock

The staged file name is `<name without "@", "/" as "-">-<version>-<sha256>.tgz`.
The Genie helper `projectPrivateProductTarballs` renders
`file:.devenv/pnpm-product-tarballs/<file>` pins (typically root `overrides`)
from the same manifest rows; the checked-in manifests carry only this
root-relative path, never an absolute store path. The shared pnpm task option
`productTarballStage` links the loader's `stage` at that directory before
`install`, `update`, and `dedupe`, and treats a stale link as an install miss.

Because the file name carries the digest, a new product changes the `file:`
identity and the lock entry. The lock records `resolution.tarball` equal to the
package key's `file:` path plus the pnpm SHA-512 integrity; pnpm rejects a
staged file whose bytes do not match that integrity. TypeScript checks and unit
tests run against this staged install; source-workspace aliases do not satisfy
this conformance lane.

### Buck and sidecar

The lock translator accepts a tarball resolution starting with `file:` only as
a product: a normalized, root-relative path ending in `-<sha256>.tgz` whose
package key names the same path. The `effect-utils/buck2-pnpm-sha256/v2`
sidecar row for it replaces `registryUrl` with `productTarball`:

```json
{
  "bins": {},
  "classification": "private",
  "integrity": "sha512-…",
  "packageIdentity": "@overeng/meters@file:.devenv/pnpm-product-tarballs/overeng-meters-0.1.0-0096….tgz",
  "productTarball": "file:.devenv/pnpm-product-tarballs/overeng-meters-0.1.0-0096….tgz",
  "sha256": "0096…",
  "sizeBytes": 43881
}
```

The generator reads product bytes only from the staged path, verifies the lock
integrity and that the SHA-256 equals the digest in the file name, and reuses an
integrity-matched previous row without reading. It never fetches a product row,
and the archive seeder never uploads one to a CAS tier.

`pnpm_package` receives the `file:` identity as its `url`. Its fetch action
resolves product rows only from `nix_store.root` (sandboxed product builds, where
`pnpm-archives.nix` takes `productArchives = archivesByDigest`) or
`nix_store.product_root` (live consumer builds; `mkConsumerBuckRoot`
`privateProductRoot = archiveRoot`) and fails when neither is configured.
`pnpm-archives.nix` requires each product row's archive to be a flat
fixed-output derivation whose hash equals the row's `sha256`.

## Conformance

The contract suite must include successful canonicalization/import and negative
mutations for unknown and missing fields, alternate digest encodings, unsafe
paths and archives, byte-size and digest mismatch, platform mismatch, runtime
descriptor mismatch, unsupported runtime kind, and inspector failure.

## Shared Product Contract

The exact [descriptor schema](../01-product-contract/spec.md#descriptor) and
BUILD.DIST.PRODUCT-R01–R04 are product-owned, not Nix-owned.
Platform-independent Nix Git-source archives preserve executable bits, normalize
symlink modes to `0555`, ignore physical hardlink topology and fix timestamps,
ownership and gzip metadata; identical NAR sources produce identical archives
on Linux and Darwin ([#1589](https://github.com/overengineeringstudio/effect-utils/pull/1589)).

## Open Design Questions

**DQ1 — Action-level reuse across changed-closure product builds**
(BUILD.DIST.NIX-R08): product source builds remain pure sandboxed invocations
of the pinned Buck graph with shared remote caching disabled. Nix substitution
reuses unchanged complete products; a changed closure still pays local product
compilation. The current answer is to retain that boundary rather than adopt
offline capsules or outside-Nix publication.

Revisit if the daily cache-health mission shows changed-product rebuild cost
dominating. End-to-end changed-product timing, including cache transport and
materialization, must justify a design change; shared AC hit rates alone do not
resolve this question. [Open question](./open-questions.md#dq1-action-level-reuse-across-changed-closure-product-builds)
owns the current answer and non-chosen E/D alternatives;
[experiment](./.experiments/2026-10-05-action-level-innix-reuse.md) owns the
measurement and limits. This question does not amend
[0037](../../.decisions/0037-nix-substitution-is-the-distribution-layer.md).
