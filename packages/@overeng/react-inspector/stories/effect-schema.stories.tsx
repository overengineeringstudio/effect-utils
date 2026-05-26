import type { Meta } from '@storybook/react'
import { Schema } from 'effect'
import React from 'react'

import {
  Inspector,
  ObjectInspector,
  ObjectRootLabel,
  ObjectLabel,
  ObjectName,
  ObjectValue,
  ObjectPreview,
  withSchemaSupport,
  SchemaProvider,
  Lineage,
} from '../src'

export default {
  title: 'Effect Schema',
  component: Inspector,
} satisfies Meta<typeof Inspector>

/** Create a schema-aware version of ObjectInspector using the HOC */
const SchemaObjectInspector = withSchemaSupport(ObjectInspector, {
  ObjectRootLabel,
  ObjectLabel,
  ObjectName,
  ObjectValue,
  ObjectPreview,
})

/** User schema with title annotation */
const UserSchema = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  email: Schema.String,
  createdAt: Schema.DateFromSelf,
}).annotations({
  identifier: 'User',
  title: 'User',
})

type User = typeof UserSchema.Type

const sampleUser: User = {
  id: 1,
  name: 'John Doe',
  email: 'john@example.com',
  createdAt: new Date('2024-01-15'),
}

/** Schema with title annotation */
export const BasicSchemaWithTitle = {
  render: () => <SchemaObjectInspector data={sampleUser} schema={UserSchema} expandLevel={1} />,
}

/** Product schema with pretty print annotation */
const PriceSchema = Schema.Number.annotations({
  identifier: 'Price',
  pretty: (value) => `$${(value as number).toFixed(2)}`,
})

const ProductSchema = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  price: PriceSchema,
  quantity: Schema.Number,
}).annotations({
  identifier: 'Product',
  title: 'Product',
})

type Product = typeof ProductSchema.Type

const sampleProduct: Product = {
  id: 42,
  name: 'Widget Pro',
  price: 29.99,
  quantity: 100,
}

/** Schema with pretty print annotation */
export const SchemaWithPrettyPrint = {
  render: () => (
    <SchemaObjectInspector data={sampleProduct} schema={ProductSchema} expandLevel={1} />
  ),
}

/** Address schema for nested structures */
const AddressSchema = Schema.Struct({
  street: Schema.String,
  city: Schema.String,
  country: Schema.String,
  zip: Schema.String,
}).annotations({
  identifier: 'Address',
  title: 'Address',
})

/** Person schema with nested address */
const PersonSchema = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  address: AddressSchema,
}).annotations({
  identifier: 'Person',
  title: 'Person',
})

type Person = typeof PersonSchema.Type

const samplePerson: Person = {
  id: 1,
  name: 'Jane Smith',
  address: {
    street: '123 Main St',
    city: 'San Francisco',
    country: 'USA',
    zip: '94102',
  },
}

/** Nested schema with annotations */
export const NestedSchemaWithAnnotations = {
  render: () => <SchemaObjectInspector data={samplePerson} schema={PersonSchema} expandLevel={2} />,
}

/** Temperature schema with pretty print for formatting */
const TemperatureSchema = Schema.Number.annotations({
  identifier: 'Temperature',
  pretty: (value) => `${value}°C`,
})

/** Weather report schema */
const WeatherReportSchema = Schema.Struct({
  location: Schema.String,
  temperature: TemperatureSchema,
  humidity: Schema.Number.annotations({
    pretty: (value) => `${value}%`,
  }),
  conditions: Schema.String,
}).annotations({
  identifier: 'WeatherReport',
  title: 'Weather Report',
})

type WeatherReport = typeof WeatherReportSchema.Type

const sampleWeather: WeatherReport = {
  location: 'New York',
  temperature: 22,
  humidity: 65,
  conditions: 'Partly Cloudy',
}

/** Pretty print for multiple fields */
export const PrettyPrintForMultipleFields = {
  render: () => (
    <SchemaObjectInspector data={sampleWeather} schema={WeatherReportSchema} expandLevel={1} />
  ),
}

/** Array of users example */
const UsersArraySchema = Schema.Array(UserSchema).annotations({
  identifier: 'Users',
  title: 'Users',
})

const sampleUsers: User[] = [
  {
    id: 1,
    name: 'Alice',
    email: 'alice@example.com',
    createdAt: new Date('2024-01-01'),
  },
  {
    id: 2,
    name: 'Bob',
    email: 'bob@example.com',
    createdAt: new Date('2024-02-15'),
  },
  {
    id: 3,
    name: 'Charlie',
    email: 'charlie@example.com',
    createdAt: new Date('2024-03-20'),
  },
]

/** Array of schema items */
export const ArrayOfSchemaItems = {
  render: () => (
    <SchemaObjectInspector data={sampleUsers} schema={UsersArraySchema} expandLevel={2} />
  ),
}

/** Without schema (for comparison) */
export const WithoutSchema = {
  render: () => <ObjectInspector data={sampleUser} expandLevel={1} />,
}

/** Order schema with complex formatting */
const MoneySchema = Schema.Number.annotations({
  identifier: 'Money',
  pretty: (value) => {
    const num = value as number
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(num)
  },
})

const OrderItemSchema = Schema.Struct({
  productId: Schema.Number,
  name: Schema.String,
  price: MoneySchema,
  quantity: Schema.Number,
}).annotations({
  identifier: 'OrderItem',
  title: 'Order Item',
})

const OrderSchema = Schema.Struct({
  orderId: Schema.String,
  customer: Schema.String,
  items: Schema.Array(OrderItemSchema),
  subtotal: MoneySchema,
  tax: MoneySchema,
  total: MoneySchema,
  status: Schema.String,
}).annotations({
  identifier: 'Order',
  title: 'Order',
})

type Order = typeof OrderSchema.Type

const sampleOrder: Order = {
  orderId: 'ORD-2024-001',
  customer: 'John Doe',
  items: [
    { productId: 1, name: 'Widget Pro', price: 29.99, quantity: 2 },
    { productId: 2, name: 'Gadget Plus', price: 49.99, quantity: 1 },
  ],
  subtotal: 109.97,
  tax: 9.9,
  total: 119.87,
  status: 'Shipped',
}

/** Complex order with currency formatting */
export const ComplexOrderExample = {
  render: () => <SchemaObjectInspector data={sampleOrder} schema={OrderSchema} expandLevel={3} />,
}

/** Enum-like union type example */
const StatusSchema = Schema.Union(
  Schema.Literal('pending'),
  Schema.Literal('processing'),
  Schema.Literal('completed'),
  Schema.Literal('cancelled'),
).annotations({
  identifier: 'OrderStatus',
  title: 'Order Status',
})

const TaskSchema = Schema.Struct({
  id: Schema.Number,
  title: Schema.String,
  status: StatusSchema,
  priority: Schema.Number.annotations({
    pretty: (value) => {
      const num = value as number
      if (num >= 8) return 'High'
      if (num >= 4) return 'Medium'
      return 'Low'
    },
  }),
}).annotations({
  identifier: 'Task',
  title: 'Task',
})

type Task = typeof TaskSchema.Type

const sampleTask: Task = {
  id: 1,
  title: 'Implement Effect Schema support',
  status: 'completed',
  priority: 9,
}

/** Task with priority formatting */
export const TaskWithPriorityFormatting = {
  render: () => <SchemaObjectInspector data={sampleTask} schema={TaskSchema} expandLevel={1} />,
}

/** Using top-level pretty print for an entire object */
const PointSchema = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
}).annotations({
  identifier: 'Point',
  title: 'Point',
  pretty: (value) => {
    const point = value as { x: number; y: number }
    return `(${point.x}, ${point.y})`
  },
})

type Point = typeof PointSchema.Type

const samplePoint: Point = { x: 10, y: 20 }

/** Object with top-level pretty print */
export const ObjectWithTopLevelPrettyPrint = {
  render: () => <SchemaObjectInspector data={samplePoint} schema={PointSchema} />,
}

/** Comparison: with and without schema */
export const ComparisonWithAndWithoutSchema = {
  render: () => (
    <div style={{ display: 'flex', gap: '40px' }}>
      <div>
        <h4 style={{ marginBottom: '8px' }}>With Schema</h4>
        <SchemaObjectInspector data={sampleOrder} schema={OrderSchema} expandLevel={2} />
      </div>
      <div>
        <h4 style={{ marginBottom: '8px' }}>Without Schema</h4>
        <ObjectInspector data={sampleOrder} expandLevel={2} />
      </div>
    </div>
  ),
}

/** Using SchemaProvider directly */
export const UsingSchemaProviderDirectly = {
  render: () => (
    <SchemaProvider schema={UserSchema}>
      <ObjectInspector data={sampleUser} expandLevel={1} />
    </SchemaProvider>
  ),
}

/** Schema with description annotations - hover over fields to see tooltips */
const DocumentedUserSchema = Schema.Struct({
  id: Schema.Number.annotations({
    description: 'Unique identifier for the user in the database',
  }),
  name: Schema.String.annotations({
    description: 'Full legal name of the user',
  }),
  email: Schema.String.annotations({
    description: 'Primary email address used for authentication and notifications',
  }),
  role: Schema.Union(
    Schema.Literal('admin'),
    Schema.Literal('moderator'),
    Schema.Literal('user'),
  ).annotations({
    description: 'Access level determining permissions in the system',
  }),
  preferences: Schema.Struct({
    theme: Schema.Union(Schema.Literal('light'), Schema.Literal('dark')).annotations({
      description: 'UI color scheme preference',
    }),
    notifications: Schema.Boolean.annotations({
      description: 'Whether to receive email notifications',
    }),
    language: Schema.String.annotations({
      description: 'Preferred language code (e.g., en-US, de-DE)',
    }),
  }).annotations({
    identifier: 'UserPreferences',
    title: 'User Preferences',
    description: 'User-configurable settings for the application',
  }),
}).annotations({
  identifier: 'DocumentedUser',
  title: 'User',
  description: 'A registered user in the system with authentication credentials and preferences',
})

type DocumentedUser = typeof DocumentedUserSchema.Type

const sampleDocumentedUser: DocumentedUser = {
  id: 42,
  name: 'Alice Johnson',
  email: 'alice@example.com',
  role: 'admin',
  preferences: {
    theme: 'dark',
    notifications: true,
    language: 'en-US',
  },
}

/** Schema with description tooltips */
export const SchemaWithDescriptionTooltips = {
  render: () => (
    <div>
      <p style={{ marginBottom: '16px', color: '#666' }}>
        Hover over (or keyboard-focus, via Tab) any field name or type badge to see its description
        and other schema annotations.
      </p>
      <SchemaObjectInspector
        data={sampleDocumentedUser}
        schema={DocumentedUserSchema}
        expandLevel={2}
      />
    </div>
  ),
}

/** API Response schema with detailed field descriptions */
const ApiResponseSchema = Schema.Struct({
  status: Schema.Number.annotations({
    description: 'HTTP status code of the response (e.g., 200, 404, 500)',
    pretty: (value) => {
      const code = value as number
      if (code >= 200 && code < 300) return `✓ ${code}`
      if (code >= 400 && code < 500) return `⚠ ${code}`
      return `✗ ${code}`
    },
  }),
  data: Schema.Struct({
    items: Schema.Array(
      Schema.Struct({
        id: Schema.String.annotations({
          description: 'UUID v4 identifier',
        }),
        value: Schema.Number.annotations({
          description: 'Numeric value in base units',
          pretty: (v) => `${v} units`,
        }),
      }).annotations({
        identifier: 'DataItem',
        title: 'Data Item',
        description: 'Individual data record from the API',
      }),
    ).annotations({
      description: 'Array of data items returned by the query',
    }),
    total: Schema.Number.annotations({
      description:
        'Total count of items matching the query (may exceed items.length due to pagination)',
    }),
  }).annotations({
    identifier: 'ResponseData',
    title: 'Response Data',
    description: 'Payload containing the requested data',
  }),
  meta: Schema.Struct({
    requestId: Schema.String.annotations({
      description: 'Unique identifier for tracing this request through logs',
    }),
    duration: Schema.Number.annotations({
      description: 'Server-side processing time in milliseconds',
      pretty: (v) => `${v}ms`,
    }),
  }).annotations({
    identifier: 'ResponseMeta',
    title: 'Metadata',
    description: 'Request metadata for debugging and monitoring',
  }),
}).annotations({
  identifier: 'ApiResponse',
  title: 'API Response',
  description: 'Standard response envelope for all API endpoints',
})

type ApiResponse = typeof ApiResponseSchema.Type

const sampleApiResponse: ApiResponse = {
  status: 200,
  data: {
    items: [
      { id: 'a1b2c3d4', value: 42 },
      { id: 'e5f6g7h8', value: 17 },
    ],
    total: 156,
  },
  meta: {
    requestId: 'req_abc123xyz',
    duration: 45,
  },
}

/** API response with descriptions and formatting */
export const ApiResponseWithDescriptions = {
  render: () => (
    <div>
      <p style={{ marginBottom: '16px', color: '#666' }}>
        Complex nested schema with descriptions and pretty formatting. Hover over fields for
        documentation.
      </p>
      <SchemaObjectInspector data={sampleApiResponse} schema={ApiResponseSchema} expandLevel={3} />
    </div>
  ),
}

/**
 * Expanded vs collapsed preview
 *
 * Demonstrates expanded vs collapsed behavior:
 * - Collapsed: Shows full inline preview "Order {orderId: "ORD-2024-001", customer: "John Doe", ...}"
 * - Expanded: Shows only the type identifier "Order" since children are visible below
 */
export const ExpandedVsCollapsedPreview = {
  render: () => (
    <div style={{ display: 'flex', gap: '60px' }}>
      <div>
        <h4 style={{ marginBottom: '8px' }}>Collapsed (expandLevel=0)</h4>
        <p style={{ fontSize: '12px', color: '#666', marginBottom: '8px' }}>
          Shows full preview:{' '}
          <code>
            Order {'{'} orderId: "...", customer: "...", ... {'}'}
          </code>
        </p>
        <SchemaObjectInspector data={sampleOrder} schema={OrderSchema} expandLevel={0} />
      </div>
      <div>
        <h4 style={{ marginBottom: '8px' }}>Expanded (expandLevel=1)</h4>
        <p style={{ fontSize: '12px', color: '#666', marginBottom: '8px' }}>
          Shows only identifier: <code>Order</code> (children visible below)
        </p>
        <SchemaObjectInspector data={sampleOrder} schema={OrderSchema} expandLevel={1} />
      </div>
    </div>
  ),
}

/* ============================================================================
 * Rich tooltip showcase — exercises every annotation kind the tooltip surfaces
 * ============================================================================ */

const Hint: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p style={{ marginBottom: '16px', color: '#666', fontSize: 13 }}>{children}</p>
)

/** Refinement-driven constraints (NonEmpty + max length, Int + Between). */
const UserHandleSchema = Schema.String.pipe(
  Schema.nonEmptyString({ message: () => 'handle must not be empty' }),
  Schema.maxLength(20),
  Schema.pattern(/^[a-z0-9_]+$/i),
).annotations({
  identifier: 'UserHandle',
  title: 'Handle',
  description: 'Unique short alias used in URLs and @mentions',
  examples: ['alice', 'bob_42'],
})

const AgeSchema = Schema.Number.pipe(Schema.int(), Schema.between(0, 150)).annotations({
  identifier: 'Age',
  title: 'Age',
  description: 'Age in whole years',
  examples: [18, 42, 80],
  default: 0,
})

const RoleSchema = Schema.Union(
  Schema.Literal('owner'),
  Schema.Literal('admin'),
  Schema.Literal('member'),
  Schema.Literal('guest'),
).annotations({
  identifier: 'Role',
  title: 'Role',
  description: 'Access tier within the workspace',
  default: 'member',
})

const PrioritySchema = Schema.Enums({
  Low: 0,
  Medium: 1,
  High: 2,
  Critical: 3,
} as const).annotations({
  identifier: 'Priority',
  title: 'Priority',
  description: 'Numeric priority bucket',
})

const EmailSchema = Schema.String.pipe(Schema.pattern(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)).annotations({
  identifier: 'Email',
  title: 'Email',
  description: 'Primary contact email; verified at signup',
  examples: ['alice@example.com'],
})

const MoneyV2Schema = Schema.Number.annotations({
  identifier: 'Money',
  title: 'Money (USD)',
  description: 'Currency amount in US dollars',
  pretty: (v) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v as number),
  examples: [9.99, 1234.5],
  default: 0,
})

const ShowcaseUserSchema = Schema.Struct({
  handle: UserHandleSchema,
  email: EmailSchema,
  age: AgeSchema,
  role: RoleSchema,
  priority: PrioritySchema,
  balance: MoneyV2Schema,
  bio: Schema.String.pipe(Schema.maxLength(280)).annotations({
    description: 'Free-form profile bio. Limited to a single tweet.',
  }),
}).annotations({
  identifier: 'ShowcaseUser',
  title: 'Showcase User',
  description: 'A user record that exercises every schema annotation kind the tooltip understands.',
  documentation: 'See the spec at internal://users/schema for the full data contract.',
})

type ShowcaseUser = typeof ShowcaseUserSchema.Type

const sampleShowcaseUser: ShowcaseUser = {
  handle: 'alice',
  email: 'alice@example.com',
  age: 33,
  role: 'admin',
  priority: 2,
  balance: 1234.5,
  bio: 'Building things in Effect.',
}

/**
 * The gold-path tooltip story.
 *
 * Each field exercises a different facet:
 * - `handle`: description + examples + constraints (minLength, maxLength, pattern)
 * - `email`: description + examples + constraint (pattern)
 * - `age`: description + examples + default + constraints (minimum, maximum) + integer
 * - `role`: description + default + possible values (literal union)
 * - `priority`: description + possible values (enum)
 * - `balance`: description + examples + default + pretty formatting
 * - `bio`: description + constraint (maxLength)
 * - root: description + documentation
 */
export const SchemaTooltipFull = {
  render: () => (
    <div>
      <Hint>
        Hover over any field name (or the root <code>Showcase User</code> badge) to see the rich
        tooltip. Each field demonstrates a different annotation: descriptions, examples, defaults,
        constraints from refinements (min/max/pattern), and possible values for literal unions and
        enums.
      </Hint>
      <SchemaObjectInspector
        data={sampleShowcaseUser}
        schema={ShowcaseUserSchema}
        expandLevel={2}
      />
    </div>
  ),
}

/**
 * Keyboard accessibility check.
 *
 * Triggers are focusable (tabIndex={0}) with an aria-describedby wire-up
 * provided by React Aria's TooltipTrigger. Tab through the inspector and each
 * field name's tooltip should appear on focus.
 */
export const SchemaTooltipKeyboardA11y = {
  render: () => (
    <div>
      <Hint>
        Press <kbd>Tab</kbd> repeatedly — tooltips should appear on focus, not only on hover. Each
        focused field announces its description via <code>aria-describedby</code>.
      </Hint>
      <SchemaObjectInspector
        data={sampleShowcaseUser}
        schema={ShowcaseUserSchema}
        expandLevel={2}
      />
    </div>
  ),
}

/**
 * Possible-values truncation.
 *
 * Demonstrates the `+N more` ellipsis when a literal union exceeds the
 * MAX_POSSIBLE_VALUES cap (12). Useful for very large enums where we don't
 * want a wall of values in the tooltip.
 */
const ManyStatusesSchema = Schema.Union(
  ...Array.from({ length: 20 }, (_, i) => Schema.Literal(`status_${i}` as const)),
).annotations({
  identifier: 'ManyStatuses',
  title: 'Status',
  description: 'One of many possible statuses (truncated in tooltip).',
})

const TruncationDemoSchema = Schema.Struct({
  status: ManyStatusesSchema,
}).annotations({
  identifier: 'TruncationDemo',
  title: 'Truncation Demo',
})

export const SchemaTooltipTruncatedPossibleValues = {
  render: () => (
    <div>
      <Hint>
        The <code>status</code> field's tooltip shows only the first 12 allowed values with a{' '}
        <code>… +8 more</code> suffix.
      </Hint>
      <SchemaObjectInspector
        data={{ status: 'status_3' as const }}
        schema={TruncationDemoSchema as unknown as typeof ShowcaseUserSchema}
        expandLevel={1}
      />
    </div>
  ),
}

/**
 * No-annotations fields stay plain.
 *
 * Fields without any annotations should render without a tooltip (no
 * underline, no `cursor: help`) — verifies `hasContent === false` short-circuits.
 */
const PlainSchema = Schema.Struct({
  plainField: Schema.String,
  withDescription: Schema.String.annotations({ description: 'Only this one has a tooltip.' }),
})

export const SchemaTooltipMixedAnnotated = {
  render: () => (
    <div>
      <Hint>
        Only fields with annotations get a tooltip-bearing affordance. The <code>plainField</code>{' '}
        field below has no underline and no tooltip.
      </Hint>
      <SchemaObjectInspector
        data={{ plainField: 'no annotations here', withDescription: 'hover me' }}
        schema={PlainSchema}
        expandLevel={1}
      />
    </div>
  ),
}

/* ============================================================================
 * Container labels for arrays, records, tuples (#686)
 * ============================================================================ */

const ItemSchema = Schema.Struct({
  sku: Schema.String,
  qty: Schema.Number,
}).annotations({
  identifier: 'Item',
  title: 'Item',
})

const InventorySchema = Schema.Struct({
  /* Anonymous `Schema.Array(Item)` — label becomes `Array<Item>`. */
  defaultItems: Schema.Array(ItemSchema),
  /* Named array — its own identifier wins over the constructed label. */
  pinnedItems: Schema.Array(ItemSchema).annotations({
    identifier: 'PinnedItems',
    title: 'Pinned Items',
    description: 'Items pinned to the top of the inventory view.',
  }),
  /* Record with a named value schema → `Record<string, Money>`. */
  priceOverrides: Schema.Record({ key: Schema.String, value: MoneyV2Schema }),
  /* Fixed tuple of primitives → `[number, number, number]`. */
  rgb: Schema.Tuple(Schema.Number, Schema.Number, Schema.Number),
}).annotations({
  identifier: 'Inventory',
  title: 'Inventory',
})

const sampleInventory = {
  defaultItems: [
    { sku: 'A-001', qty: 12 },
    { sku: 'A-002', qty: 4 },
  ],
  pinnedItems: [{ sku: 'P-100', qty: 1 }],
  priceOverrides: {
    'A-001': 19.99,
    'A-002': 49.5,
  },
  rgb: [255, 128, 0] as const,
}

/**
 * Container labels — addresses #686.
 *
 * Arrays show `Array<Item>(N)` instead of `Array(N)`. Records show
 * `Record<string, Money>` instead of `Object`. Tuples show
 * `[number, number, number]`. A named array schema's `identifier` wins over
 * the constructed `Array<…>` label.
 */
export const ContainerLabels = {
  render: () => (
    <div>
      <Hint>
        Arrays, records, and tuples now surface their schema-derived type in the type-badge slot.
        Compare with <code>ArrayOfSchemaItems</code> for the array-only path.
      </Hint>
      <SchemaObjectInspector
        data={sampleInventory}
        schema={InventorySchema as unknown as typeof ShowcaseUserSchema}
        expandLevel={2}
      />
    </div>
  ),
}

/* ============================================================================
 * Map / Set container labels (#686)
 * ============================================================================ */

const StockMapSchema = Schema.Struct({
  /* `Map<string, Money>` — runtime is a real Map instance. */
  pricesByLocation: Schema.MapFromSelf({ key: Schema.String, value: MoneyV2Schema }),
  /* `Set<Item>` — runtime is a real Set instance. */
  uniqueItems: Schema.SetFromSelf(ItemSchema),
  /* `ReadonlyMap<string, number>` — distinct prefix. */
  readonlyCounts: Schema.ReadonlyMapFromSelf({ key: Schema.String, value: Schema.Number }),
}).annotations({
  identifier: 'StockMap',
  title: 'Stock Map',
})

const sampleStockMap = {
  pricesByLocation: new Map<string, number>([
    ['us-east', 19.99],
    ['eu-west', 22.5],
  ]),
  uniqueItems: new Set([
    { sku: 'A-001', qty: 12 },
    { sku: 'A-002', qty: 4 },
  ]),
  readonlyCounts: new Map<string, number>([['total', 16]]),
}

/**
 * Map/Set container labels — addresses #686.
 *
 * `Schema.MapFromSelf({ key, value })` renders as `Map<string, Money>(N)` and
 * `Schema.SetFromSelf(Item)` as `Set<Item>(N)`. `Schema.ReadonlyMapFromSelf`
 * keeps the `ReadonlyMap<...>` prefix.
 */
export const MapAndSetContainerLabels = {
  render: () => (
    <div>
      <Hint>
        Map and Set fields take their schema-derived label (e.g.{' '}
        <code>Map&lt;string, Money&gt;(2)</code>) in the type-badge slot.
      </Hint>
      <SchemaObjectInspector
        data={sampleStockMap}
        schema={StockMapSchema as unknown as typeof ShowcaseUserSchema}
        expandLevel={2}
      />
    </div>
  ),
}

/* ============================================================================
 * Runtime tagged-union narrowing (#686)
 * ============================================================================ */

const EventCreatedSchema = Schema.Struct({
  _tag: Schema.Literal('Created'),
  id: Schema.String,
  createdAt: Schema.String,
}).annotations({
  identifier: 'EventCreated',
  title: 'Created Event',
  description: 'A resource was created.',
})

const EventUpdatedSchema = Schema.Struct({
  _tag: Schema.Literal('Updated'),
  id: Schema.String,
  changedFields: Schema.Array(Schema.String),
}).annotations({
  identifier: 'EventUpdated',
  title: 'Updated Event',
  description: 'An existing resource was modified.',
})

const EventDeletedSchema = Schema.Struct({
  _tag: Schema.Literal('Deleted'),
  id: Schema.String,
}).annotations({
  identifier: 'EventDeleted',
  title: 'Deleted Event',
  description: 'A resource was removed.',
})

const EventSchema = Schema.Union(EventCreatedSchema, EventUpdatedSchema, EventDeletedSchema)

const AuditEntrySchema = Schema.Struct({
  actor: Schema.String,
  event: EventSchema,
}).annotations({
  identifier: 'AuditEntry',
  title: 'Audit Entry',
})

const sampleCreated = {
  actor: 'alice',
  event: {
    _tag: 'Created' as const,
    id: 'rsc_001',
    createdAt: '2026-05-25T10:00:00Z',
  },
}

const sampleUpdated = {
  actor: 'bob',
  event: {
    _tag: 'Updated' as const,
    id: 'rsc_001',
    changedFields: ['title', 'status'],
  },
}

/**
 * Runtime tagged-union narrowing — addresses #686.
 *
 * The `event` field is a `Schema.Union(Created, Updated, Deleted)`. When the
 * runtime value carries `_tag: 'Created'`, tooltips, badge, and field
 * annotations narrow to `EventCreated`; same for `'Updated'`.
 */
export const RuntimeTaggedUnionNarrowing = {
  render: () => (
    <div>
      <Hint>
        Each entry's <code>event</code> is a union of three tagged structs. The badge and tooltip
        narrow to the matching variant (<code>Created Event</code>, <code>Updated Event</code>)
        based on the runtime <code>_tag</code>.
      </Hint>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <SchemaObjectInspector
          data={sampleCreated}
          schema={AuditEntrySchema as unknown as typeof ShowcaseUserSchema}
          expandLevel={2}
        />
        <SchemaObjectInspector
          data={sampleUpdated}
          schema={AuditEntrySchema as unknown as typeof ShowcaseUserSchema}
          expandLevel={2}
        />
      </div>
    </div>
  ),
}

/* ============================================================================
 * Lineage annotations (#687)
 * ============================================================================ */

const OrderTotalsSchema = Schema.Struct({
  subtotal: Schema.Number.pipe(Lineage.sourceOfTruth({ owner: 'orders' })),
  tax: Schema.Number.pipe(Lineage.sourceOfTruth()),
  total: Schema.Number.pipe(Lineage.derivedFrom(['subtotal', 'tax'], 'Pure', { pure: true })),
  displayTotal: Schema.String.pipe(Lineage.computed({ fn: 'formatMoney(total)' })),
  cachedFxRate: Schema.Number.pipe(Lineage.cache('fxRate', { ttlMs: 60_000 })),
  mirroredStripeId: Schema.String.pipe(Lineage.mirror('id', { system: 'stripe' })),
  legacyOrderRef: Schema.String.pipe(Lineage.external('legacy-erp', 'order-id')),
  lastSyncedSnapshot: Schema.Number.pipe(Lineage.projection('total', { stalenessMs: 30_000 })),
  customerId: Schema.String.pipe(
    Lineage.authority({ writers: ['orders-svc'], readers: ['*'] }),
    Lineage.freshness({ capturedAt: 'event-time', maxAgeMs: 5_000 }),
    Lineage.foreignKey('Customer', 'id'),
  ),
}).annotations({
  identifier: 'OrderTotals',
  title: 'Order Totals',
  description: 'Money breakdown for an order; exercises every lineage kind.',
})

const sampleOrderTotals = {
  subtotal: 99.0,
  tax: 8.91,
  total: 107.91,
  displayTotal: '$107.91',
  cachedFxRate: 1.085,
  mirroredStripeId: 'pi_3OABCD',
  legacyOrderRef: 'ORD-998877',
  lastSyncedSnapshot: 107.91,
  customerId: 'cust_42',
}

/**
 * Lineage annotations — addresses #687.
 *
 * Each field carries a different Lineage variant. Hovering the field name
 * shows the LINEAGE block (kind label, summary, source paths). Companion
 * annotations (Authority, Freshness, Reference) compose: `customerId` carries
 * all three at once.
 */
export const LineageAnnotations = {
  render: () => (
    <div>
      <Hint>
        Hover any field name to reveal the lineage details. The small superscript next to a name
        (e.g. <code>ƒ</code>, <code>≈</code>, <code>☷</code>) is an at-a-glance marker for the
        lineage kind. <code>SourceOfTruth</code> is the default and intentionally gets no badge. The
        last field exercises the companion <code>Authority</code> / <code>Freshness</code> /{' '}
        <code>ForeignKey</code> annotations together.
      </Hint>
      <SchemaObjectInspector
        data={sampleOrderTotals}
        schema={OrderTotalsSchema as unknown as typeof ShowcaseUserSchema}
        expandLevel={2}
      />
    </div>
  ),
}
