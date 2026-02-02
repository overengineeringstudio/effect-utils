import React from 'react'

import type { Color } from '@overeng/tui-core'
import { Box, Text } from '@overeng/tui-react'

/** Describes a single Notion database property with optional select options, groups, and relation info. */
export interface PropertyInfo {
  readonly name: string
  readonly type: string
  readonly options?: readonly string[]
  readonly groups?: readonly string[]
  readonly relationDatabase?: string
}

/** Props for {@link PropertyList}. */
export interface PropertyListProps {
  properties: readonly PropertyInfo[]
  detailed?: boolean
}

const typeColor = (type: string): Color | undefined => {
  switch (type) {
    case 'title':
    case 'rich_text':
    case 'url':
    case 'email':
    case 'phone_number':
      return 'cyan'
    case 'number':
    case 'formula':
    case 'rollup':
      return 'yellow'
    case 'select':
    case 'multi_select':
    case 'status':
      return 'green'
    case 'date':
    case 'created_time':
    case 'last_edited_time':
      return 'magenta'
    case 'checkbox':
      return 'blue'
    case 'relation':
    case 'people':
    case 'created_by':
    case 'last_edited_by':
      return 'white'
    case 'files':
      return 'red'
    default:
      return undefined
  }
}

/** Renders a color-coded list of database properties, optionally including options and relation details. */
export const PropertyList = ({ properties, detailed = false }: PropertyListProps) => (
  <Box flexDirection="column">
    <Text bold>Properties ({properties.length}):</Text>
    {properties.map((prop) => {
      const color = typeColor(prop.type)
      return (
        <React.Fragment key={prop.name}>
          <Box flexDirection="column">
            <Box flexDirection="row">
              <Text> - {prop.name}: </Text>
              <Text color={color} dim={color === undefined}>
                {prop.type}
              </Text>
            </Box>
            {detailed && prop.options && prop.options.length > 0 && (
              <Text dim> options: {prop.options.join(', ')}</Text>
            )}
            {detailed && prop.groups && prop.groups.length > 0 && (
              <Text dim> groups: {prop.groups.join(', ')}</Text>
            )}
            {detailed && prop.relationDatabase && (
              <Text dim> database: {prop.relationDatabase}</Text>
            )}
          </Box>
        </React.Fragment>
      )
    })}
  </Box>
)
