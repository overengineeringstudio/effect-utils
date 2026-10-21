# Effect Schema → Swift Codable

`@overeng/schema-codegen-swift` is a pure emitter over the same
`@overeng/schema-codegen` contract IR used by effect-rust. It does not walk a
second AST or translate a JSON Schema projection. The Swift admission profile
adds finite numeric scalars and safe bounded bare integers without relaxing the
Rust admission profile.

## Generation contract

```ts
import { generateSwift } from '@overeng/schema-codegen-swift'
import { Schema } from 'effect'

const files = generateSwift({
  schemas: { Message: Schema.Struct({ text: Schema.String }) },
  options: {
    filename: 'Message.generated.swift',
    moduleName: 'Messages',
    header: 'Inputs: contracts.ts; schema-codegen{,-swift}/src. Regenerate: devenv tasks run genie:run',
  },
})
```

The result is a readonly array of `{ path, content }` files. Generation is
synchronous and deterministic, has no filesystem or environment dependencies,
and requires a relative `.swift` output path and nonempty provenance header.
Consumers own output paths, dependency pinning, writes and committing generated
files. Headers must name all schema/generator inputs and the regeneration task;
no wall-clock timestamps are emitted. Generated Swift imports Foundation and the
`CodableHelpers` product from `swift/OverengKit`.

## Supported wire semantics

- Public `Codable`, `Equatable`, `Sendable` structs, arrays and scalar aliases.
- Strings, booleans, strict JSON null, finite numeric values, and admitted integer
  intervals. Numeric values use generated immutable scalar wrappers with a public
  `value` and throwing initializer; validation holds for named roots, fields and
  array elements, not only when decoding an outer struct. Integer storage widths
  and JavaScript safe-integer limits are preserved. Wrapper names are namespaced
  by an emitted definition, so independently generated files with disjoint
  definition sets can share a target; `SchemaCodegen_` is a reserved name prefix.
- String literals become enums with explicit UTF-16-exact Codable membership;
  Swift's normalization-equivalent `String` equality is never used for wire
  literals. Normalization-distinct alternatives remain distinct cases.
  Nonidentifier values get deterministic `valueN` case names. Wire values are
  Swift-escaped, not JSON-escaped.
- Tagged unions become indirect enums with named struct associated payloads.
  Their discriminator remains a top-level JSON property, not Swift's synthesized
  nested enum Codable format. Discriminator comparison is UTF-16-exact; unknown
  or merely normalization-equivalent tags fail decoding.
- Required nullable fields use `T?` but are decoded with required-key `decode`,
  so absence fails and null succeeds. Encoding always emits the required key.
- Optional nonnullable fields use `T?`: absent succeeds, explicit null fails,
  and nil encodes as an absent key.
- Optional nullable fields use `Presence<T?>`: `.absent`, `.present(nil)` and
  `.present(value)` preserve all three states on decode and encode.
- Shared identifier annotations determine nominal names; description annotations
  become Swift documentation comments. Struct excess-key policy is preserved,
  including union payloads (only the active variant's keys are admitted).

The emitter fails closed with shared `AdmissionError` diagnostics (`path`,
`feature`, `remedy`) for unsupported contracts. Currently excluded are semantic
codecs (timestamps, BigInt decimal strings, binary32), records, constrained or
branded strings, tuples, untagged unions, direct infinitely sized recursive
structs and invalid/reserved Swift names. No constraints are silently dropped.
Array recursion and tagged-union recursion have a representable Swift shape.

Generated JSON encoding is ordinary Codable JSON. It is **not** a canonical JSON
or content-address encoder. In particular, the effect-rust discriminator-first
canonical protocol is different from UTF-16-key-sorted canonical content-address
JSON; callers must use the appropriate runtime rather than relying on encoder
property order.

## Genie and freshness

A consumer's `Message.generated.swift.genie.ts` exports the thin adapter:

```ts
import { swiftFile } from '@overeng/schema-codegen-swift/genie'
import { schemas } from './contracts.ts'

export default swiftFile({
  schemas,
  options: {
    filename: 'Message.generated.swift',
    header: 'Inputs: contracts.ts; pinned schema-codegen compiler/emitter. Regenerate: devenv tasks run genie:run',
  },
})
```

One Genie file owns one Swift output. Keep `filename` aligned with the sibling
output path. The adapter returns exactly the core emitter's content; it has no
separate templates or semantics. Commit generated Swift because Swift consumers
must build without running TypeScript. Never patch generated Swift directly.
Use `devenv tasks run genie:run` to regenerate, and
`devenv tasks run genie:check` in CI and locally to check source/content
freshness. Genie owns write/read-only handling; custom consumers must compare
content before writes, restore read-only permissions and enforce the same
freshness gate. There is no timestamp churn or unchecked input-hash sidecar.

## Tests

`src/mod.unit.test.ts` exercises the public generation seam and diagnostics.
`src/fixtures/swift` is a real Swift package, with two source files generated by
checked-in `.swift.genie.ts` adapters. Regenerate with the repository Genie task,
then run:

```sh
swift test --package-path packages/@overeng/schema-codegen-swift/src/fixtures/swift
```

Its XCTest suite compiles the generated code against the real CodableHelpers
runtime and exercises Producer associated-value roundtrips, rejection of unknown
tags/keys, absent versus null, required-nullable key rejection, numeric bounds,
string literals (including normalization-distinct Unicode alternatives), exact
tag membership, arrays and empty structs. Both generated files compile in one
target and exercise distinct numeric bounds without helper-name collisions.
The fixture is not a hand-maintained parallel model. Review generated changes
alongside the schema and emitter.
