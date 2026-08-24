# Buck2 Open Questions

Tracked questions that no subsystem spec currently owns or that were left
dangling by experiment records. Each entry names its source.

## Reserved: `BUCK.EXEC-R09` through `BUCK.EXEC-R17`

- Source: `03-target-execution/requirements.md` defines only
  `BUCK.EXEC-R01`–`R08`, while
  `03-target-execution/01-typescript/requirements.md` and
  `03-target-execution/02-rust/requirements.md` declare inheritance
  "`R01` through `R17`" and attach `Refines:` lines pointing at `R09`–`R17`.
- Decision for now: these identifiers are **reserved with intent**, not
  defined. The downstream `Refines:` lines carry usable local semantics, but
  they do not determine a single parent requirement text each; writing nine
  parent requirements by reverse-engineering child usage would fabricate
  normative intent that no decision record supports. Formalizing them belongs
  to the target-execution spec owner.
- Observed intent, derived strictly from existing refinement usage (not
  decided semantics):
  - `R09` — structured diagnostics validated under repository policy;
    emitting a report must not mask failure (`EXEC.TS-R09`, `EXEC.RUST-R12`).
  - `R10` — truthful test/doc-test inventory and verdict reporting through
    Buck (`EXEC.TS-R10`, `EXEC.RUST-R02`, `EXEC.RUST-R11`, `EXEC.RUST-R14`).
  - `R11` — compilers, linkers, formatters, bundlers, and related toolchain
    pieces declared as compatible tool-provider inputs (`EXEC.TS-R06`,
    `EXEC.RUST-R09`, `EXEC.RUST-R10`, `EXEC.RUST-R13`).
  - `R12`, `R13` — support-tool provider relationship (stage0 versus promoted
    provider); refined only by `EXEC.RUST-R16`, whose text says the parent
    contract defines this relationship — that parent text does not exist yet.
  - `R14` — selection of native packages, runtime assets, proc macros, and
    toolchain components per target versus execution platform
    (`EXEC.TS-R05`, `EXEC.RUST-R09`, `EXEC.RUST-R10`).
  - `R15` — staging/freshness equivalence independent of checkout location,
    mtime, or environment staleness, failing closed (`EXEC.TS-R07`,
    `EXEC.RUST-R06`, `EXEC.RUST-R08`).
  - `R17` — terminal build authority convergence for admitted executables and
    packages (`EXEC.TS-R03`, `EXEC.TS-R11`, `EXEC.RUST-R15`).
  - `R16` — referenced by nothing except the blanket "`R01` through `R17`"
    inheritance claims; fully unconstrained.

## `BUCK.GRAPH.BIND.RUST-DQ2`: Supported Cargo `cfg` breadth

- Status: open, as recorded in
  `01-semantic-graph/01-authoring-bindings/02-rust-cargo/spec.md`.
- Question: which initial Cargo predicate grammar is worth supporting beyond
  the current repository corpus?
- Resolution signal: Linux and Darwin fixtures for the proposed subset; all
  other syntax continues to fail closed.
- Note: the factual portions were resolved by
  `.experiments/2026-08-12-workspace-target-profile-boundary.md` in the
  rust-cargo subtree; the grammar-scope policy remains open.

## `BUCK.GRAPH.BIND.RUST-DQ3`: Execution-profile policy

- Status: open, as recorded in
  `01-semantic-graph/01-authoring-bindings/02-rust-cargo/spec.md`.
- Question: does Rust target execution expose only canonical Buck profiles or
  promise equivalence with arbitrary Cargo profiles?
- Owned by `03-target-execution/02-rust/spec.md`; must not change
  dependency-root identity. The mechanical portion was resolved by the
  features-and-target-predicates experiment; the policy question remains.

## `BUCK.GRAPH.BIND.RUST-DQ5`: Provider fidelity and cross-platform admission

- Source experiment: `01-semantic-graph/01-authoring-bindings/02-rust-cargo/.experiments/2026-08-12-build-and-reindeer-contexts.md`,
  which narrows this question to the outstanding provider-fidelity and
  cross-platform admission proof.
- Open remainder: strict unresolved-fixup admission, explicit
  execution-platform classification for build scripts, pinned
  Reindeer/Prelude versions, and Linux/Darwin controls before build scripts or
  cross-platform proc-macro execution are admitted.

## `BUCK.GRAPH.BIND.RUST-DQ6` / `DQ7`: Overlay API shape and watch freshness

- Source experiment: `01-semantic-graph/01-authoring-bindings/02-rust-cargo/.experiments/2026-08-12-operation-roots-and-overlay.md`,
  which resolved the baseline and lifecycle parts of both questions.
- Open remainder: the exact overlay module API shape and watch-mode
  invalidation freshness remain unproved.

## Cross-repo kernel conformance

- Source: vision success criterion 6 — the public kernel passes the same
  conformance fixtures in at least two independently owned repositories whose
  graphs and policies remain local.
- Status: unscheduled post-phase work. No current phase, subsystem spec, or
  decision owns it; it becomes schedulable once the kernel boundary stabilizes
  enough for its conformance fixture set to be extracted.
