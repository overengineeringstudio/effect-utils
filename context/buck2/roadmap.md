# Buck2 Repository Build Roadmap

This file is non-normative. The [VRS](./vision.md) defines the intended system;
GitHub issues own executable work, dependencies, exact revisions, and status.

The current dependency shape is:

```text
VRS and semantic graph foundation
  -> dependency and platform authority
  -> TypeScript and Rust target execution
  -> artifact/system bridge
  -> evidence and deterministic admission
  -> authority transfer and immediate legacy deletion per slice
  -> reusable contract proof in a second megarepo
  -> linked dotfiles and remaining-repository adoption
```

The comprehensive refactor epic must reuse existing capability issues, express
real execution boundaries through GitHub parent/sub-issue and dependency
relationships, and keep a topological deletion plan for the current rollout.
That plan is execution status, not a second normative graph. The epic must not
duplicate the VRS as a speculative issue tree.

Unresolved VRS design questions block only the slices whose implementation they
change. Research, prototypes, benchmark results, and rejected paths belong
under [`.experiments/`](./.experiments/) and are linked from the relevant issue.
