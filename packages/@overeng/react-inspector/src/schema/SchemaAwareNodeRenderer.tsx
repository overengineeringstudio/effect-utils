import React from 'react'
import type { FC } from 'react'

import { useStyles } from '../styles/index.tsx'
import { hasOwnProperty } from '../utils/objectPrototype.tsx'
import { getPropertyValue } from '../utils/propertyUtils.tsx'
import { SchemaAwareObjectPreview } from './SchemaAwareObjectPreview.tsx'
import { SchemaProvider, useSchemaContext } from './SchemaContext.tsx'
import { SchemaTooltip } from './SchemaTooltip.tsx'

export interface SchemaAwareNodeRendererProps {
  /** Original ObjectRootLabel component */
  ObjectRootLabel: FC<{ name?: string; data: unknown }>
  /** Original ObjectLabel component */
  ObjectLabel: FC<{ name: string; data: unknown; isNonenumerable?: boolean }>
  /** Original ObjectName component */
  ObjectName: FC<{ name: string; dimmed?: boolean }>
  /** Original ObjectValue component */
  ObjectValue: FC<{ object: unknown }>
  /** Original ObjectPreview component */
  ObjectPreview: FC<{ data: unknown }>
}

/**
 * Creates a schema-aware node renderer that uses schema annotations for display.
 * Uses path-based schema lookup to resolve the correct schema for any node
 * in the tree, including deeply nested fields.
 */
export const createSchemaAwareNodeRenderer = ({
  ObjectName,
  ObjectValue,
  ObjectPreview,
}: SchemaAwareNodeRendererProps) => {
  /** Schema-aware ObjectValue that uses pretty print and display name */
  const SchemaAwareObjectValue: FC<{ object: unknown; path: string }> = ({ object, path }) => {
    const rootCtx = useSchemaContext()
    const schemaCtx = rootCtx.getContextForPath(path)

    const prettyFormatted = schemaCtx.formatValue(object)
    if (prettyFormatted !== undefined) {
      return <span>{prettyFormatted}</span>
    }

    if (Array.isArray(object) === true) {
      /*
       * For arrays whose schema describes the element type, render
       * `Array<Element>(N)` instead of the default `Array(N)`. The array
       * schema's own `title`/`identifier` (e.g. `Schema.Array(Item)
       * .annotations({ identifier: 'OrderItems' })`) wins over the
       * constructed `Array<Element>` label.
       */
      const schemaDisplayName = schemaCtx.getDisplayName()
      const containerLabel = schemaCtx.getSchemaInfo()?.containerLabel
      const label = schemaDisplayName ?? containerLabel
      if (label !== undefined) {
        return (
          <span>
            <span style={{ fontStyle: 'italic' }}>{label}</span>
            <span>{`(${object.length})`}</span>
          </span>
        )
      }
      return <ObjectValue object={object} />
    }

    if (
      typeof object === 'object' &&
      object !== null &&
      !(object instanceof Date) &&
      !(object instanceof RegExp)
    ) {
      const schemaDisplayName = schemaCtx.getDisplayName()
      if (schemaDisplayName !== undefined && object.constructor?.name === 'Object') {
        return <span>{schemaDisplayName}</span>
      }
    }

    return <ObjectValue object={object} />
  }

  /** Schema-aware ObjectPreview that uses schema annotations */
  const hasOwnPropertyOnObject = (obj: object, prop: string) => hasOwnProperty.call(obj, prop)

  const SchemaAwareObjectPreviewForPath: FC<{
    data: unknown
    path: string
  }> = ({ data, path }) => {
    const rootCtx = useSchemaContext()
    const schemaCtx = rootCtx.getContextForPath(path)

    return (
      <SchemaProvider schema={schemaCtx.schema}>
        <SchemaAwareObjectPreview
          data={data}
          ObjectPreview={ObjectPreview}
          ObjectValue={ObjectValue}
          ObjectName={ObjectName}
          hasOwnProperty={hasOwnPropertyOnObject}
          getPropertyValue={getPropertyValue}
          useStyles={useStyles}
        />
      </SchemaProvider>
    )
  }

  /** Schema-aware ObjectLabel that uses path-based schema lookup */
  const SchemaAwareObjectLabel: FC<{
    name: string | undefined
    data: unknown
    path: string
    isNonenumerable: boolean | undefined
    expanded: boolean | undefined
  }> = ({ name, data, path, isNonenumerable = false, expanded }) => {
    const rootCtx = useSchemaContext()
    const schemaCtx = rootCtx.getContextForPath(path)
    const info = schemaCtx.getSchemaInfo()
    const schemaDisplayName = schemaCtx.getDisplayName()

    const isComplexObject =
      typeof data === 'object' &&
      data !== null &&
      !(data instanceof Date) &&
      !(data instanceof RegExp) &&
      !Array.isArray(data) &&
      data.constructor?.name === 'Object'

    /**
     * Tooltip attaches to the field-name span. For complex objects we still
     * delegate to `SchemaAwareObjectPreviewWithName` for the value/preview side
     * — that component owns its own tooltip on the type-badge inside the
     * preview, which can have different content (the value's type schema may
     * differ from the field's declared schema).
     */
    return (
      <span>
        {typeof name === 'string' ? (
          <SchemaTooltip info={info}>
            <ObjectName name={name} dimmed={isNonenumerable} />
          </SchemaTooltip>
        ) : (
          <SchemaAwareObjectPreviewForPath data={name} path={path} />
        )}
        <span>: </span>
        {isComplexObject === true ? (
          <SchemaAwareObjectPreviewWithName
            data={data}
            schemaDisplayName={schemaDisplayName}
            expanded={expanded}
            path={path}
          />
        ) : (
          <SchemaAwareObjectValue object={data} path={path} />
        )}
      </span>
    )
  }

  /** Schema-aware ObjectRootLabel */
  const SchemaAwareObjectRootLabel: FC<{
    name: string | undefined
    data: unknown
    path: string
    expanded: boolean | undefined
  }> = ({ name, data, path, expanded }) => {
    const rootCtx = useSchemaContext()
    const schemaCtx = rootCtx.getContextForPath(path)
    const info = schemaCtx.getSchemaInfo()

    const prettyFormatted = schemaCtx.formatValue(data)
    if (prettyFormatted !== undefined) {
      if (typeof name === 'string') {
        return (
          <span>
            <SchemaTooltip info={info}>
              <ObjectName name={name} />
            </SchemaTooltip>
            <span>: </span>
            <span>{prettyFormatted}</span>
          </span>
        )
      }
      return (
        <SchemaTooltip info={info}>
          <span>{prettyFormatted}</span>
        </SchemaTooltip>
      )
    }

    const schemaDisplayName = schemaCtx.getDisplayName()

    if (typeof name === 'string') {
      return (
        <span>
          <SchemaTooltip info={info}>
            <ObjectName name={name} />
          </SchemaTooltip>
          <span>: </span>
          <SchemaAwareObjectPreviewWithName
            data={data}
            schemaDisplayName={schemaDisplayName}
            expanded={expanded}
            path={path}
          />
        </span>
      )
    }

    return (
      <SchemaAwareObjectPreviewWithName
        data={data}
        schemaDisplayName={schemaDisplayName}
        expanded={expanded}
        path={path}
      />
    )
  }

  /** Helper for root preview with schema name */
  const SchemaAwareObjectPreviewWithName: FC<{
    data: unknown
    schemaDisplayName: string | undefined
    expanded: boolean | undefined
    path: string
  }> = ({ data, schemaDisplayName, expanded, path }) => {
    const rootCtx = useSchemaContext()
    const schemaCtx = rootCtx.getContextForPath(path)
    const info = schemaCtx.getSchemaInfo()

    const isComplexObject =
      typeof data === 'object' &&
      data !== null &&
      !(data instanceof Date) &&
      !(data instanceof RegExp) &&
      data.constructor?.name === 'Object'

    /**
     * When expanded, show only the type identifier (no inline preview needed
     * since children are visible). The identifier itself is the tooltip
     * trigger — hovering it shows the type's annotations.
     */
    if (expanded === true && isComplexObject === true) {
      const containerLabel = info?.containerLabel
      const schemaSourcedLabel = schemaDisplayName ?? containerLabel
      const label = schemaSourcedLabel ?? data.constructor?.name ?? 'Object'
      return (
        <SchemaTooltip info={info}>
          <span style={schemaSourcedLabel !== undefined ? { fontStyle: 'italic' } : undefined}>
            {label}
          </span>
        </SchemaTooltip>
      )
    }

    /**
     * When collapsed, delegate to the preview. `SchemaAwareObjectPreview` owns
     * the type-badge tooltip inside the preview itself, so this wrapper does
     * not add another one — that would double-trigger.
     */
    return <SchemaAwareObjectPreviewForPath data={data} path={path} />
  }

  /**
   * The node renderer function to pass to ObjectInspector.
   * Uses the `path` prop to resolve the correct schema for each node.
   */
  const schemaAwareNodeRenderer = ({
    depth,
    name,
    data,
    path,
    isNonenumerable,
    expanded,
  }: {
    depth: number
    name: string | undefined
    data: unknown
    path: string
    isNonenumerable: boolean | undefined
    expanded: boolean | undefined
  }) => {
    if (depth === 0) {
      return <SchemaAwareObjectRootLabel name={name} data={data} path={path} expanded={expanded} />
    }

    return (
      <SchemaAwareObjectLabel
        name={name}
        data={data}
        path={path}
        isNonenumerable={isNonenumerable}
        expanded={expanded}
      />
    )
  }

  return schemaAwareNodeRenderer
}
