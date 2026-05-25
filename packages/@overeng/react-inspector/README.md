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

### With Effect Schema Support

```tsx
import { ObjectInspector, withSchemaSupport, SchemaProvider } from '@overeng/react-inspector'
import { Schema } from 'effect'

const UserSchema = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
}).annotations({ title: 'User' })

// Option 1: Using HOC
const SchemaInspector = withSchemaSupport(ObjectInspector)
<SchemaInspector data={user} schema={UserSchema} />

// Option 2: Using SchemaProvider directly
<SchemaProvider schema={UserSchema}>
  <ObjectInspector data={user} />
</SchemaProvider>
```

### Schema Annotation Tooltips

When using `withSchemaSupport`, hovering or keyboard-focusing a field name (or
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
const AgeSchema = Schema.Number.pipe(Schema.int(), Schema.between(0, 150)).annotations({
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

<SchemaTooltip info={getSchemaInfo(AgeSchema)}>
  <span>age</span>
</SchemaTooltip>
```

See [FORK_CHANGELOG.md](./FORK_CHANGELOG.md) for details on fork-specific features.
