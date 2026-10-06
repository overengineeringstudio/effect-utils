# Decision: Owned bidirectional schema compiler

## Status

Status: accepted

## Context

Current-round q4 and q7–q9 resolve the generator baseline in [decision 0002](./0002-schema-ownership-semantic-extensions.md). Existing generators lose Unicode flags, semantic keywords, check identifiers, or Effect 4 runtime compatibility.

## Decision

Own a TypeScript compiler core walking live Effect SchemaAST. Reuse Effect's code emitter for Effect output. Rust-owned contracts enter through schemars 1.x plus the effect-rust helper crate. Both frontends lower to one versioned IR; emit executable codecs, typed Rust source, a required versioned JSON Schema 2020-12 `$vocabulary`, and shared-vector tests.

Admit regex only through a strict reviewed cross-engine grammar with flags `u` or `iu`, expanded construct by construct with differential vectors. Reject unsupported semantics with a path and remedy; never silently weaken a contract.

## Evidence and Argument

[B1](../.experiments/b1-schema-compiler.md) found no existing stack passing all six must-haves. The custom prototype reached zero disagreements on 35 portable, 27 extension, and seven flag vectors for both owners/sides, rejected 16 lossy inputs, and regenerated 34 files identically. It proves the approach on those fixtures, not a production compiler or complete regex grammar.

## Options

| Option                            | Tradeoff                                               |
| --------------------------------- | ------------------------------------------------------ |
| TS core on live AST (selected)    | Preserves check identifiers; reuses the Effect emitter |
| Rust core over exported JSON      | Cannot recover lost Effect checks                      |
| Two compilers                     | Duplicates semantic lowering                           |
| Existing generator plus validator | Failed required parity and diagnostics                 |
| Arbitrary regex plus fuzzing      | Does not establish cross-engine equivalence            |

## Consequences

The compiler is deliberate complexity forced by executable parity. No Typify/validator fallback remains. Unknown required vocabulary versions and keywords fail closed. Generated Rust shape is refined in [decision 0009](./0009-generated-rust-shape.md).

## Specification

[Schema ownership and semantic codecs](../spec.md#schema-ownership-and-semantic-codecs-r02r04-r14).

## Amendment 1

The frontend is [annotation-first](./0014-annotation-first-authoring.md), not a mandatory `Wire.*` vocabulary. Ordinary admitted Effect Schema and namespaced annotations lower into the same IR; unsupported predicates still fail closed. Emit optional schemars `JsonSchema` implementations directly from that IR for Effect-owned types, preserving definitions and constraints rather than deriving weaker metadata from Rust fields.

Discriminated Cargo standalone/workspace output and typed generated package/resource admission are [decision 0015](./0015-typed-build-and-host-seams.md). [PR #1578](https://github.com/overengineeringstudio/effect-utils/pull/1578) is the open implementation source; [Effect issue #8690](https://github.com/Effect-TS/effect/issues/8690) records the upstream AST/export/import gaps that justify live-AST lowering.
