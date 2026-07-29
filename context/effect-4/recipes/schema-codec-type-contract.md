# Pattern: schema-codec-type-contract

**Area:** Schema type-level contracts **Kind:** shape change **Our usage:** 23 multi-parameter
references in `notion-effect-schema`

## Shape change

Effect 3 used one `Schema.Schema` type for bidirectional codecs:

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

The rule applies at every arity. In particular, the safe-looking one-parameter form is also a real
migration:

```ts
// Effect 3 defaults: Encoded = Type, Context = never
Schema.Schema<Type>

// Effect 4 preserves those defaults
Schema.Codec<Type>
```

Effect 4's `Schema<Type>` is a different, weaker interface carrying only the decoded Type. It does
not preserve Effect 3's implicit encoded type or bidirectional service contract.

## Why the alternatives are not equivalent

- `Schema.Schema<Type>` is not the Effect 3 one-parameter contract; it drops the implicit encoded
  type and bidirectional codec guarantee.
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
- One-parameter references are the easiest to miss because both old and new names accept one type
  argument while meaning different things.

## Codemod rule

One-parameter `Schema.Schema<T>` references mechanically become `Schema.Codec<T>`.
Three-parameter `Schema.Schema<T, E, R>` references mechanically become
`Schema.Codec<T, E, R, R>`. Constraint-position types require site review.
