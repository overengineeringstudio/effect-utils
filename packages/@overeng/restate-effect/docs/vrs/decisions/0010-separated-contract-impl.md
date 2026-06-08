# Separated service contract and implementation (@effect/rpc-style)

A service is authored in two parts. `RestateService.contract(name, { greet: {
input, success, error } })` produces a lightweight, shareable typed artifact
(handler names + I/O/error Schemas) — this is what CLIENTS import to get typed
ingress calls + serde, with no server code or deps.
`RestateService.implement(contract, { greet: (input) => Effect... })` produces the
SERVER-side Layer with the handler effects. The same split applies to Virtual
Objects and Workflows.

## Why

- The ingress client needs the contract (Schemas → serde + types) but not the
  implementation; separating them keeps client bundles free of server code and
  matches how the Effect ecosystem (`@effect/rpc`, `@effect/cluster`) structures
  schema-described handler groups. Reinforces the typed-client decision (0008).

## Consequences

- Slightly more ceremony for a trivial single-package service; pays off whenever
  client and server live in different packages (the norm).
- The POC's combined `make` is superseded by `contract` + `implement`.

Status: accepted
