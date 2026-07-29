# Pattern: schema-codec-type-contract

**Area:** Schema type-level contracts **Kind:** shape change **Our usage:** generic codec helpers
throughout the repository, including 23 multi-parameter references in `notion-effect-schema` and
one-parameter public return types in `otel-contract`.

## Shape change

Effect 3 used one `Schema.Schema` type for both value-only schemas and bidirectional codecs:

```ts
Schema.Schema<Type, Encoded, Context>
```

Effect 4's `Schema.Schema<Type>` is a different, weaker interface that carries only the decoded
type. The faithful replacement is `Schema.Codec` at **every arity**:

| v3                       | v4                         |
| ------------------------ | -------------------------- |
| `Schema.Schema<T>`       | `Schema.Codec<T>`          |
| `Schema.Schema<T, E>`    | `Schema.Codec<T, E>`       |
| `Schema.Schema<T, E, R>` | `Schema.Codec<T, E, R, R>` |

`Codec` defaults `E = T`, `RD = never`, and `RE = never`, exactly matching the omitted Effect 3
parameters. For the three-parameter form, Effect 3's single `Context` applied in both directions,
so it must be copied into v4's decoding and encoding service slots.

All interface shapes and defaults above are **VERIFIED** against the real
`effect@4.0.0-beta.102` tarball (SHA-1
`f51092854960f60cbdb06bd59e788acbc8ee8492`).

## Why the alternatives are not equivalent

- `Schema.Schema<T>` drops the encoded type and both service requirements, even when the v3 type
  used only one explicit parameter.
- `Schema.Codec<T, E, R, never>` narrows the encoding requirement.
- `Schema.Codec<T, E, never, R>` narrows the decoding requirement.
- `Schema.ConstraintCodec` is only for APIs that read type views and do not require the full schema
  protocol.
- `Schema.Decoder` and `Schema.Encoder` are deliberately one-directional.

Even when a current helper exercises only one direction, narrowing the other direction is a
refactor rather than a faithful port and belongs in follow-up work.

## `AnyNoContext`

The replacement for v3 `Schema.Schema.AnyNoContext` is:

```ts
Schema.Codec<any, any, never, never>
```

Do **not** use `Schema.Top`. `Top` erases both service slots to `unknown` and therefore admits
codecs that require decoding or encoding services; v3 `AnyNoContext` rejected them.

This bound is **VERIFIED** from both tarball declarations:

```text
v3 AnyNoContext = Schema<any, any, never>
v4 Codec<any, any, never, never>
v4 Top = decoded/encoded/services all unknown
```

Use `Schema.ConstraintCodec<any, any, never, never>` only when the generic utility merely reads
type views and does not call schema methods. A direct port of a v3 `Schema` bound should retain the
full protocol with `Codec`.

## Equivalence

This recipe preserves the v3 compile-time encoded and service contracts. It does not apply a
repository migration or establish runtime codec equivalence. Owning slices must replay decoding
and encoding with exact encoded bytes and both service environments.

## Gotchas

- The apparently safe one-parameter spelling is the easiest trap: v4 `Schema<T>` is not v3
  `Schema<T>` with fewer visible parameters.
- The two service slots are easy to confuse because both default to `never`.
- A green typecheck after narrowing one slot does not prove the old public contract was preserved.
- `Top` is the existential any-schema bound, not the service-free-codec bound.

## Codemod rule

All v3 `Schema.Schema<...>` type references become `Schema.Codec<...>`. Duplicate the third v3
parameter into both v4 service slots. Replace `Schema.Schema.AnyNoContext` with
`Schema.Codec<any, any, never, never>`.
