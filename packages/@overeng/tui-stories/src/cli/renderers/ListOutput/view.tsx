import type { Atom } from '@effect-atom/atom'
import React from 'react'

import { Box, Text, useTuiAtomValue } from '@overeng/tui-react'

import type { ListStateType } from './schema.ts'

/** Props for the ListView component */
export interface ListViewProps {
  readonly stateAtom: Atom.Atom<ListStateType>
}

/** Renders the grouped story list with counts and timeline indicators */
export const ListView = ({ stateAtom }: ListViewProps) => {
  const state = useTuiAtomValue(stateAtom)
  const totalCount = state.groups.reduce((sum, g) => sum + g.stories.length, 0)

  if (state.groups.length === 0) {
    return <Text dim>No stories found.</Text>
  }

  return (
    <Box flexDirection="column">
      {state.groups.map((group) => (
        <Box key={group.title} flexDirection="column">
          <Text>{''}</Text>
          <Text bold>{group.title}</Text>
          {group.stories.map((story) => (
            <Text key={story.name}>
              {'  '}
              {story.name}
              {story.hasTimeline === true ? <Text color="cyan">{' [timeline]'}</Text> : null}
              {story.argCount > 0 ? <Text dim>{` (${story.argCount} args)`}</Text> : null}
            </Text>
          ))}
        </Box>
      ))}
      <Text>{''}</Text>
      <Text dim>
        {totalCount} stories · {state.groups.length} groups
        {state.skippedCount > 0 ? ` · ${state.skippedCount} skipped` : ''}
      </Text>
    </Box>
  )
}
