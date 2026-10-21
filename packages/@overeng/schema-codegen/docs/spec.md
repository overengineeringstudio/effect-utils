# Schema codegen

This document specifies shared Effect Schema admission and the portable contract IR. It is constrained by the [Effect–Rust interop contract](../../../../context/effect-rust-interop/spec.md) and the Swift emitter's [specification](../../schema-codegen-swift/docs/spec.md).

## Status

Active.

## Scope

The core owns lowering, structured admission failures, semantic schema metadata and the IR. Language emitters own source rendering. Filesystem writes, generated-source ownership and freshness enforcement belong to callers.

```text
Effect schemas -> schema-codegen.lower -> ContractIR
                                          |      |
                                     effect-rust Swift emitter
```

## Admission

`lower(schemas, contract?, options?)` returns `ContractIR`, or throws `AdmissionError` with `path`, `feature` and `remedy`. Unsupported transformations, opaque refinements, untagged unions and lossy number intervals fail rather than silently changing their wire meaning.

The default profile preserves the Effect–Rust admission contract: numbers require bounded safe-integer intervals or the registered binary32 codec; bigint values use canonical decimal strings; timestamps require the registered millisecond-precision contract. The Swift JSON profile is selected explicitly with `{ profile: 'swift' }`. It additionally admits bare numbers as finite binary64 JSON values and bare integers within JavaScript's safe-integer range. This selection does not broaden Rust admission. Emitters must reject unsupported IR variants.

`{ descriptions: true }` includes schema descriptions on definitions and fields. Descriptions are otherwise omitted, preserving the default IR representation. Schema identifiers name definitions, and collisions fail admission.

## IR

`ContractIR` has `irVersion: 1`, a contract name and a named definition map. Definitions describe strings and their portable constraints, literal-string sets, structs, tagged unions and aliases. Types describe scalar values, named references, arrays, records, nullable values and patch values. Field presence is independent of value nullability: required-nullable keys must exist, optional non-null values must reject explicit null, and optional-nullable patch fields preserve absent/null/value.

The `annotations` subpath owns the registered scalar codecs and metadata constants. Existing `effect-rust/*` annotation strings are stable compatibility identifiers, not target selection; retaining their spellings preserves schema identity and existing wire contracts. The Rust package exports the same public `EffectRust` namespace from this shared owner.

## Encoding boundaries

`tagFields` and `tagKeys` describe discriminator-first contract JSON encoding. They do not define content-address canonicalization. The [content-address protocol](../../../../context/content-address/spec.md) sorts every object key by UTF-16 code unit, including discriminator keys. These protocols are deliberately not interchangeable.

## Conformance

Core tests cover profile isolation, documentation metadata and key-presence semantics. The Rust compiler fixture corpus exercises the extracted lowerer through its existing compiler and runtime APIs. Generated Rust crates, JSON Schema and generated Effect sources retain their previous bytes for existing contracts.
