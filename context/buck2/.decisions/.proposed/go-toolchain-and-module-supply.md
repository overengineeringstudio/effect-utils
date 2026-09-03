# Go Toolchain and Module Supply

Status: proposed

## Context

A consumer repo's Go service (a ~16 MB GitHub Actions scaleset controller: `go
1.25.3`, 3 direct and 28 indirect module requirements, a 95-line `go.sum`) is
built today by `buildGoModule` with a hand-maintained
`vendorHash = "sha256-…"` fixed-output derivation. The platform hub had no Go
toolchain at all, so no member cell could name `toolchains//:go`, and the
module supply had no representation in Buck: a `vendorHash` FOD is neither
content-addressed per module nor derivable from `go.sum`.

Three questions had to be answered together, because each one's cheapest answer
constrains the others: where the Go distribution comes from, how third-party
module sources arrive, and which runtime contract the product satisfies.

## Evidence and Argument

Measured on a composed scratch root (cells `workspace`/`prelude`/`effect_utils`/
`dotfiles`, hub mounted by `cp -a`, capabilities projected by mr's resolver,
buck2 `unstable-2026-08-22` bundled prelude, nixpkgs `go-1.26.5`):

| probe                                                        | result                                                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `buck2 build dotfiles//go/runner-scaler:bin` cold            | BUILD SUCCEEDED, 9.8 s, `Commands: 32 (cached: 0, local: 32)`, 22 MiB fetched                                      |
| binary runs under `env -i`                                   | full flag set printed; statically linked, no `PT_INTERP`, no `DT_NEEDED`                                           |
| second root, longer absolute path, empty `buck-out`          | `Commands: 32 (cached: 32, remote: 0, local: 0)`, artifact byte-identical (`sha256 074aac42…`)                     |
| one-file edit                                                | `Commands: 1`, 10.7–26.6 s — a full recompile of all 31 modules; `go build` has no per-package Buck incrementality |
| pin-table generation for 31 modules                          | 4.8 s, every proxy zip byte-identical to the `go.sum`-authenticated module-cache zip                               |
| `buck2 build dotfiles//go/hello:hello` (prelude `go_binary`) | BUILD SUCCEEDED, 415 actions, 22.9 s — the whole per-package stdlib, from the Nix-realized distribution            |
| `go_library(srcs = [":<module-archive>[uuid.go]", …])`       | BUILD SUCCEEDED, 6 actions, 2.3 s, runs — a module compiles straight out of a hash-pinned zip's sub-targets        |
| `buck2-artifact-scan tree` on the product (`pkgs.go`)        | `FATAL - forbidden Nix store reference in bin/runner-scaler`, rc=1                                                 |
| `buck2-artifact-scan tree` on the same product (official Go) | rc=0                                                                                                               |

Four facts the plan did not have:

- **The Go module proxy is already the content-addressed supply shape.**
  `<proxy>/<module>/@v/<version>.zip` is immutable by specification and
  `go.sum`'s `h1:` entry is a dirhash over that zip's contents, so a `sha256`
  over the served bytes is a restatement of an existing authenticated pin, not a
  second one. That removes the "hash of a server-generated artifact" failure
  mode that hash-pinned GitHub tarballs carry.
- **Prelude's Go rules accept archive sub-targets as `srcs`.** No vendor tree
  and no source files in the repo are required for third-party code; the
  per-package file lists are in the zip index, so a generator can emit them.
  Prelude's own `gobuckify` uses a `go mod vendor` tree, which is strictly more
  machinery than this.
- **nixpkgs' Go patches its own standard library with four absolute store
  paths** (`mime/type_unix.go` → mailcap, `time/zoneinfo_unix.go` → tzdata,
  `net/{port,lookup}_unix.go` → iana-etc, `internal/buildcfg/zbootstrap.go` →
  glibc's loader). Every binary built with `pkgs.go` inherits them, so
  `buck2-artifact-scan.nix`'s categorical store-reference prohibition rejects
  the product. Go is therefore the first language whose toolchain cannot be
  `pkgs.<lang>` unmodified — `bun`, `tsgo`, `rustc` and `python3` all can.
- **`prelude//go:go_stdlib.bzl` takes `goroot` as `dynattrs.value(Artifact)`**
  and projects stdlib sources out of it, so the prelude-native graph needs the
  Go distribution materialized inside `buck-out`: measured at 250 MB per
  configuration.

## Options

| Decision                     | Selected                                                                                                                    | Alternatives rejected                                                                                                                                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Go toolchain provenance      | a `go` `ToolchainAuthority` realized by the hub flake's `go` output, projected as the `go` capability                       | `system_go_toolchain`/`system_go_bootstrap_toolchain` — both resolve the bare name `go` off the ambient PATH, the exact non-hermetic term `python-bootstrap` was introduced to remove                                                               |
| Module supply                | one `http_archive` per module version over the proxy zip, `sha256` generated from `go.sum`-authenticated bytes              | `vendorHash` FOD (not per-module, not derivable, hand-maintained); `go mod download` in a build action (network in an action, contradicts DEPS-R08); a committed vendor tree (30 k source files under review)                                       |
| Assembly                     | `go_vendored_binary`: archives assembled into `vendor/` plus the generated `modules.txt`, one `go build -mod=vendor` action | prelude-native per-package `go_library`/`go_binary` — proven to work and strictly better for incrementality, but needs the generator to emit per-package import graphs, and costs the 250 MB GOROOT copy while the distribution is a Nix store path |
| Runtime contract             | `elf-static/v1` (`CGO_ENABLED=0`, no interpreter, no `DT_NEEDED`)                                                           | `elf-dynamic/v1` — rejects a static binary outright (no `PT_INTERP` to match); `nix-closure/v1` — works and its closure is toolchain-derivable here, but costs ≈337 lines and splits the Linux fleet across two contracts                           |
| Store strings in the product | left unresolved in this change; the lane is proven with both distributions and the scan verdict measured for each           | punching a Go-shaped hole in the scan's store-reference prohibition (turns a categorical repository invariant into a per-language allowlist, the strongest argument `nix-closure/v1` raised against itself)                                         |

## Decision

The platform hub owns Go the way it owns every other toolchain: a `go`
`ToolchainAuthority` whose single provided capability is the hub flake's `go`
output at `bin/go`, and two conventional targets in the hub root package —
`toolchain_alias` `go` and `go_bootstrap` onto `//buck2/toolchains:*`.
`bin/go` in that realization is a symlink into `share/go/bin/go` of the _same_
store path, so it satisfies the resolver's realpath shape check with no wrapper
(unlike `python3`, whose nixpkgs `bin/python3` points at `python3.13`).

Two toolchain rules, because prelude has two Go toolchain providers and they
answer different questions:

- `nix_go_bootstrap_toolchain` supplies `GoBootstrapToolchainInfo` — the
  `go build` driver. `env_go_root` is left `None`: `go` locates its own GOROOT
  relative to the realized executable, so declaring it would only restate what
  the store path already says.
- `nix_go_toolchain` supplies `GoToolchainInfo` — prelude's per-package
  compile/link graph. Because `go_stdlib` needs GOROOT as an artifact, it
  materializes the distribution with a bootstrap-Python tool whose input is the
  exact store path, rather than prelude's `copy_goroot.go`, which shells out to
  a bare `go` on PATH. `packer` comes from `prelude//go/tools:tool_pack`: modern
  Go distributions ship no `pkg/tool/*/pack` binary, so prelude compiles
  `cmd/pack` from the distribution's own sources.

Third-party Go code arrives as one `http_archive` per module version over
`<proxy>/<module>/@v/<version>.zip`, pinned by a `sha256` that a generator
computes at generation time after `go` itself has authenticated the same bytes
against `go.sum` and the checksum database; the generator refuses to emit unless
an independent HTTPS fetch of the proxy URL matches the module-cache zip
byte-for-byte. The pin table carries a digest over `go.mod`+`go.sum` so a
dependency bump with a stale table fails at generation time. No build action
touches the network: `GOPROXY=off` in the action environment is the fail-closed
term.

`go_vendored_binary` assembles those archives into a `vendor/` tree beside the
first-party sources, together with the `modules.txt` `go mod vendor` itself
produced, and runs one `go build -mod=vendor -trimpath` with `CGO_ENABLED=0`
and `GOTOOLCHAIN=local`. `GOCACHE` lives in `BUCK_SCRATCH_PATH` (prelude's
`go_wrapper.py` sets it), so the compile cache is per-action and cannot leak
between builds — verified: wiping the scratch directory changes the rebuild time
by less than the host's own noise.

## Consequences

- A consumer cell can build and run a real Go service from Buck: cold 9.8 s,
  100 % cross-root cache reuse, a byte-identical artifact across roots, and a
  binary within 0.05 % of the `buildGoModule` output it replaces.
- The consumer deletes its `default.nix`, its flake, and the `vendorHash`
  maintenance class. `go.mod`/`go.sum` become the single declared pin set.
- Two authoring shapes exist for Go and only one should survive.
  `go_vendored_binary` is 112 lines of hub code and rebuilds the whole binary on
  any edit; the prelude-native graph has no hub rule at all and rebuilds one
  package, but needs a larger generator and — while the distribution is a Nix
  store path — 250 MB of `buck-out` per configuration. Both are proven; the
  choice is deliberately left open because it depends on the provenance question
  below.
- `cgo_enabled = False` is mandatory, and the reason is a hub gap: with cgo
  enabled, `go_stdlib` compiles `.S` sources through `toolchains//:cxx` and fails
  with `Could not find compiler for extension '.S'` because the hub's `cxx`
  toolchain declares no assembler. Any future cgo-dependent Go product needs
  that closed first, and so would a Rust crate with `.S` sources.
- `http_archive` on a `.zip` shells out to `unzip` from the ambient PATH. The
  Rust reindeer graph never hits this (crates are `.tar.gz`); the Go lane always
  does, because the proxy serves only `.zip`. Pinning `unzip` as a capability is
  open follow-up work.
- **Unresolved, and it gates the first Go product import:** whether the Go
  distribution stays `pkgs.go` (whose stdlib patches put three store paths in
  every product and make `elf-static/v1` unreachable without either
  `nix-closure/v1` or a hole in the artifact scan) or becomes the official
  distribution as a hash-pinned archive (zero store references, zero-line
  `elf-static/v1` admission, and a GOROOT that is already a Buck artifact — but
  a second trust root and the first capability that is not a Nix realization).
  Both were measured; the trade is a policy question, not a technical one.
