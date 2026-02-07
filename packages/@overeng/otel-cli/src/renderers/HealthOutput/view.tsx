/**
 * Health TUI view
 *
 * Renders OTEL stack health check results.
 */

import type { Atom } from '@effect-atom/atom'
import React from 'react'

import { Box, Text, useTuiAtomValue, useSymbols } from '@overeng/tui-react'

import type { ComponentHealth, HealthState } from './schema.ts'

// =============================================================================
// Props
// =============================================================================

/** Props for the HealthView component. */
export interface HealthViewProps {
  /** State atom from the TUI app. */
  readonly stateAtom: Atom.Atom<HealthState>
}

// =============================================================================
// Main View
// =============================================================================

/** Root view for health check output. */
export const HealthView = ({ stateAtom }: HealthViewProps) => {
  const state = useTuiAtomValue(stateAtom)
  const symbols = useSymbols()

  if (state._tag === 'Loading') {
    return (
      <Box flexDirection="row">
        <Text color="blue">{symbols.status.circle}</Text>
        <Text> {state.message}</Text>
      </Box>
    )
  }

  if (state._tag === 'Error') {
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color="red">{symbols.status.cross}</Text>
          <Text color="red" bold>
            {' '}
            Error: {state.error}
          </Text>
        </Box>
        <Text color="gray">{state.message}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text bold>OTEL Stack Health</Text>
        <Text> </Text>
        {state.allHealthy ? (
          <Text color="green">{symbols.status.check} All healthy</Text>
        ) : (
          <Text color="red">{symbols.status.cross} Issues detected</Text>
        )}
      </Box>
      <Text> </Text>
      {state.components.map((component: ComponentHealth) => (
        <ComponentRow key={component.name} component={component} />
      ))}
    </Box>
  )
}

// =============================================================================
// Constants
// =============================================================================

const COMPONENT_NAME_COLUMN_WIDTH = 16

// =============================================================================
// Internal Components
// =============================================================================

const ComponentRow = ({ component }: { readonly component: ComponentHealth }) => {
  const symbols = useSymbols()

  return (
    <Box flexDirection="row">
      {component.healthy ? (
        <Text color="green">{symbols.status.check}</Text>
      ) : (
        <Text color="red">{symbols.status.cross}</Text>
      )}
      <Text> </Text>
      <Text bold>{component.name.padEnd(COMPONENT_NAME_COLUMN_WIDTH)}</Text>
      {component.version !== undefined ? <Text color="gray"> v{component.version}</Text> : null}
      {component.message !== undefined ? (
        <Text color={component.healthy ? 'gray' : 'red'}> {component.message}</Text>
      ) : null}
    </Box>
  )
}
