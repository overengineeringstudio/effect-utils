export { chromeLight, chromeDark } from './styles/themes/index.tsx'

import { DOMInspector } from './dom-inspector/DOMInspector.tsx'
import { ObjectInspector } from './object-inspector/ObjectInspector.tsx'
import { ObjectLabel } from './object-inspector/ObjectLabel.tsx'
import { ObjectPreview } from './object-inspector/ObjectPreview.tsx'
import { ObjectRootLabel } from './object-inspector/ObjectRootLabel.tsx'
import { ObjectName } from './object/ObjectName.tsx'
import { ObjectValue } from './object/ObjectValue.tsx'
import { TableInspector } from './table-inspector/TableInspector.tsx'

export {
  TableInspector,
  ObjectInspector,
  ObjectLabel,
  ObjectPreview,
  ObjectRootLabel,
  ObjectValue,
  ObjectName,
}

import isDOM from 'is-dom'
import React, { type FC } from 'react'
import type { ComponentProps } from 'react'

export const Inspector: FC<TableInspectorProps | ObjectInspectorProps> = ({
  table = false,
  data,
  ...rest
}) => {
  if (table) {
    return <TableInspector data={data} {...rest} />
  }

  if (isDOM(data)) return <DOMInspector data={data} {...rest} />

  return <ObjectInspector data={data} {...rest} />
}

interface TableInspectorProps extends ComponentProps<typeof TableInspector> {
  table: true
}
interface ObjectInspectorProps extends ComponentProps<typeof ObjectInspector> {
  table: false
}

// ============================================================================
// Fork additions: Effect Schema support
// All new code is in src/schema/ - these are just re-exports
// ============================================================================
export {
  SchemaProvider,
  useSchemaContext,
  useSchemaDisplayInfo,
  type SchemaContextValue,
  type SchemaProviderProps,
} from './schema/mod.ts'

export {
  withSchemaSupport,
  withSchemaContext,
  type SchemaAwareObjectInspectorDeps,
} from './schema/SchemaAwareObjectInspector.tsx'
export { createSchemaAwareNodeRenderer } from './schema/SchemaAwareNodeRenderer.tsx'
export { SchemaAwareObjectValue } from './schema/SchemaAwareObjectValue.tsx'
export { SchemaAwareObjectPreview } from './schema/SchemaAwareObjectPreview.tsx'
