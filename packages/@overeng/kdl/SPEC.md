# @overeng/kdl — KDL v2 Implementation Spec

## Overview

A native TypeScript implementation of the [KDL v2](https://kdl.dev/) document language, with Effect integration. KDL is a node-oriented document language designed for configuration files with XML-like semantics and a concise, human-friendly syntax.

This package targets **KDL v2 only** (spec version 2.0.0). No v1 compatibility.

## Goals

- **Behavioral equivalence**: Parse/format output must be indistinguishable from the reference implementation, including whitespace, formatting, and error cases
- **Format preservation**: Full round-tripping — parsing then serializing produces byte-identical output
- **TypeScript-native**: Real `.ts` source with full type system leverage, not JS with type annotations
- **Effect-idiomatic**: AST types use `Schema.TaggedStruct`, errors use `Schema.TaggedError`
- **Fast and portable**: Zero runtime deps beyond `effect`. Works in all modern JS runtimes (Node, Bun, Deno, CF Workers, browsers)
- **Maintainable**: 1:1 structural mapping to reference impl for easy upstream tracking

## Non-Goals (for now)

- KDL v1 compatibility
- KDL Query Language
- KDL Schema Language validation
- JSON-in-KDL / XML-in-KDL

## Reference Implementation

Primary reference: [`@bgotink/kdl`](https://github.com/bgotink/kdl) (JS, hand-written tokenizer + recursive descent parser, format-preserving, zero runtime deps).

Secondary reference for correctness: [`kdl-rs`](https://github.com/kdl-org/kdl-rs) (Rust, winnow parser combinators).

Official test suite: [`kdl-org/kdl/tests/test_cases/`](https://github.com/kdl-org/kdl/tree/main/tests/test_cases) — 336 test cases (249 success, 87 failure).

## Porting Principles

### 1. 1:1 Structural Mapping

Mirror `@bgotink/kdl` module-by-module, function-by-function where feasible. This makes it easy to:
- Pull upstream bug fixes and new features
- Cross-reference behavior questions against the reference
- Maintain parity with minimal cognitive overhead

**Module mapping:**

| `@bgotink/kdl` | `@overeng/kdl` | Notes |
|---|---|---|
| `src/parser/tokenize/types.js` | `src/parser/tokenize/types.ts` | Token enum + char classifiers |
| `src/parser/tokenize/context.js` | `src/parser/tokenize/context.ts` | Tokenizer state machine |
| `src/parser/tokenize/tokenize.js` | `src/parser/tokenize/tokenize.ts` | Main tokenizer |
| `src/parser/parse.js` | `src/parser/parse.ts` | Recursive descent parser |
| `src/parser/parse-whitespace.js` | `src/parser/parse-whitespace.ts` | Whitespace-preserving variant |
| `src/model/document.js` | `src/model/document.ts` | KdlDocument |
| `src/model/node.js` | `src/model/node.ts` | KdlNode |
| `src/model/entry.js` | `src/model/entry.ts` | KdlEntry |
| `src/model/value.js` | `src/model/value.ts` | KdlValue |
| `src/model/identifier.js` | `src/model/identifier.ts` | KdlIdentifier |
| `src/model/tag.js` | `src/model/tag.ts` | KdlTag |
| `src/format.js` | `src/format.ts` | AST → string |
| `src/clear-format.js` | `src/clear-format.ts` | Strip formatting |
| `src/string-utils.js` | `src/string-utils.ts` | Escape/unescape |
| `src/error.js` | `src/error.ts` | Error types |
| `src/parse.js` | `src/parse.ts` | Public entry point |

**Excluded from port:**
- `src/parser/tokenize/tokenize-v1.js` — v1 only
- `src/parser/parse-v1.js` — v1 only
- `src/parser/tokenize/tokenize-query.js` — query language
- `src/parser/parse-query.js` — query language
- `src/dessert/` — deserialization helpers (future `@overeng/kdl-effect`)
- `src/json-impl.js` — JSON-in-KDL
- `src/v1-compat/` — v1 compatibility

### 2. TypeScript Adaptations

While maintaining 1:1 structure, apply these TS-specific changes:

- **Numeric token type constants → string literal union type**: Replace numeric `T_QUOTED_STRING = 1` with a discriminated string union for better debugging and type safety
- **JSDoc types → proper TS types**: Full type annotations on all public APIs, inferred internally
- **`class` model → mutable objects with `Schema.TaggedStruct`-based construction**: The reference uses mutable classes. We'll keep mutability where the parser requires it, but use Effect schemas for construction/validation at the public API boundary
- **Generator tokenizer preserved**: The `function*` tokenizer pattern is standard ES and works everywhere. Keep it as-is

### 3. Effect Integration

**Errors:**
```ts
export class KdlParseError extends Schema.TaggedError<KdlParseError>()(
  'KdlParseError',
  {
    message: Schema.String,
    locations: Schema.Array(KdlLocation),
  },
) {}
```

**AST types**: Use plain mutable objects internally (matching reference), but provide `Schema.TaggedStruct` definitions for the public API boundary where decode/encode is needed.

**Public API**: The `parse()` function returns `Effect.Effect<KdlDocument, KdlParseError>`. A synchronous `parseSync()` is also available.

### 4. Test Strategy

**Official test suite (primary):**
- Git submodule or vendored copy of `kdl-org/kdl/tests/test_cases/`
- For each input `.kdl` file:
  - If filename contains `_fail`: assert parsing fails
  - Otherwise: parse, re-serialize, compare byte-for-byte with `expected_kdl/` file
- All 336 cases must pass

**Unit tests (from reference impl):**
- Port relevant tests from `@bgotink/kdl/test/` covering:
  - String escape/unescape edge cases
  - Tokenizer behavior
  - Parser error recovery
  - Format round-tripping

**Our own tests:**
- Effect integration tests
- Public API ergonomics tests

### 5. Performance Constraints

- Parsing a typical config file (~100 lines) should take <1ms
- No allocations beyond the AST itself on the hot path
- No use of `eval`, `new Function`, or dynamic `import()` (CF Workers compat)
- No Node.js-specific APIs in core (no `fs`, `path`, `Buffer`, etc.)

## KDL v2 Spec Summary

This section is a self-contained reference for the KDL v2 format. Full spec: https://kdl.dev/

### Document Structure

A KDL document is zero or more **nodes** separated by newlines or semicolons.

```kdl
// This is a KDL document
title "Hello World"
author "Jane" email="jane@example.com"
contents {
  section "Introduction"
  section "Body" collapsed=#true
}
```

### Nodes

Every node has:
- **Name**: A string (bare identifier, quoted, or raw)
- **Type annotation** (optional): `(type)name`
- **Arguments**: Ordered positional values
- **Properties**: Key=value pairs (order not guaranteed, rightmost wins for duplicates)
- **Children block** (optional): `{ ... }` containing nested nodes

### Values

| Type | Syntax | Examples |
|------|--------|---------|
| String | bare identifier, `"quoted"`, `#"raw"#`, `"""multiline"""` | `hello`, `"hello world"`, `#"no \"escapes\""#` |
| Number (decimal) | digits with optional `.` and `e` exponent | `42`, `3.14`, `1e10`, `1_000` |
| Number (hex) | `0x` prefix | `0xff`, `0xDEAD_BEEF` |
| Number (octal) | `0o` prefix | `0o755` |
| Number (binary) | `0b` prefix | `0b1010` |
| Boolean | keyword | `#true`, `#false` |
| Null | keyword | `#null` |
| Special numbers | keyword | `#inf`, `#-inf`, `#nan` |

### Strings

- **Bare identifiers**: No quotes needed if the string matches identifier rules (starts with letter/`_`/etc., no special chars)
- **Quoted**: `"hello world"` with escape sequences (`\n`, `\t`, `\\`, `\"`, `\u{XXXX}`, etc.)
- **Raw**: `#"no escapes here"#` — hash count must match, no escape processing
- **Multi-line**: `"""..."""` with automatic dedenting based on closing `"""`'s indentation
- **Raw multi-line**: `#"""..."""#`

### Comments

- Single-line: `// comment`
- Multi-line: `/* comment */` (nestable)
- Slashdash: `/-` comments out the next node, argument, property, or children block

### Type Annotations

Optional prefix on nodes or values: `(type)value`

```kdl
(date)"2024-01-01"
(person)author "Jane"
node (u8)123
```

### Whitespace

Line continuations: `\` followed by optional whitespace and a newline allows nodes to span multiple lines.

## Architecture

```
@overeng/kdl (core)
├── Tokenizer (character dispatch → Token stream)
├── Parser (Token stream → AST)
├── AST Model (KdlDocument, KdlNode, KdlEntry, KdlValue, KdlIdentifier, KdlTag)
├── Formatter (AST → string, format-preserving)
├── String Utils (escape/unescape)
└── Error Types (Schema.TaggedError with source locations)

@overeng/kdl-effect (future)
├── Schema definitions (KDL ↔ typed data decode/encode)
├── Config utilities (typed config file reading)
└── KDL Query Language (future)
```

## Design Decisions (Resolved)

### Generator tokenizer — keep as-is

The generator-based tokenizer (`function*`) provides lazy, pull-based token consumption. The 255-entry character dispatch table gives O(1) classification. For config files (~500-1000 tokens), generator suspend/resume overhead is nanoseconds — negligible. Switching to an imperative loop would require worse architecture (pre-allocated array or callback inversion) for no measurable gain. Generators maintain 1:1 parity with the reference impl.

### AST mutability — keep mutable classes

The parser heavily mutates AST nodes post-construction: `tag`, `leading`, `trailing`, `representation`, `betweenTagAndName`, `beforeChildren`, `equals` are all set incrementally as the parser discovers more context. Immutable `Data.TaggedStruct` would require O(n²) object copying or a builder pattern for no real benefit. The `clone()` methods provide copy-on-demand for consumers who need it. The `readonly type` discriminant on each class gives tagged-union-style dispatch without the immutability constraint.

### Effect wrapping depth — boundary only

Effect is used only at the public API boundary (`parseEffect()`). Internally the parser uses synchronous throw/catch with `InvalidKdlError` and mutable error accumulation (`ctx.errors.push()`). The parser is synchronous, CPU-bound, single-pass — no concurrency, resources, or retry points where Effect's strengths apply. `Effect.gen` overhead per step would be significant across thousands of parser operations.

### Two-layer error architecture

- **Internal**: `InvalidKdlError extends Error` — used by tokenizer, parser, string-utils. Standard JS exception handling for performance
- **Public**: `KdlParseError extends Schema.TaggedError` — yieldable in Effect, used at the API boundary. The `parseEffect()` function catches `InvalidKdlError` and wraps it

### Number precision — JS `number`, accept known limitations

Uses JS `number` for all values, matching the `@bgotink/kdl` reference. 4 test cases are known-broken due to JS precision limits (large hex integers exceeding `MAX_SAFE_INTEGER`, `10^1000` scale scientific notation). These are irrelevant for config files. Format preservation mitigates: the original `representation` string round-trips perfectly even when the numeric value loses precision. `bigint` support can be added as a focused follow-up if needed.
