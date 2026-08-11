# Buck2 Evidence

This VRS node defines how effect-utils moves repository-local build work to
Buck2 without moving system authority out of Nix, Home Manager, NixOS, or
nix-darwin.

The design favors fine-grained generated package boundaries, exact dependency
closures, and explainable cache behavior. Nix pins and exports tools; Buck owns
admitted repo-local actions; Buck artifacts cross into Nix through a verified
immutable descriptor; devenv remains the setup, lifecycle, and compatibility
surface.

## Current Status

The local evidence foundation is implemented. It includes:

- a pnpm lockfile-v9 compiler with separate package-content, peer-context, and
  task-closure identities, gated on verified normalized package payloads;
- strict Buck closure rules and a synthetic local-only foundation target;
- a thin launcher retaining Buck reports/logs and emitting sanitized receipts;
- Nix helpers for relocatable tool export and digest/platform-verified artifact
  import;
- a synthetic portable-toolchain provider/verifier fixture;
- Genie-generated package-local `BUCK` and a conservative `tui-core` dependency
  input plan; and
- a benchmark harness that separates end-user latency from compute-only action
  time and records invalidation evidence.

The `tui-core` E2E packages its declared source/configuration census and
non-authoritative dependency input plan, retains Buck's raw evidence and
receipt, verifies and imports the artifact through Nix, and executes it with an
empty `PATH`. It does not materialize normalized dependency payloads, compile
TypeScript, or mint authoritative closure IDs.

The first repo-local compilation pilot is `//packages/@overeng/megarepo:mr`.
Buck owns a generated project-reference typecheck and a separate Bun
compile/package action. Genie derives the latter's exact first-party runtime
source closure from a flake-pinned Bun metafile, emits its analyzer identity and
semantic-input fingerprint in every affected generated shard, and rejects
unclassified first-party inputs. Tests, stories, and unreachable production
modules remain outside the bundle action. Nix supplies pinned local
tools and one immutable target-specific pnpm dependency tree; this is still a
coarser external boundary than the final package-content/context/task closure.
The action embeds build identity, removes Nix-specific ELF paths, emits a
deterministic tar plus declared-input provenance, and the E2E imports and
executes that exact artifact through the normal Nix bridge. This pilot is a
real shadow build artifact, not yet production release authority, and remains
local-only: raw Nix store inputs are not a portable execution image.

The package-evidence rule and portable verifier currently use the bundled
Prelude Python demo toolchain as a local bootstrap. The portable-provider
fixture proves the provider shape, not a real Nix-exported production
toolchain. The `mr` action instead executes its declared builder source with an
immutable Nix Python path, avoiding isolation-specific Buck Python wrappers.
The launcher has a registered OTEL contract but does not export OTLP
at runtime; current runtime observability is the receipt plus retained Buck
event logs and build reports.

Local source correctness currently requires Buck's Watchman backend with
root/nested `node_modules` and Cargo `target` trees ignored. Oxlint's injected
root config is persisted and atomically replaced to avoid crawler read races.
The default Linux notify watcher was falsified by
pnpm directory-symlink aliases; a declared source change could be observed only
through an ignored alias and leave DICE stale. The hash crawler was also
rejected because concurrent deletion can fail its whole-tree initialization
scan. The generated `tui-core` evidence target is explicitly
`x86_64-linux`; mismatched local analysis fails closed, while configured remote
execution-platform binding remains deferred. The `mr` rules apply the same
fail-closed local host/platform comparison before analysis.

This is not yet production dependency-materialization authority. Remote cache
reads, remote cache writes, and remote execution remain disabled. The current
Nix/devenv path stays authoritative until normalized-payload materialization,
target-specific parity, portable toolchains, hermeticity, trust,
artifact-import, activation, and rollback gates pass.

## Documents

| Document                             | Role                                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| [requirements.md](./requirements.md) | Stable required behavior and safety constraints.                                         |
| [spec.md](./spec.md)                 | Normative architecture, interfaces, evidence semantics, benchmarks, and admission gates. |
| [roadmap.md](./roadmap.md)           | Ordered adoption and refinement direction.                                               |
| [`.decisions/`](./.decisions/)       | The six accepted design choices and their tradeoffs.                                     |
| [`.experiments/`](./.experiments/)   | Measured and adversarial evidence supporting or limiting the choices.                    |

## Accepted Design

| Decision                   | Selected direction                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Buck/Nix artifact boundary | Buck builds normalized repo artifacts; Nix verifies and imports them.                                        |
| Hot-path launcher          | Reusable implementation starts in effect-utils; downstream repositories own their aliases and system policy. |
| Dependency identity        | Shared immutable package bytes plus exact target-local closure manifests.                                    |
| Initial granularity        | Role-aware schema immediately; conservative first shadow closure, then benchmark-led refinement.             |
| Graph layout               | Deterministic checked-in package-local shards generated by Genie; shared rules remain hand-authored.         |
| Toolchains                 | Nix exports relocatable archives or execution images; Buck consumes their immutable identities.              |

## Local Foundation Checks

```sh
devenv tasks run buck2:check
```

The aggregate covers the synthetic Buck closure build and tests, the `mr`
compile/invalidation/Nix-import proof, Nix bridge negative controls, the
`tui-core` input-plan E2E, and benchmark harness checks.
Individual tasks are listed in [spec.md](./spec.md#devenv-integration).

Passing the foundation suite does not admit remote caching, remote execution,
or a production package migration. Those transitions are deliberately separate
and require the rollout gates in [spec.md](./spec.md#rollout-and-admission).
