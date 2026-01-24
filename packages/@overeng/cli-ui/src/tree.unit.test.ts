import { describe, expect, it } from 'vitest'

import {
  buildContinuationPrefix,
  buildTree,
  buildTreePrefix,
  flattenTree,
  treeChars,
  treeCharsAscii,
  type TreeNode,
} from './tree.ts'

describe('tree', () => {
  describe('treeChars', () => {
    it('has correct Unicode characters', () => {
      expect(treeChars.middle).toBe('├── ')
      expect(treeChars.last).toBe('└── ')
      expect(treeChars.vertical).toBe('│   ')
      expect(treeChars.empty).toBe('    ')
    })

    it('has correct ASCII characters', () => {
      expect(treeCharsAscii.middle).toBe('+-- ')
      expect(treeCharsAscii.last).toBe('\\-- ')
      expect(treeCharsAscii.vertical).toBe('|   ')
      expect(treeCharsAscii.empty).toBe('    ')
    })
  })

  describe('buildTreePrefix', () => {
    it('builds prefix for root level items', () => {
      // First/middle item at root
      expect(buildTreePrefix({ ancestors: [], isLast: false })).toBe('├── ')
      // Last item at root
      expect(buildTreePrefix({ ancestors: [], isLast: true })).toBe('└── ')
    })

    it('builds prefix for nested items under non-last parent', () => {
      // ancestors: [true] means parent has more siblings
      expect(buildTreePrefix({ ancestors: [true], isLast: false })).toBe('│   ├── ')
      expect(buildTreePrefix({ ancestors: [true], isLast: true })).toBe('│   └── ')
    })

    it('builds prefix for nested items under last parent', () => {
      // ancestors: [false] means parent is last (no more siblings)
      expect(buildTreePrefix({ ancestors: [false], isLast: false })).toBe('    ├── ')
      expect(buildTreePrefix({ ancestors: [false], isLast: true })).toBe('    └── ')
    })

    it('builds prefix for deeply nested items', () => {
      // Three levels deep: grandparent has siblings, parent has siblings
      expect(buildTreePrefix({ ancestors: [true, true], isLast: false })).toBe('│   │   ├── ')
      expect(buildTreePrefix({ ancestors: [true, true], isLast: true })).toBe('│   │   └── ')

      // Mixed: grandparent is last, parent has siblings
      expect(buildTreePrefix({ ancestors: [false, true], isLast: true })).toBe('    │   └── ')
    })

    it('uses custom chars when provided', () => {
      expect(
        buildTreePrefix({ ancestors: [], isLast: false, chars: treeCharsAscii }),
      ).toBe('+-- ')
      expect(
        buildTreePrefix({ ancestors: [true], isLast: true, chars: treeCharsAscii }),
      ).toBe('|   \\-- ')
    })
  })

  describe('buildContinuationPrefix', () => {
    it('builds continuation for items at root', () => {
      // Non-last item: show vertical line
      expect(buildContinuationPrefix({ ancestors: [], isLast: false })).toBe('│   ')
      // Last item: no line
      expect(buildContinuationPrefix({ ancestors: [], isLast: true })).toBe('    ')
    })

    it('builds continuation for nested items', () => {
      expect(buildContinuationPrefix({ ancestors: [true], isLast: false })).toBe('│   │   ')
      expect(buildContinuationPrefix({ ancestors: [true], isLast: true })).toBe('│       ')
      expect(buildContinuationPrefix({ ancestors: [false], isLast: false })).toBe('    │   ')
      expect(buildContinuationPrefix({ ancestors: [false], isLast: true })).toBe('        ')
    })
  })

  describe('buildTree', () => {
    it('builds tree from flat list with parent references', () => {
      type Item = { id: string; parentId: string | null; name: string }
      const items: Item[] = [
        { id: '1', parentId: null, name: 'root1' },
        { id: '2', parentId: null, name: 'root2' },
        { id: '3', parentId: '1', name: 'child1' },
        { id: '4', parentId: '1', name: 'child2' },
        { id: '5', parentId: '3', name: 'grandchild' },
      ]

      const result = buildTree({
        items,
        getId: (i) => i.id,
        getParentId: (i) => i.parentId,
      })

      expect(result).toHaveLength(2) // Two roots

      // Check root1 and its children
      const root1 = result.find((n) => n.data.name === 'root1')
      expect(root1).toBeDefined()
      expect(root1!.children).toHaveLength(2)

      const child1 = root1!.children.find((n) => n.data.name === 'child1')
      expect(child1).toBeDefined()
      expect(child1!.children).toHaveLength(1)
      expect(child1!.children[0]!.data.name).toBe('grandchild')

      // Check root2 has no children
      const root2 = result.find((n) => n.data.name === 'root2')
      expect(root2).toBeDefined()
      expect(root2!.children).toHaveLength(0)
    })

    it('handles orphaned items as roots', () => {
      type Item = { id: string; parentId: string | null }
      const items: Item[] = [
        { id: '1', parentId: null },
        { id: '2', parentId: 'nonexistent' }, // Parent doesn't exist
      ]

      const result = buildTree({
        items,
        getId: (i) => i.id,
        getParentId: (i) => i.parentId,
      })

      // Both should be roots (orphan is promoted to root)
      expect(result).toHaveLength(2)
    })

    it('handles empty list', () => {
      const result = buildTree({
        items: [],
        getId: (i: { id: string }) => i.id,
        getParentId: () => null,
      })

      expect(result).toHaveLength(0)
    })
  })

  describe('flattenTree', () => {
    it('flattens tree with correct prefixes', () => {
      type Item = { name: string }
      const nodes: TreeNode<Item>[] = [
        {
          data: { name: 'root1' },
          children: [
            { data: { name: 'child1' }, children: [] },
            { data: { name: 'child2' }, children: [] },
          ],
        },
        {
          data: { name: 'root2' },
          children: [],
        },
      ]

      const result = flattenTree({ nodes })

      expect(result).toHaveLength(4)

      // root1 (not last root)
      expect(result[0]!.data.name).toBe('root1')
      expect(result[0]!.depth).toBe(0)
      expect(result[0]!.isLast).toBe(false)
      expect(result[0]!.prefix).toBe('├── ')

      // child1 (not last child)
      expect(result[1]!.data.name).toBe('child1')
      expect(result[1]!.depth).toBe(1)
      expect(result[1]!.isLast).toBe(false)
      expect(result[1]!.prefix).toBe('│   ├── ')

      // child2 (last child)
      expect(result[2]!.data.name).toBe('child2')
      expect(result[2]!.depth).toBe(1)
      expect(result[2]!.isLast).toBe(true)
      expect(result[2]!.prefix).toBe('│   └── ')

      // root2 (last root)
      expect(result[3]!.data.name).toBe('root2')
      expect(result[3]!.depth).toBe(0)
      expect(result[3]!.isLast).toBe(true)
      expect(result[3]!.prefix).toBe('└── ')
    })

    it('handles deeply nested trees', () => {
      type Item = { name: string }
      const nodes: TreeNode<Item>[] = [
        {
          data: { name: 'a' },
          children: [
            {
              data: { name: 'b' },
              children: [
                {
                  data: { name: 'c' },
                  children: [],
                },
              ],
            },
          ],
        },
      ]

      const result = flattenTree({ nodes })

      expect(result).toHaveLength(3)
      expect(result[0]!.prefix).toBe('└── ') // a is only root
      expect(result[1]!.prefix).toBe('    └── ') // b is only child of a
      expect(result[2]!.prefix).toBe('        └── ') // c is only child of b
    })

    it('handles empty tree', () => {
      const result = flattenTree({ nodes: [] })
      expect(result).toHaveLength(0)
    })

    it('preserves ancestors array for each item', () => {
      type Item = { name: string }
      const nodes: TreeNode<Item>[] = [
        {
          data: { name: 'root' },
          children: [
            { data: { name: 'child' }, children: [] },
          ],
        },
      ]

      const result = flattenTree({ nodes })

      expect(result[0]!.ancestors).toEqual([])
      expect(result[1]!.ancestors).toEqual([false]) // parent (root) is last
    })
  })
})
