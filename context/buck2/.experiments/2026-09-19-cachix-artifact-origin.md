# Cachix Pins as a package artifact origin

Date: 2026-09-19

Host class: x86_64-linux development host. Versions: Cachix 1.11.0, Determinate Nix 3.22.3 / Nix 2.35.2,
pnpm 11.25.0, and Buck2 `2026-08-31-be6971d47dcc835b7356e1698b23039ffee4f4c2`.

## Question

Can Cachix Pins replace a GitHub Release in the read path for Nix `prefetch-file`/`pkgs.fetchurl`, a pnpm URL
dependency, and Buck2 `http_file`? Which private/public combinations work, and what publisher contract remains?

This is mechanism evidence only. It makes no architecture decision and does not
amend [decision 0034](../.decisions/0034-artifact-default-composition-no-registry.md).

## Documented mechanism

Cachix documents that a pin names a store path, is GC-immune by default, keeps every same-name revision
indefinitely by default, and can expose files with repeated `--artifact` arguments
([Pins](https://docs.cachix.org/pins.html)). Its GC otherwise removes oldest paths at the storage limit
([Garbage Collection](https://docs.cachix.org/garbage-collection.html)). Public caches allow anonymous reads;
private reads and writes require a token ([Security](https://docs.cachix.org/security.html)).

The installed 1.11.0 CLI reports:

```text
cachix pin CACHE PIN STORE-PATH --artifact ARTIFACTS...
  [--keep-days INT | --keep-revisions INT | --keep-forever]
```

It has no list, unpin, or delete verb. The pinned client validates artifacts inside the store path, then posts
pin name, path, artifacts, and retention ([`Pin.hs`, v1.11.0](https://github.com/cachix/cachix/blob/v1.11.0/cachix/src/Cachix/Client/Command/Pin.hs)).
The served URL observed here was stable and unredirected:

```text
https://<cache>.cachix.org/serve/<nix-store-hash>/<artifact-path>
```

The pin name is not in that URL. The store hash content-addresses the whole Nix
output, not the artifact's flat digest; clients still need SHA-256/SHA-512.
Cachix's 1.11.0 API exposes the `serve/<storehash>/<filepath>` route
([`API.hs`, v1.11.0](https://github.com/cachix/cachix/blob/v1.11.0/cachix-api/src/Cachix/API.hs)).

## Method

1. Download PR #1310's public `@overeng/utils` archive, verify SHA-256, add a directory store path, and push it
   to private `schickling-dotfiles`.
2. Pin a unique digest-bearing name with `--artifact <tgz>`/`--keep-forever`; repeat in public `overeng-effect-utils`.
3. Probe authenticated/anonymous HTTP, Nix native prefetch and `fetchurl`, pnpm, and Buck2 `http_file`.
4. Re-pin both test names with `--keep-days 1`; no delete verb exists, so this bounds cleanup without touching existing pins.

| Field | Value |
| --- | --- |
| Artifact | `5ec4fb7b…953f2b-overeng-utils.tgz` |
| Size | 289,672 bytes |
| SHA-256 | `5ec4fb7b529fb020ab4159491fe46ad8a36c9a8859370236f426eba925953f2b` |
| SHA-512 SRI | `sha512-zD2EdAQEmFXRcdtNf86nLp1L4of0S4cLZH2v6+Swid0XDuuxg23M+ThlMYpHrQj4iCSME8m7XvC3BN1oCIVVbA==` |
| Store path | `/nix/store/m62549nx…-cachix-artifact-origin-q44-utils-5ec4fb7b` |
| Test pin | `q44-cachix-artifact-origin-utils-5ec4fb7b…953f2b` |

Anonymous `nix-cache-info` returned 401 for `schickling-dotfiles` and
`schickling-stiftung`, and 200 for `overeng-effect-utils`; the latter is the
available public product-cache fixture.

## Result

| Consumer | Private cache | Public cache |
| --- | --- | --- |
| HTTP GET | **PASS with token.** Anonymous 401; daemon netrc Basic and Bearer header each returned 200 and 289,672 matching bytes. | **PASS anonymous.** 200, 289,672 matching bytes. |
| Nix `store prefetch-file` | **PASS.** The daemon netrc was honored; 0.67 s and expected SRI. | **PASS.** Anonymous; 0.17 s and expected SRI. |
| Nix `pkgs.fetchurl` | **FAIL.** Four 401 responses: the sandboxed curl did not receive the daemon netrc. | **PASS.** Output digest matched. |
| pnpm URL dependency | **PASS.** A trusted user-level `.npmrc` selected with `NPM_CONFIG_USERCONFIG` supplied a path-scoped `_authToken`; clean 129-package store, 46.0 s. | **PASS.** 129 packages, 46.1 s; lock recorded exact SHA-512. |
| Buck2 `http_file` | **FAIL.** A fresh isolation with a valid `$HOME/.netrc` received 401. | **PASS.** Fresh isolation materialized matching bytes. |

The private pnpm auth entry was scoped to the artifact route and used an
environment placeholder in a user-level `.npmrc`; pnpm deliberately refuses to
expand credentials from a repository `.npmrc`
([pnpm authentication settings](https://pnpm.io/npmrc#environment-variables-in-auth-settings)).
Cachix's generated netrc uses an empty Basic username and token as password
([`NetRc.hs`, v1.11.0](https://github.com/cachix/cachix/blob/v1.11.0/cachix/src/Cachix/Client/NetRc.hs)); this probe also confirmed Bearer works. Buck2's pinned HTTP client exposes no credential/header input
([`client.rs`, pinned revision](https://github.com/facebook/buck2/blob/be6971d47dcc835b7356e1698b23039ffee4f4c2/app/buck2_http/src/client.rs#L47-L76)).

Single-sample timings: GitHub fixture download 0.46 s; private push/pin 2.43/0.77
s; private authenticated GET 1.62 s (first) and 0.30 s (warm); public push/pin
2.12/0.38 s; public GET 0.85 s (first) and 0.32 s (warm). The heavy gate made
public/private `fetchurl` walls 487.81/305.43 s and public Buck wall 387.50 s;
those walls are admission evidence, not transfer benchmarks. Buck's post-gate
daemon startup plus successful public fetch took about 3.4 s.

## Conclusion

- Use a public cache for public effect-utils products. A private cache cannot
  serve native Buck2 `http_file`, and its daemon netrc does not reach
  `pkgs.fetchurl`; embedding credentials in product URLs is not acceptable.
- Compute the artifact SHA-256, SHA-512, and size independently. Put the digest
  in the filename and pin name, and keep those values in the checked-in product
  manifest; the `/serve/` URL itself does not state the flat artifact digest.
- Push the complete store path, create the pin with `--artifact` and
  `--keep-forever`, then fetch the served URL and compare size and digest before
  publishing the manifest. Verify anonymous access for a public cache.
- Never reuse a published pin name. Same-name `cachix pin` calls create mutable
  revisions; this probe repeated its unique name successfully. Digest-derived
  names plus a publisher-side reject-on-existing check preserve write-once
  identity. Consumer hashes remain the final byte-integrity gate.
- Keep supported revisions forever, monitor Cachix storage-limit warnings and
  pin state, and preserve the existing provenance mapping. Removing release
  tags does not remove retention, provenance, or adoption verification.

The test pin remains only because Cachix 1.11.0 has no CLI/API delete route; its
retention was changed from forever to one day in both caches. Both URLs still
returned 200 after that revision.

## VRS Impact

The result supplies transport, auth, mutability, and retention evidence for the
q44 reframe. It shows that the existing public Cachix cache can transport the
same archive to all three consumer kinds, while a private cache cannot satisfy
all native clients. It changes no requirement or decision.
