# @overeng/react-inspector

Power of Browser DevTools inspectors right inside your React app. Fork of [storybookjs/react-inspector](https://github.com/storybookjs/react-inspector) with Effect Schema support.

[**Storybook**](https://overeng-effect-utils-react-inspecto.vercel.app) - Interactive component documentation and examples

## Installation

```bash
bun add @overeng/react-inspector
```

## Usage

### Basic Usage

```tsx
import { ObjectInspector } from '@overeng/react-inspector'

const data = {
  id: 1,
  name: 'John Doe',
  nested: { foo: 'bar' },
}

<ObjectInspector data={data} />
```

### With Effect 4 Schema Support

```tsx
import { ObjectInspector } from '@overeng/react-inspector'
import { Schema } from 'effect'

const UserSchema = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
}).annotate({ title: 'User' })

<ObjectInspector data={user} schema={UserSchema} />
```

`schema` is optional, so the same component handles both ordinary JavaScript
values and Effect 4 schemas. Package v8 remains the Effect 3 release line;
package v9 is the Effect 4 release line.

### Schema Annotation Tooltips

When a schema is provided, hovering or keyboard-focusing a field name (or
the type badge on a struct) shows a rich tooltip with the schema's
annotations:

- **description** (`Symbol.for('effect/annotation/Description')`)
- **examples** (`ExamplesAnnotationId`), formatted via `pretty` if present
- **default** (`DefaultAnnotationId`)
- **constraints** derived from `JSONSchemaAnnotationId` set by refinements
  like `nonEmptyString`, `int`, `between`, `pattern`, `format`, ...
- **possible values** for `Schema.Literal`, `Schema.Enums`,
  `Schema.TemplateLiteral`, and `Schema.Union` of literals (capped at 12 with
  a `… +N more` suffix)
- **documentation** (`DocumentationAnnotationId`)

Fields with only Effect's built-in primitive descriptions ("a string",
"a number", ...) do not get a tooltip — only user-supplied annotations
trigger one.

```tsx
const AgeSchema = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isBetween({ minimum: 0, maximum: 150 })),
).annotate({
  identifier: 'Age',
  title: 'Age',
  description: 'Age in whole years',
  examples: [18, 42, 80],
  default: 0,
})
```

For full control, the `SchemaTooltip` component is exported directly:

```tsx
import { SchemaTooltip, getSchemaInfo } from '@overeng/react-inspector'
;<SchemaTooltip info={getSchemaInfo(AgeSchema)}>
  <span>age</span>
</SchemaTooltip>
```

### Lineage annotations

A standardized vocabulary for the _epistemic_ status of a field — is it the
source of truth, a derivation, a projection, a cache, etc. — surfaced by the
inspector as inline badges and a dedicated tooltip section
([#687](https://github.com/overengineeringstudio/effect-utils/issues/687)).

| Glyph | Kind            | Meaning                                                  |
| ----- | --------------- | -------------------------------------------------------- |
| `⇆`   | Source of truth | Authoritative value (default; no badge rendered inline). |
| `ƒ`   | Derived         | Computed deterministically from listed source fields.    |
| `≈`   | Projection      | Read-model view of another field; may be stale.          |
| `☷`  | Cache           | Cached copy with an optional TTL.                        |
| `↻`   | Mirror          | Synced replica of a field, often from another system.    |
| `↗`   | External        | Reference into an external system.                       |
| `⊙`   | Computed        | Pure read-time computation; not persisted.               |

Companion annotations (`Authority`, `Freshness`, `ForeignKey`) compose
with any `Lineage` and surface as extra tooltip rows.

```tsx
import { Lineage } from '@overeng/react-inspector'
import { Schema } from 'effect'

const OrderTotals = Schema.Struct({
  subtotal: Schema.Number.pipe(Lineage.sourceOfTruth({ owner: 'orders' })),
  total: Schema.Number.pipe(Lineage.derivedFrom(['subtotal', 'tax'])),
  customerId: Schema.String.pipe(
    Lineage.foreignKey('Customer', 'id'),
    Lineage.authority({ writers: ['orders-svc'] }),
  ),
})
```

See [FORK_CHANGELOG.md](./FORK_CHANGELOG.md) for details on fork-specific features.
