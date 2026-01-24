import { describe, it, expect, beforeEach } from 'vitest'

import {
  createTreeProgressState,
  renderTreeProgress,
  formatTreeProgressSummary,
  markTreeItemActive,
  markTreeItemSuccess,
  markTreeItemError,
  markTreeItemSkipped,
  addTreeItem,
  removeTreeItem,
  isTreeComplete,
  getTreeStatusCounts,
  getTreeItemsByStatus,
  getTreeChildren,
  updateTreeItemStatus,
  type TreeProgressState,
} from './tree-progress.ts'
import { treeCharsAscii } from './tree.ts'
import { stripAnsi } from './utils.ts'

describe('tree-progress', () => {
  // ==========================================================================
  // State Creation
  // ==========================================================================

  describe('createTreeProgressState', () => {
    it('creates state with items set to pending', () => {
      const state = createTreeProgressState({
        items: [
          { id: 'a', parentId: null, label: 'Item A' },
          { id: 'b', parentId: null, label: 'Item B' },
        ],
      })

      expect(state.items).toHaveLength(2)
      expect(state.items[0]!.status).toBe('pending')
      expect(state.items[1]!.status).toBe('pending')
    })

    it('preserves custom data on items', () => {
      const state = createTreeProgressState({
        items: [{ id: 'a', parentId: null, label: 'Item A', data: { path: '/foo' } }],
      })

      expect(state.items[0]!.data).toEqual({ path: '/foo' })
    })

    it('initializes with default options', () => {
      const state = createTreeProgressState({ items: [] })

      expect(state.options.spinnerInterval).toBe(80)
      expect(state.options.showSummary).toBe(true)
    })

    it('accepts custom options', () => {
      const state = createTreeProgressState({
        items: [],
        options: {
          spinnerInterval: 100,
          showSummary: false,
          chars: treeCharsAscii,
        },
      })

      expect(state.options.spinnerInterval).toBe(100)
      expect(state.options.showSummary).toBe(false)
      expect(state.options.chars).toBe(treeCharsAscii)
    })
  })

  // ==========================================================================
  // Rendering
  // ==========================================================================

  describe('renderTreeProgress', () => {
    it('renders flat list without tree prefixes', () => {
      const state = createTreeProgressState({
        items: [
          { id: 'a', parentId: null, label: 'Item A' },
          { id: 'b', parentId: null, label: 'Item B' },
        ],
      })

      const lines = renderTreeProgress(state)
      expect(lines).toHaveLength(2)
      // Root items have no prefix
      expect(stripAnsi(lines[0]!)).toContain('Item A')
      expect(stripAnsi(lines[1]!)).toContain('Item B')
    })

    it('renders nested items with tree prefixes', () => {
      const state = createTreeProgressState({
        items: [
          { id: 'root', parentId: null, label: 'Root' },
          { id: 'child1', parentId: 'root', label: 'Child 1' },
          { id: 'child2', parentId: 'root', label: 'Child 2' },
        ],
        options: { chars: treeCharsAscii },
      })

      const lines = renderTreeProgress(state)
      expect(lines).toHaveLength(3)

      const stripped = lines.map(stripAnsi)
      expect(stripped[0]).toContain('Root')
      expect(stripped[1]).toContain('+--')
      expect(stripped[1]).toContain('Child 1')
      expect(stripped[2]).toContain('\\--')
      expect(stripped[2]).toContain('Child 2')
    })

    it('renders deeply nested items', () => {
      const state = createTreeProgressState({
        items: [
          { id: 'a', parentId: null, label: 'A' },
          { id: 'b', parentId: 'a', label: 'B' },
          { id: 'c', parentId: 'b', label: 'C' },
        ],
        options: { chars: treeCharsAscii },
      })

      const lines = renderTreeProgress(state)
      const stripped = lines.map(stripAnsi)

      expect(stripped[0]).toContain('A')
      expect(stripped[1]).toContain('B')
      expect(stripped[2]).toContain('C')
      // Deep nesting shows continuation
      expect(stripped[2]).toMatch(/\s+\\--/)
    })

    it('renders different status icons', () => {
      const state = createTreeProgressState({
        items: [
          { id: 'pending', parentId: null, label: 'Pending' },
          { id: 'active', parentId: null, label: 'Active' },
          { id: 'success', parentId: null, label: 'Success' },
          { id: 'error', parentId: null, label: 'Error' },
          { id: 'skipped', parentId: null, label: 'Skipped' },
        ],
      })

      markTreeItemActive({ state, id: 'active' })
      markTreeItemSuccess({ state, id: 'success' })
      markTreeItemError({ state, id: 'error' })
      markTreeItemSkipped({ state, id: 'skipped' })

      const lines = renderTreeProgress(state)
      const stripped = lines.map(stripAnsi)

      // Check each line has the label
      expect(stripped[0]).toContain('Pending')
      expect(stripped[1]).toContain('Active')
      expect(stripped[2]).toContain('Success')
      expect(stripped[3]).toContain('Error')
      expect(stripped[4]).toContain('Skipped')
    })

    it('renders message for active items', () => {
      const state = createTreeProgressState({
        items: [{ id: 'a', parentId: null, label: 'Task' }],
      })
      markTreeItemActive({ state, id: 'a', message: 'fetching...' })

      const lines = renderTreeProgress(state)
      expect(stripAnsi(lines[0]!)).toContain('fetching...')
    })

    it('renders message for error items', () => {
      const state = createTreeProgressState({
        items: [{ id: 'a', parentId: null, label: 'Task' }],
      })
      markTreeItemError({ state, id: 'a', message: 'connection failed' })

      const lines = renderTreeProgress(state)
      expect(stripAnsi(lines[0]!)).toContain('connection failed')
    })
  })

  describe('formatTreeProgressSummary', () => {
    it('shows completion progress', () => {
      const state = createTreeProgressState({
        items: [
          { id: 'a', parentId: null, label: 'A' },
          { id: 'b', parentId: null, label: 'B' },
          { id: 'c', parentId: null, label: 'C' },
        ],
      })
      markTreeItemSuccess({ state, id: 'a' })

      const summary = formatTreeProgressSummary(state)
      expect(stripAnsi(summary)).toContain('1/3')
    })

    it('shows error count when there are errors', () => {
      const state = createTreeProgressState({
        items: [
          { id: 'a', parentId: null, label: 'A' },
          { id: 'b', parentId: null, label: 'B' },
        ],
      })
      markTreeItemSuccess({ state, id: 'a' })
      markTreeItemError({ state, id: 'b' })

      const summary = formatTreeProgressSummary(state)
      expect(stripAnsi(summary)).toContain('2/2')
      expect(stripAnsi(summary)).toContain('1 error')
    })

    it('pluralizes errors correctly', () => {
      const state = createTreeProgressState({
        items: [
          { id: 'a', parentId: null, label: 'A' },
          { id: 'b', parentId: null, label: 'B' },
        ],
      })
      markTreeItemError({ state, id: 'a' })
      markTreeItemError({ state, id: 'b' })

      const summary = formatTreeProgressSummary(state)
      expect(stripAnsi(summary)).toContain('2 errors')
    })

    it('counts skipped as completed', () => {
      const state = createTreeProgressState({
        items: [
          { id: 'a', parentId: null, label: 'A' },
          { id: 'b', parentId: null, label: 'B' },
        ],
      })
      markTreeItemSkipped({ state, id: 'a' })

      const summary = formatTreeProgressSummary(state)
      expect(stripAnsi(summary)).toContain('1/2')
    })
  })

  // ==========================================================================
  // State Updates
  // ==========================================================================

  describe('status updates', () => {
    let state: TreeProgressState

    beforeEach(() => {
      state = createTreeProgressState({
        items: [
          { id: 'a', parentId: null, label: 'A' },
          { id: 'b', parentId: null, label: 'B' },
        ],
      })
    })

    it('markTreeItemActive sets active status', () => {
      markTreeItemActive({ state, id: 'a' })
      expect(state.items[0]!.status).toBe('active')
    })

    it('markTreeItemActive sets message', () => {
      markTreeItemActive({ state, id: 'a', message: 'working...' })
      expect(state.items[0]!.message).toBe('working...')
    })

    it('markTreeItemSuccess sets success status', () => {
      markTreeItemSuccess({ state, id: 'a' })
      expect(state.items[0]!.status).toBe('success')
    })

    it('markTreeItemSuccess can set message', () => {
      markTreeItemSuccess({ state, id: 'a', message: 'done in 2s' })
      expect(state.items[0]!.message).toBe('done in 2s')
    })

    it('markTreeItemError sets error status', () => {
      markTreeItemError({ state, id: 'a' })
      expect(state.items[0]!.status).toBe('error')
    })

    it('markTreeItemError sets message', () => {
      markTreeItemError({ state, id: 'a', message: 'failed' })
      expect(state.items[0]!.message).toBe('failed')
    })

    it('markTreeItemSkipped sets skipped status', () => {
      markTreeItemSkipped({ state, id: 'a' })
      expect(state.items[0]!.status).toBe('skipped')
    })

    it('updateTreeItemStatus updates any status', () => {
      updateTreeItemStatus({ state, id: 'a', status: 'error', message: 'timeout' })
      expect(state.items[0]!.status).toBe('error')
      expect(state.items[0]!.message).toBe('timeout')
    })

    it('ignores updates for non-existent items', () => {
      markTreeItemActive({ state, id: 'nonexistent' })
      // Should not throw, just no-op
      expect(state.items).toHaveLength(2)
    })
  })

  describe('addTreeItem', () => {
    it('adds new item to state', () => {
      const state = createTreeProgressState({ items: [{ id: 'a', parentId: null, label: 'A' }] })

      addTreeItem({ state, item: { id: 'b', parentId: 'a', label: 'B' } })

      expect(state.items).toHaveLength(2)
      expect(state.items[1]!.id).toBe('b')
      expect(state.items[1]!.parentId).toBe('a')
      expect(state.items[1]!.status).toBe('pending')
    })

    it('does not add duplicate items', () => {
      const state = createTreeProgressState({ items: [{ id: 'a', parentId: null, label: 'A' }] })

      addTreeItem({ state, item: { id: 'a', parentId: null, label: 'A duplicate' } })

      expect(state.items).toHaveLength(1)
      expect(state.items[0]!.label).toBe('A') // Original unchanged
    })

    it('preserves custom data', () => {
      const state = createTreeProgressState<{ path: string }>({ items: [] })

      addTreeItem({
        state,
        item: {
          id: 'a',
          parentId: null,
          label: 'A',
          data: { path: '/a' },
        },
      })

      expect(state.items[0]!.data).toEqual({ path: '/a' })
    })
  })

  describe('removeTreeItem', () => {
    it('removes item from state', () => {
      const state = createTreeProgressState({
        items: [
          { id: 'a', parentId: null, label: 'A' },
          { id: 'b', parentId: null, label: 'B' },
        ],
      })

      removeTreeItem({ state, id: 'a' })

      expect(state.items).toHaveLength(1)
      expect(state.items[0]!.id).toBe('b')
    })

    it('does nothing for non-existent items', () => {
      const state = createTreeProgressState({ items: [{ id: 'a', parentId: null, label: 'A' }] })

      removeTreeItem({ state, id: 'nonexistent' })

      expect(state.items).toHaveLength(1)
    })
  })

  // ==========================================================================
  // Status Queries
  // ==========================================================================

  describe('isTreeComplete', () => {
    it('returns false when items are pending', () => {
      const state = createTreeProgressState({ items: [{ id: 'a', parentId: null, label: 'A' }] })

      expect(isTreeComplete(state)).toBe(false)
    })

    it('returns false when items are active', () => {
      const state = createTreeProgressState({ items: [{ id: 'a', parentId: null, label: 'A' }] })
      markTreeItemActive({ state, id: 'a' })

      expect(isTreeComplete(state)).toBe(false)
    })

    it('returns true when all items are success', () => {
      const state = createTreeProgressState({
        items: [
          { id: 'a', parentId: null, label: 'A' },
          { id: 'b', parentId: null, label: 'B' },
        ],
      })
      markTreeItemSuccess({ state, id: 'a' })
      markTreeItemSuccess({ state, id: 'b' })

      expect(isTreeComplete(state)).toBe(true)
    })

    it('returns true when all items are error', () => {
      const state = createTreeProgressState({ items: [{ id: 'a', parentId: null, label: 'A' }] })
      markTreeItemError({ state, id: 'a' })

      expect(isTreeComplete(state)).toBe(true)
    })

    it('returns true when all items are skipped', () => {
      const state = createTreeProgressState({ items: [{ id: 'a', parentId: null, label: 'A' }] })
      markTreeItemSkipped({ state, id: 'a' })

      expect(isTreeComplete(state)).toBe(true)
    })

    it('returns true for mixed completed statuses', () => {
      const state = createTreeProgressState({
        items: [
          { id: 'a', parentId: null, label: 'A' },
          { id: 'b', parentId: null, label: 'B' },
          { id: 'c', parentId: null, label: 'C' },
        ],
      })
      markTreeItemSuccess({ state, id: 'a' })
      markTreeItemError({ state, id: 'b' })
      markTreeItemSkipped({ state, id: 'c' })

      expect(isTreeComplete(state)).toBe(true)
    })

    it('returns true for empty state', () => {
      const state = createTreeProgressState({ items: [] })
      expect(isTreeComplete(state)).toBe(true)
    })
  })

  describe('getTreeStatusCounts', () => {
    it('counts all statuses', () => {
      const state = createTreeProgressState({
        items: [
          { id: 'a', parentId: null, label: 'A' },
          { id: 'b', parentId: null, label: 'B' },
          { id: 'c', parentId: null, label: 'C' },
          { id: 'd', parentId: null, label: 'D' },
          { id: 'e', parentId: null, label: 'E' },
        ],
      })
      markTreeItemActive({ state, id: 'b' })
      markTreeItemSuccess({ state, id: 'c' })
      markTreeItemError({ state, id: 'd' })
      markTreeItemSkipped({ state, id: 'e' })

      const counts = getTreeStatusCounts(state)

      expect(counts.pending).toBe(1)
      expect(counts.active).toBe(1)
      expect(counts.success).toBe(1)
      expect(counts.error).toBe(1)
      expect(counts.skipped).toBe(1)
    })
  })

  describe('getTreeItemsByStatus', () => {
    it('returns items matching status', () => {
      const state = createTreeProgressState({
        items: [
          { id: 'a', parentId: null, label: 'A' },
          { id: 'b', parentId: null, label: 'B' },
          { id: 'c', parentId: null, label: 'C' },
        ],
      })
      markTreeItemSuccess({ state, id: 'a' })
      markTreeItemSuccess({ state, id: 'c' })

      const successItems = getTreeItemsByStatus({ state, status: 'success' })

      expect(successItems).toHaveLength(2)
      expect(successItems.map((i) => i.id)).toEqual(['a', 'c'])
    })

    it('returns empty array when no items match', () => {
      const state = createTreeProgressState({ items: [{ id: 'a', parentId: null, label: 'A' }] })

      const errorItems = getTreeItemsByStatus({ state, status: 'error' })

      expect(errorItems).toHaveLength(0)
    })
  })

  describe('getTreeChildren', () => {
    it('returns children of a parent', () => {
      const state = createTreeProgressState({
        items: [
          { id: 'root', parentId: null, label: 'Root' },
          { id: 'child1', parentId: 'root', label: 'Child 1' },
          { id: 'child2', parentId: 'root', label: 'Child 2' },
          { id: 'grandchild', parentId: 'child1', label: 'Grandchild' },
        ],
      })

      const children = getTreeChildren({ state, parentId: 'root' })

      expect(children).toHaveLength(2)
      expect(children.map((i) => i.id)).toEqual(['child1', 'child2'])
    })

    it('returns root items when parentId is null', () => {
      const state = createTreeProgressState({
        items: [
          { id: 'root1', parentId: null, label: 'Root 1' },
          { id: 'root2', parentId: null, label: 'Root 2' },
          { id: 'child', parentId: 'root1', label: 'Child' },
        ],
      })

      const roots = getTreeChildren({ state, parentId: null })

      expect(roots).toHaveLength(2)
      expect(roots.map((i) => i.id)).toEqual(['root1', 'root2'])
    })

    it('returns empty array for leaf nodes', () => {
      const state = createTreeProgressState({
        items: [
          { id: 'root', parentId: null, label: 'Root' },
          { id: 'leaf', parentId: 'root', label: 'Leaf' },
        ],
      })

      const children = getTreeChildren({ state, parentId: 'leaf' })

      expect(children).toHaveLength(0)
    })
  })
})
