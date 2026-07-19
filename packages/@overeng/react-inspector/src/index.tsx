export { chromeLight, chromeDark } from './styles/themes/index.tsx'

import { DOMInspector } from './dom-inspector/DOMInspector.tsx'
import { ObjectInspector } from './object-inspector/ObjectInspector.tsx'
import type {
  ObjectInspectorNodeRendererProps,
  ObjectInspectorProps,
} from './object-inspector/ObjectInspector.tsx'
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
  type ObjectInspectorNodeRendererProps,
  type ObjectInspectorProps,
}

import isDOM from 'is-dom'
import React, { type FC } from 'react'
import type { ComponentProps } from 'react'

export const Inspector: FC<TableInspectorProps | InspectorObjectProps> = ({
  table = false,
  data,
  ...rest
}) => {
  if (table === true) {
    return <TableInspector data={data} {...rest} />
  }

  if (isDOM(data) === true) return <DOMInspector data={data} {...rest} />

  return <ObjectInspector data={data} {...rest} />
}

interface TableInspectorProps extends ComponentProps<typeof TableInspector> {
  table: true
}
interface InspectorObjectProps extends ComponentProps<typeof ObjectInspector> {
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
  Lineage,
} from './schema/mod.tsx'

export { createSchemaAwareNodeRenderer } from './schema/SchemaAwareNodeRenderer.tsx'
export { SchemaAwareObjectValue } from './schema/SchemaAwareObjectValue.tsx'
export { SchemaAwareObjectPreview } from './schema/SchemaAwareObjectPreview.tsx'
