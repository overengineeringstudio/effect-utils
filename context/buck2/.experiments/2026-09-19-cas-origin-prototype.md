# bazel-remote CAS as a package artifact origin

Date: 2026-09-19

Host class: x86_64-linux development host. Versions: bazel-remote 2.6.2,
Buck2 `2026-08-31-be6971d47dcc835b7356e1698b23039ffee4f4c2`, Determinate
Nix 3.22.3 / Nix 2.35.2, pnpm 11.25.0, and curl 8.22.0.

## Question

Can the already-deployed bazel-remote shape serve one immutable package archive
straight from `/cas/<sha256>` to the three current consumer kinds—Nix
`pkgs.fetchurl`, a pnpm URL dependency, and Buck2 `http_file`—without a GitHub
Release in the read path? Which unauthenticated-read and Basic-auth combinations
work, does a package lock make the bytes available offline, and does Buck2's HTTP
fetch create a remote action-cache entry?

This is mechanism evidence only. It does not select or amend the durable-origin
choice in [decision 0034](../.decisions/0034-artifact-default-composition-no-registry.md).

## Method

1. Start the deployed bazel-remote 2.6.2 binary on loopback ports 50045/50046
   with a fresh 5 GiB directory and a scratch `htpasswd` file. Run it first with
   authentication required for all requests, then with
   `--allow_unauthenticated_reads`, and finally in strict-auth mode again. The
   live service and its data directory were never addressed by the probe.
2. Query all effect-utils releases. No `buck2-product-v3-utils-*` tag existed on
   2026-09-19, so use the current public package publication instead:
   [`buck2-package-v1-overeng-utils-5ec4…`](https://github.com/overengineeringstudio/effect-utils/releases/tag/buck2-package-v1-overeng-utils-5ec4fb7b529fb020ab4159491fe46ad8a36c9a8859370236f426eba925953f2b).
3. Download its only asset, calculate SHA-256 and SHA-512 independently, upload
   it with `PUT /cas/<sha256>`, download it with `GET`, and compare the bytes.
   Repeat reads and writes across strict-auth and read-public modes. Upload the
   same bytes under an all-zero digest as the corruption control.
4. Exercise `nix store prefetch-file`, then a clean `pkgs.fetchurl` fixed-output
   derivation with the same SHA-256. In strict-auth mode pass a scratch netrc
   through `--option netrc-file` and keep the output name distinct so an existing
   store path cannot mask a fetch.
5. Install `@overeng/utils` from the CAS URL in a scratch pnpm project. Inspect
   `pnpm-lock.yaml`, repeat against strict-auth mode with a URL-scoped `_auth`,
   and try frozen offline installs both after deleting only `node_modules` and
   after deleting the content-addressable pnpm store.
6. Build a minimal Buck root containing a native `http_file` with `urls` set to
   the CAS URL, `sha256` set to the artifact digest, and `size_bytes = 289672`.
   Use the repository's bundled Prelude shape and the pinned Buck2. Compare
   bazel-remote endpoint metrics immediately before and after the first build,
   repeat a warm build, and run fresh strict-auth builds with both a netrc and URL
   userinfo.

All Nix builds and Buck2 builds ran through the fleet heavy-command gate. Scratch
credentials were loopback-only, were not retained in this repository, and are
not reproduced here.

## Fixtures

### Artifact

| Field | Value |
| --- | --- |
| Release tag | `buck2-package-v1-overeng-utils-5ec4fb7b529fb020ab4159491fe46ad8a36c9a8859370236f426eba925953f2b` |
| Asset | `5ec4fb7b529fb020ab4159491fe46ad8a36c9a8859370236f426eba925953f2b-overeng-utils.tgz` |
| Download size | 289,672 bytes |
| SHA-256 | `5ec4fb7b529fb020ab4159491fe46ad8a36c9a8859370236f426eba925953f2b` |
| SHA-512 | `cc3d847404049855d171db4d7fcea72e9d4be287f44b870b647dafebe4b089dd170eebb1836dccf93865318a47ad08f888248c13c9bb5ef0b704dd680885556c` |
| SHA-512 SRI | `sha512-zD2EdAQEmFXRcdtNf86nLp1L4of0S4cLZH2v6+Swid0XDuuxg23M+ThlMYpHrQj4iCSME8m7XvC3BN1oCIVVbA==` |

The GitHub asset metadata already declared the same SHA-256 and size. The
archive's published manifest includes two runtime URL dependencies, so pnpm 11's
default `blockExoticSubdeps` rejects it. The consumer fixture therefore set
`blockExoticSubdeps: false`, matching the already-recorded direct-URL constraint
in `context/buck2/05-composition/.experiments/2026-09-13-composition-bakeoff.md:194-200`.
`--ignore-scripts` isolated transport from pnpm 11's unrelated build-approval
gate.

### Cache

The scratch process reported `Storage mode: zstd`, built an LRU index, and
reported `Will evict at max size: 5.00 GB`. The already-compressed tarball's
stored file was 289,745 bytes (299,520 allocated bytes), slightly larger than the
289,672-byte input. The deployed cache is operator-reported at 3.6 GB used of a
500 GB cap (0.72%). That low current fill is capacity evidence, not a retention
contract.

Upstream defines `/cas/<key>` as lowercase SHA-256 content-addressed storage and
`/ac/<key>` as a separate action-cache keyspace
([bazel-remote 2.6.2 README, lines 27-32](https://github.com/buchgr/bazel-remote/blob/v2.6.2/README.md#L27-L32)).
Its implementation describes `SizedLRU` as keeping total size below `maxSize` by
evicting items
([`cache/disk/lru.go`, lines 14-16](https://github.com/buchgr/bazel-remote/blob/v2.6.2/cache/disk/lru.go#L14-L16)).
This matches the deployment's existing cache-only/disposable contract in
`context/buck2/.decisions/0013-shared-cache-foundation.md:21-26`.

## Result

### HTTP storage semantics

| Probe | Observed result |
| --- | --- |
| Strict mode, unauthenticated `PUT` | `401 Unauthorized`; Basic challenge returned |
| Strict mode, authenticated `PUT /cas/<sha256>` | `200 OK`, zero-length response; blob stored |
| Strict mode, unauthenticated `GET` | `401 Unauthorized`; Basic challenge returned |
| Strict mode, authenticated `GET` | `200 OK`, `Content-Length: 289672`, `application/octet-stream`; bytes matched |
| Read-public mode, unauthenticated `GET` | `200 OK`; bytes matched; no redirect |
| Read-public mode, unauthenticated `PUT` | `401 Unauthorized`; reads did not imply writes |
| Authenticated `PUT` under an incorrect digest | Rejected as `500 Internal Server Error`; body named expected and actual digests; no wrong-key blob was admitted |

The wrong-digest rejection is content validation, although the HTTP status is a
server error rather than a client-error status.

### Consumer matrix

| Consumer | Unauthenticated read (`--allow_unauthenticated_reads`) | Basic-auth read (strict mode) |
| --- | --- | --- |
| Nix `pkgs.fetchurl` | **PASS.** Clean FOD returned the expected store path and byte comparison passed. | **FAIL.** `--option netrc-file` did not reach the sandboxed `pkgs.fetchurl` curl; four attempts returned 401. The Nix-native `nix store prefetch-file` downloader did honor the same netrc and passed, so this is specifically the current `pkgs.fetchurl` FOD boundary. |
| pnpm URL dependency | **PASS.** The package installed and the lock recorded the CAS URL plus exact SHA-512 integrity. | **PASS.** A URL-scoped `//127.0.0.1:50046/:_auth=<base64>` caused pnpm to send valid Basic credentials; the strict server returned 200 and the frozen install completed. |
| Buck2 native `http_file` | **PASS.** Fresh isolation downloaded once, SHA-256/size validation passed, and output bytes matched. | **FAIL.** A fresh isolation with a matching `$HOME/.netrc` returned 401; embedding userinfo in the URL also returned 401. |

`nix store prefetch-file` also passed without authentication in read-public mode
and returned the expected SHA-256. Its strict-auth run with `netrc-file` passed,
which separates Nix's native downloader from the `pkgs.fetchurl` builder.

The pnpm lock row was:

```yaml
resolution:
  integrity: sha512-zD2EdAQEmFXRcdtNf86nLp1L4of0S4cLZH2v6+Swid0XDuuxg23M+ThlMYpHrQj4iCSME8m7XvC3BN1oCIVVbA==
  tarball: http://127.0.0.1:50046/cas/5ec4fb7b529fb020ab4159491fe46ad8a36c9a8859370236f426eba925953f2b
```

The integrity is the independently calculated artifact SHA-512. A frozen offline
install did **not** prove byte availability: after deleting `node_modules` while
retaining the pnpm store it failed with `ERR_PNPM_NO_OFFLINE_TARBALL` for the CAS
URL, and after clearing the store it failed identically. The lock pins the bytes
that are acceptable; it does not contain or guarantee availability of those
bytes.

### Buck2 action-cache observation

Before the first fresh Buck build, bazel-remote metrics reported CAS GET hits 6
and action-cache GET hit/miss counters 0/0. After the build, CAS GET hits were 7
and action-cache counters remained 0/0. The next build in the same Buck isolation
reported `Network: up 0B down 0B` and completed without a server request.

Therefore `http_file` fetched the digest-addressed bytes from the HTTP CAS and
Buck's local state reused the materialization, but the fetch did not create a
bazel-remote `/ac/` entry. This matches the pinned Prelude implementation:
`http_file` calls `actions.download_file` directly
([Prelude revision `1f8c24e`, lines 12-53](https://github.com/facebook/buck2-prelude/blob/1f8c24e0b1f85e645011f93a4073b0c6c762d7b1/http_file.bzl#L12-L53)).
The pinned Buck2 GET builder adds only the user-agent and exposes no header input
([Buck2 commit `be6971d`, lines 47-76](https://github.com/facebook/buck2/blob/be6971d47dcc835b7356e1698b23039ffee4f4c2/app/buck2_http/src/client.rs#L47-L76)),
which grounds the observed Basic-auth gap.

## Timing

Single samples on loopback; they establish mechanism cost, not a benchmark.
Times are the inner command's elapsed value. The heavy-command gate's admission
wait is excluded where noted.

| Operation | Bytes | Elapsed | Result |
| --- | ---: | ---: | --- |
| GitHub Release download | 289,672 | 1.341 s | 200 |
| Authenticated CAS PUT | 289,672 | 0.082 s | 200 |
| Authenticated CAS GET | 289,672 | 0.484 s | 200, bytes equal |
| Public CAS GET | 289,672 | 0.726 s | 200, bytes equal |
| Wrong-digest PUT | 289,672 | 0.002 s | rejected, 500 |
| `nix store prefetch-file`, public | 289,672 | 0.95 s | pass |
| `nix store prefetch-file`, Basic netrc | 289,672 | 0.26 s | pass |
| `pkgs.fetchurl`, public | 289,672 | 0.77 s | pass |
| `pkgs.fetchurl`, Basic netrc | 0 accepted | 9.51 s | fail after four 401 attempts |
| pnpm public install, clean store | 129 packages | 13.53 s | pass |
| pnpm Basic install, clean store, frozen lock | 129 packages | 11.26 s | pass |
| pnpm frozen offline, retained store | 129-package plan | 3.41 s | fail: direct tarball unavailable offline |
| pnpm frozen offline, cleared store | 129-package plan | 2.09 s | fail: direct tarball unavailable offline |
| Buck2 fresh public `http_file` | 289,672 | 1.15 s | pass; gate-wrapped wall 78.57 s |
| Buck2 warm same isolation | 0 network bytes | 0.49 s | pass; gate-wrapped wall 180.74 s |
| Buck2 fresh strict-auth with netrc | 0 accepted | 3.68 s | fail, 401 |
| Buck2 fresh strict-auth with URL userinfo | 0 accepted | 0.85 s | fail, 401 |

## Conclusion

### What bazel-remote alone serves today

The existing bazel-remote binary is already a digest-addressed HTTP artifact
server in the protocol sense. One authenticated writer can seed a SHA-256 CAS;
unauthenticated readers can fetch the exact bytes when the process is configured
for public reads. Nix `pkgs.fetchurl`, pnpm direct URLs, and Buck2 `http_file` all
consume that read-public endpoint without a GitHub redirect. pnpm additionally
works against strict Basic auth. Hash verification remains consumer-side as well
as server-side: Nix and Buck pin SHA-256, pnpm pins SHA-512, and bazel-remote
rejects a mismatched PUT.

### What still needs a durable backend or origin

The measured process is a bounded LRU cache, not durable retention. At 3.6/500 GB
it is far from eviction today, but `max_size` explicitly authorizes eviction and
there is no measured backup, restore, replication, or retention guarantee in
this experiment. A sole local CAS would therefore make a supported lockfile
unreconstructable after eviction or host loss. Either the current immutable
release assets or a retention/restore-proven durable proxy/backend would still
have to carry that property. The current release bridge also carries discovery
and provenance: it derives tag/name/URL from the digest and validates the
manifest binding (`nix/buck2-products/default.nix:40-156`), while the publisher
verifies immutable one-asset releases (`nix/buck2-products/publish.sh:240-281`).
Bare CAS keys do not replace that manifest function.

Private artifacts cannot share a publicly readable CAS. bazel-remote 2.6.2 does
not isolate CAS by instance name, and the accepted trust posture requires
separate public and private data domains
(`context/buck2/.decisions/0033-ci-cache-posture-two-trust-tiers.md:23-28,47-60`).
A private, network-confined read-public endpoint and a public repository endpoint
are different trust boundaries even when both use the same binary.

### What needs code or a different access shape

- The publisher would need an authenticated CAS PUT path plus idempotent
  existence/digest verification, and the manifest/Nix bridge would need to emit
  CAS URLs instead of release URLs. Removing releases does not remove the
  manifest/provenance requirement.
- `pkgs.fetchurl` did not consume Nix's `netrc-file` in its sandboxed FOD. A
  strict-auth origin needs a different secret-aware Nix fetch boundary, or it
  must rely on network confinement plus unauthenticated reads. The latter is not
  appropriate for a mixed public/private store.
- Buck2's native `http_file` lacks Basic-auth input in this pin. It needs client
  credential/header support or the same network-confined read-public shape.
- The current package closure uses direct URL subdependencies, so pnpm 11 needs
  `blockExoticSubdeps: false`; that policy change is independent of whether the
  URL names GitHub or a CAS.
- A lockfile does not make a direct tarball available offline. An origin or
  pre-populated package store remains required.

These observations leave the architecture options open: keep release assets as
the durable origin and CAS as accelerator; put a durable, restore-proven backend
behind the CAS; or accept another retention mechanism while preserving the
manifest and trust-domain contracts.

## Falsifiers

- A clean-store `pkgs.fetchurl` FOD that successfully authenticates to this
  strict bazel-remote using only `--option netrc-file` falsifies the Nix auth
  result.
- A pinned Buck2 `http_file` build that sends configured Basic credentials and
  succeeds against strict mode falsifies the Buck auth gap.
- A fresh Buck isolation that increments `/ac/` counters or re-materializes with
  the HTTP endpoint unavailable falsifies the finding that native `http_file`
  creates no remote action-cache record.
- A frozen pnpm install after deleting both `node_modules` and the pnpm store
  that succeeds with the origin unavailable falsifies the availability finding.
- A configured backend with an explicit retention rule and a restore drill that
  recovers an evicted sole-origin blob falsifies the durability caveat for that
  deployment.
- A single bazel-remote process that cryptographically prevents public readers
  from addressing private CAS blobs falsifies the separate-data-domain
  requirement for that version and configuration.

## VRS Impact

This record supplies evidence for re-deriving the origin options behind decision
0034. It changes no requirement and makes no architecture decision. It confirms
that bazel-remote's existing HTTP CAS is sufficient transport for all three
read-public consumers, while separating that transport result from retention,
provenance, authentication, offline availability, action-cache behavior, and
public/private trust-domain requirements.
