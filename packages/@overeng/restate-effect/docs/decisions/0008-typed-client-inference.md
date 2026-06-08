# Service definitions preserve typed handler maps; typed clients derived from them

`RestateService.make` (and the object/workflow builders) retain each handler's
input/success/error Schemas in the definition's TYPE (mirroring Restate's phantom
`ServiceDefinition<P, M>`). From a single definition the binding derives, fully
typed:

- the external **ingress client** (`@restatedev/restate-sdk-clients`) wrapped as
  an Effect service — `client.greet({ name })` is Schema-validated, returns the
  typed success, and surfaces typed terminal errors via the decode helper;
- in-handler **service-to-service clients** (`ctx.serviceClient` / `objectClient`
  / `workflowClient` + `*SendClient`) as Effect combinators.

The internal `materialize` boundary may erase to `any` (invisible to users); what
is preserved is the definition's PUBLIC type.

## Why

- Deriving typed clients from one Schema-typed definition is the core payoff of
  building on Effect — it makes the wire boundary feel like local, typed,
  validated calls (the POC's hand-declared client types were the #6 pain point).

## Consequences

- Real generics care is required in `make`/`handler` and the client-view type
  derivation; the cost is contained inside the builder, keeping authoring +
  calling surfaces clean.

Status: accepted
