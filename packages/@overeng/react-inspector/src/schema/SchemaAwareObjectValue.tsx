import React from 'react';
import type { FC } from 'react';
import { useSchemaContext } from './SchemaContext.tsx';

export interface SchemaAwareObjectValueProps {
  object: unknown;
  styles?: React.CSSProperties;
  /** The original ObjectValue component to wrap */
  ObjectValue: FC<{ object: unknown; styles?: React.CSSProperties }>;
}

/**
 * Wrapper component that adds Effect Schema support to ObjectValue.
 * Uses schema annotations to enrich the display:
 * - `pretty` annotation for custom value formatting
 * - `title` or `identifier` annotation for type names
 */
export const SchemaAwareObjectValue: FC<SchemaAwareObjectValueProps> = ({ object, styles, ObjectValue }) => {
  const schemaCtx = useSchemaContext();

  const prettyFormatted = schemaCtx.formatValue(object);
  if (prettyFormatted !== undefined) {
    return <span>{prettyFormatted}</span>;
  }

  if (
    typeof object === 'object' &&
    object !== null &&
    !(object instanceof Date) &&
    !(object instanceof RegExp) &&
    !Array.isArray(object)
  ) {
    const schemaDisplayName = schemaCtx.getDisplayName();
    if (schemaDisplayName && object.constructor?.name === 'Object') {
      return <span>{schemaDisplayName}</span>;
    }
  }

  if (styles) {
    return <ObjectValue object={object} styles={styles} />;
  }

  return <ObjectValue object={object} />;
};
