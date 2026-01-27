import React from 'react'
import { Box, Text, Spinner } from '../mod.ts'

/** All spinner types */
export const SpinnerAllTypesExample = () => (
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
)
