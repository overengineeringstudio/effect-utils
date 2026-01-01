import React from 'react';
import type { FC, ReactNode } from 'react';
import { SchemaAwareObjectValue } from './SchemaAwareObjectValue.tsx';
import { useSchemaContext, SchemaProvider } from './SchemaContext.tsx';

export interface SchemaAwareObjectPreviewProps {
  data: unknown;
  /** The original ObjectPreview component to wrap */
  ObjectPreview: FC<{ data: unknown }>;
  /** The original ObjectValue component */
  ObjectValue: FC<{ object: unknown }>;
  /** The original ObjectName component */
  ObjectName: FC<{ name: string }>;
  /** Property utilities */
  hasOwnProperty: (obj: object, prop: string) => boolean;
  getPropertyValue: (obj: object, prop: string) => unknown;
  /** Style hooks */
  useStyles: (key: string) => Record<string, unknown>;
}

/** Intersperse array elements with a separator */
const intersperse = (arr: ReactNode[], sep: string): ReactNode[] => {
  if (arr.length === 0) return [];
  return arr.slice(1).reduce<ReactNode[]>((xs, x) => xs.concat([sep, x]), [arr[0]]);
};

/**
 * Wrapper component that adds Effect Schema support to ObjectPreview.
 * Uses schema annotations to enrich the display:
 * - `pretty` annotation for custom value formatting
 * - `title` or `identifier` annotation for type names
 * - Field-level schemas for nested property display
 */
export const SchemaAwareObjectPreview: FC<SchemaAwareObjectPreviewProps> = ({
  data,
  ObjectPreview,
  ObjectValue,
  ObjectName,
  hasOwnProperty,
  getPropertyValue,
  useStyles,
}) => {
  const styles = useStyles('ObjectPreview');
  const schemaCtx = useSchemaContext();
  const object = data;

  const prettyFormatted = schemaCtx.formatValue(object);
  if (prettyFormatted !== undefined) {
    return <span>{prettyFormatted}</span>;
  }

  if (!schemaCtx.schema) {
    return <ObjectPreview data={data} />;
  }

  if (typeof object !== 'object' || object === null || object instanceof Date || object instanceof RegExp) {
    return <ObjectValue object={object} />;
  }

  if (Array.isArray(object)) {
    const maxProperties = (styles.arrayMaxProperties as number) || 10;
    const elementCtx = schemaCtx.getElementContext();

    const previewArray = object.slice(0, maxProperties).map((element, index) => (
      <SchemaProvider key={index} schema={elementCtx.schema} schemas={[]}>
        <SchemaAwareObjectValue object={element} ObjectValue={ObjectValue} />
      </SchemaProvider>
    ));
    if (object.length > maxProperties) {
      previewArray.push(<span key="ellipsis">…</span>);
    }
    const arrayLength = object.length;
    return (
      <React.Fragment>
        <span style={styles.objectDescription as React.CSSProperties}>
          {arrayLength === 0 ? `` : `(${arrayLength})\xa0`}
        </span>
        <span style={styles.preview as React.CSSProperties}>[{intersperse(previewArray, ', ')}]</span>
      </React.Fragment>
    );
  } else {
    const maxProperties = (styles.objectMaxProperties as number) || 5;
    const propertyNodes: ReactNode[] = [];
    for (const propertyName in object) {
      if (hasOwnProperty(object, propertyName)) {
        let ellipsis;
        if (propertyNodes.length === maxProperties - 1 && Object.keys(object).length > maxProperties) {
          ellipsis = <span key={'ellipsis'}>…</span>;
        }

        const propertyValue = getPropertyValue(object, propertyName);
        const fieldCtx = schemaCtx.getFieldContext(propertyName);

        propertyNodes.push(
          <span key={propertyName}>
            <ObjectName name={propertyName || `""`} />
            :&nbsp;
            <SchemaProvider schema={fieldCtx.schema} schemas={[]}>
              <SchemaAwareObjectValue object={propertyValue} ObjectValue={ObjectValue} />
            </SchemaProvider>
            {ellipsis}
          </span>
        );
        if (ellipsis) break;
      }
    }

    const schemaDisplayName = schemaCtx.getDisplayName();
    const objectConstructorName = schemaDisplayName ?? (object.constructor ? object.constructor.name : 'Object');

    return (
      <React.Fragment>
        <span style={styles.objectDescription as React.CSSProperties}>
          {objectConstructorName === 'Object' ? '' : `${objectConstructorName} `}
        </span>
        <span style={styles.preview as React.CSSProperties}>
          {'{'}
          {intersperse(propertyNodes, ', ')}
          {'}'}
        </span>
      </React.Fragment>
    );
  }
};
