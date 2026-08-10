# Pattern: schema-utility-renames

**Area:** Schema utilities **Kind:** mechanical

## Mapping

```ts
// v3
Schema.asSchema(MySchema)
Schema.equivalence(MySchema)

// v4
MySchema
Schema.toEquivalence(MySchema)
```

`Schema.asSchema` is removed; where it only wrapped an already-typed schema, remove the wrapper.
`Schema.equivalence` is renamed to `Schema.toEquivalence`.

If a site supplies a custom equivalence implementation, use `Schema.overrideToEquivalence`; that API
annotates a schema and is not a replacement for deriving an equivalence.

## Verification

Checked against `effect@4.0.0-beta.102`: `Schema.asSchema` and `Schema.equivalence` are absent;
`Schema.toEquivalence` and `Schema.overrideToEquivalence` are declared in `Schema.ts`.

## Gotchas

- Removing `asSchema` is mechanical only when its input is already a schema. Stop if the wrapper was
  participating in inference or accepting a non-schema value.
- Do not replace a custom-equivalence site with `toEquivalence`; preserve the override.
