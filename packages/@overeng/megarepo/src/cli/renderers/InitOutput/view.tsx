/**
 * InitOutput View
 */

import path from 'node:path'

import React from 'react'

import { Box, Text } from '@overeng/tui-react'

import type { InitState } from './schema.ts'
import { isInitError, isInitAlready } from './schema.ts'

const symbols = {
  check: '\u2713',
  cross: '\u2717',
}

export interface InitViewProps {
  state: InitState
}

/**
 * InitView - View for init command.
 */
export const InitView = ({ state }: InitViewProps) => {
  // Handle error state
  if (isInitError(state)) {
    return (
      <Box flexDirection="row">
        <Text color="red">{symbols.cross}</Text>
        <Text> {state.message}</Text>
      </Box>
    )
  }

  // Handle already initialized
  if (isInitAlready(state)) {
    return <Text dim>megarepo already initialized</Text>
  }

  // Handle success
  const dirName = path.basename(path.dirname(state.path))

  return (
    <Box flexDirection="row">
      <Text color="green">{symbols.check}</Text>
      <Text dim> initialized megarepo at </Text>
      <Text bold>{dirName}</Text>
    </Box>
  )
}
