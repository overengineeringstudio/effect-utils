export { chromeLight, chromeDark } from './styles/themes'

import { DOMInspector } from './dom-inspector/DOMInspector'
import { ObjectInspector } from './object-inspector/ObjectInspector'
import { ObjectLabel } from './object-inspector/ObjectLabel'
import { ObjectPreview } from './object-inspector/ObjectPreview'
import { ObjectRootLabel } from './object-inspector/ObjectRootLabel'
import { ObjectName } from './object/ObjectName'
import { ObjectValue } from './object/ObjectValue'
import { TableInspector } from './table-inspector/TableInspector'

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
import React, { ComponentProps, FC } from 'react'

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
} from './schema/mod'

export {
  withSchemaSupport,
  withSchemaContext,
  type SchemaAwareObjectInspectorDeps,
} from './schema/SchemaAwareObjectInspector'
export { createSchemaAwareNodeRenderer } from './schema/SchemaAwareNodeRenderer'
export { SchemaAwareObjectValue } from './schema/SchemaAwareObjectValue'
export { SchemaAwareObjectPreview } from './schema/SchemaAwareObjectPreview'
