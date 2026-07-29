# Pattern: schema-json-formatting

**Area:** Schema JSON wire bytes **Kind:** semantic boundary **Our usage:** persisted configuration
and generated JSON files that pass `{ space }` to v3 JSON codecs.

## Shape change

V4 has no pretty-print JSON codec. `Schema.fromJsonString(S)` accepts no formatting options, and no
beta.102 codec replacement carries v3's `{ space }` behavior.

The replacement is to encode with the schema, then stringify the encoded JSON value explicitly:

```ts
// v3
const JsonConfig = Schema.parseJson(Config, { space: 2 })
const content = Schema.encodeSync(JsonConfig)(value)

// v4
const encoded = Schema.encodeSync(Config)(value)
const content = JSON.stringify(encoded, null, 2)
```

The same rule applies to v3 `Schema.fromJsonString(S, { space })` call shapes. Use
`Schema.encodeEffect` when the surrounding path handles schema failures as an Effect.

This absence and replacement are **VERIFIED** against the real
`effect@4.0.0-beta.102` tarball.

## Equivalence

Formatting is behavior at persistence, CLI, snapshot, and hashing boundaries. Compare the complete
output bytes, including indentation, property order, escaping, and final newline.

`JSON.stringify(encoded, null, 2)` preserves a v3 two-space formatting request only after
`encoded` has passed through the owning schema. Stringifying the decoded value directly can bypass
schema transformations and emit different bytes.

Preserve any existing trailing newline separately:

```ts
const content = `${JSON.stringify(encoded, null, 2)}\n`
```

## Intended differences

None. File churn is not an accepted migration difference.

## Gotchas

- `Schema.fromJsonString(S)` remains the v4 parse/stringify codec for compact JSON, but it has no
  pretty-print option.
- Do not stringify the decoded application value when the schema transforms its encoded shape.
- `space` may be a number or string in `JSON.stringify`; preserve the exact v3 setting.
- A value-level round trip cannot prove whitespace bytes.

## Codemod rule

No broad codemod. Split the old combined codec operation at each formatted output boundary:
schema-encode first, then explicit `JSON.stringify`, then preserve any newline policy.
