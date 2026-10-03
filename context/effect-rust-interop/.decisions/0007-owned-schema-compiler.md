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
