# Pattern: predicate-object

**Area:** Runtime predicates **Kind:** semantic rename **Our usage:** object-or-function guards in
shared utilities.

## v3

```ts
Predicate.isObject(value)
```

## v4 replacement

```ts
Predicate.isObjectKeyword(value)
```

V4 still exports `Predicate.isObject`, but its meaning narrowed to non-null records: it rejects
arrays and functions. Use `isObjectKeyword` to preserve v3's JavaScript `object`-keyword semantics,
which accept non-null objects, arrays, and functions.

## Equivalence

The predicates are **VERIFIED** against the real `effect@3.21.4` and
`effect@4.0.0-beta.102` tarballs. Across `null`, plain object, array, function, and string, v3
`isObject` and v4 `isObjectKeyword` returned identical results. V4 `isObject` differed for arrays
and functions.

## Intended differences

None when using `isObjectKeyword`.

## Gotchas

- This is a surviving-name hazard: leaving `isObject` unchanged compiles but changes behavior.
- If a site deliberately wants record-only semantics, v4 `isObject` is appropriate, but that is a
  behavior change requiring an explicit decision.

## Codemod rule

Replace v3 `Predicate.isObject` with v4 `Predicate.isObjectKeyword` unless the owning slice
explicitly adopts record-only semantics and tests arrays and functions.
