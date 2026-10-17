/** Parse MCP tool name format `mcp__<serverName>__<toolName>` into components. */
export const parseMcpToolName = (name: string): { toolName: string; serverName: string } => {
  if (name.startsWith('mcp__') !== true) return { toolName: name, serverName: '' }
  const rest = name.slice('mcp__'.length)
  const separatorIndex = rest.indexOf('__')
  if (separatorIndex === -1) return { toolName: name, serverName: '' }
  return {
    serverName: rest.slice(0, separatorIndex),
    toolName: rest.slice(separatorIndex + 2),
  }
}
