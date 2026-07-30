# Pattern: schema-uuid-guid

**Area:** Schema string checks **Kind:** removal with a surviving-name trap **Our usage:** two
packages (`otel-contract` and `utils`)

## Shape change first: UUID was a GUID check

`Schema.UUID` is removed in Effect 4 beta.102. The faithful replacement is:

```ts
Schema.String.check(Schema.isGUID())
```

Do **not** replace it with the similarly named `Schema.isUUID()`. Effect 3's `Schema.UUID` accepted
any dashed hexadecimal `8-4-4-4-12` GUID. Effect 4's `isUUID` additionally enforces UUID version and
variant nibbles, so it silently tightens the accepted set.

For example, Effect 3 accepts `123e4567-e89b-02d3-0456-426614174000`, while Effect 4's `isUUID`
rejects it. Effect 4's `isGUID` accepts it and preserves the encoded string.

## v3

```ts
const RequestId = Schema.UUID
```

## v4

```ts
const RequestId = Schema.String.check(Schema.isGUID())
```

## Equivalence

The replacement was checked at runtime against `effect@3.21.4` and
`effect@4.0.0-beta.102`. Re-run the comparison with:

- a standard versioned lowercase UUID;
- the same value in uppercase;
- the nil UUID;
- an all-`f` GUID;
- `123e4567-e89b-02d3-0456-426614174000`, whose version and variant nibbles are invalid;
- a 32-character hexadecimal value without dashes;
- a non-GUID string.

For each accepted value, also compare the encoded strings exactly. In the measured cases, v3
`Schema.UUID` and v4 `Schema.String.check(Schema.isGUID())` had identical acceptance and encoding;
v4 `Schema.isUUID()` rejected the non-version/variant counterexample.

## Gotchas

- The symbol whose name most resembles the v3 schema is the wrong replacement.
- A typecheck cannot detect the accepted-set tightening.
- Do not add a brand merely because the old export was named `UUID`; v3's filter decoded to a plain
  string.

