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
- **VALIDATED (DQ4)**: a type-level test proves `contract` → `call`/`send`/`implement`
  inference recovers the EXACT per-handler I/O/error types against real `effect`
  types (asserted with `Equals<>`): a phantom `Contract<Name, HandlerMap>` +
  `const` type params + `InputOf`/`SuccessOf`/`ErrorOf` indexed accessors, with no
  erasure to `Record<string, …>`. Wrong-input, unknown-method, and wrong-success
  all error. The Phase-1 gate — paired with the
  [0002](./0002-typed-capability-contexts.md) capability-discharge prototype —
  PASSES.

Status: accepted

_Revised: tightened `contract` to carry the handler map in a phantom type param
(the `Record`-erasure case is a normative R10 failure) and validated the
contract→client inference gate (DQ4, above)._
