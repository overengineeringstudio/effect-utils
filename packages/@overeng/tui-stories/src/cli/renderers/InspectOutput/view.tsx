import type { Atom } from '@effect-atom/atom'
import React from 'react'

import { Box, Text, useTuiAtomValue } from '@overeng/tui-react'

import type { InspectStateType } from './schema.ts'

/** Props for the InspectView component */
export interface InspectViewProps {
  readonly stateAtom: Atom.Atom<InspectStateType>
}

/** Renders detailed info for a single story including args and timeline status */
export const InspectView = ({ stateAtom }: InspectViewProps) => {
  const state = useTuiAtomValue(stateAtom)

  return (
    <Box flexDirection="column">
      <Text>
        <Text dim>Story: </Text>
        <Text bold>{state.id}</Text>
      </Text>
      <Text>
        <Text dim>File: </Text>
        <Text>{state.filePath}</Text>
      </Text>

      {state.args.length > 0 ? (
        <Box flexDirection="column">
          <Text>{''}</Text>
          <Text bold>Args:</Text>
          {state.args.map((arg) => (
            <Text key={arg.name}>
              {'  '}
              <Text color="cyan">--{arg.name}</Text>
              {'  '}
              <Text dim>
                ({arg.options !== undefined ? arg.options.join(' | ') : arg.controlType})
              </Text>
              {arg.description !== undefined ? <Text dim> — {arg.description}</Text> : null}
              {arg.defaultValue !== undefined ? (
                <Text dim>{`  (default: ${arg.defaultValue})`}</Text>
              ) : null}
              {arg.conditional !== undefined ? <Text dim>{` [if ${arg.conditional}]`}</Text> : null}
            </Text>
          ))}
        </Box>
      ) : null}

      <Text>{''}</Text>
      <Text dim>
        Timeline:{' '}
        {state.hasTimeline === true
          ? `yes (${state.timelineEventCount} events, use --final to apply)`
          : 'no'}
      </Text>
    </Box>
  )
}
