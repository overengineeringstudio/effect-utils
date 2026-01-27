import React from 'react'
import { Box, Text } from '../mod.ts'

/** Example showing all available text styles */
export const TextStylesExample = () => (
  <Box>
    <Text bold>Bold text</Text>
    <Text dim>Dim text</Text>
    <Text italic>Italic text</Text>
    <Text underline>Underlined text</Text>
    <Text strikethrough>Strikethrough text</Text>
    <Text bold color="cyan">Bold + Cyan</Text>
  </Box>
)
