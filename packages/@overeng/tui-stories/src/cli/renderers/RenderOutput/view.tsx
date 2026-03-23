import type { Atom } from '@effect-atom/atom'
import React from 'react'

import { Box, Text, Spinner, useTuiAtomValue } from '@overeng/tui-react'

import type { RenderStateType } from './schema.ts'

/** Props for the RenderView component */
export interface RenderViewProps {
  readonly stateAtom: Atom.Atom<RenderStateType>
}

/** Renders the output of a `tui-stories render` command */
export const RenderView = ({ stateAtom }: RenderViewProps) => {
  const state = useTuiAtomValue(stateAtom)

  switch (state._tag) {
    case 'Rendering':
      return (
        <Box flexDirection="column">
          <Text>
            <Spinner type="dots" />
            <Text dim>{` Rendering ${state.storyId}...`}</Text>
          </Text>
          <Text dim>{`  width: ${state.width} · timeline: ${state.timelineMode}`}</Text>
        </Box>
      )

    case 'Complete':
      return (
        <Box flexDirection="column">
          {state.renderedLines.map((line) => (
            <Text key={line}>{line}</Text>
          ))}
        </Box>
      )

    case 'Error':
      return (
        <Box flexDirection="column">
          <Text color="red" bold>
            {'✗ '}
            {state.message}
          </Text>
          <Text dim> Story: {state.storyId}</Text>
          <Text dim>{'  Use `tui-stories list --path <dir>` to see available stories.'}</Text>
        </Box>
      )
  }
}
