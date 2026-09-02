# Workspace, Target, and Profile Boundary

## Status

Passed for authority placement with Cargo 1.95 fixtures on 2026-08-12. Buck
execution-profile equivalence remains untested.

## Question

Effective package and target facts require more than the member manifest, while
Cargo profiles are execution policy rather than dependency-root identity.

## Method

Disposable root/member workspaces varied inherited package and dependency
fields, renamed workspace dependencies, explicit targets, convention-discovered
targets, and root/member profile tables. Each mutation was observed with:

```bash
cargo metadata --format-version 1 --no-deps --manifest-path <member>/Cargo.toml
```

The target control added `tests/second.rs` without editing either manifest.
The profile control changed `[profile.dev]` at the workspace root. Results were
checked against Cargo's [workspace](https://doc.rust-lang.org/cargo/reference/workspaces.html)
and [target auto-discovery](https://doc.rust-lang.org/cargo/reference/cargo-targets.html#target-auto-discovery)
contracts.

## Result

| Probe                        | Result                                                               |
| ---------------------------- | -------------------------------------------------------------------- |
| Member-only TOML observation | Failed to reproduce inherited effective package and dependency facts |
| Root plus member observation | Preserved inheritance and the member alias                           |
| Add `tests/second.rs` only   | Changed Cargo's target inventory                                     |
| Change root profile only     | Did not appear in metadata's package/dependency/target records       |
| Profile in member manifest   | Cargo ignored it; profiles are workspace-root policy                 |

## Conclusion

The binding input includes the workspace root manifest, member manifest, and
Cargo convention-discovery file set. It retains inheritance provenance.
Profiles do not enter dependency-root IR. Whether Buck emulates arbitrary Cargo
profiles or exposes a canonical profile set remains an execution-policy
decision.

## VRS Impact

Resolves the factual portions of `BUCK.GRAPH.BIND.RUST-DQ1` and
`BUCK.GRAPH.BIND.RUST-DQ2`; preserves execution-profile policy as a DQ.
