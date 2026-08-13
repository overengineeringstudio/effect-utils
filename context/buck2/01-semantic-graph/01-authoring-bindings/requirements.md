# Authoring Bindings Requirements

**Role:** This subsystem defines the shared contract by which language-native
authorities contribute package, project, operation, and direct-dependency facts
to the parent [semantic graph](../requirements.md). Child bindings interpret
their own ecosystems without creating a universal package-manager model.

## Context

An authoring binding joins existing ecosystem authorities at a typed boundary
and lowers their facts into the shared semantic graph. It does not select
dependency versions, render Buck syntax, bind tools, or execute targets.

## Assumptions

- **BUCK.GRAPH.BIND-A01 Parent graph contract:** Contributions satisfy the
  parent graph's strict identity, edge, normalization, and capability contract.
- **BUCK.GRAPH.BIND-A02 Native authorities remain authoritative:** Package,
  project, test, and artifact facts continue to be authored through the
  language ecosystem surfaces that already own them.
- **BUCK.GRAPH.BIND-A03 Resolver boundary:** Dependency selection,
  materialization, selected topology, and immutable dependency bytes remain
  owned by the dependency-materialization contract.

## Acceptable Tradeoffs

- **BUCK.GRAPH.BIND-T01 Binding-specific facets:** Different languages may use
  different typed facet and overlay shapes when their native authorities do
  not share semantics. Every binding must still normalize into the same graph
  entities.
- **BUCK.GRAPH.BIND-T02 Fail-closed adoption:** A binding may initially reject
  valid ecosystem features whose graph meaning has not been proved. Rejection
  must identify the unsupported fact rather than silently approximate it.

## Requirements

### Must preserve native authority

- **BUCK.GRAPH.BIND-R01 Single fact authority:** Every contributed fact must
  trace to exactly one language-native authority or one repository-owned
  semantic overlay. A binding must not introduce a parallel dependency map,
  package identity, project configuration, or target definition.
- **BUCK.GRAPH.BIND-R02 Irreducible overlays:** A repository-owned overlay may
  author only relationships or intent absent from the native authority. It must
  reference native declarations by canonical identity rather than copy their
  values.
- **BUCK.GRAPH.BIND-R03 Provenance-preserving composition:** Composition must
  retain enough typed provenance to validate canonical package, declaration,
  project, and target references before normalization widens or erases
  language-specific types.

### Must expose one shared adapter boundary

- **BUCK.GRAPH.BIND-R04 Closed contribution:** Each binding must emit a strict,
  versioned language contribution containing only graph-authoring facts. It
  must reject unknown fields, duplicate identities, unresolved references, and
  unsupported native semantics.
- **BUCK.GRAPH.BIND-R05 Canonical dependency roots:** Operation-local
  dependency uses must resolve to canonical direct declarations and normalize
  to the parent graph's `DependencyRootRef`. A binding must not copy requested
  versions, selected versions, transitive topology, resolver context, or
  physical dependency paths into operation identity.
- **BUCK.GRAPH.BIND-R06 Workspace edge separation:** A dependency request for a
  first-party workspace package must become a logical first-party edge;
  external requests must remain resolver roots. Bindings must not infer this
  distinction after provenance has been erased.

### Must remain deterministic and inspectable

- **BUCK.GRAPH.BIND-R07 Pure normalization:** Equal authority inputs and
  overlays must emit equal contributions regardless of module evaluation
  order, checkout location, ambient environment, or equivalent adapter
  implementation.
- **BUCK.GRAPH.BIND-R08 Local invalidation:** A change to one facet must affect
  only graph fields that semantically consume that facet. Unrelated package,
  project, operation, and generated-output bytes must remain identical.
- **BUCK.GRAPH.BIND-R09 Causal admission:** Every binding must retain RED/GREEN
  controls for authority duplication, unknown and foreign references,
  provenance loss, unsupported semantics, repeated evaluation, privacy leaks,
  and relevant versus irrelevant invalidation before it becomes authoritative.
