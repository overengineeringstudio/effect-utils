# Shared-Workspace Rust Foundation Contraction

Status: completed; repository-owned stage-zero support tools admitted

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

## Method

### Candidate Boundary

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

### Required Evidence

| Gate             | Required control                                                                                  | Current result                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Golden behavior  | Byte-identical valid outputs and equivalent modes                                                 | Portable staging and fixture outputs matched the Python implementation in disposable controls                                                                            |
| Failure parity   | Existing malformed-input corpus and exit partition                                                | 26 Rust unit and adversarial tests pass; stable structured error codes replace traceback-shaped failures                                                                 |
| Archive security | Traversal, link, duplicate, sparse, size, padding, and trailing-byte adversaries                  | Passed by the portable-toolchain adversarial corpus and strict bridge contract controls                                                                                  |
| Runtime absence  | Buck actions run with no ambient `python` and make no CPython fetch                               | Passed with hostile `PATH`; foundation graph census reports zero owned Python and zero CPython edges                                                                     |
| Invalidation     | Relevant helper changes affect only its consumers; irrelevant changes run zero production actions | Disposable-project RED/GREEN/restore proof passed with one relevant action and zero restored-state actions                                                               |
| Bootstrap        | Stage-0 realization does not consume the Buck artifact it verifies                                | Passed: Nix independently realizes four leaf tools and Buck consumes immutable store executables                                                                         |
| Platforms        | Linux and Darwin target/execution tuples pass independently                                       | Four stage-0 tools and the bridge pass on previously verified x86_64 Linux and natively on aarch64 Linux and Darwin; the fixture pins every admitted descriptor identity |
| Performance      | Comparable cold/warm latency, closure bytes, and action/materialization counts                    | Rust actions measured 38-41x faster; runtime footprint measured about 180x smaller                                                                                       |
| Contraction      | Python sources, tests, targets, archive bootstrap, and duplicate adapters are deleted             | Passed: six Python files, their tests/targets, live CPython archive, and empty legacy package are removed                                                                |

The invalidation harness must mutate a disposable repository/cell rather than a
shared tracked source. RED and GREEN controls use the same target and
observation queries.

## Result

The measured gates and net contraction admit the four repository-owned Rust
stage-zero tools through
[decision 0010](../.decisions/0010-admit-rust-stage-zero-support-tools.md).
This admission does not generalize to Prelude Python actions: decision 0009
continues to require an immutable, digest-pinned CPython closure for any such
action until its consumer is removed.

### Measurements

The disposable prototype measured invalid-input validation at 52.6 ms for
Python and 1.29 ms for Rust, valid staging at 59.2 ms and 1.55 ms, and fixture
generation at 54.4 ms and 1.37 ms. The runtime footprint contracted from about
110 MB of extracted CPython to a 611 KB binary. A cold Rust dependency build
took 5.79 seconds and a warm no-op took 82 ms.

Native, local-only Nix realization of all four stage-0 tools passed on
`aarch64-linux` in 77.5 seconds and `aarch64-darwin` in 56.3 seconds. Those cold
builds also exposed the next measured contraction: the root lock is the correct
semantic dependency authority, but its full vendor graph pulled 65 build
derivations plus 240 fetched paths on Linux and 43 plus 65 on Darwin. A future
generated stage-0 closure projection may reduce those operational inputs; it
must remain derived from the root manifests and lock and must not become a
second authored dependency authority.

The full devenv task entrypoint also realizes unrelated TypeScript, UI, Go, and
product-Rust tooling before a narrow Buck foundation check on a cold host. A
minimal foundation app or task closure is therefore a measured follow-up. The
remaining product admission gate is native execution of real TypeScript and
Rust products across explicitly generated platform tuples, not stage-0
feasibility.

## Conclusion

All nine gates passed: the four repository-owned Rust stage-zero tools are
admitted, the Python foundation (sources, tests, targets, CPython archive) is
deleted, and behavior, security, invalidation, bootstrap, and platform parity
are preserved with 38-41x faster actions and a ~180x smaller runtime
footprint. Measured follow-ups: a derived stage-0 closure projection to shrink
cold vendor realization, and a minimal foundation task closure.

## VRS Impact

Grounds [decision 0010](../.decisions/0010-admit-rust-stage-zero-support-tools.md)
and the stage-zero contract in [02-execution](../02-execution/requirements.md)
(EXEC-T01): bootstrap providers are exact, finite, and retired when the graph
reproduces them.
