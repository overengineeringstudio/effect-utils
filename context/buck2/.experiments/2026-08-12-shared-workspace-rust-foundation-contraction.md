# Shared-Workspace Rust Foundation Contraction

Status: in progress; no admission verdict

## Question

Does moving the repository-owned Buck support tools from Python to
fine-grained Rust binaries in the existing root Cargo workspace reduce total
foundation complexity while preserving exact behavior, cache boundaries, and
supported platforms?

## Why the Candidate Is Reopened

The earlier
[Rust helper prototypes](./2026-08-12-rust-helper-prototypes.md) established
directional startup gains but rejected adoption. The all-Rust candidate created
a second Cargo/lock authority and lacked parity, security, invalidation, and
platform evidence. The repository now has one root workspace and lock shared by
its Rust packages, so a support-tool member can reuse that authority instead of
creating another one.

Removing one blocker is not a verdict. This experiment preserves the earlier
record and evaluates the new architecture as a separate delta.

## Candidate Boundary

```text
TypeScript + Genie     semantic authoring and deterministic projection
Starlark               Buck graph and action declarations
Rust leaf binaries     repository-owned action support tools
Nix                    stage-0 realization and system composition
Prelude CPython        temporary on-demand input only while Python actions remain
```

The Rust tools share schema and validation code only where semantics are
identical. Closure staging, package evidence, and portable-toolchain staging
remain separate binaries and exec dependencies so changing one does not
invalidate unrelated actions. A shared multi-command binary is admitted only
if measured closure/transfer savings exceed that coarser invalidation cost.

## Required Evidence

| Gate             | Required control                                                                                  | Current result |
| ---------------- | ------------------------------------------------------------------------------------------------- | -------------- |
| Golden behavior  | Byte-identical valid outputs and equivalent modes                                                 | Pending        |
| Failure parity   | Existing malformed-input corpus and exit partition                                                | Pending        |
| Archive security | Traversal, link, duplicate, sparse, size, padding, and trailing-byte adversaries                  | Pending        |
| Runtime absence  | Buck actions run with no ambient `python` and make no CPython fetch                               | Pending        |
| Invalidation     | Relevant helper changes affect only its consumers; irrelevant changes run zero production actions | Pending        |
| Bootstrap        | Stage-0 realization does not consume the Buck artifact it verifies                                | Pending        |
| Platforms        | Linux and Darwin target/execution tuples pass independently                                       | Pending        |
| Performance      | Comparable cold/warm latency, closure bytes, and action/materialization counts                    | Pending        |
| Contraction      | Python sources, tests, targets, archive bootstrap, and duplicate adapters are deleted             | Pending        |

The invalidation harness must mutate a disposable repository/cell rather than a
shared tracked source. RED and GREEN controls use the same target and
observation queries.

## Admission Rule

Do not add decision 0010 or call the migration complete until the table has
measured results and the net abstraction count contracts. A Linux-only pass may
admit only that execution-platform tuple. Until the last Python action is
removed, decision 0009 still requires the on-demand Prelude CPython closure to
be immutable and digest-pinned; it is not a Starlark rule-loading dependency.

## Pending Measurements

Record exact revisions, commands, fixtures, per-platform results, before/after
source and target counts, binary closure sizes, and benchmark distributions
here. Directional timings from the predecessor experiment are context, not
current evidence.
