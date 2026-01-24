/**
 * Tree Rendering Helpers
 *
 * Utilities for rendering tree structures in the terminal.
 * Used by status and progress components for nested display.
 */

// =============================================================================
// Tree Characters
// =============================================================================

/** Unicode box-drawing characters for tree rendering */
export const treeChars = {
  /** Branch for middle items: ├── */
  middle: '\u251C\u2500\u2500 ',
  /** Branch for last item: └── */
  last: '\u2514\u2500\u2500 ',
  /** Vertical continuation: │   */
  vertical: '\u2502   ',
  /** Empty spacing (no line):     */
  empty: '    ',
} as const

/** Simpler ASCII tree characters (for environments without Unicode support) */
export const treeCharsAscii = {
  middle: '+-- ',
  last: '\\-- ',
  vertical: '|   ',
  empty: '    ',
} as const

// =============================================================================
// Prefix Building
// =============================================================================

/**
 * Build a tree prefix string for an item at a given depth.
 *
 * @param ancestors - Array of booleans, one per ancestor level.
 *                    `true` means that ancestor has more siblings after it.
 * @param isLast - Whether this item is the last among its siblings.
 * @param chars - Tree characters to use (defaults to Unicode).
 *
 * @example
 * ```
 * // Root level, not last
 * buildTreePrefix([], false) // "├── "
 *
 * // Root level, last
 * buildTreePrefix([], true) // "└── "
 *
 * // Nested under non-last parent, this item is last
 * buildTreePrefix([true], true) // "│   └── "
 *
 * // Nested under last parent, this item is not last
 * buildTreePrefix([false], false) // "    ├── "
 * ```
 */
export const buildTreePrefix = ({
  ancestors,
  isLast,
  chars = treeChars,
}: {
  ancestors: readonly boolean[]
  isLast: boolean
  chars?: typeof treeChars
}): string => {
  // Build prefix from ancestor continuation lines
  let prefix = ''
  for (const hasMoreSiblings of ancestors) {
    prefix += hasMoreSiblings ? chars.vertical : chars.empty
  }

  // Add the branch character for this item
  prefix += isLast ? chars.last : chars.middle

  return prefix
}

/**
 * Build continuation prefix for content lines under a tree item.
 * This is used when an item spans multiple lines.
 *
 * @param ancestors - Array of booleans for ancestor levels.
 * @param isLast - Whether the parent item is last among its siblings.
 * @param chars - Tree characters to use.
 */
export const buildContinuationPrefix = ({
  ancestors,
  isLast,
  chars = treeChars,
}: {
  ancestors: readonly boolean[]
  isLast: boolean
  chars?: typeof treeChars
}): string => {
  let prefix = ''
  for (const hasMoreSiblings of ancestors) {
    prefix += hasMoreSiblings ? chars.vertical : chars.empty
  }
  // Under this item, use vertical if not last, empty if last
  prefix += isLast ? chars.empty : chars.vertical
  return prefix
}

// =============================================================================
// Tree Flattening
// =============================================================================

/** A node in a tree structure */
export type TreeNode<T> = {
  /** The data for this node */
  data: T
  /** Child nodes */
  children: TreeNode<T>[]
}

/** A flattened tree item with rendering metadata */
export type FlatTreeItem<T> = {
  /** The original data */
  data: T
  /** Depth in the tree (0 = root) */
  depth: number
  /** Whether this is the last sibling at its level */
  isLast: boolean
  /** Ancestor continuation flags (for building prefix) */
  ancestors: boolean[]
  /** Pre-computed tree prefix string */
  prefix: string
}

/**
 * Flatten a tree structure into a list with rendering metadata.
 *
 * @param nodes - Root-level tree nodes.
 * @param chars - Tree characters to use.
 * @returns Flattened list with prefix strings computed.
 */
export const flattenTree = <T>({
  nodes,
  chars = treeChars,
}: {
  nodes: readonly TreeNode<T>[]
  chars?: typeof treeChars
}): FlatTreeItem<T>[] => {
  const result: FlatTreeItem<T>[] = []

  const walk = ({
    items,
    ancestors,
  }: {
    items: readonly TreeNode<T>[]
    ancestors: boolean[]
  }): void => {
    for (let i = 0; i < items.length; i++) {
      const node = items[i]!
      const isLast = i === items.length - 1

      const prefix = buildTreePrefix({ ancestors, isLast, chars })

      result.push({
        data: node.data,
        depth: ancestors.length,
        isLast,
        ancestors: [...ancestors],
        prefix,
      })

      if (node.children.length > 0) {
        // When recursing, add whether current node has more siblings
        walk({
          items: node.children,
          ancestors: [...ancestors, !isLast],
        })
      }
    }
  }

  walk({ items: nodes, ancestors: [] })
  return result
}

/**
 * Build a tree structure from a flat list with parent references.
 *
 * @param items - Flat list of items with id and parentId.
 * @param getId - Function to get item's id.
 * @param getParentId - Function to get item's parent id (null for root).
 * @returns Tree nodes (roots only, with children populated).
 */
export const buildTree = <T>({
  items,
  getId,
  getParentId,
}: {
  items: readonly T[]
  getId: (item: T) => string
  getParentId: (item: T) => string | null
}): TreeNode<T>[] => {
  // Create nodes for all items
  const nodeMap = new Map<string, TreeNode<T>>()
  for (const item of items) {
    nodeMap.set(getId(item), { data: item, children: [] })
  }

  // Build parent-child relationships
  const roots: TreeNode<T>[] = []
  for (const item of items) {
    const node = nodeMap.get(getId(item))!
    const parentId = getParentId(item)

    if (parentId === null) {
      roots.push(node)
    } else {
      const parent = nodeMap.get(parentId)
      if (parent) {
        parent.children.push(node)
      } else {
        // Parent not found, treat as root
        roots.push(node)
      }
    }
  }

  return roots
}
