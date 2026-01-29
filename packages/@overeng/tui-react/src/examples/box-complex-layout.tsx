import React from 'react'

import { Box, Text } from '../mod.ts'

/** Complex layout demonstrating CLI-like output */
export const BoxComplexLayoutExample = () => (
  <Box>
    <Box flexDirection="row">
      <Text bold>mr sync</Text>
      <Text dim> workspace/project</Text>
    </Box>
    <Text> </Text>
    <Box paddingLeft={2}>
      <Box flexDirection="row">
        <Text color="green">OK</Text>
        <Text> member-1</Text>
      </Box>
      <Box flexDirection="row">
        <Text color="green">OK</Text>
        <Text> member-2</Text>
      </Box>
      <Box flexDirection="row">
        <Text color="red">ERR</Text>
        <Text> member-3</Text>
        <Text dim> (network error)</Text>
      </Box>
    </Box>
  </Box>
)
