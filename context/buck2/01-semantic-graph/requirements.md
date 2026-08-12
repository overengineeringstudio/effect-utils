# Semantic Graph Requirements

**Role:** This subsystem defines the implementation-neutral package and target
graph consumed by Buck projections and realizations. It refines the Buck
[requirements](../requirements.md); child nodes define Genie projection and
dependency-closure semantics without redefining this graph.

## Context

The graph composes existing package, language-project, test, and artifact
authorities into one normalized model. It does not replace those authorities,
select build tools, or execute repository work.

## Assumptions

- **BUCK.GRAPH-A01 Upstream metadata authority:** Package manifests, language
  project configuration, test configuration, and package-local artifact intent
  remain authoritative for their own domain facts.
- **BUCK.GRAPH-A02 Root Buck contract:** Target analysis, action ownership, and
  toolchain selection satisfy the parent Buck requirements.
- **BUCK.GRAPH-A03 Dependency materialization contract:** External dependency
  identity and materialization satisfy the dependency-materialization VRS; the
  graph references that contract rather than defining another one.

## Acceptable Tradeoffs

- **BUCK.GRAPH-T01 Conservative declarations:** A target may initially declare
  a conservative superset of required inputs when exact selection is not yet
  available, provided the superset is explicit, complete, and independently
  measurable.
- **BUCK.GRAPH-T02 Versioned graph changes:** An incompatible graph-schema
  correction may intentionally invalidate affected generated projections and
  Buck actions through one explicit schema-version change.

## Requirements

### Must provide one semantic model

- **BUCK.GRAPH-R01 Composed package model:** Each package must contribute one
  composed semantic model containing its package identity, language projects,
  checks, tests, artifacts, dependency edges, validation edges, file sets, and
  capability requirements. Generated files must not become a second authority
  for those facts.
- **BUCK.GRAPH-R02 Runtime-neutral IR:** The normalized graph must not encode a
  concrete compiler, runtime executable, Nix store path, host discovery result,
  action command, or local-versus-remote execution policy.
- **BUCK.GRAPH-R03 Strict tagged entities:** Projects, checks, tests, artifacts,
  dependencies, file sets, and capability requirements must have versioned,
  tagged, strictly validated representations. Unknown tags, duplicate logical
  identities, and unsupported fields must fail before projection.
- **BUCK.GRAPH-R04 Explicit field ownership:** Every graph field must name or
  inherit one semantic authority. A projection or realization may derive a
  lower-level representation but must not independently reinterpret the field.

### Must keep identity and relationships stable

- **BUCK.GRAPH-R05 Logical identity:** Package and target identity must be
  stable logical data independent of source language, physical repository
  location, generator implementation, and selected tool implementation.
- **BUCK.GRAPH-R06 Typed edges:** Compile, runtime, test, validation, and
  artifact edges must be distinguishable in the graph. A consumer must not
  infer edge meaning from a target name or physical label.
- **BUCK.GRAPH-R07 Deterministic normalization:** Equal semantic input must
  produce equal normalized graph data. Set-like values must have a canonical
  order, duplicates must be rejected, and order-sensitive values must retain
  their authored order.
- **BUCK.GRAPH-R08 Move and split semantics:** A physical package move must not
  silently change logical identity, and splitting a check, test, or artifact
  target must create explicit identities and validation relationships.

### Must support language-specific facts without fragmenting the graph

- **BUCK.GRAPH-R09 Language adapters:** Each supported language must provide an
  adapter that validates its project-specific facts and lowers them into the
  shared graph entities. An adapter must not redefine package identity, generic
  edge kinds, artifact identity, or execution-tool selection.
- **BUCK.GRAPH-R10 Symbolic capabilities:** Projects and targets must request
  symbolic capabilities and output formats. Buck realization must bind those
  requests to tools and platforms outside the semantic graph.
- **BUCK.GRAPH-R11 Cross-language composition:** Dependency and validation edges
  must be able to connect projects and artifacts implemented in different
  languages without either adapter importing the other language's model.

### Must make completeness and invalidation observable

- **BUCK.GRAPH-R12 Owned file sets and completeness:** Every supported
  repository source or test file must match typed, target-scoped Buck file sets
  for exactly the intended semantic roles. An independent repository census
  must fail on missing or ambiguous ownership. It must use Buck's resolved
  ownership rather than reimplementing pattern matching. Matching membership
  changes must not require generated shard enumeration.
- **BUCK.GRAPH-R13 Projection locality:** A semantic change confined to one
  package must leave unrelated package projections byte-identical. A dependent
  target may change only when its declared semantic relationship or selected
  input closure changes.
- **BUCK.GRAPH-R14 Implementation independence:** Replacing a graph normalizer,
  projection implementation, or action tool with an equivalent implementation
  must leave normalized graph data and semantic projection bytes unchanged.
- **BUCK.GRAPH-R15 Causal verification:** Verification must include negative and
  positive controls for undeclared files, unrelated package changes, package
  moves, target splits, adapter changes, and tool implementation changes.
- **BUCK.GRAPH-R16 Operation dependency-root model:** The graph must support
  operation-local references to canonical direct dependency declarations and
  preserve admitted normalized roots in semantic identity without copying
  versions, selected topology, resolver context, or physical paths. Each
  language binding must define its request authority, legality rules, and any
  explicitly conservative root policy before admission.
