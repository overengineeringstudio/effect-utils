/**
 * Basic example - demonstrates fundamental components and styles.
 *
 * Run: npx tsx examples/basic.tsx
 *
 * Uses shared example components from src/examples/
 */

import React from 'react'
import { createRoot, Box, Text } from '../src/mod.ts'
import { TextColorsExample, TextStylesExample } from '../src/examples/mod.ts'

const App = () => (
  <Box>
    <Text bold>@overeng/tui-react Demo</Text>
    <Text dim>────────────────────────</Text>

    <Box paddingTop={1}>
      <Text bold>Colors:</Text>
      <Box paddingLeft={2}>
        <TextColorsExample />
      </Box>
    </Box>

    <Box paddingTop={1}>
      <Text bold>Styles:</Text>
      <Box paddingLeft={2}>
        <TextStylesExample />
      </Box>
    </Box>

    <Box paddingTop={1}>
      <Text dim>This is a basic demo of @overeng/tui-react</Text>
    </Box>
  </Box>
)

const root = createRoot(process.stdout)
root.render(<App />)

// Exit after a moment to show the output
setTimeout(() => {
  root.unmount()
  process.exit(0)
}, 100)
