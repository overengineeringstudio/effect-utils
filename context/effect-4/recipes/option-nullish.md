# Pattern: option-nullish

**Area:** Option constructors **Kind:** mechanical rename **Our usage:** 19 references across 15
files and six packages.

## v3

```ts
Option.fromNullable(value)
```

## v4

```ts
Option.fromNullishOr(value)
```

This replacement is **VERIFIED** against the real `effect@4.0.0-beta.102` tarball:
`fromNullable` is absent and `fromNullishOr` is present.

## Equivalence

Both constructors map `null` and `undefined` to `Option.none()` and every other value to
`Option.some(value)`.

Do not substitute the narrower `fromNullOr` or `fromUndefinedOr`:

| Input       | `fromNullishOr` | `fromNullOr`      | `fromUndefinedOr` |
| ----------- | --------------- | ----------------- | ----------------- |
| `null`      | `None`          | `None`            | `Some(null)`      |
| `undefined` | `None`          | `Some(undefined)` | `None`            |

## Intended differences

None.

## Codemod rule

`Option.fromNullable` mechanically becomes `Option.fromNullishOr`. Preserve any explicit fallback
argument or surrounding `Option` combinators unchanged.
