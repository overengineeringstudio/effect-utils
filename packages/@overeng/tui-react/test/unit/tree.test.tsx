/**
 * Tests for Tree component
 */

import React from 'react'
import { describe, test, expect } from 'vitest'

import { createRoot, Tree, Box, Text } from '../../src/mod.tsx'
import { createMockTerminal } from '../helpers/mod.ts'

interface FileNode {
  name: string
  children?: FileNode[]
}

const renderAndCapture = async (element: React.ReactElement): Promise<string> => {
  const terminal = createMockTerminal()
  const root = createRoot({ terminalOrStream: terminal })
  root.render(element)
  await new Promise((r) => setTimeout(r, 50))
  const output = terminal.getPlainOutput().trimEnd()
  root.unmount()
  return output
}

describe('Tree', () => {
  test('renders flat list with tree chars', async () => {
    const items: FileNode[] = [{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }]

    const output = await renderAndCapture(
      <Tree
        items={items}
        renderItem={(item, { prefix }) => (
          <Box flexDirection="row">
            <Text>{prefix}</Text>
            <Text>{item.name}</Text>
          </Box>
        )}
      />,
    )

    expect(output).toMatchInlineSnapshot(`
      "├── alpha
      ├── beta
      └── gamma"
    `)
  })

  test('renders nested tree', async () => {
    const items: FileNode[] = [
      {
        name: 'src',
        children: [{ name: 'mod.ts' }, { name: 'utils.ts' }],
      },
      { name: 'README.md' },
    ]

    const output = await renderAndCapture(
      <Tree
        items={items}
        getChildren={(item) => item.children}
        renderItem={(item, { prefix }) => (
          <Box flexDirection="row">
            <Text>{prefix}</Text>
            <Text>{item.name}</Text>
          </Box>
        )}
      />,
    )

    expect(output).toMatchInlineSnapshot(`
      "├── src
      │   ├── mod.ts
      │   └── utils.ts
      └── README.md"
    `)
  })

  test('renders deeply nested tree', async () => {
    const items: FileNode[] = [
      {
        name: 'a',
        children: [
          {
            name: 'b',
            children: [{ name: 'c' }],
          },
        ],
      },
      { name: 'd' },
    ]

    const output = await renderAndCapture(
      <Tree
        items={items}
        getChildren={(item) => item.children}
        renderItem={(item, { prefix }) => (
          <Box flexDirection="row">
            <Text>{prefix}</Text>
            <Text>{item.name}</Text>
          </Box>
        )}
      />,
    )

    expect(output).toMatchInlineSnapshot(`
      "├── a
      │   └── b
      │       └── c
      └── d"
    `)
  })

  test('renders single item with last-branch char', async () => {
    const output = await renderAndCapture(
      <Tree
        items={[{ name: 'only' }]}
        renderItem={(item: FileNode, { prefix }) => (
          <Box flexDirection="row">
            <Text>{prefix}</Text>
            <Text>{item.name}</Text>
          </Box>
        )}
      />,
    )

    expect(output).toMatchInlineSnapshot(`"└── only"`)
  })

  test('provides correct depth and index in context', async () => {
    const items: FileNode[] = [
      { name: 'root1', children: [{ name: 'child1' }, { name: 'child2' }] },
      { name: 'root2' },
    ]

    const output = await renderAndCapture(
      <Tree
        items={items}
        getChildren={(item) => item.children}
        renderItem={(item, { prefix, depth, index }) => (
          <Box flexDirection="row">
            <Text>{prefix}</Text>
            <Text>
              {item.name} d={depth} i={index}
            </Text>
          </Box>
        )}
      />,
    )

    expect(output).toMatchInlineSnapshot(`
      "├── root1 d=0 i=0
      │   ├── child1 d=1 i=0
      │   └── child2 d=1 i=1
      └── root2 d=0 i=1"
    `)
  })

  test('renders child content with continuation prefix', async () => {
    const items: FileNode[] = [
      { name: 'project-a', children: [{ name: 'sub1' }] },
      { name: 'project-b' },
    ]

    const output = await renderAndCapture(
      <Tree
        items={items}
        getChildren={(item) => item.children}
        renderItem={(item, { prefix }) => (
          <Box flexDirection="row">
            <Text>{prefix}</Text>
            <Text>{item.name}</Text>
          </Box>
        )}
        renderChildContent={(item, { continuationPrefix }) =>
          item.name === 'project-a' ? (
            <Box flexDirection="row">
              <Text>{continuationPrefix}</Text>
              <Text dim> detail line</Text>
            </Box>
          ) : null
        }
      />,
    )

    expect(output).toMatchInlineSnapshot(`
      "├── project-a
      │    detail line
      │   └── sub1
      └── project-b"
    `)
  })

  test('last item child content uses empty prefix', async () => {
    const items: FileNode[] = [{ name: 'first' }, { name: 'last' }]

    const output = await renderAndCapture(
      <Tree
        items={items}
        renderItem={(item, { prefix }) => (
          <Box flexDirection="row">
            <Text>{prefix}</Text>
            <Text>{item.name}</Text>
          </Box>
        )}
        renderChildContent={(item, { continuationPrefix }) =>
          item.name === 'last' ? (
            <Box flexDirection="row">
              <Text>{continuationPrefix}extra</Text>
            </Box>
          ) : null
        }
      />,
    )

    expect(output).toMatchInlineSnapshot(`
      "├── first
      └── last
          extra"
    `)
  })

  test('handles empty items array', async () => {
    const output = await renderAndCapture(
      <Tree
        items={[]}
        renderItem={(_item: FileNode, { prefix }) => (
          <Box flexDirection="row">
            <Text>{prefix}item</Text>
          </Box>
        )}
      />,
    )

    expect(output).toBe('')
  })

  test('skips children when getChildren returns undefined', async () => {
    const items: FileNode[] = [{ name: 'leaf', children: [{ name: 'hidden' }] }]

    const output = await renderAndCapture(
      <Tree
        items={items}
        getChildren={() => undefined}
        renderItem={(item, { prefix }) => (
          <Box flexDirection="row">
            <Text>{prefix}</Text>
            <Text>{item.name}</Text>
          </Box>
        )}
      />,
    )

    expect(output).toMatchInlineSnapshot(`"└── leaf"`)
  })
})
