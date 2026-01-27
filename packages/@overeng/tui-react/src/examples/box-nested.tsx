import React from 'react'
import { Box, Text } from '../mod.ts'

/** Nested boxes with indentation */
export const BoxNestedExample = () => (
  <Box>
    <Text bold>Tasks</Text>
    <Box paddingLeft={2}>
      <Text color="green">Task 1 - Done</Text>
      <Text color="yellow">Task 2 - In Progress</Text>
      <Text dim>Task 3 - Pending</Text>
    </Box>
  </Box>
)
