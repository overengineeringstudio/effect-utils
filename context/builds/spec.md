# Reusable Builds Spec

This document specifies build-contract composition. It builds on
[requirements.md](./requirements.md).

## Status

Active.

## Scope

Defines reusable identity, descriptor and authority seams and their realizations.
Does not define private products, cache service deployment, activation or CI topology.

## Composition

```text
01 identity       02 cache descriptor      03 authority
       \                |                    /
        +---------------+-------------------+
                        |
                   04 Buck realization
                        |
               05 product distribution -> consumer deployment
```

| Owner                                                        | Contract                                                                   | Requirement   |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------- |
| [01-identity](./01-identity/spec.md)                         | Component fields and C closure-rev semantics                               | BUILD-R01     |
| [02-cache-contract](./02-cache-contract/spec.md)             | Tagged descriptors and protocol initialization                             | BUILD-R04     |
| [03-authority](./03-authority/spec.md)                       | Ledger, deletion and complexity trajectory                                 | BUILD-R02     |
| [04-buck2](./04-buck2/spec.md)                               | Semantic graph, tools, roots, materialization, actions, reuse and evidence | BUILD-R01–R04 |
| [05-product-distribution](./05-product-distribution/spec.md) | Product bytes and independent Nix import                                   | BUILD-R03     |

The cache contract does not grant writes. [Execution admission](./04-buck2/05-execution/spec.md#cache-writable-lane-admission)
owns hermetic-lane eligibility because it depends on declared inputs, toolchains,
environment and verdict determinism, not the transport descriptor. Consumer policy
selects writer principals; the service enforces credentials and public read-only access.

Historical ADR filenames/numbers remain in [.decisions](./.decisions/).
The [ID map](./.reference/id-map.md) traces old semantic IDs to their current owners.
[Migration records](./.reference/migration-2026/roadmap.md) are non-normative evidence,
not a second active contract.
