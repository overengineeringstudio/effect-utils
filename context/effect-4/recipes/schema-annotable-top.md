# Pattern: schema-annotable-top

**Area:** Schema type bounds **Kind:** mechanical

## Mapping

Effect 4 removes the `Schema.Annotable` namespace. For generic helpers that accepted any annotatable
schema, replace the v3 bound with `Schema.Top`:

```ts
// v3
const annotate = <S extends Schema.Annotable.All>(schema: S): S => schema

// v4
const annotate = <S extends Schema.Top>(schema: S): S => schema
```

`Schema.Top` is the beta.102 top-level schema interface and retains the schema's precise rebuilt type
through annotation methods.

## Verification

Checked against `effect@4.0.0-beta.102`: `Schema.Annotable` is absent and `Schema.Top` is declared in
`Schema.ts`.

## Gotchas

- Use this mapping for a type bound, not as a replacement runtime value.
- Preserve the original generic `S`; widening parameters or returns to `Schema.Top` loses the
  caller's concrete schema type.
