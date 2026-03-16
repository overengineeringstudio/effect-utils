/**
 * Generic tree rendering component for hierarchical data.
 *
 * Renders items with tree-drawing characters (├── └── │) and supports
 * arbitrary nesting via a `getChildren` callback. Uses render props
 * for full control over item and child content rendering.
 *
 * @example
 * ```tsx
 * <Tree
 *   items={files}
 *   getChildren={(f) => f.children}
 *   renderItem={({ item, prefix }) => (
 *     <Box flexDirection="row">
 *       <Text>{prefix}</Text>
 *       <Text>{item.name}</Text>
 *     </Box>
 *   )}
 * />
 * ```
 */

import React, { type ReactNode } from 'react'

import { useSymbols } from '../hooks/useSymbols.tsx'
import { Box } from './Box.tsx'

/** Context passed to render callbacks */
export interface TreeItemContext {
  /** Tree prefix string (e.g. "├── ", "│   └── ") to render before the item */
  readonly prefix: string
  /** Whether this is the last item among its siblings */
  readonly isLast: boolean
  /** Zero-based index among siblings */
  readonly index: number
  /** Nesting depth (0 for root items) */
  readonly depth: number
}

/** Context passed to `renderChildContent` */
export interface TreeChildContentContext {
  /** Continuation prefix for content below an item (aligns with tree lines) */
  readonly continuationPrefix: string
  /** Nesting depth of the parent item */
  readonly depth: number
}

/** Props for the Tree component */
export interface TreeProps<TItem> {
  /** Items to render at the top level */
  readonly items: readonly TItem[]
  /** Extract children for recursive rendering. Return undefined/empty for leaf nodes */
  readonly getChildren?: ((item: TItem) => readonly TItem[] | undefined) | undefined
  /** Render a single item. Must include the `prefix` in its output for tree lines to appear */
  readonly renderItem: (args: { item: TItem } & TreeItemContext) => ReactNode
  /** Optional content to render below each item (e.g. details, lock info). Gets a continuation prefix that aligns with the tree */
  readonly renderChildContent?:
    | ((args: { item: TItem } & TreeChildContentContext) => ReactNode)
    | undefined
}

/** Generic tree component that renders hierarchical data with tree-drawing characters */
export const Tree = <TItem,>(props: TreeProps<TItem>): ReactNode => {
  const symbols = useSymbols()

  return (
    <Box>
      <TreeLevel
        items={props.items}
        prefix=""
        depth={0}
        getChildren={props.getChildren}
        renderItem={props.renderItem}
        renderChildContent={props.renderChildContent}
        tree={symbols.tree}
      />
    </Box>
  )
}

interface TreeLevelProps<TItem> {
  readonly items: readonly TItem[]
  readonly prefix: string
  readonly depth: number
  readonly getChildren: TreeProps<TItem>['getChildren']
  readonly renderItem: TreeProps<TItem>['renderItem']
  readonly renderChildContent: TreeProps<TItem>['renderChildContent']
  readonly tree: { branch: string; last: string; vertical: string; empty: string }
}

const TreeLevel = <TItem,>(props: TreeLevelProps<TItem>): ReactNode => {
  const { items, prefix, depth, getChildren, renderItem, renderChildContent, tree } = props

  return (
    <>
      {items.map((item, index) => {
        const isLast = index === items.length - 1
        const branchChar = isLast === true ? tree.last : tree.branch
        const childPrefix = prefix + (isLast === true ? tree.empty : tree.vertical)
        const children = getChildren?.(item)
        const hasChildren = children !== undefined && children.length > 0

        return (
          <React.Fragment key={index}>
            {renderItem({
              item,
              prefix: `${prefix}${branchChar}`,
              isLast,
              index,
              depth,
            })}
            {renderChildContent?.({
              item,
              continuationPrefix: childPrefix,
              depth,
            })}
            {hasChildren === true && (
              <TreeLevel
                items={children}
                prefix={childPrefix}
                depth={depth + 1}
                getChildren={getChildren}
                renderItem={renderItem}
                renderChildContent={renderChildContent}
                tree={tree}
              />
            )}
          </React.Fragment>
        )
      })}
    </>
  )
}
