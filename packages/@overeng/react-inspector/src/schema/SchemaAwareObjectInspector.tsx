import React, { useMemo } from 'react';
import type { ComponentProps, FC } from 'react';
import type { Schema as S } from 'effect';
import { SchemaProvider } from './SchemaContext.tsx';
import { createSchemaAwareNodeRenderer } from './SchemaAwareNodeRenderer.tsx';

export interface SchemaAwareObjectInspectorDeps {
  /** Original ObjectRootLabel component */
  ObjectRootLabel: FC<{ name?: string; data: unknown }>;
  /** Original ObjectLabel component */
  ObjectLabel: FC<{ name: string; data: unknown; isNonenumerable?: boolean }>;
  /** Original ObjectName component */
  ObjectName: FC<{ name: string; dimmed?: boolean }>;
  /** Original ObjectValue component */
  ObjectValue: FC<{ object: unknown }>;
  /** Original ObjectPreview component */
  ObjectPreview: FC<{ data: unknown }>;
}

/**
 * HOC that wraps ObjectInspector with Effect Schema support.
 * When a schema is provided, the inspector will use schema annotations
 * to provide richer display information including for nested fields.
 *
 * @param ObjectInspector - The inspector component to wrap
 * @param deps - Original components needed for the schema-aware renderer
 */
export const withSchemaSupport = <TInspector extends FC<any>>(
  ObjectInspector: TInspector,
  deps: SchemaAwareObjectInspectorDeps
): FC<ComponentProps<TInspector> & { schema?: S.Schema.AnyNoContext; schemas?: S.Schema.AnyNoContext[] }> => {
  const SchemaAwareObjectInspector: FC<
    ComponentProps<TInspector> & { schema?: S.Schema.AnyNoContext; schemas?: S.Schema.AnyNoContext[] }
  > = ({ schema, schemas, nodeRenderer, ...props }) => {
    const schemaNodeRenderer = useMemo(() => createSchemaAwareNodeRenderer(deps), [deps]);

    const Inspector = ObjectInspector as FC<any>;

    if (schema || (schemas && schemas.length > 0)) {
      return (
        <SchemaProvider schema={schema} schemas={schemas}>
          <Inspector {...props} nodeRenderer={schemaNodeRenderer} />
        </SchemaProvider>
      );
    }

    return <Inspector {...props} nodeRenderer={nodeRenderer} />;
  };

  return SchemaAwareObjectInspector;
};

/**
 * Simple HOC for cases where you don't need nested schema support.
 * Just wraps the inspector with SchemaProvider context.
 */
export const withSchemaContext = <TInspector extends FC<any>>(
  ObjectInspector: TInspector
): FC<ComponentProps<TInspector> & { schema?: S.Schema.AnyNoContext; schemas?: S.Schema.AnyNoContext[] }> => {
  const SchemaAwareObjectInspector: FC<
    ComponentProps<TInspector> & { schema?: S.Schema.AnyNoContext; schemas?: S.Schema.AnyNoContext[] }
  > = ({ schema, schemas, ...props }) => {
    const inspector = <ObjectInspector {...(props as ComponentProps<TInspector>)} />;

    if (schema || (schemas && schemas.length > 0)) {
      return (
        <SchemaProvider schema={schema} schemas={schemas}>
          {inspector}
        </SchemaProvider>
      );
    }

    return inspector;
  };

  return SchemaAwareObjectInspector;
};
