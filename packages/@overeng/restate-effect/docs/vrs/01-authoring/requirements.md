# Requirements: 01-authoring

**Role.** How a construct is authored (the `contract`/`implement`/`define`
surface for Services, Virtual Objects, and Workflows), the typed capability-marker
context that gates durable operations per handler kind, the per-invocation runtime
boundary that provides those markers, the invocation lifecycle, and the surfaced
service/handler options. This subsystem owns the authoring-time and per-invocation
shape every other subsystem builds on.

Builds on the cross-cutting [../requirements.md](../requirements.md) (global
A/T + the faithful-binding stance) and [../glossary.md](../glossary.md). IDs are
GLOBAL and preserved — do not renumber.

## Requirements

### Must enforce capability safety in types

- **R04 Capability-gated combinators:** A durable combinator that requires a
  context capability (e.g. writing State, resolving a durable promise) MUST carry
  that requirement in its Effect `R` channel such that invoking it where the
  capability is not provided is a type error. (Vision; [../.decisions/0002](../.decisions/0002-typed-capability-contexts.md).)
- **R05 Capability provision per handler kind:** The per-invocation boundary MUST
  provide exactly the capability markers legal for the construct and handler kind
  (service / exclusive / shared / workflow `run` / workflow shared), so legal
  handlers compile and illegal operations do not. (A02; [../.decisions/0002](../.decisions/0002-typed-capability-contexts.md).)
- **R06 Typed State access:** Virtual Object / Workflow State access MUST be
  key- and value-typed against a declared State schema, so reading or writing an
  unknown key or a wrong-typed value is a type error. A state field MAY be
  declared OPTIONAL (`Schema.optional`); since State is K/V, an absent key reads
  back as `undefined` and writing `undefined` (or `clear`) REMOVES the key — one
  compiler-agreed pattern under both the type-checker and the bundler, reachable
  identically in handlers and through the test `stateOf` proxies.

### Must preserve a typed I/O and client contract

- **R09 Contract/implementation separation:** A service contract (handler names +
  I/O/error Schemas) MUST be expressible and importable independently of the
  implementation, with no server code or server-only dependencies. (T03; [../.decisions/0010](../.decisions/0010-separated-contract-impl.md).)

### Must shut down gracefully

- **R30 Per-invocation runtime boundary:** The shared application runtime MUST be
  built once from a Layer; the per-invocation `ctx` and its capability markers
  MUST be provided per call, never placed in the long-lived application Layer.
  (A02.)

### Must expose the full durable-promise and option surface

- **R34 Durable-promise lifecycle:** The Workflow durable-promise combinators MUST
  cover `get` / `resolve` / `reject` / `peek` (non-blocking read). The workflow
  contract DSL MUST distinguish signals (write-only shared handlers) from queries
  (read-only shared handlers) so a query path that observes a `'rejected'` state
  is reachable. (R06; [../.decisions/0002](../.decisions/0002-typed-capability-contexts.md).)
- **R35 Surfaced service/handler options:** The remaining SDK service/handler
  options MUST be surfaced as TYPED options — `enableLazyState`,
  `journalRetention`, `idempotencyRetention`, `inactivityTimeout`, `abortTimeout`,
  `ingressPrivate`, `workflowRetention`, `explicitCancellation`. `ingressPrivate`
  MUST be reflected in the ingress client TYPE so an ingress-private handler is
  not callable from the ingress client. (A02.)

### May reduce single-package ceremony

- **R36 `define` convenience helper:** For the single-package case, a
  `RestateService.define(name, specs, impl)` helper MAY combine `contract` and
  `implement` in one expression, mitigating T03's ceremony without removing the
  separable `contract` artifact. (T03; [../.decisions/0010](../.decisions/0010-separated-contract-impl.md).)
