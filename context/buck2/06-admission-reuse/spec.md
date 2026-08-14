# Admission and Reuse Spec

This document specifies exact-tuple admission and cross-repository conformance.
It builds on [requirements.md](./requirements.md).

## Status

Draft.

## Scope

**Defines:** admission predicate, authority switch, capability isolation, and
kernel conformance.

**Does not define:** rollout scheduling, PR topology, or consumer deployment
policy.

## Admission Predicate

```text
graph fresh
  + declared/hermetic execution
  + semantic parity and negative controls
  + relevant/irrelevant invalidation controls
  + complete native evidence
  + BuildProduct/Nix import proof when the operation produces a product
  = PASS for one exact tuple
```

Every term has `PASS`, `FAIL`, or `NO_VERDICT`. The conjunction passes only when
all required terms pass. Unsupported platform or decoder versions are
`NO_VERDICT`, not inferred success.

## Authority Switch

Admission and contraction are separate records but one dependent change:

```text
verified candidate -> admission PASS -> route entrypoints -> delete old producer
```

The post-switch verifier invokes the normal developer and CI surfaces and
proves their executed process/action graph reaches Buck and cannot reach the
former producer. Recovery uses a source revert or prior immutable result, not a
standing shadow producer.

## Capability Isolation

| Capability          | Minimum independent evidence                            |
| ------------------- | ------------------------------------------------------- |
| Local execution     | hermeticity, semantic parity, invalidation              |
| Cache read          | compatible action identity and trust policy             |
| Cache write         | isolated credentials and poisoning controls             |
| Remote execution    | execution-platform compatibility and remote hermeticity |
| Product consumption | exact descriptor and payload verification               |
| Nix import          | platform match, archive checks, runtime inspection      |

One capability never implies another.

## Cross-Repository Conformance

The kernel suite contains only synthetic public fixtures. Each consumer runs the
same suite plus its local adapter suite. A compatibility claim records kernel
version, repository-adapter version, Buck version, admitted platform tuple, and
verdict without exporting the consumer graph. A second consumer justifies
extracting shared behavior; it does not transfer ownership of either graph.
