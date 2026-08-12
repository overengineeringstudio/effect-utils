# Buck2 Repository Build Roadmap

This file is non-normative. The [VRS](./vision.md) defines the intended system;
GitHub issues own executable work, dependencies, exact revisions, and status.

The current dependency shape preserves sibling foundations and makes product
composition explicit:

```text
shared base
  +-- semantic graph and language bindings --------+
  +-- dependency authority ------------------------+
  +-- execution-platform and bootstrap authority --+--> product integration join
  +-- strict product/artifact contract ------------+          |
                                                               v
                                            TypeScript or Rust target execution
                                                               |
                                                               v
                                 OCI publication + reviewed Nix exact-child pin
                                                               |
                                                               v
                                  import, offline activation, rollback, health
                                                               |
                                                               v
                                deterministic admission + immediate contraction
                                                               |
                                                               v
                             second-repository and system-consumer conformance
```

Prelude's CPython live-origin closure is contracted as an admitted stage-0
execution-platform input rather than hidden ambient state. Production OCI
publication is not complete until two independent storage reads, a third
failure-domain archive restore, and network-disabled activation and rollback
have evidence. Registry deployment details remain in the private system
repository; this public roadmap owns only the generic contract.

The comprehensive refactor epic must reuse existing capability issues, express
real execution boundaries through GitHub parent/sub-issue and dependency
relationships, and keep a topological deletion plan for the current rollout.
That plan is execution status, not a second normative graph. The epic must not
duplicate the VRS as a speculative issue tree.

Unresolved VRS design questions block only the slices whose implementation they
change. Research, prototypes, benchmark results, and rejected paths belong
under [`.experiments/`](./.experiments/) and are linked from the relevant issue.
