# Pattern: schema-codec-type-contract

**Area:** Schema type-level contracts **Kind:** shape change **Our usage:** 23 multi-parameter
references in `notion-effect-schema`

## Shape change

Effect 3 used one `Schema.Schema` type for both value-only schemas and bidirectional codecs:

```ts
Schema.Schema<Type, Encoded, Context>
```

Effect 4 separates the value-only interface from the bidirectional codec interface. Preserve the
old contract as:

```ts
Schema.Codec<Type, Encoded, Context, Context>
```

The third and fourth parameters are decoding and encoding services respectively. Effect 3's single
`Context` parameter applied in both directions, so it must be copied into both slots.

One-parameter `Schema.Schema<Type>` references remain `Schema.Schema<Type>`.

## Why the alternatives are not equivalent

- `Schema.Schema<Type>` drops the encoded type and both service requirements.
- `Schema.Codec<Type, Encoded, Context, never>` narrows the encoding requirement.
- `Schema.Codec<Type, Encoded, never, Context>` narrows the decoding requirement.
- `Schema.ConstraintCodec` belongs to the constraint hierarchy rather than the concrete Schema
  hierarchy.
- `Schema.Decoder` and `Schema.Encoder` are deliberately one-directional.

Even when a current helper only exercises one direction, narrowing the other direction is a
refactor rather than a faithful port and belongs in follow-up work.

## Equivalence

The `Schema`, `Codec`, `ConstraintCodec`, `Decoder`, and `Encoder` interfaces and their service
parameters were verified against the `effect@4.0.0-beta.102` tarball. The migration preserves the
Effect 3 type contract exactly by retaining the same service requirement for decoding and encoding.

Owning slices must still replay codec behavior in both directions; this recipe only settles the
type-level mapping.

## Gotchas

- The two service slots are easy to confuse because both default to `never`.
- A green typecheck after narrowing one slot does not prove the old public contract was preserved.
- Do not migrate one-parameter `Schema.Schema<Type>` annotations to `Codec` without a concrete
  encoded/service contract.

## Codemod rule

Three-parameter `Schema.Schema<T, E, R>` references mechanically become
`Schema.Codec<T, E, R, R>`. Other arities and constraint-position types require site review.
