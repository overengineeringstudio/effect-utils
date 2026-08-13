# Buck2 Repository Build Intuition

_For: repository maintainers and build-system authors - Assumes: Buck2 and Nix
fundamentals - Covers: why the system has two directional authorities and one
semantic graph_

The central idea is not "replace Nix with Buck." It is to stop asking one
system boundary to do two incompatible jobs.

Buck is good at representing many small computations and reusing them when
their declared inputs are equal. Nix is good at pinning system tools, composing
runtime closures, and moving machines between reversible configurations. The
fast and principled design lets each system own the work matching its model.

```text
package intent -> fine-grained Buck work -> normalized immutable artifact
                                                      |
                                                      v
Nix tool recipes ------------------------------> verified system realization
```

The bridge passes immutable data and expectations. It does not create a
meta-build loop in which Buck invokes Nix and Nix invokes Buck.

Genie is the authoring adapter. Package authors declare projects, tests,
artifacts, and capabilities once. Genie normalizes that intent and writes thin,
stable package-local Buck projections. Buck rules decide how semantic
operations become actions. A Rust executor can replace a Python executor
without changing the package model or target label.

Fine-grained does not mean one target per line of source. Boundaries follow
semantic ownership: a project check, emitted project, test suite, library,
binary, build script, normalizer, or artifact packager. Measurements can justify
further splitting. This produces useful cache precision without turning graph
maintenance into the dominant cost.

The migration is a contraction program. A shadow path exists only long enough
to prove the new authority at the real seam. Once the proof is complete, the
old producer is deleted; rollback uses a prior immutable artifact or a Git
revert, not a permanent second build universe.
