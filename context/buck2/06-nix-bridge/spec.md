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

## Descriptor

```json
{
  "schema": "buck-build-product/v1",
  "name": "fixture-tool",
  "entrypoints": ["bin/fixture-tool"],
  "payload": {
    "file": "artifact.tar",
    "format": "tar",
    "sizeBytes": 123,
    "digest": { "algorithm": "sha256", "sri": "sha256-...=" }
  },
  "platform": { "os": "linux", "architecture": "x86_64", "abi": "musl" },
  "runtime": { "kind": "self-contained", "inspectionContract": "elf-static/v1" },
  "semanticProvenance": {
    "target": "//fixtures:tool",
    "recipe": "fixture-tool/v1",
    "toolchain": "rust-linux-musl/v1"
  }
}
```

Every object uses exact fields. Descriptor identity is SHA-256 over canonical
JSON. Entry points and payload paths are normalized safe relative paths.
Runtime is a tagged union whose fields and inspection contract depend on
`kind`; acceptance of a descriptor kind does not imply an importer exists for
it.

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

## Private pnpm Consumption

Nix realizes a private package product before dependency installation. The
consumer staging step writes that immutable tarball path into the staged package
manifest as a `file:` dependency. pnpm receives no cache credential and performs
no private network fetch. The checked-in source manifest does not contain an
absolute store path.

The tarball path or filename must change when the product digest changes. The
consumer lock records that exact `file:` identity and the package integrity.
TypeScript checks and unit tests run against the staged install; source-workspace
aliases do not satisfy this conformance lane.

## Conformance

The contract suite must include successful canonicalization/import and negative
mutations for unknown and missing fields, alternate digest encodings, unsafe
paths and archives, byte-size and digest mismatch, platform mismatch, runtime
descriptor mismatch, unsupported runtime kind, and inspector failure.
