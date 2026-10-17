import React from 'react'

import { Box, Text } from '@overeng/tui-react'

/** Props for {@link DatabaseHeader}. */
export interface DatabaseHeaderProps {
  name: string
  id: string
  url: string
}

/** Renders a Notion database's name, ID, and URL as a compact header block. */
export const DatabaseHeader = ({ name, id, url }: DatabaseHeaderProps) => (
  <Box flexDirection="column">
    <Box flexDirection="row">
      <Text bold>Database: </Text>
      <Text>{name}</Text>
    </Box>
    <Box flexDirection="row">
      <Text dim>ID: </Text>
      <Text dim>{id}</Text>
    </Box>
    <Box flexDirection="row">
      <Text dim>URL: </Text>
      <Text dim>{url}</Text>
    </Box>
  </Box>
)
