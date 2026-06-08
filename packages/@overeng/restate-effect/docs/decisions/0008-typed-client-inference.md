# Contracts preserve typed handler maps; typed clients derived from them

`RestateService.contract` (and the object/workflow builders) retain each
handler's input/success/error Schemas in the contract's TYPE. `contract` MUST
return a `Contract<Name, HandlerMap>` carrying the handler map in a PHANTOM type
parameter — mirroring `@effect/rpc`'s `Rpc.make` → typed group and the SDK's
`ServiceDefinition<P, M>`. `call` / `send` / `implement` then index
`HandlerMap[method]` to recover the per-handler I/O/error types. From a single
contract the binding derives, fully typed:

- the external **ingress client** (`@restatedev/restate-sdk-clients`) wrapped as
  an Effect service — `ingress.call(Greeter, 'greet', { name })` is
  Schema-validated, returns the typed success, and surfaces typed terminal errors
  via the decode helper;
- in-handler **service-to-service clients** (`ctx.serviceClient` / `objectClient`
  / `workflowClient` + `*SendClient`) as Effect combinators.

NORMATIVE: a contract whose handler map erases to `Record<string, …>` does NOT
satisfy R10 — the method name and its I/O types must survive in the phantom. The
POC's hand-declared `GreeterApi` plus a `{ name }`-only phantom
`ServiceDefinition` is exactly the ANTI-PATTERN being replaced: it requires the
caller to re-declare the handler shape. The internal `materialize` boundary may
still erase to `any` (invisible to users); what is preserved is the CONTRACT's
public, indexable type.

## Why

- Deriving typed clients from one Schema-typed contract is the core payoff of
  building on Effect — it makes the wire boundary feel like local, typed,
  validated calls (the POC's hand-declared client types were the #6 pain point).

## Consequences

- Real generics care is required in `contract` and the client-view type
  derivation; the cost is contained inside the builder, keeping authoring +
  calling surfaces clean.
- **Unproven**: a type-level test that `contract` → `call`/`send`/`implement`
  inference works (and that the handler map does NOT erase to `Record<string,
  …>`) must pass BEFORE 0008 is treated as settled. This is the Phase-1 gate,
  paired with the [0002](./0002-typed-capability-contexts.md) capability-discharge
  prototype.

Status: accepted

_Revised after design review: `contract` must carry the handler map in a phantom
type param (not erase to `Record`); made the `Record`-erasure case a normative
R10 failure and added the Phase-1 type-level inference gate; named the POC's
hand-declared `GreeterApi` as the anti-pattern being replaced._
