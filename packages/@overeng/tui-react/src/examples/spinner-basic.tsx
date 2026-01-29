import React from 'react'

import { Box, Text, Spinner } from '../mod.ts'

/** Basic spinner with loading message */
export const SpinnerBasicExample = () => (
  <Box flexDirection="row">
    <Spinner />
    <Text> Loading...</Text>
  </Box>
)
