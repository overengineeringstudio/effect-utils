# @overeng/react-inspector

Power of Browser DevTools inspectors right inside your React app. Fork of [storybookjs/react-inspector](https://github.com/storybookjs/react-inspector) with Effect Schema support.

[**Storybook**](https://overeng-effect-utils-react-inspecto.vercel.app) - Interactive component documentation and examples

## Installation

```bash
pnpm add @overeng/react-inspector
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

See [FORK_CHANGELOG.md](./FORK_CHANGELOG.md) for details on fork-specific features.
