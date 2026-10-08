# 0029 Official Go Release Toolchain

Status: accepted

## Context

Ratified by Johannes on 2026-09-03 (dotfiles Buck2 adoption epic #2319, question
q37): the hub's Go capability is the **official Go release archive**, fetched per
platform by `fetchurl` against the `sha256` go.dev publishes — the same shape
`nix/buck2.nix` already uses for buck2 — and **not** `pkgs.go`. nixpkgs' Go
stays available for non-product uses (dev shells, scripts); it is out of the
product path. The same ratification requires a rule lint so a Go product cannot
silently depend on the host's zone database or MIME table.

The question this settles was recorded as unresolved when the Go lane landed. A
consumer repo's Go service (a ~16 MB GitHub Actions scaleset controller: 3 direct
and 28 indirect module requirements, a 95-line `go.sum`) is built today by
`buildGoModule` with a hand-maintained `vendorHash` fixed-output derivation. The
platform hub had no Go toolchain at all, so no member cell could name
`toolchains//:go_bootstrap`, and the module supply had no representation in Buck:
a `vendorHash` FOD is neither content-addressed per module nor derivable from
`go.sum`.

Three questions had to be answered together, because each one's cheapest answer
constrains the others: where the Go distribution comes from, how third-party
module sources arrive, and which runtime contract the product satisfies.

## Evidence and Argument

Measured on a composed scratch root (cells `workspace`/`prelude`/`effect_utils`/
`dotfiles`, hub mounted by `cp -a`, capabilities projected by mr's resolver,
buck2 `unstable-2026-08-22` bundled prelude, Go 1.26.5):

| probe                                                        | result                                                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `buck2 build dotfiles//go/runner-scaler:bin` cold            | BUILD SUCCEEDED, 9.8 s, `Commands: 32 (cached: 0, local: 32)`, 22 MiB fetched                                      |
| binary runs under `env -i`                                   | full flag set printed; statically linked, no `PT_INTERP`, no `DT_NEEDED`                                           |
| second root, longer absolute path, empty `buck-out`          | `Commands: 32 (cached: 32, remote: 0, local: 0)`, artifact byte-identical (`sha256 074aac42…`)                     |
| one-file edit                                                | `Commands: 1`, 10.7–26.6 s — a full recompile of all 31 modules; `go build` has no per-package Buck incrementality |
| pin-table generation for 31 modules                          | 4.8 s, every proxy zip byte-identical to the `go.sum`-authenticated module-cache zip                               |
| `go_library(srcs = [":<module-archive>[uuid.go]", …])`       | BUILD SUCCEEDED, 6 actions, 2.3 s, runs — a module compiles straight out of a hash-pinned zip's sub-targets        |
| `buck2-artifact-scan tree` on the product (`pkgs.go`)        | `FATAL - forbidden Nix store reference in bin/runner-scaler`, rc=1                                                 |
| `buck2-artifact-scan tree` on the same product (official Go) | rc=0                                                                                                               |

The toolchain-source verdict, re-derived independently against this change's own
`nix/go.nix` realization (one 68-import Go program, identical sources, identical
`-trimpath -tags timetzdata CGO_ENABLED=0` flags, Go 1.26.5 both ways):

|                                                 | `pkgs.go`                                                               | official archive (`nix/go.nix`) |
| ----------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------- |
| `/nix/store` strings in the product             | **2** (`mailcap-2.1.54/etc/mime.types`, `tzdata-2026c/share/zoneinfo/`) | **0**                           |
| binary size                                     | 3,026,743 B                                                             | 3,026,751 B (+8 B)              |
| toolchain runtime closure (`nix path-info -r`)  | tzdata, mailcap, iana-etc, glibc + Go                                   | **1 path — itself**             |
| `buck2-artifact-scan` verdict at product import | rejected                                                                | accepted                        |

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
- **The official archive needs no Nix rewriting at all.** `bin/go` and every
  `pkg/tool/*` binary are statically linked, so they run unmodified on NixOS with
  no `autoPatchelfHook`, nothing is stripped, and the realization's closure is
  the single path itself. A toolchain nobody patched is a toolchain that is
  byte-identical fleet-wide, which is what makes cross-host action keys agree.

The reason the lint exists, measured on a fleet host with the official archive:
the unpatched standard library resolves host data from FHS paths, so
`time.LoadLocation("Europe/Berlin")` succeeds **by accident** (Go 1.26's search
list includes `/etc/zoneinfo`, which NixOS happens to provide) while
`mime.TypeByExtension(".woff2")` returns `""` because `/etc/mime.types` does not
exist. Both answers are functions of ambient host state, and the failure mode is
a wrong answer at run time, not a build error. Removing nixpkgs' store paths from
the product removes the guarantee they were providing; the lint is what replaces
it.

## Options

| Decision                     | Selected                                                                                                                    | Alternatives rejected                                                                                                                                                                                                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Go toolchain provenance      | the official release archive per platform, `fetchurl` + published `sha256`, realized as the `buck2-go` flake output         | `pkgs.go` (patched stdlib puts store paths in every product, so `elf-static/v1` is unreachable without either `nix-closure/v1` or a hole in the artifact scan); a patch-stripped nixpkgs Go (a fork of nixpkgs' Go expression to maintain, for bytes upstream already publishes)          |
| Where the archive is fetched | Nix `fetchurl`, like `nix/buck2.nix`                                                                                        | a Buck `http_archive` for the distribution (would make GOROOT a Buck artifact and remove the copy, but makes the toolchain the only capability outside the projection, and `http_archive`'s `.zip` path already needs an ambient `unzip`)                                                 |
| Go toolchain provenance kind | still a Nix realization, so the capability projection, the resolver and `_require_nix_store_binary` are unchanged           | a non-Nix capability class (a second capability protocol and a second trust root for one tool)                                                                                                                                                                                            |
| Module supply                | one `http_archive` per module version over the proxy zip, `sha256` generated from `go.sum`-authenticated bytes              | `vendorHash` FOD (not per-module, not derivable, hand-maintained); `go mod download` in a build action (network in an action, contradicts DEPS-R08); a committed vendor tree (30 k source files under review)                                                                             |
| Assembly                     | `go_vendored_binary`: archives assembled into `vendor/` plus the generated `modules.txt`, one `go build -mod=vendor` action | prelude-native per-package `go_library`/`go_binary` — proven to work and strictly better for incrementality, but needs GOROOT as a Buck artifact, which for a Nix realization means an action-language helper decision 0028 does not admit plus a 250 MB copy per configuration           |
| Host data                    | a required, defaultless `host_data` attribute; `"embedded"` appends the `timetzdata` build tag                              | a static import scan at analysis time (Buck analysis cannot read source bytes, so the check would have to be a build-time text match over `go list -deps`, and `mime` is in `net/http`'s closure, so it would fire on every service); a silent default (the decision it hides is the bug) |
| Runtime contract             | `elf-static/v1` (`CGO_ENABLED=0`, no interpreter, no `DT_NEEDED`)                                                           | `elf-dynamic/v1` — rejects a static binary outright (no `PT_INTERP` to match); `nix-closure/v1` — works and its closure is toolchain-derivable here, but costs ≈337 lines and splits the Linux fleet across two contracts                                                                 |

## Decision

The hub's `go` capability is the official Go release archive. `nix/go.nix` pins
one `fetchurl` per admitted platform (`linux-amd64`, `linux-arm64`,
`darwin-arm64`) by the `sha256` published at `https://go.dev/dl/?mode=json`,
unpacks it verbatim — no patchelf, no strip, no fixup — and fails closed in its
own install check on the property it exists for: `bin/go` must run, and no file
under `src/` may mention `/nix/store`. It is exposed as the `buck2-go` flake
output, so `nix run .#go` cannot silently hand anyone the product-illegal
distribution, and `pkgs.go` remains available for everything that is not a Buck
product.

Because the archive is still realized through Nix, it is an ordinary capability:
the projection, the resolver, and `_require_nix_store_binary`'s
`/nix/store/<realization>/bin/go` shape assertion are unchanged, and the
interpreter-shaped question the derisk raised ("the first capability that is not
a Nix realization") does not arise.

The hub declares one Go toolchain: `nix_go_bootstrap_toolchain`, prelude's
`GoBootstrapToolchainInfo` — the `go build` driver — reached as
`toolchains//:go_bootstrap`. `env_go_root` is left `None`: `go` locates its own
GOROOT relative to the realized executable, so declaring it would only restate
what the store path already says. Prelude's per-package `GoToolchainInfo` graph
is **not** declared. It needs GOROOT as a Buck `Artifact`
(`prelude//go:go_stdlib.bzl`), which for a store-path GOROOT means an
action-language helper — the shape it was prototyped in was a
`python_bootstrap_binary`, which [decision
0028](./0028-hermetic-python-bootstrap-for-consumer-cells.md) admits the
bootstrap _toolchain_ for but not first-party Python _actions_ — plus 250 MB of
`buck-out` per configuration. That lane is deferred until the distribution
arrives as a Buck artifact, at which point the copy disappears entirely rather
than being reimplemented.

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

**Host data is a required declaration.** `go_vendored_binary` takes a defaultless
`host_data` attribute:

- `"embedded"` — the rule appends the `timetzdata` build tag, which links the
  zone database into the binary (measured: +411 KB, `go list -deps` gains
  `time/tzdata`), and the product registers its own MIME types with
  `mime.AddExtensionType`. The standard library has no MIME equivalent of
  `time/tzdata`, so that half is an assertion the attribute records rather than a
  mechanism the rule supplies.
- `"unused"` — the product performs no zone lookup and no
  `mime.TypeByExtension` call.

The rule additionally refuses `timetzdata` in `tags`: the tag has exactly one
owner. A source-level import scan was considered and rejected — Buck analysis
cannot read source bytes, so the check would have to be a build-time text match
over `go list -deps`, and `mime` is in `net/http`'s dependency closure, so it
would fire on every service and teach people to suppress it.

## Consequences

- A consumer cell can build and run a real Go service from Buck: cold 9.8 s,
  100 % cross-root cache reuse, a byte-identical artifact across roots, and a
  binary within 0.05 % of the `buildGoModule` output it replaces.
- The product carries zero Nix store references, so `elf-static/v1` admits it
  with zero added inspector lines and the Linux fleet converges on one runtime
  contract for both Rust and Go.
- The consumer deletes its `default.nix`, its flake, and the `vendorHash`
  maintenance class. `go.mod`/`go.sum` become the single declared pin set.
- A new maintenance class replaces it, smaller and mechanical: three published
  `sha256` values per Go release. There is no `nix flake update` path for them —
  a Go bump is a `nix/go.nix` edit against `https://go.dev/dl/?mode=json`.
- The pinned release is **1.26.5**, the version every measurement in this record
  and in the cross-compile digest evidence was taken at. 1.26.8 is current;
  bumping it is a follow-up that should re-run the lane, not a silent edit.
- The prelude-native authoring shape is deferred, not rejected. It has no hub
  rule at all and rebuilds one package instead of the whole binary, so it is the
  better long-term shape — but only once GOROOT is a Buck artifact. Until then
  `go_vendored_binary` is the single admitted shape, and a one-line edit costs a
  full recompile of every module. Two facts the prototype paid for and whoever
  revives it should not rediscover: `GoToolchainInfo.version` must be
  `parse_go_version(...)` of the distribution's version, and `packer` must come
  from `prelude//go/tools:tool_pack` — modern Go distributions ship no
  `pkg/tool/<os>_<arch>/pack` binary, and pointing at that path fails only at
  _link_ time, after the whole standard library has compiled.
- `cgo_enabled = False` is mandatory, and the reason is a hub gap: with cgo
  enabled, `go_stdlib` compiles `.S` sources through `toolchains//:cxx` and fails
  with `Could not find compiler for extension '.S'` because the hub's `cxx`
  toolchain declares no assembler. Any future cgo-dependent Go product needs
  that closed first, and so would a Rust crate with `.S` sources.
- `http_archive` on a `.zip` shells out to `unzip` from the ambient PATH. The
  Rust reindeer graph never hits this (crates are `.tar.gz`); the Go lane always
  does, because the proxy serves only `.zip`. Pinning `unzip` as a capability is
  open follow-up work.
- The `buck2-go` realization is 235 MB in the store and its closure is exactly
  itself. That is larger than `pkgs.go`'s own output but smaller as a closure,
  and it is the price of an unpatched distribution.
