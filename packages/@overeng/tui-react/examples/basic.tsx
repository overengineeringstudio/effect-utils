/**
 * Basic example - demonstrates fundamental components and styles.
 *
 * Run: npx tsx examples/basic.tsx
 */

import React from 'react'
import { createRoot, Box, Text } from '../src/mod.ts'

const App = () => (
  <Box>
    <Text bold>@overeng/tui-react Demo</Text>
    <Text dim>────────────────────────</Text>
    <Box paddingTop={1}>
      <Text color="green" bold>✓ Success</Text>
      <Text color="red">✗ Error</Text>
      <Text color="yellow">⚠ Warning</Text>
      <Text color="cyan">ℹ Info</Text>
    </Box>
    <Box paddingTop={1}>
      <Text>Text styles: <Text bold>bold</Text>, <Text dim>dim</Text>, <Text italic>italic</Text>, <Text underline>underline</Text></Text>
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
