import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { SpinnerBasicExample, SpinnerAllTypesExample } from '../examples/mod.ts'
import { Box } from './Box.tsx'
import { Spinner, type SpinnerType } from './Spinner.tsx'
import { Text } from './Text.tsx'

const meta: Meta<typeof Spinner> = {
  title: 'Components/Spinner',
  component: Spinner,
  argTypes: {
    type: {
      control: 'select',
      options: ['dots', 'line', 'arc', 'bounce', 'bar'] satisfies SpinnerType[],
    },
    color: {
      control: 'select',
      options: ['cyan', 'green', 'yellow', 'red', 'magenta', 'blue', 'white'],
    },
  },
}

export default meta
type Story = StoryObj<typeof Spinner>

/** Basic spinner with loading text */
export const Default: Story = {
  render: () => <SpinnerBasicExample />,
}

export const WithColor: Story = {
  render: () => (
    <Box flexDirection="row">
      <Spinner color="green" />
      <Text> Processing...</Text>
    </Box>
  ),
}

/** All available spinner types */
export const AllTypes: Story = {
  render: () => <SpinnerAllTypesExample />,
}

export const InContext: Story = {
  render: () => (
    <Box>
      <Text bold>Syncing repositories</Text>
      <Box paddingLeft={2}>
        <Box flexDirection="row">
          <Spinner color="cyan" />
          <Text> effect-utils</Text>
          <Text dim> fetching...</Text>
        </Box>
        <Box flexDirection="row">
          <Text color="green">OK</Text>
          <Text> livestore</Text>
        </Box>
      </Box>
    </Box>
  ),
}
