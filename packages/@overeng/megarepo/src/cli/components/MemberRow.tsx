/** Scope-aware row wrapper — reads ScopeContext and dims all children when out of scope. */

import type { ReactNode } from 'react'

import type { Color } from '@overeng/tui-core'
import { Box, Text } from '@overeng/tui-react'

import { useScope } from './Scope.tsx'

/** Scope-aware row — reads ScopeContext and dims all children when out of scope. */
export const MemberRow = ({
  prefix,
  children,
  backgroundColor,
  extendBackground,
}: {
  prefix?: string | undefined
  children: ReactNode
  backgroundColor?: Color | undefined
  extendBackground?: boolean | undefined
}): ReactNode => {
  const { inScope } = useScope()
  const dim = inScope === false

  return (
    <Box
      flexDirection="row"
      backgroundColor={dim === true ? undefined : backgroundColor}
      extendBackground={dim === true ? false : extendBackground}
    >
      {prefix !== undefined && <Text dim={dim}>{prefix}</Text>}
      {dim === true ? <Text dim>{children}</Text> : children}
    </Box>
  )
}
