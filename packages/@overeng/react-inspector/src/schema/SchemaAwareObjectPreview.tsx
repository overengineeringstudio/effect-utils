import React from 'react'
import type { FC, ReactNode } from 'react'

import { SchemaAwareObjectValue } from './SchemaAwareObjectValue.tsx'
import { useSchemaContext, SchemaProvider } from './SchemaContext.tsx'
import { SchemaTooltip } from './SchemaTooltip.tsx'

export interface SchemaAwareObjectPreviewProps {
  data: unknown
  /** The original ObjectPreview component to wrap */
  ObjectPreview: FC<{ data: unknown }>
  /** The original ObjectValue component */
  ObjectValue: FC<{ object: unknown }>
  /** The original ObjectName component */
  ObjectName: FC<{ name: string }>
  /** Property utilities */
  hasOwnProperty: (obj: object, prop: string) => boolean
  getPropertyValue: (obj: object, prop: string) => unknown
  /** Style hooks */
  useStyles: (key: string) => Record<string, unknown>
}

/** Intersperse array elements with a separator */
const intersperse = (arr: ReactNode[], sep: string): ReactNode[] => {
  if (arr.length === 0) return []
  return arr.slice(1).reduce<ReactNode[]>((xs, x) => xs.concat([sep, x]), [arr[0]])
}

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
  const styles = useStyles('ObjectPreview')
  const schemaCtx = useSchemaContext()
  const object = data

  const prettyFormatted = schemaCtx.formatValue(object)
  if (prettyFormatted !== undefined) {
    return <span>{prettyFormatted}</span>
  }

  if (schemaCtx.schema === undefined) {
    return <ObjectPreview data={data} />
  }

  if (
    typeof object !== 'object' ||
    object === null ||
    object instanceof Date ||
    object instanceof RegExp
  ) {
    return <ObjectValue object={object} />
  }

  /*
   * Map/Set: render `<Container>(N)` for the type-badge slot when the schema
   * carries a container label (e.g. `Map<string, Money>(2)`). We don't try
   * to inline-preview the entries the way arrays/objects do — the inspector's
   * default expansion will surface them on click, and our goal here is the
   * collapsed badge.
   *
   * @see https://github.com/overengineeringstudio/effect-utils/issues/686
   */
  if (object instanceof Map || object instanceof Set) {
    const schemaDisplayName = schemaCtx.getDisplayName()
    const info = schemaCtx.getSchemaInfo()
    const label = schemaDisplayName ?? info?.containerLabel
    if (label === undefined) {
      return <ObjectPreview data={data} />
    }
    const descriptionStyle: React.CSSProperties = {
      ...(styles.objectDescription as React.CSSProperties),
      fontStyle: 'italic',
    }
    return (
      <React.Fragment>
        <SchemaTooltip info={info}>
          <span style={descriptionStyle}>{`${label} `}</span>
        </SchemaTooltip>
        <span style={styles.objectDescription as React.CSSProperties}>{`(${object.size})`}</span>
      </React.Fragment>
    )
  }

  if (Array.isArray(object) === true) {
    const maxProperties = (styles.arrayMaxProperties as number) || 10
    const elementCtx = schemaCtx.getElementContext()

    const previewArray = object.slice(0, maxProperties).map((element, index) => (
      // eslint-disable-next-line react/no-array-index-key -- array elements are positional
      <SchemaProvider key={index} schema={elementCtx.schema} schemas={[]}>
        <SchemaAwareObjectValue object={element} ObjectValue={ObjectValue} />
      </SchemaProvider>
    ))
    if (object.length > maxProperties) {
      previewArray.push(<span key="ellipsis">…</span>)
    }
    const arrayLength = object.length

    /*
     * Prefer the array schema's own name (e.g. `OrderItems`) over the
     * constructed `Array<Element>` label. The label sits in the type-badge
     * slot before the `(N)` length suffix.
     */
    const arrayDisplayName = schemaCtx.getDisplayName()
    const info = schemaCtx.getSchemaInfo()
    const containerLabel = info?.containerLabel
    const label = arrayDisplayName ?? containerLabel
    const descriptionStyle: React.CSSProperties = {
      ...(styles.objectDescription as React.CSSProperties),
      fontStyle: 'italic',
    }

    return (
      <React.Fragment>
        {label !== undefined ? (
          <SchemaTooltip info={info}>
            <span style={descriptionStyle}>{`${label} `}</span>
          </SchemaTooltip>
        ) : null}
        <span style={styles.objectDescription as React.CSSProperties}>
          {arrayLength === 0 ? `` : `(${arrayLength})\xa0`}
        </span>
        <span style={styles.preview as React.CSSProperties}>
          [{intersperse(previewArray, ', ')}]
        </span>
      </React.Fragment>
    )
  } else {
    const maxProperties = (styles.objectMaxProperties as number) || 5
    const propertyNodes: ReactNode[] = []
    for (const propertyName in object) {
      if (hasOwnProperty(object, propertyName) === true) {
        let ellipsis
        if (
          propertyNodes.length === maxProperties - 1 &&
          Object.keys(object).length > maxProperties
        ) {
          ellipsis = <span key={'ellipsis'}>…</span>
        }

        const propertyValue = getPropertyValue(object, propertyName)
        const fieldCtx = schemaCtx.getFieldContext(propertyName)

        propertyNodes.push(
          <span key={propertyName}>
            <ObjectName name={propertyName || `""`} />
            :&nbsp;
            <SchemaProvider schema={fieldCtx.schema} schemas={[]}>
              <SchemaAwareObjectValue object={propertyValue} ObjectValue={ObjectValue} />
            </SchemaProvider>
            {ellipsis}
          </span>,
        )
        if (ellipsis !== undefined) break
      }
    }

    const schemaDisplayName = schemaCtx.getDisplayName()
    const info = schemaCtx.getSchemaInfo()
    /*
     * Container label precedence: user-set title/identifier > derived
     * `Record<K, V>` > runtime constructor name. We want a schema-sourced
     * label whenever possible so records show as `Record<string, Money>`
     * rather than `Object`, and named structs show as their identifier.
     */
    const schemaSourcedName = schemaDisplayName ?? info?.containerLabel
    const objectConstructorName =
      schemaSourcedName ?? (object.constructor !== undefined ? object.constructor.name : 'Object')

    const descriptionStyle: React.CSSProperties = {
      ...(styles.objectDescription as React.CSSProperties),
      ...(schemaSourcedName !== undefined ? { fontStyle: 'italic' } : undefined),
    }

    /*
     * Normally we suppress the "Object " prefix to match the browser-devtools
     * convention for unnamed objects. But if the schema carries tooltip
     * content (e.g. a struct annotated with just `description`, no
     * `title`/`identifier`), we have to render *something* for the tooltip to
     * attach to — otherwise the description is unreachable on collapsed
     * roots. Fall back to "Object" in that case.
     */
    const hasTooltipContent = info?.hasContent === true
    const showName = objectConstructorName !== 'Object' || hasTooltipContent

    return (
      <React.Fragment>
        {showName === true ? (
          <SchemaTooltip info={info}>
            <span style={descriptionStyle}>{`${objectConstructorName} `}</span>
          </SchemaTooltip>
        ) : (
          <span style={descriptionStyle} />
        )}
        <span style={styles.preview as React.CSSProperties}>
          {'{'}
          {intersperse(propertyNodes, ', ')}
          {'}'}
        </span>
      </React.Fragment>
    )
  }
}
