# Swift schema emitter

This document specifies Swift source generation over the [shared schema-codegen contract](../../schema-codegen/docs/spec.md). Supported wire mappings and runnable consumption examples are defined in the [package reference](../README.md).

## Status

Active.

## Scope

```text
product schemas -> shared lower(profile: swift) -> ContractIR -> emitSwift
                                                               |
                                          generateSwift -> [{ path, content }]
                                                               |
                                                     Genie swiftFile adapter
```

`generateSwift({ schemas, options })` is the pure caller seam. The emitter consumes shared lowering and never performs an independent Effect AST or JSON Schema traversal. Options select the relative Swift filename, contract/module name and deterministic provenance header. A result contains all owned output paths and bytes; invalid paths, unsupported schemas or unrepresentable Swift declarations fail with `AdmissionError`.

Generated declarations implement Codable, Equatable and Sendable. The wire format remains ordinary JSON structs and internally tagged unions. Generated decoding preserves closed-object policies and key presence independently from value nullability; the focused `CodableHelpers` runtime provides JSON null and absent/present values, not product schemas.

## Ownership and freshness

Products pin effect-utils as source, author their own schemas and commit their generated Swift. They consume `swift/OverengKit` as a local SwiftPM package under that same source pin; this repository does not promise a separately versioned remote Swift package or npm publication.

The `./genie` adapter exports `swiftFile` as one generator per output. Genie owns materialization and exact-byte freshness checking; consumer CI invokes `genie:check`. Generators must name the schema inputs and regeneration command in their header. Generated timestamps are excluded. Foundation owns compiler/runtime contracts; products retain their domain fixtures and generated declarations.

## Conformance

Vitest exercises the public seam, deterministic generation and admission errors. The SwiftPM fixture compiles actual generated output against the actual CodableHelpers target and tests tagged associated-value roundtrips, absent/null distinctions, required keys, literals, scalar bounds and excess-key rejection. It is not a separately authored mirror model.
