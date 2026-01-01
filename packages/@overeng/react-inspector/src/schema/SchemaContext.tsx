import React, { createContext, useContext, useMemo } from 'react';
import type { FC, ReactNode } from 'react';
import type { Schema as S } from 'effect';
import {
  type SchemaAnnotations,
  type SchemaRegistry,
  getAnnotations,
  getFieldSchema,
  getArrayElementSchema,
  createSchemaRegistry,
  registerSchema,
  lookupSchema,
  formatWithPretty,
  getDisplayName,
} from './effectSchema.tsx';

export interface SchemaContextValue {
  /** The current schema for the data being inspected */
  schema: S.Schema.AnyNoContext | undefined;
  /** The root schema (stays constant during tree traversal) */
  rootSchema: S.Schema.AnyNoContext | undefined;
  /** Registry of schemas for looking up by constructor name */
  registry: SchemaRegistry;
  /** Get annotations for the current schema */
  getAnnotations: () => SchemaAnnotations;
  /** Get display name for the current value (from schema annotations) */
  getDisplayName: () => string | undefined;
  /** Get description for the current value (from schema annotations) */
  getDescription: () => string | undefined;
  /** Format a value using schema's pretty annotation */
  formatValue: (value: unknown) => string | undefined;
  /** Get schema context for a child field */
  getFieldContext: (fieldName: string) => SchemaContextValue;
  /** Get schema context for array elements */
  getElementContext: () => SchemaContextValue;
  /** Look up a schema by name from registry */
  lookupByName: (name: string) => S.Schema.AnyNoContext | undefined;
  /** Get schema for a path like "$.address.street" or "$[0].name" */
  getSchemaForPath: (path: string) => S.Schema.AnyNoContext | undefined;
  /** Get schema context for a path */
  getContextForPath: (path: string) => SchemaContextValue;
}

const defaultContextValue: SchemaContextValue = {
  schema: undefined,
  rootSchema: undefined,
  registry: createSchemaRegistry(),
  getAnnotations: () => ({}),
  getDisplayName: () => undefined,
  getDescription: () => undefined,
  formatValue: () => undefined,
  getFieldContext: () => defaultContextValue,
  getElementContext: () => defaultContextValue,
  lookupByName: () => undefined,
  getSchemaForPath: () => undefined,
  getContextForPath: () => defaultContextValue,
};

const SchemaContext = createContext<SchemaContextValue>(defaultContextValue);

export interface SchemaProviderProps {
  children: ReactNode;
  /** Schema for the data being inspected */
  schema?: S.Schema.AnyNoContext | undefined;
  /** Additional schemas to register for lookup by name */
  schemas?: S.Schema.AnyNoContext[] | undefined;
}

/**
 * Parse a TreeView path into segments.
 * Paths look like: "$", "$.address", "$.items.0", "$.items.0.name"
 */
const parsePathSegments = (path: string): string[] => {
  if (path === '$') return [];
  // Remove leading "$." and split by "."
  const withoutRoot = path.startsWith('$.') ? path.slice(2) : path.slice(1);
  return withoutRoot.split('.');
};

/**
 * Resolve a schema by traversing path segments from root schema.
 */
const resolveSchemaForSegments = (
  rootSchema: S.Schema.AnyNoContext | undefined,
  segments: string[]
): S.Schema.AnyNoContext | undefined => {
  if (!rootSchema) return undefined;
  let current: S.Schema.AnyNoContext | undefined = rootSchema;

  for (const segment of segments) {
    if (!current) return undefined;

    // Check if segment is a numeric index (array access)
    if (/^\d+$/.test(segment)) {
      current = getArrayElementSchema(current);
    } else {
      current = getFieldSchema(current, segment);
    }
  }

  return current;
};

/** Create a context value for a given schema and registry */
const createContextValue = (
  schema: S.Schema.AnyNoContext | undefined,
  registry: SchemaRegistry,
  rootSchema?: S.Schema.AnyNoContext
): SchemaContextValue => {
  const effectiveRootSchema = rootSchema ?? schema;

  const ctx: SchemaContextValue = {
    schema,
    rootSchema: effectiveRootSchema,
    registry,
    getAnnotations: () => (schema ? getAnnotations(schema) : {}),
    getDisplayName: () => (schema ? getDisplayName(getAnnotations(schema)) : undefined),
    getDescription: () => (schema ? getAnnotations(schema).description : undefined),
    formatValue: (value: unknown) => (schema ? formatWithPretty(value, getAnnotations(schema)) : undefined),
    getFieldContext: (fieldName: string) => {
      if (!schema) return createContextValue(undefined, registry, effectiveRootSchema);
      const fieldSchema = getFieldSchema(schema, fieldName);
      return createContextValue(fieldSchema, registry, effectiveRootSchema);
    },
    getElementContext: () => {
      if (!schema) return createContextValue(undefined, registry, effectiveRootSchema);
      const elementSchema = getArrayElementSchema(schema);
      return createContextValue(elementSchema, registry, effectiveRootSchema);
    },
    lookupByName: (name: string) => lookupSchema(registry, name),
    getSchemaForPath: (path: string) => {
      const segments = parsePathSegments(path);
      return resolveSchemaForSegments(effectiveRootSchema, segments);
    },
    getContextForPath: (path: string) => {
      const segments = parsePathSegments(path);
      const pathSchema = resolveSchemaForSegments(effectiveRootSchema, segments);
      return createContextValue(pathSchema, registry, effectiveRootSchema);
    },
  };

  return ctx;
};

export const SchemaProvider: FC<SchemaProviderProps> = ({ children, schema, schemas = [] }) => {
  const value = useMemo(() => {
    const registry = createSchemaRegistry();

    if (schema) {
      registerSchema(registry, schema);
    }

    for (const s of schemas) {
      registerSchema(registry, s);
    }

    return createContextValue(schema, registry);
  }, [schema, schemas]);

  return <SchemaContext.Provider value={value}>{children}</SchemaContext.Provider>;
};

export const useSchemaContext = (): SchemaContextValue => {
  return useContext(SchemaContext);
};

/** Hook to get schema-derived display info for a value */
export const useSchemaDisplayInfo = (
  value: unknown,
  fieldName?: string
): {
  displayName: string | undefined;
  formattedValue: string | undefined;
  hasSchema: boolean;
} => {
  const ctx = useSchemaContext();

  const effectiveCtx = fieldName ? ctx.getFieldContext(fieldName) : ctx;

  const displayName = effectiveCtx.getDisplayName();
  const formattedValue = effectiveCtx.formatValue(value);

  return {
    displayName,
    formattedValue,
    hasSchema: !!effectiveCtx.schema,
  };
};
