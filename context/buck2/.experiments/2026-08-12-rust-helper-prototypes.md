# Rust Helper Replacement Prototypes

Status: completed; both candidates rejected for current adoption

## Question

Can current repository Python helper behavior move to Rust now while reducing
latency and total system complexity?

## Compared Candidates

| Candidate                   | Result                 | Useful evidence                                                                             | Blocking evidence                                                                                                        |
| --------------------------- | ---------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Hybrid stage0 Rust packager | Feasible, not admitted | Byte-identical package evidence; 30.716 ms versus 44.149 ms Python sample                   | Added about 89 source lines, duplicated verifier and raw local Nix-path mechanics, local-only, no remote proof, x86-only |
| All-Rust helper set         | Rejected               | Separate binaries showed roughly 1.4 ms tiny-process execution versus 61.7 ms Python sample | Second Cargo/lock authority coupled to the otel vendor graph; parity, security, tests, and integration incomplete        |

The timing samples establish prototype direction only. They are not a full
cross-engine benchmark verdict because compilation amortization, closure bytes,
platform coverage, and equivalent end-to-end work were incomplete.

## Conclusion

Rust remains the preferred convergence direction for repository-owned action
executors, but only after the semantic graph, canonical tool identities, and
per-platform bootstrap boundary exist. The accepted shape is separate leaf
binaries unless fanout and transfer measurements justify sharing. The next
prototype must include golden bytes, modes, failures, adversarial archives,
ambient-runtime absence, exact action invalidation, Linux and Darwin proof, and
net abstraction deletion.
