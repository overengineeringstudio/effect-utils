# Pattern: schema-struct-extension

**Area:** Schema struct composition **Kind:** shape change **Our usage:** 27 sites in
`notion-effect-schema`

## Shape change first

Effect 4 has no standalone `Schema.extend`. There are two replacements for the repository's
current sites, depending on whether the right-hand schema is another struct or a record index
signature.

### Plain field merge

For two plain structs, merge their fields explicitly:

```ts
Schema.extend(A, B)
```

becomes:

```ts
Schema.Struct({ ...A.fields, ...B.fields })
```

This is the same field merge used internally by the Effect 4 Class API's static `extend` method.
It applies to plain `Struct` and `TaggedStruct` values; it does not require or create a Class.

### Struct plus index signature

For a struct extended with a record:

```ts
Schema.extend(BlockBase, Schema.Record(Schema.String, Schema.Unknown))
```

use:

```ts
Schema.StructWithRest(BlockBase, [Schema.Record(Schema.String, Schema.Unknown)])
```

`Schema.Record` returns `$Record`, not `Struct`. It has no `.fields` to spread. Treating it like a
plain struct silently drops the index signature and changes excess-property decoding.

## Not a replacement: `extendTo`

Do not replace a plain merge with `Schema.extendTo`. `extendTo(fields, derive)` is a transforming
schema operation: it computes derived fields from the original decoded input using
`Option`-returning callbacks. It is not a struct merge.

## Equivalence

The two Effect 4 APIs and their implementation shapes were verified against the
`effect@4.0.0-beta.102` tarball. The 27 `notion-effect-schema` sites were categorized as:

- 23 plain `Struct` plus `TaggedStruct` field merges;
- 2 plain `Struct` plus `Struct` field merges;
- 2 `Struct` plus `Record` index-signature extensions;
- 0 derived-field extensions.

Owning slices must replay encoded baselines. For `StructWithRest`, include an input with an
additional property and verify that decode and encode preserve the same key and bytes.

## Gotchas

- `Schema.Record(...).fields` is not a valid field merge; `Record` is not a `Struct`.
- `Schema.extendTo` can typecheck while implementing different runtime behavior.
- Field order follows object spread order. Preserve the original left-to-right extension order.
- When both structs define the same key, the right-hand fields continue to win.

## Codemod rule

Only plain `Struct`/`TaggedStruct` pairs may use the field-spread rewrite. Every right-hand operand
must be classified first. Record/index-signature operands require `StructWithRest`; Class and
genuinely derived-field sites require separate adjudication.
