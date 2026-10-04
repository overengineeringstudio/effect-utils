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
caller / test adapter -> cached result -> pass or fail, without rerunning suite
```

Unit tests are result-producing build actions, not a reliance on uploads from
local `buck2 test` orchestration. Pinned Buck2 `be6971d4` never uploads local
test executions (`orchestrator.rs:1533–1538`); compile hits alone therefore
cannot prove verdict reuse. Axe record `ecwtsb` selects this mechanism;
[issue #1600](https://github.com/overengineeringstudio/effect-utils/issues/1600)
tracks implementation and its blocked proof. ADR
[0026, Amendment 1](../../.decisions/0026-buck-owned-unit-tests.md) retains the
unit-test authority and unchanged-input reuse goals.

The action receives the suite's complete declared source/dependency closure,
exact runner, scrubbed environment and deterministic policy. Its declared result
artifact binds `schemaVersion: 1`, `verdict: "pass" | "fail"`, configured
operation identity and report path. The report is a declared output, not stdout.
The repository owns this exact, case-sensitive schema and verdict vocabulary;
unknown versions/verdicts or missing report/output fail closed. A valid failed
suite emits `verdict: "fail"` while the artifact-producing action succeeds, so
its deterministic failure is reusable. Tool crashes, malformed outputs and
infrastructure failures remain action failures and are not converted to verdicts.
A reader/test adapter fails the gate for a failed verdict without becoming a
second suite executor. It cannot turn a failed suite into a successful gate.
Flaky or nonhermetic suites are explicitly uncached, not admitted as deterministic
verdict reuse (BUILD.BUCK.EXEC-R07/R09; BUILD.BUCK.REUSE-R02).

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

## Open Design Questions

- **BUILD.BUCK.EXEC-DQ01 Verdict artifact implementation:** Blocked by
  [#1600](https://github.com/overengineeringstudio/effect-utils/issues/1600).
  Resolve with the runner/result schema, failed-verdict gate propagation, and
  independent same-platform warm-context proof of both pass and fail reuse, plus
  relevant/irrelevant mutation and crash/flaky controls. The mechanism is selected;
  implementation and its proof are not claimed complete.
- **BUILD.BUCK.EXEC-DQ02 Hermetic lane enforcement:** Blocked on audited lane
  inventory, scrubbed-env implementation and feasible sandbox enforcement. Resolve
  with undeclared-env/file controls under identical keys and platform/toolchain
  changes proving key separation; cache writes remain conditional on admission.
