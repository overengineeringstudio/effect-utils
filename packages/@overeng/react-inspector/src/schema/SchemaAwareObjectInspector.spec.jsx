import { render } from '@testing-library/react'
import { Schema } from 'effect'
import React from 'react'
import { describe, it, expect } from 'vitest'

import { ObjectInspector } from '../object-inspector/ObjectInspector'
import { ObjectRootLabel } from '../object-inspector/ObjectRootLabel'
import { ObjectLabel } from '../object-inspector/ObjectLabel'
import { ObjectPreview } from '../object-inspector/ObjectPreview'
import { ObjectName } from '../object/ObjectName'
import { ObjectValue } from '../object/ObjectValue'
import { withSchemaSupport } from './SchemaAwareObjectInspector'

const SchemaObjectInspector = withSchemaSupport(ObjectInspector, {
  ObjectRootLabel,
  ObjectLabel,
  ObjectName,
  ObjectValue,
  ObjectPreview,
})

describe('SchemaAwareObjectInspector — collapsed schema-aware previews', () => {
  it('renders the schema title exactly once for a collapsed array-item object', async () => {
    const Item = Schema.Struct({ id: Schema.String }).annotations({
      title: 'Source Origin Summary',
    })
    const Root = Schema.Struct({ sourceOrigins: Schema.Array(Item) })

    const { container } = render(
      <SchemaObjectInspector
        data={{ sourceOrigins: [{ id: 'x' }] }}
        schema={Root}
        expandLevel={2}
      />,
    )

    /** Expand levels render the array but keep its item objects collapsed. */
    await new Promise((resolve) => setTimeout(resolve, 0))

    const occurrences = container.textContent.match(/Source Origin Summary/g) ?? []
    expect(occurrences.length).toBe(1)
  })
})
