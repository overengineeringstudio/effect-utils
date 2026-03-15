import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { createStaticApp } from '../storybook/static-app.ts'
import { TuiStoryPreview } from '../storybook/TuiStoryPreview.tsx'
import { Box } from './Box.tsx'
import { Text } from './Text.tsx'
import { Tree } from './Tree.tsx'

interface FileNode {
  name: string
  children?: FileNode[]
}

const StaticApp = createStaticApp()

export default {
  title: 'Components/Tree',
  component: Tree,
} satisfies Meta

type Story = StoryObj

/** Flat list of items */
export const Flat: Story = {
  render: () => (
    <TuiStoryPreview
      command="tree-demo"
      app={StaticApp}
      View={() => (
        <Tree<FileNode>
          items={[{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }]}
          renderItem={({ item, prefix }) => (
            <Box flexDirection="row">
              <Text>{prefix}</Text>
              <Text>{item.name}</Text>
            </Box>
          )}
        />
      )}
      initialState={null}
    />
  ),
}

/** Nested file tree */
export const Nested: Story = {
  render: () => (
    <TuiStoryPreview
      command="tree-demo"
      app={StaticApp}
      View={() => (
        <Tree<FileNode>
          items={[
            {
              name: 'src',
              children: [
                { name: 'components', children: [{ name: 'Button.tsx' }, { name: 'Input.tsx' }] },
                { name: 'utils', children: [{ name: 'helpers.ts' }] },
                { name: 'mod.ts' },
              ],
            },
            { name: 'package.json' },
            { name: 'tsconfig.json' },
          ]}
          getChildren={(item) => item.children}
          renderItem={({ item, prefix }) => (
            <Box flexDirection="row">
              <Text>{prefix}</Text>
              <Text bold={item.children !== undefined}>{item.name}</Text>
            </Box>
          )}
        />
      )}
      initialState={null}
    />
  ),
}

interface RepoNode {
  name: string
  status: 'success' | 'error' | 'pending'
  branch?: string
  children?: RepoNode[]
}

const statusIcon = (status: RepoNode['status']) => {
  switch (status) {
    case 'success':
      return <Text color="green">✓</Text>
    case 'error':
      return <Text color="red">✗</Text>
    case 'pending':
      return <Text dim>○</Text>
  }
}

/** Megarepo-style tree with status icons */
export const WithStatusIcons: Story = {
  render: () => {
    return (
      <TuiStoryPreview
        command="tree-demo"
        app={StaticApp}
        View={() => (
          <Tree<RepoNode>
            items={[
              {
                name: 'effect-utils',
                status: 'success',
                branch: 'main',
                children: [
                  { name: 'acme-app', status: 'success', branch: 'main' },
                  { name: 'acme-api', status: 'error', branch: 'feat/auth' },
                  { name: 'shared-types', status: 'pending', branch: 'main' },
                ],
              },
              { name: 'livestore', status: 'success', branch: 'main' },
              { name: 'dotfiles', status: 'success', branch: 'main' },
            ]}
            getChildren={(item) => item.children}
            renderItem={({ item, prefix }) => (
              <Box flexDirection="row">
                <Text>{prefix}</Text>
                {statusIcon(item.status)}
                <Text> </Text>
                <Text bold>{item.name}</Text>
                {item.branch !== undefined && <Text dim> {item.branch}</Text>}
              </Box>
            )}
          />
        )}
        initialState={null}
      />
    )
  },
}

/** Tree with child content (details below items) */
export const WithChildContent: Story = {
  render: () => (
    <TuiStoryPreview
      command="tree-demo"
      app={StaticApp}
      View={() => (
        <Tree<FileNode>
          items={[
            { name: 'dotfiles', children: [{ name: 'vim' }, { name: 'zsh' }] },
            { name: 'effect-utils' },
            { name: 'livestore' },
          ]}
          getChildren={(item) => item.children}
          renderItem={({ item, prefix }) => (
            <Box flexDirection="row">
              <Text>{prefix}</Text>
              <Text color="green">✓</Text>
              <Text> </Text>
              <Text bold>{item.name}</Text>
            </Box>
          )}
          renderChildContent={({ item, continuationPrefix }) =>
            item.name === 'dotfiles' ? (
              <Box flexDirection="row">
                <Text dim>{continuationPrefix} flake.lock updated (2 inputs)</Text>
              </Box>
            ) : null
          }
        />
      )}
      initialState={null}
    />
  ),
}
