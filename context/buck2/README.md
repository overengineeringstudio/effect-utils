# Buck2 Repository Build System

This directory is the canonical VRS for Buck2-owned repository-local builds and
their Nix-managed system boundary.

- [vision.md](./vision.md) defines why the system exists.
- [requirements.md](./requirements.md) defines its stable constraints.
- [spec.md](./spec.md) defines the global authority model.
- Numbered subsystem directories refine the contract in reading order and in
  dependency order where a dependency exists; independent foundations remain
  siblings and meet at explicit product integration joins.
- Semantic authoring bindings translate ecosystem-owned facts before the Buck
  projection; target execution consumes the resulting graph and closures.
- [roadmap.md](./roadmap.md) is the non-normative execution bridge to GitHub.

Dependency materialization remains a sibling upstream contract at
[`context/dependency-materialization`](../dependency-materialization/). Its
former Buck evidence node is retained as a narrow dependency-closure
refinement and historical evidence index; it no longer owns the general build
architecture.
