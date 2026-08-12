# Buck2 Repository Build Open Questions

- [BUCK-DQ1](./spec.md#open-design-questions): where the shared contract and
  conformance tools are published after a second repository proves the
  extraction boundary.
- **BUCK-DQ2 Rust dependency use boundary:** how authored Cargo requests expose
  canonical operation-local references, and which current per-target
  conservative Cargo scopes should be replaced after Cargo/Reindeer parity and
  invalidation tests.

Subsystem specs own other questions local to their mechanisms. Resolved
questions leave this index and become normative spec text plus a decision
record when their tradeoff warrants one.
