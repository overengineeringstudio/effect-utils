/* oxlint-disable oxc/no-barrel-file -- This module is the package's intentional public schema API. */

export {
  type LineageBundle,
  type SchemaAnnotations,
  type SchemaConstraint,
  type SchemaInfo,
  type SchemaRegistry,
  getAnnotations,
  getAnnotationsFromAST,
  getConstraintsFromJSONSchema,
  getDisplayName,
  getPossibleValuesFromAST,
  getSchemaInfo,
  formatWithPretty,
  isEffectSchema,
  getFieldSchema,
  getArrayElementSchema,
  createSchemaRegistry,
  registerSchema,
  lookupSchema,
} from './effectSchema.tsx'

export {
  type SchemaContextValue,
  type SchemaProviderProps,
  SchemaProvider,
  useSchemaContext,
  useSchemaDisplayInfo,
} from './SchemaContext.tsx'

export {
  withSchemaSupport,
  withSchemaContext,
  type SchemaAwareObjectInspectorDeps,
} from './SchemaAwareObjectInspector.tsx'
export { createSchemaAwareNodeRenderer } from './SchemaAwareNodeRenderer.tsx'
export { SchemaAwareObjectValue } from './SchemaAwareObjectValue.tsx'
export { SchemaAwareObjectPreview } from './SchemaAwareObjectPreview.tsx'
export { SchemaTooltip, type SchemaTooltipProps } from './SchemaTooltip.tsx'

export * as Lineage from './lineage.ts'
