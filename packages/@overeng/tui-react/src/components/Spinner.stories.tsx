import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '../storybook/TuiStoryPreview.tsx'
import { Box } from './Box.tsx'
import { Spinner, type SpinnerType } from './Spinner.tsx'
import { Text } from './Text.tsx'

const meta: Meta<typeof Spinner> = {
  title: 'Components/Feedback/Spinner',
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
  render: () => (
    <TuiStoryPreview>
      <Box flexDirection="row">
        <Spinner />
        <Text> Loading...</Text>
      </Box>
    </TuiStoryPreview>
  ),
}

export const WithColor: Story = {
  render: () => (
    <TuiStoryPreview>
      <Box flexDirection="row">
        <Spinner color="green" />
        <Text> Processing...</Text>
      </Box>
    </TuiStoryPreview>
  ),
}

/** All available spinner types */
export const AllTypes: Story = {
  render: () => (
    <TuiStoryPreview>
      <Box>
        <Box flexDirection="row">
          <Spinner type="dots" />
          <Text> dots</Text>
        </Box>
        <Box flexDirection="row">
          <Spinner type="line" />
          <Text> line</Text>
        </Box>
        <Box flexDirection="row">
          <Spinner type="arc" />
          <Text> arc</Text>
        </Box>
        <Box flexDirection="row">
          <Spinner type="bounce" />
          <Text> bounce</Text>
        </Box>
        <Box flexDirection="row">
          <Spinner type="bar" />
          <Text> bar</Text>
        </Box>
      </Box>
    </TuiStoryPreview>
  ),
}

export const InContext: Story = {
  render: () => (
    <TuiStoryPreview>
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
    </TuiStoryPreview>
  ),
}
