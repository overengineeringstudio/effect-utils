/**
 * Preview of what `tui-stories list` output looks like rendered as a TUI component.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { Box, Text } from '@overeng/tui-react'
import { ALL_OUTPUT_TABS, createStaticApp, TuiStoryPreview } from '@overeng/tui-react/storybook'

const StaticApp = createStaticApp()

const exampleModules = [
  {
    title: 'CLI/Status/Basic',
    stories: [
      { name: 'Default', hasTimeline: false, argCount: 3 },
      { name: 'WithErrors', hasTimeline: false, argCount: 3 },
      { name: 'EmptyWorkspace', hasTimeline: false, argCount: 3 },
    ],
  },
  {
    title: 'CLI/Exec/Running',
    stories: [
      { name: 'RunningVerboseParallel', hasTimeline: true, argCount: 6 },
      { name: 'RunningVerboseSequential', hasTimeline: true, argCount: 6 },
    ],
  },
  {
    title: 'Components/StatusIcon',
    stories: [
      { name: 'SuccessCheck', hasTimeline: false, argCount: 0 },
      { name: 'ErrorCross', hasTimeline: false, argCount: 0 },
      { name: 'ActiveSpinner', hasTimeline: false, argCount: 0 },
    ],
  },
]

const totalCount = exampleModules.reduce((sum, m) => sum + m.stories.length, 0)

const ListView = () => (
  <Box flexDirection="column">
    {exampleModules.map((mod) => (
      <Box key={mod.title} flexDirection="column">
        <Text>{'\n'}</Text>
        <Text bold>{mod.title}</Text>
        {mod.stories.map((story) => (
          <Text key={story.name}>
            {'  '}
            {story.name}
            {story.hasTimeline === true ? <Text color="cyan">{' [timeline]'}</Text> : null}
            {story.argCount > 0 ? <Text dim>{` (${story.argCount} args)`}</Text> : null}
          </Text>
        ))}
      </Box>
    ))}
    <Text>{'\n'}</Text>
    <Text dim>{totalCount} stories total</Text>
  </Box>
)

export default {
  title: 'tui-stories/List',
  component: ListView,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof ListView>

type Story = StoryObj<typeof ListView>

export const Default: Story = {
  render: () => (
    <TuiStoryPreview
      command="tui-stories list --path packages/@overeng/megarepo"
      app={StaticApp}
      View={ListView}
      initialState={null}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}
