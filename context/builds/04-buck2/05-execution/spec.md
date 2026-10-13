# Execution Spec

This document specifies per-language action mechanics. It builds on [requirements.md](./requirements.md).

## Status

Draft.

## Scope

**Defines:** TypeScript, Rust and compiled JavaScript action shapes, typed
verdicts and hermetic-lane admission.

**Does not define:** [platforms/tools](../02-platforms-toolchains/spec.md),
[materialization](../04-materialization/spec.md), [reuse](../06-reuse-client/spec.md)
or [product import](../../05-product-distribution/02-nix-bridge/spec.md).

## TypeScript Actions

The typecheck/build action stages package sources plus its materialized
`node_modules` (03), then runs `tsgo` from a toolchain target. Prototype
evidence
([.experiments/2026-08-25-tsgo-rule-prototype.md](.experiments/2026-08-25-tsgo-rule-prototype.md)):
a ~40-line rule checks real tui-core with negligible overhead — cold 0.58 s
including hashing a 104 MB closure, warm no-op 14 ms, single-file invalidation
75 ms via watchman. Materialized closures must contain no dangling symlinks
(pnpm's platform-excluded optional-dep aliases are pruned at materialization).
Workspace sibling sources enter as declared inputs of the dependent's check
(live-link model, 03). Output contract: a slim verdict/dist artifact, not the
staged tree, for cache-upload economics.

Emit scratch copies retain owner-write permission on files and directories,
including copied workspace siblings. Buck can therefore remove an abandoned
`TMPDIR` before rerunning the action even when the runner was killed without
cleanup. Within the writable scratch staging view, input integrity
(BUILD.BUCK.EXEC-R08) is additionally checked: the runner fingerprints declared
roots and the complete staged workspace before and after the compiler. The staged walk
hashes symlink destinations without following them, so the declared output
symlink permits emission without exempting staged source or sibling mutations.
Any input fingerprint change fails the action, including a compiler exit of zero.

### TypeScript containment and platform admission (BUILD.BUCK-R04)

```text
selected Linux executor -> mandatory linux-bwrap -> admitted check/emit
                                                -> local-only package projection
selected Darwin executor -> darwin-unsandboxed   -> local execution, no admission/reuse
declared Linux Nix builder -> nix-outer-sandboxed -> local execution, no action-cache admission
```

Outside the explicitly declared Nix builder mode below, Linux TS check, emit and package-tree run actions use the declared Nix
Bubblewrap capability. There is no unsandboxed fallback: a missing capability,
failed namespace setup, denied access or failed compiler makes the action fail.
Analysis emits the exact bind argv in a declared shell argument script. The
scrubbed, Nix-pinned Bash entry creates output directories and immediately
execs Bubblewrap; no Bun containment observer or per-input realpath/stat walk
runs outside the action:

| Resource                                                                   | Linux action access                                                                                                         |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Declared artifact/read-root inputs and their declared symlink destinations | Read-only                                                                                                                   |
| Exact transitive Nix closures of the selected action tools                 | Read-only; no whole `/nix/store` mount                                                                                      |
| Declared per-action output directories                                     | Writable in place; host siblings and parents are not mounted                                                                |
| Buck-owned action scratch and private `/tmp`                               | Writable                                                                                                                    |
| `/proc` and minimal `/dev`                                                 | Minimal namespace views, read-only mounts                                                                                   |
| Environment                                                                | Cleared; only `LC_ALL=C`, `TZ=UTC`, `BUCK_SCRATCH_PATH`, private `TMPDIR`, and action-owned `PWD` (also synthesized by Bun) |
| Network and undeclared host filesystem                                     | Unavailable; isolated network namespace and no ambient filesystem mount                                                     |

The capability pins upstream Bubblewrap 0.13.0 in `nix/bubblewrap.nix`.
Its recursive `mount_setattr` path applies read-only, `nodev`, and `nosuid`
without reparsing the growing mount table for each declared bind. Older kernels
use Bubblewrap's upstream attribute-setting fallback; neither path weakens the
filesystem or network boundary. Declared inputs remain individual mounts:
there is no copied input-view grouping, overlay, image, or FUSE dependency.

Every TS run action declares directory outputs, including directories holding
projected file receipts. The shared scrubbed launcher creates those directories
before Linux containment, outer-Nix execution, or unsandboxed Darwin execution, so fresh nested verdicts
do not depend on a pre-existing output root. Runners reset their contents without deleting the
mount point. Outputs are written in place: there is no staging publication
copy, rename, or post-action observer. Files staged into scratch remain writable
for abandoned-action cleanup; compiler mutation
of staged inputs still fails the fingerprint check. Read-only input mounts and
the exact closure prevent ambient reads and live-input mutation independently
of that check. Only `linux-bwrap` TS actions hold BUILD.BUCK-R04 at this per-action boundary;
outer Nix containment, environment scrubbing or fingerprint detection alone does not establish it.

`buck2/platforms:ts_action_execution_policy` is a default-only execution
dependency, selected in Buck's actual execution configuration. The policy does
not infer execution OS from a portable target, host metadata or tool strings.
`ts_action_policy_attrs()` installs that dependency;
`ts_action_execution_constraints(constraints = [])` preserves caller constraints,
pins the native host executor, and adds `cache_hermetic` only for default Linux Bubblewrap mode.
Rule-owned `ts_action_cache_eligible(ctx)` admits `linux-bwrap` only, and
`ts_action_admission_status(ctx)` checks actual execution before registering any
TS run action. Explicit `exec_compatible_with` cache overrides cannot admit a
Darwin executor or the declared Nix outer boundary. These helpers do not change other action families' platform
policy.

Darwin TS actions continue to run locally unsandboxed with `local_only = True`.
They explicitly report `admission_status = "darwin-unsandboxed"` and use the
nonremote native platform with cache uploads disabled. BUILD.BUCK-R04 does
**not** hold for Darwin TS execution; it is not hermetic/shareable or eligible
for hermetic shared immutable-store admission. Unsupported admission is not
refusal to execute macOS merge-group tests or editor development workflows:
worktree-local editor snapshot reuse remains permitted on Darwin and is not
shared/hermetic admission. No cross-checkout shared immutable TS store is
introduced by this policy; existing npm/archive and Nix product boundaries are
unchanged. Linux reports
`admission_status = "linux-bwrap"`; package-tree projection remains excluded
from shared cache by `local-materialization-policy` even when sandboxed.

Decision authority is the live 2026-10-11 axe record `jd5hbf`,
`enforce-linux-block-darwin`: enforce Linux containment and block Darwin
admission, not Darwin execution. Action evidence names `darwin-unsandboxed`
separately from `local-materialization-policy`, using the explicit
`_darwin_unsandboxed` category suffix rather than guessing executor OS from a
target configuration. Both exclusions stay outside eligible shared-cache
cohorts without rewriting native execution/cache outcome enums.

Linux Nix from-source products explicitly set `ts_action.outer_sandbox=nix-build/v1`
in their declared Buck build arguments. Their Nix derivation owns filesystem and
network containment over the complete declared build inputs; nested Bubblewrap
user namespaces and `pivot_root` are not available on all Nix builders. The
declaration selects `nix-outer-sandboxed` policy but is not sufficient to execute:
the native nonremote launcher verifies the outer boundary at runtime **before**
creating declared outputs or executing the TS child. It requires:

- `NIX_BUILD_TOP` to name an existing absolute directory, resolved physically,
  containing both the action cwd and its discovered `.buckroot` Buck root.
- `HOME` to be exactly `/homeless-shelter` or resolve physically under `NIX_BUILD_TOP`.
- Readable `/proc/net/dev` to list only `lo`, including `lo`.
- Readable `/proc/self/mountinfo` to identify the mount at `/`, whose root field
  must differ from `/`; a network namespace alone is not a filesystem boundary.
- `/tmp` to be absent with `lstat` returning `ENOENT`, or be a plain nonsymlink
  directory on the same subtree root mount. Its actual device must match `/`,
  and `/proc/self/mountinfo` must contain no separate or bind mount at `/tmp`.
  Equal device/inode with the build directory does not exempt a `/tmp` mount.
- `/home`, `/root`, `/run/user`, and `/nix/var/nix` to be absent with `lstat`
  returning `ENOENT`. Real passwd homes outside the verified `NIX_BUILD_TOP`
  must likewise be absent: these are homes for UID 0 or
  `1000 <= UID < 65534`, read from `/etc/passwd`. Builder homes within the
  build top are exempt; the `nobody` UID 65534 entry is ignored.
  Nonwritability is insufficient: existing read-only paths and inspection
  failures such as `EACCES` do not satisfy absence.

`NIX_BUILD_TOP` and `HOME` are explicitly conveyed through `env -i` only for
verification, then unset before the scrubbed TS child runs. Missing, unreadable,
unusable, or failing criteria refuse execution with
`outer sandbox declared but not verified`; diagnostics name all required criteria
and the actual failures. No failure falls back to unsandboxed execution or retries
Bubblewrap. There is no automatic environment detection: an absent declaration
still requires Bubblewrap, and unknown declaration versions fail analysis.

Namespace Linux CI runner labels request `container.privileged=true`: the runner
container is inside an ephemeral per-job VM, and this permission allows Nix to
create its real build namespaces instead of automatically disabling sandboxing.
Darwin runner labels do not request this feature. The temporary #1212 CI probe
records effective Nix sandbox settings, user-namespace sysctls and an unprivileged
namespace check, then runs the pinned Bubblewrap with the default TS mount,
environment and namespace arguments inside a strict Nix derivation. Its evidence
must be observed before changing the declared outer-mode policy.
Default Linux and Darwin execution remain unchanged.

The verifier establishes a filesystem/network boundary, not proof of Nix
origin. A caller-created full mount namespace satisfying every criterion is
acceptable; plain `unshare -rn` with a forged build top and HOME is rejected
because it retains the host filesystem.

The empirical dev4 Nix builder probe (2026-10-13) ran as UID 1000 (`nixbld`).
Its root mount's root field was the derivation's private chroot directory;
passwd homes for both `root` and `nixbld` were `/build`, while `nobody` had `/`.
`/tmp` was a private plain directory in that chroot on the root device, with
an inode distinct from `/build` and no separate `/tmp` mount. The accepted
plain-directory layout therefore does not require or admit a build-directory
alias exemption.

Runtime verification checks the outer derivation boundary, not per-action input
isolation: other declared derivation inputs can be visible. Even with a verified
outer sandbox, these TS actions use native nonremote execution with cache uploads
disabled and are not hermetic action-cache candidates or eligible for shared
immutable TS-store reuse. Their `_nix_outer_sandboxed` action categories produce a
separate `nix-outer-sandboxed` evidence exclusion, preserving raw Buck outcomes;
the category records selected policy, not proof of successful verification.
The Bubblewrap probe reports this boundary as unsupported rather than claiming
BUILD.BUCK-R04's per-action checks passed. The runtime regression contract rejects
an ordinary-host declaration and a forged `NIX_BUILD_TOP`/`HOME` context,
including plain `unshare -rn`, without producing verdicts. The positive
production-path regression runs in the existing Nix from-source product CI
contract lane.

## Rust Actions

Authored `Cargo.toml` is the request authority; workspace binding follows the
rust-cargo decisions (0017–0019). Third-party source supply and product ordering
follow [decision 0023](../../.decisions/0023-buck-fetched-rust-crates.md) and
[decision 0024](../../.decisions/0024-rust-workspace-before-product-proof.md).
Rust admission converges through the same provider and platform contracts;
complete-lock Nix vendoring remains the transitional packaging boundary until
products cross the bridge (BUILD.BUCK-R10, roadmap Phase 5).

`cargo_build_script` writes a launcher whose shebang is the projected
`rust-shell` executable (BUILD.BUCK.PLAT-R02). That capability exposes the native
`pkgs.bash` binary directly, not a `writeShellScriptBin` wrapper: macOS cannot
execute a script when its shebang interpreter is another script. Other Rust
tool wrappers remain separate, including the Linux linker environment.

The Rust toolchain has two configured profiles. Normal `buck2 build`, `test`,
and `check` use the dev profile (`-Copt-level=0`); the Nix native-product
recipe passes `--config rust_profile.mode=release`. A Buck `config_setting`
selects the toolchain flags, so the choice is part of configured analysis and
the action key rather than a per-crate edit. After source staging, the recipe
reads the owning workspace's `Cargo.toml` `[profile.release]` (including
derivation-backed consumer roots) and passes its opt-level, debug, LTO,
codegen-units, panic, strip, debug-assertions, and overflow-checks settings
as Buck config values. Unspecified values use Cargo release defaults
(3, 0, local thin LTO, 16, unwind, debuginfo strip, no, no); false or absent
`lto` leaves rustc's local thin LTO enabled, while `lto = "off"` disables it.
Absent `strip` follows Cargo (1.77 and later): `debuginfo` when debug is off,
`none` otherwise. The final link then also drops the DWARF of static native
libraries, which can name `/nix/store` source paths, for example from a
Zig-built archive.
The selected compile flags apply to
all crates in the product graph, including third-party crates and build
scripts; LTO applies only at the final binary link because Rust proc-macro
dylibs cannot use it. Package-specific Cargo profile overrides require a
package-aware rule projection; the current Cargo projector does not read
profiles, so the shared workspace profile is the supported boundary.

### Rust Interop Products

```text
Cargo cdylib + declared toolchain -> configured native/wasm library -> runtime-specific package
```

`buck2/rust/interop.bzl` owns Rust products for JavaScript runtimes. They use
the root Cargo workspace and the strict Reindeer graph; a Cargo library declares
`crate-type = ["cdylib", "rlib"]` and the Cargo projection emits the wrapper.

- `rust_wasm_bindgen_library` transitions its crate to the `//buck2/rust:wasm32`
  target constraint. The executor stays native: `//buck2/toolchains:rust`
  selects the attested wasm rustc, the C/C++ toolchain links with the attested
  `wasm-ld` (`LinkerType("wasm")`), and `rust/third-party/PACKAGE` selects the
  Reindeer `wasm32` platform. The fleet profile is `opt-level=s`, fat LTO and
  stripped symbols, with no forced codegen-unit count; `profile` overrides
  `opt_level`, `lto` and `strip`. The action runs the pinned `wasm-bindgen`
  (matching the crate pin) for `nodejs` and `web`, then `wasm-opt` with
  `WASM_OPT_FLAGS` (explicit features, never `--all-features`). The package
  uses conditional exports: `workerd` → precompiled `Module`, `node` → CJS
  glue, `bun` → inline bytes, and `browser`/`default` → emitted external wasm
  fetched and streamed through pinned bindgen glue. Explicit `./inline`,
  `./browser-worker`, `./workerd`, and corresponding `/load` entries separate
  embedded bytes, browser Worker asset delivery, and workerd precompiled Modules;
  `./url` accepts a consumer source. Fresh `./load` uses inline bytes on Node/Bun
  and external assets on browser/default. Only inline/workerd glue removes the
  unused default asset URL; the action fails on pinned glue-shape drift.
- `rust_napi_library` packages the native cdylib as `<name>.node` and rejects
  wasm or `panic=abort` toolchains. It builds only on the matching native
  executor; there are no cross builds.
- `rust_wasm_aggregator` takes an application manifest (group → cores) and
  generates one Rust crate and one wasm product per group in `buck-out`, plus a
  TS entry that re-exports the `eager` group and exposes every other group as a
  dynamic-import loader; nothing generated is committed. The output is a copied
  directory, so runtimes and bundlers resolve the groups from the entry's real
  path. Unknown, duplicate, or unassigned cores fail analysis.
- `rust_interop_smoke` loads a product or aggregator in the admitted Node or
  Bun (`runtime`), asserts that the runtime resolved its own export condition,
  and records a verdict artifact; `//:all` includes the fixture smokes under
  `rust/effect-rust-fixtures` for both runtimes.

## Compiled JavaScript Executables

`bun_compiled_product_executable` refines BUILD.BUCK.PLAT-R01, BUILD.BUCK.PLAT-R02, BUILD.BUCK.EXEC-R06,
BUILD.BUCK.EXEC-R07, and BUILD.BUCK.EXEC-R09. It takes one portable `cli` module-v2 artifact,
its module descriptor, a declared `ProductPlatformInfo`, and the projected Bun
toolchains. The build action runs the pinned Nix Bun bundler with
`bun build <module> --compile --target bun-<os>-<arch>
--compile-executable-path <official-release-bun>` on the **matching native
execution platform**. The module must have no external module imports; process
capabilities remain independently declared. The action outputs an executable
and a `ProductExecutableInfo` with the platform and provenance bound to the
bundler and release-runtime identities. `build_product` packages it using the
same descriptor and runtime inspectors as Rust/Go native products.

The compile runtime is the official, hash-pinned Bun release (the same version
as the Nix bundler), copied verbatim into a Nix capability. Compiling against
patched `pkgs.bun` instead embeds its `/nix/store` ELF interpreter in the
product and fails the store-reference scan. The admitted tuples are Linux
x86_64 and aarch64 under `elf-dynamic/v1`, plus Darwin aarch64 under
`mach-o-dynamic/v1`. Neither Buck nor Nix strips or patches Mach-O output:
Bun's embedded ad-hoc signature is part of the executable and macOS refuses
the altered bytes.

## Action Lifecycle

```text
ConfiguredOperation
  -> validate typed payload and declared providers
  -> execute tool without ambient discovery
  -> validate declared outputs or semantic verdict
  -> return typed provider + native Buck result
```

| Operation kind | Required provider data                                           |
| -------------- | ---------------------------------------------------------------- |
| Check or lint  | semantic verdict, tool identity, configured operation identity   |
| Test           | semantic verdict, structured test summary, declared test outputs |
| Compilation    | declared output roles and content identities                     |
| Product        | `BuildProduct` descriptor path and payload path                  |

## Cacheable Unit-Test Verdict Actions

```text
declared suite + closure + runner + policy -> cacheable Buck build action
                                          -> result.json + structured report
caller / test adapter -> cached passing result -> pass, without rerunning suite
```

Unit tests are result-producing build actions, not a reliance on uploads from
local `buck2 test` orchestration. Pinned Buck2 `be6971d4` never uploads local
test executions (`orchestrator.rs:1533–1538`); compile hits alone therefore
cannot prove verdict reuse. Axe record `ecwtsb` selects this mechanism;
[issue #1600](https://github.com/overengineeringstudio/effect-utils/issues/1600)
tracks the verdict action and adapter. ADR
[0026, Amendment 1](../../.decisions/0026-buck-owned-unit-tests.md) retains the
unit-test authority and unchanged-input reuse goals.

The action receives the suite's complete declared source/dependency closure,
exact runner, scrubbed environment and deterministic policy. Its declared result
artifact binds `schemaVersion: 1`, `verdict: "pass" | "fail"`, configured
operation identity and report path. The report is a declared output, not stdout.
The repository owns this exact, case-sensitive schema and verdict vocabulary;
unknown versions/verdicts or missing report/output fail closed. A valid failed
suite writes `verdict: "fail"` and exits nonzero. Ordinary nonzero actions are
never uploaded, so a red verdict always reruns rather than becoming a reusable
cached failure. A zero-exit action encoding failure was rejected: it would
publish a reusable red artifact and make transient failures sticky. Successful
actions alone are reusable; tool crashes, malformed outputs and infrastructure
failures also remain action failures.
A reader/test adapter fails the gate for a failed verdict without becoming a
second suite executor. It cannot turn a failed suite into a successful gate.
Flaky or host-dependent suites declare `cacheable: false` in their package's
`BUCK.genie.ts` test lane (`cacheable = False` in generated BUCK). They remain
ordinary uncached test executions, without a verdict build action, on the
non-cache-readable execution platform (BUILD.BUCK.EXEC-R07/R09;
BUILD.BUCK.REUSE-R02). Suites requiring undeclared host inputs remain with their
source-side devenv owner rather than entering the contained package-tree lane.

## Cache-Writable Lane Admission

```text
lane audit -> hermetic + deterministic -> policy-authorized writer -> publish
           -> host-dependent            -> no cache reads or writes
           -> flaky tests               -> uncached
```

Lane eligibility belongs here rather than the descriptor schema: it is a property
of action inputs and execution, independent of endpoint identity or writer role.
A cache-writable lane has an audited complete declared input closure, exact
Buck/Nix/tool capabilities, a scrubbed environment and deterministic declared
outputs/verdicts. It uses an actual sandbox where feasible; sandbox comments
or execution-placement flags are not evidence. Where sandboxing is infeasible,
the audit explicitly records enforcement and the absence of result-affecting
undeclared access. Host-dependent lanes neither read nor write; flaky tests are
uncached. Dirty source is permitted when every changed input participates in
the action identity. Native and portable lanes must prove platform-correct keys.

Any tailnet context may write eligible lanes with mitigations, not merely because
of network location. Consumer cache policy and the service own revocable per-host
credentials, authenticated key logs, AC instance mangling per repo, validation
and a purge runbook. Public PR write denial is server-enforced. This admission
contract does not operate the cache or create credentials (axe record `4pmebr`).

### Audited action inventory

Admission is the execution constraint `@rules//buck2/platforms:cache_hermetic`,
not `local_only` or an upload bit. The default native platform denies both
remote-cache reads and writes. Its paired hermetic platform enables only the
root-authorized cache policy; remote execution remains disabled. Macros add the
constraint only for their audited action set. Action rules use
`cache_guarded_rule`: its rule-definition-owned eligibility predicate defaults
to denial, and analysis compares Buck's resolved execution constraints with the
canonical label of a default-only admission attribute before registering actions.
Relative labels and cell aliases therefore cannot admit an unaudited rule or a
`cacheable = False` collection through raw `exec_compatible_with`.
Every admitted run starts the projected native GNU `env -i` before Bun, a shell or another interpreter; only
literal declared environment, `LC_ALL=C`, `TZ=UTC`, and Buck-owned
`BUCK_SCRATCH_PATH`/`TMPDIR` survive. The env executable and manifest are inputs.
The substituted multicall binary is selected with `--coreutils-prog=env`;
dispatch must not depend on a symlink basename erased by capability projection.
Admitted Bun launchers also use `--no-env-file`, `--no-install`, and an empty
declared `--config=<artifact>`: env clearing alone cannot stop dotenv discovery
or `bunfig.toml` preloads. Bun children receive the same flags with an empty
scratch config, so package-local startup hooks cannot bypass the runner contract.

| Action family                                                                                    | Admission and audited boundary                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependency extraction/store assembly and package-tree projections                                | Not admitted: the five cheap filesystem categories use `local-materialization-policy`, with remote-cache reads and writes disabled despite their declared inputs and scrubbed execution. See [the policy decision](../06-reuse-client/spec.md#local-materialization-policy-buildbuckreuse-r08r10).                                                                                                                                                             |
| Declared pnpm runtime closure                                                                    | Admitted: normalized declared read roots, exact runtime tools, no install-time network or ambient tool discovery.                                                                                                                                                                                                                                                                                                                                              |
| TypeScript check/emit                                                                            | Admitted only for Linux `linux-bwrap` over declared inputs and exact tool closure. Explicit Nix from-source mode is local-only and excluded as `nix-outer-sandboxed`; its derivation, not the action, owns containment. Darwin is local-only and excluded as `darwin-unsandboxed`. Caller cache constraints cannot override either exclusion.                                                                                                                  |
| Static formatter/linter, Nix-source and Devenv trace-source checks                               | Admitted: declared source set, configuration, projected native tool and runner; scrubbed outer launcher. Trace-source audit reads only the declared source view; Nix-source mode invokes attested nixfmt/deadnix over explicit files.                                                                                                                                                                                                                          |
| Weaver registry and version-pin checks                                                           | Admitted: declared registry/model and pin sources, attested Weaver/model locator, and scrubbed Bun launcher; registry copy/rewrite uses executor scratch and invokes only the pinned checker.                                                                                                                                                                                                                                                                  |
| JavaScript collection runner                                                                     | Admitted only for deterministic `cacheable` lanes: complete runner-relative module closure, declared package/read roots, config/selection/runtime and fingerprint tool. The runner constructs the child's env/PATH from declared tools and scratch, checks input immutability, and normalizes collected paths. A false-cacheable lane uses the default deny platform and disables uploads while retaining env scrubbing. Inherited-env collection is rejected. |
| Package command runner, portable bundle                                                          | Admitted bundle mode: runner plus declared parser closure, complete package/read-root map, platform-gated manifest and projected Bun. A label-named hardlink farm contains resolution, emitted module comments reject host paths, and the descriptor binds the bytes.                                                                                                                                                                                          |
| Package command runner, arbitrary check/build entrypoints                                        | Scrubbed before runner startup but **not admitted**: an arbitrary script may read undeclared files, network or host state despite receiving only literal child env and passing input-immutability checks. Launch/exec mode remains interactive and uncached.                                                                                                                                                                                                   |
| External test orchestration, native compilation, repository validation and remaining run actions | No blanket admission. The default deny platform prevents shared reads/writes until the family's complete action closure is audited. Deterministic verdict actions have their own declared admission; flaky/host-dependent suites remain uncached.                                                                                                                                                                                                              |

The prerequisite categories `pnpm_extract`, `pnpm_store_entry`,
`pnpm_store_scc`, `pnpm_store_view`, and `package_tree` use the default
nonremote platform under `local-materialization-policy`; default Linux `tsgo_emit`
retains the cache-admitted TypeScript platform, while declared Nix outer mode and Darwin check/emit use
the nonremote platform under `nix-outer-sandboxed` and `darwin-unsandboxed`, respectively. Each macro owns its own
admission: a verdict hit does not admit its ancestors. This classification
does not admit native compilation or executable build scripts.

Repository `workspace-contract` and `genie-import-closure` modes are not
promoted with the source-only checks: the former executes Cargo/Nix through a
shell script and the latter invokes a product-backed checker/server. Auditing
their complete subprocess/configuration boundaries is distinct from the
source-only modes. Product executable/support staging remains unadmitted where
the target also owns native compilation; a copy action alone cannot admit its
target's other actions. Rust build scripts remain host-dependent and denied.

Hash-and-size-validated pnpm archive acquisition is admitted separately from
offline extraction. The network source is an explicit CAS/registry acquisition
capability; a successful output must match both declared digest and byte size
before atomic publication. Nix-backed acquisition reads the explicit immutable
store root and verifies the same output identity. Complete acquisition/import
sources and projected Bun participate in the action key; launchers clear env,
dotenv/preloads and implicit installation. Endpoint availability can fail an
acquisition but cannot alter a successful output's pinned bytes.

Linux TS check/emit and package-tree projections provide the OS boundary
defined above. The remaining local runners do not provide a general OS
filesystem/network sandbox. GNU env scrubbing is startup enforcement,
declared-input hashing detects mutation, and the bundle farm prevents resolver
escape; none alone is a general undeclared-read sandbox. Auditing a runner does
not certify every arbitrary program it launches. Host/network-dependent tests
are not promoted merely because they use the same runner.

## Open Design Questions

- **BUILD.BUCK.EXEC-DQ02 Remaining filesystem/network sandbox enforcement:**
  Linux TS containment is defined above; other action families still need
  feasible OS-level enforcement where declared-closure controls do not prevent
  undeclared reads. Darwin TS admission remains unsupported under the named
  `darwin-unsandboxed` exclusion. Unlisted and host-dependent actions remain
  default-deny.
