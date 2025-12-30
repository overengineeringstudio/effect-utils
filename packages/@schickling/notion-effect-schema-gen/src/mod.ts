/**
 * Schema generation for Notion databases.
 *
 * This module provides functionality to introspect Notion databases
 * and generate Effect schemas from their property definitions.
 *
 * @module
 */

// Code generation
export {
  type GenerateOptions,
  generateSchemaCode,
  getAvailableTransforms,
  getDefaultTransform,
  isReadOnlyProperty,
  PROPERTY_TRANSFORMS,
} from './codegen.ts'
// Config
export { type DatabaseConfig, loadConfig, mergeWithDefaults, type SchemaGenConfig } from './config.ts'
// Introspection
export {
  type DatabaseInfo,
  type FormulaConfig,
  introspectDatabase,
  type NotionPropertyType,
  type NumberFormat,
  type PropertyInfo,
  type PropertyTransformConfig,
  type RelationConfig,
  type RollupConfig,
  type SelectOption,
  type StatusGroup,
} from './introspect.ts'
// Output
export { formatCode, writeSchemaToFile } from './output.ts'
