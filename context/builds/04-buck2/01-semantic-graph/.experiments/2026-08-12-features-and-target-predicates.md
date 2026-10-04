# Cargo Features and Target Predicates

## Status

Passed for semantic preservation on 2026-08-12. Default-feature policy and the
initial supported `cfg` vocabulary remain unresolved.

## Question

The binding must preserve authored feature expressions and platform predicates;
Cargo's resolved metadata graph alone cannot recover exact operation intent.

## Method

A disposable locked Cargo fixture varied optional dependencies, `dep:name`,
strong `name/feature` forwarding, weak `name?/feature` forwarding,
`required-features`, dependency kinds, and target-specific dependency tables.
Authored expressions were compared with `cargo metadata --format-version 1`
under enabled and disabled feature sets. The cases follow Cargo's
[feature](https://doc.rust-lang.org/cargo/reference/features.html) and
[platform-specific dependency](https://doc.rust-lang.org/cargo/reference/specifying-dependencies.html#platform-specific-dependencies)
contracts.

## Result

| Semantic fact                       | Result                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| Optional dependency and `dep:` edge | Preserved as authored feature relations                                                 |
| Strong versus weak forwarding       | Semantically distinct; weak forwarding does not activate an absent optional dependency  |
| `required-features`                 | Gates target admission; does not itself activate the features                           |
| Normal/dev predicate                | Evaluated for the target platform                                                       |
| Build-dependency predicate          | Evaluated for the host platform                                                         |
| Resolved metadata as exact source   | Failed: a weak-forwarding case over-selected when reconstructed from the resolved union |

## Conclusion

The pure contribution retains typed feature expressions, dependency kind,
target predicate, and target `required-features`. Predicate parsing fails
closed. Cargo metadata remains a locked parity oracle, not the semantic source.
The default-feature selection policy and the admitted `cfg` subset require user
decisions.

## VRS Impact

Resolves the mechanical parts of `BUCK.GRAPH.BIND.RUST-DQ3` and
`BUCK.GRAPH.BIND.RUST-DQ4`; retains their policy questions.
