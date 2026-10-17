import type { Schema } from 'effect'
import React, { useMemo } from 'react'
import type { FC } from 'react'

import { ObjectName } from '../object/ObjectName.tsx'
import { ObjectValue } from '../object/ObjectValue.tsx'
import { createSchemaAwareNodeRenderer } from '../schema/SchemaAwareNodeRenderer.tsx'
import { SchemaProvider } from '../schema/SchemaContext.tsx'
import { themeAcceptor } from '../styles/index.tsx'
import { TreeView } from '../tree-view/TreeView.tsx'
import { propertyIsEnumerable } from '../utils/objectPrototype.tsx'
import { getPropertyValue } from '../utils/propertyUtils.tsx'
import { ObjectLabel } from './ObjectLabel.tsx'
import { ObjectPreview } from './ObjectPreview.tsx'
import { ObjectRootLabel } from './ObjectRootLabel.tsx'

const createIterator = (showNonenumerable: any, sortObjectKeys: any) => {
  const objectIterator = function* (data: any) {
    const shouldIterate = (typeof data === 'object' && data !== null) || typeof data === 'function'
    if (shouldIterate === false) return

    const dataIsArray = Array.isArray(data)

    // iterable objects (except arrays)
    if (dataIsArray === false && data[Symbol.iterator] !== undefined) {
      let i = 0
      for (const entry of data) {
        if (Array.isArray(entry) === true && entry.length === 2) {
          const [k, v] = entry
          yield {
            name: k,
            data: v,
          }
        } else {
          yield {
            name: i.toString(),
            data: entry,
          }
        }
        i++
      }
    } else {
      const keys = Object.getOwnPropertyNames(data)
      if (sortObjectKeys === true && dataIsArray === false) {
        // Array keys should not be sorted in alphabetical order
        keys.sort()
      } else if (typeof sortObjectKeys === 'function') {
        keys.sort(sortObjectKeys)
      }

      for (const propertyName of keys) {
        if (propertyIsEnumerable.call(data, propertyName) === true) {
          const propertyValue = getPropertyValue(data, propertyName)
          yield {
            name: propertyName || `""`,
            data: propertyValue,
          }
        } else if (showNonenumerable === true) {
          // To work around the error (happens some time when propertyName === 'caller' || propertyName === 'arguments')
          // 'caller' and 'arguments' are restricted function properties and cannot be accessed in this context
          // http://stackoverflow.com/questions/31921189/caller-and-arguments-are-restricted-function-properties-and-cannot-be-access
          let propertyValue
          try {
            propertyValue = getPropertyValue(data, propertyName)
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
          } catch (e) {
            // console.warn(e)
          }

          if (propertyValue !== undefined) {
            yield {
              name: propertyName,
              data: propertyValue,
              isNonenumerable: true,
            }
          }
        }
      }

      // [[Prototype]] of the object: `Object.getPrototypeOf(data)`
      // the property name is shown as "__proto__"
      if (showNonenumerable === true && data !== Object.prototype /* already added */) {
        yield {
          name: '__proto__',
          data: Object.getPrototypeOf(data),
          isNonenumerable: true,
        }
      }
    }
  }

  return objectIterator
}

const defaultNodeRenderer = ({ depth, name, data, isNonenumerable }: any) =>
  depth === 0 ? (
    <ObjectRootLabel name={name} data={data} />
  ) : (
    <ObjectLabel name={name} data={data} isNonenumerable={isNonenumerable} />
  )

/**
 * Tree-view for objects
 */
export interface ObjectInspectorNodeRendererProps {
  depth: number
  path: string
  expanded: boolean
  name?: string
  data: unknown
  isNonenumerable?: boolean
}

export interface ObjectInspectorProps {
  name?: string
  data?: unknown
  expandLevel?: number
  expandPaths?: string | ReadonlyArray<string>
  showNonenumerable?: boolean
  sortObjectKeys?: boolean | ((left: string, right: string) => number)
  nodeRenderer?: FC<ObjectInspectorNodeRendererProps>
  schema?: Schema.Top
  schemas?: ReadonlyArray<Schema.Top>
}

const ObjectInspector: FC<ObjectInspectorProps> = ({
  showNonenumerable = false,
  sortObjectKeys,
  nodeRenderer,
  schema,
  schemas,
  ...treeViewProps
}) => {
  const dataIterator = createIterator(showNonenumerable, sortObjectKeys)
  const schemaNodeRenderer = useMemo(
    () =>
      createSchemaAwareNodeRenderer({
        ObjectName,
        ObjectValue,
        ObjectPreview,
      }),
    [],
  )
  const hasSchema = schema !== undefined || (schemas?.length ?? 0) > 0
  const renderer =
    hasSchema === true
      ? schemaNodeRenderer
      : nodeRenderer !== undefined
        ? nodeRenderer
        : defaultNodeRenderer
  const inspector = (
    <TreeView nodeRenderer={renderer} dataIterator={dataIterator} {...treeViewProps} />
  )

  return hasSchema === true ? (
    <SchemaProvider schema={schema} schemas={schemas} rootData={treeViewProps.data}>
      {inspector}
    </SchemaProvider>
  ) : (
    inspector
  )
}

// ObjectInspector.propTypes = {
//   /** An integer specifying to which level the tree should be initially expanded. */
//   expandLevel: PropTypes.number,
//   /** An array containing all the paths that should be expanded when the component is initialized, or a string of just one path */
//   expandPaths: PropTypes.oneOfType([PropTypes.string, PropTypes.array]),

//   name: PropTypes.string,
//   /** Not required prop because we also allow undefined value */
//   data: PropTypes.any,

//   /** Show non-enumerable properties */
//   showNonenumerable: PropTypes.bool,
//   /** Sort object keys with optional compare function. */
//   sortObjectKeys: PropTypes.oneOfType([PropTypes.bool, PropTypes.func]),

//   /** Provide a custom nodeRenderer */
//   nodeRenderer: PropTypes.func,
// };

const themedObjectInspector = themeAcceptor(ObjectInspector)

export { themedObjectInspector as ObjectInspector }
