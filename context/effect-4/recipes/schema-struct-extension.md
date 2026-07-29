# Pattern: schema-struct-extension

**Area:** Schema struct composition **Kind:** shape change **Our usage:** 27 sites in
`notion-effect-schema`.

## Shape change first

Effect 4 has no standalone `Schema.extend`. There are two replacements, selected by the right-hand
schema's shape.

### Plain field merge

For two plain structs:

```ts
// v3
Schema.extend(A, B)

// v4
Schema.Struct({ ...A.fields, ...B.fields })
```

This mirrors the field merge used internally by Effect 4's Class `static extend` implementation.
It applies to plain `Struct` and `TaggedStruct` values; it does not require or create a Class.

### Struct plus index signature

For a struct extended with a record:

```ts
// v3
Schema.extend(BlockBase, Schema.Record({ key: Schema.String, value: Schema.Unknown }))

// v4
Schema.StructWithRest(BlockBase, [Schema.Record(Schema.String, Schema.Unknown)])
```

`Schema.Record` returns `$Record`, not `Struct`, and has no `.fields` to spread. Treating it like a
plain struct silently drops the index signature and changes excess-property decoding.

## Not a replacement: `extendTo`

Do not replace a plain merge with `Schema.extendTo`. `extendTo(fields, derive)` computes derived
fields from decoded input using `Option`-returning callbacks. It is a transforming schema
operation, not a struct merge.

## Equivalence

Both replacements and Effect 4's own Class merge implementation are **VERIFIED** against the real
`effect@4.0.0-beta.102` tarball.

The measured 27 `notion-effect-schema` sites comprise 25 plain struct/tagged-struct merges and two
struct-plus-record extensions. Owning slices must replay encoded baselines. For `StructWithRest`,
include an additional property and verify that decode and encode preserve the same key and bytes.

## Gotchas

- `Schema.Record(...).fields` is not a valid merge; `Record` is not a `Struct`.
- `Schema.extendTo` can typecheck while implementing different runtime behavior.
- Field order follows object spread order. Preserve the original left-to-right extension order.
- When both structs define the same key, the right-hand fields continue to win.

## Codemod rule

Only plain `Struct`/`TaggedStruct` pairs may use the field-spread rewrite. Classify every right-hand
operand first. Record/index-signature operands require `StructWithRest`; Class and genuinely
derived-field sites require separate adjudication.
