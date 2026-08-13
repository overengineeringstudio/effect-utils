# Rust Helper Replacement Prototypes

Status: completed; both candidates rejected for current adoption

## Question

Can current repository Python helper behavior move to Rust now while reducing
latency and total system complexity?

## Method

Disposable prototypes compared a hybrid stage0 Rust packager with an all-Rust
helper set. They checked selected output-byte parity and sampled execution
latency, then assessed added source, authority duplication, platform evidence,
and missing security and integration coverage. The exact fixtures and commands
are not retained here, so the timing data is directional rather than a
reproducible benchmark.

### Compared Candidates

| Candidate                   | Result                 | Useful evidence                                                                             | Blocking evidence                                                                                                        |
| --------------------------- | ---------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Hybrid stage0 Rust packager | Feasible, not admitted | Byte-identical package evidence; 30.716 ms versus 44.149 ms Python sample                   | Added about 89 source lines, duplicated verifier and raw local Nix-path mechanics, local-only, no remote proof, x86-only |
| All-Rust helper set         | Rejected               | Separate binaries showed roughly 1.4 ms tiny-process execution versus 61.7 ms Python sample | Second Cargo/lock authority coupled to the otel vendor graph; parity, security, tests, and integration incomplete        |

The timing samples establish prototype direction only. They are not a full
cross-engine benchmark verdict because compilation amortization, closure bytes,
platform coverage, and equivalent end-to-end work were incomplete.

## Result

The hybrid candidate demonstrated byte parity for its sampled package path but
added a second implementation of verification and local Nix-path behavior. The
all-Rust candidate reduced sampled tiny-process latency but introduced another
Cargo/lock authority coupled to the otel vendor graph. Neither candidate had
enough parity, platform, security, or end-to-end evidence for adoption.

## Conclusion

Rust remains the preferred convergence direction for repository-owned action
executors, but only after the semantic graph, canonical tool identities, and
per-platform bootstrap boundary exist. The accepted shape is separate leaf
binaries unless fanout and transfer measurements justify sharing. The next
prototype must include golden bytes, modes, failures, adversarial archives,
ambient-runtime absence, exact action invalidation, Linux and Darwin proof, and
net abstraction deletion.

## Historical VRS Impact

This experiment did not admit either helper replacement. It established the
parity, security, platform, invalidation, and abstraction-deletion gates for a
new candidate. The shared-workspace candidate later satisfied those gates and
was admitted by
[decision 0010](../.decisions/0010-admit-rust-stage-zero-support-tools.md);
that decision supersedes this experiment's then-current rejection without
rewriting the historical result.
