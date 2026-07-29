# Pattern: schema-date

**Area:** Schema wire format **Kind:** semantic (conditional rewrite) **Our usage:**
`Schema.DateTimeUtc`, `Schema.DateFromSelf`, and date transforms appear in agent-session, Notion
codecs, and path schemas.

## v3

```ts
const decode = Schema.decodeUnknownEither(Schema.Date)
const encode = Schema.encodeEither(Schema.Date)
```

## v4

```ts
const DateWire = Schema.DateFromString
const decode = Schema.decodeUnknownExit(DateWire)
const encode = Schema.encodeExit(DateWire)
```

The v4 codecs return `Exit`, not `Either`; callers must handle the changed result shape.

## Equivalence

Command:

```sh
bun run run schema-date
```

Result: encoded wire strings and accept/reject outcomes are equivalent after
using `Schema.DateFromString` on effect `4.0.0-beta.102`. The only differences
are allowlisted parse-message text changes for invalid inputs. That allowlist is
a harness classification, not blanket migration acceptance.

## Intended differences (alignment register entries)

- v4 invalid-date parse messages use `SchemaError(...)`; v3 prints a parse-tree
  message. Proposed decision: accept only for internal structural failure
  checks. User-facing or snapshotted boundaries must preserve/normalize the
  message or intentionally sign off on the text change.
- Audit result: no current snapshot contains the specific v3 Date parse-tree text
  or v4 `SchemaError(...)` text. Structural failure tests in
  `notion-effect-schema` and `notion-property-write` do not inspect text.
  User-facing/stringified-error boundaries exist in `notion-cli`,
  `notion-datasource-sync`, `tui-react`, and `restate-effect`, so they need
  migration-time review before this difference is accepted at the boundary.

## Gotchas

- This is a rename trap: `Schema.Date` still exists in v4 but means a Date
  instance schema, not the v3 ISO-string wire schema.
- In effect `4.0.0-beta.102`, `Schema.Date` rejects invalid Date instances and
  `Schema.DateFromString` decodes through that stricter Date schema. The beta.99
  mapping `Schema.DateFromString.check(Schema.isDateValid())` is stale because
  `Schema.isDateValid` is no longer exported.
- Value-level assertions are insufficient because a decoded Date can look right
  while the encoded wire contract changed.
- The harness first used the wrong v4 port (`Schema.Date`) and reported 14
  unexpected diffs, proving the oracle catches this migration hazard.

## Codemod rule (mechanical patterns only)

Where v3 `Schema.Date` is used as a wire schema, rewrite:

```ts
Schema.Date
```

to:

```ts
Schema.DateFromString
```

Do not apply this blindly to v3 `Schema.DateFromSelf` or v4 code that already
expects a Date instance input.

A site is a wire schema when its encoded input is JSON/string data crossing a
process, persistence, API, file, config, test fixture, or `Schema.encode*` /
`Schema.decodeUnknown*` boundary. Do not apply this rule when callers already
pass Date instances directly and the encoded side is not part of the observable
contract.

## DateTime follows the same surviving-name trap

Effect 3 `Schema.DateTimeUtc` was a bidirectional ISO-string wire codec whose Type was
`DateTime.Utc`. In Effect 4 the bare surviving name validates values that are already
`DateTime.Utc`; the wire codec is:

```ts
Schema.DateTimeUtcFromString
```

At string-to-value boundaries, migrate:

```ts
Schema.DateTimeUtc
```

to:

```ts
Schema.DateTimeUtcFromString
```

The Effect 4 encoder formats the UTC value through `DateTime.formatIso`, which bottoms out in
`Date.prototype.toISOString()`. For the repository baseline this preserves exact bytes including
milliseconds and the `Z` suffix. Invalid strings still fail, but parse-message text may differ and
must not be silently rebaselined at observable boundaries.

The broader pattern is: when a v3 schema performed string-to-value decoding, a surviving bare v4
identifier may have become an instance validator while a `...FromString` schema now owns the wire
contract. Verify Type, Encoded, and exact encoded bytes rather than trusting the surviving name.
