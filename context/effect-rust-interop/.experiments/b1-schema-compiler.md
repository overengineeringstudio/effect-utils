# Experiment B1: Bidirectional schema compiler bakeoff

## Question

Does any existing stack pass every generation must-have in both ownership directions?

## Hypothesis

An existing generator stack can preserve the required Effect/Rust runtime semantics without mirrored validators or silent lowering.

## Method

Correctness-only bakeoff of Typify 0.8.0, jsonschema 0.58.3, schemafy 0.6.0, quicktype 26.0.0, Effect 4.0.0-rc.118's importer, and @xschemadev/effect 0.1.1. A custom shared-AST prototype was the comparator. Effect and schemars owners exercised 35 portable, 27 semantic-extension, and seven regex-flag vectors on both generated sides. Repeated generation checked determinism; lossy-input probes checked admission diagnostics. Rust toolchain was 1.98.1, Bun 1.4.2, and Node 24.20.0.

## Result

| Observation                                         | Measured result                                                                                                        |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Existing complete stacks passing all six must-haves | 0                                                                                                                      |
| Typify portable disagreements                       | 10/35, due to missing Unicode flag                                                                                     |
| Typify extension disagreements                      | 6/27 Effect-owned; 13/27 Rust-owned                                                                                    |
| Native Effect importer                              | 0/35 portable after owner metadata/width normalization; 6/27 and 13/27 extension disagreements; 2/7 flag disagreements |
| Custom prototype                                    | 0/35, 0/27, 0/7 disagreements for both owners and generated sides                                                      |
| Deterministic output                                | 34 files byte-identical across reruns                                                                                  |
| Lossy inputs rejected                               | 16, each with path and remedy                                                                                          |

Quicktype's Effect target used Effect 3 APIs and did not run against Effect 4. @xschemadev/effect also required Effect 3. Schemafy's release was outside the six-month maintenance gate. Existing candidates ignored unknown extension keywords. Effect's importer hook could transform JSON Schema but could not emit a semantic codec.

## Conclusion

The all-must-haves rule selected an owned compiler, refined in [decision 0007](../.decisions/0007-owned-schema-compiler.md). Live Effect SchemaAST preserves check identifiers that exported JSON had lost; schemars 1.x plus helper metadata is the selected Rust-owned frontend. Reuse Effect's emitter rather than duplicate reference/recursion machinery.

## Intent Impact

Supersedes the generator baseline in decision 0002 without changing single-owner or runtime-parity requirements.

## Limits

No performance benchmark was run. Correctness ran under heavy load (one-minute load approximately 143–202), which does not turn semantic results into throughput evidence. The custom prototype was written in Python, emitted a dynamic Rust tree rather than typed structs, admitted only five reviewed regex patterns, and did not implement tagged unions or general refs/recursion. The Rust owner used schemars 0.8.22 for the Typify baseline; schemars 1.x is the decided production frontend, not a claim that B1 exercised it. A 28–42 engineer-day production estimate was an inference, not measured duration.

## Specification

[Schema ownership and semantic codecs](../spec.md#schema-ownership-and-semantic-codecs-r02r04-r14).
