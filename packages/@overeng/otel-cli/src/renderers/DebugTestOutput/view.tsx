/**
 * DebugTest TUI view
 *
 * Renders step-by-step progress of the E2E smoke test.
 */

import type { Atom } from '@effect-atom/atom'
import React from 'react'

import { Box, Text, useTuiAtomValue, useSymbols } from '@overeng/tui-react'

import type { TestState, TestStep } from './schema.ts'

// =============================================================================
// Props
// =============================================================================

/** Props for the DebugTestView component. */
export interface DebugTestViewProps {
  /** State atom from the TUI app. */
  readonly stateAtom: Atom.Atom<TestState>
}

// =============================================================================
// Main View
// =============================================================================

/** Root view for the debug test command. */
export const DebugTestView = ({ stateAtom }: DebugTestViewProps) => {
  const state = useTuiAtomValue(stateAtom)
  const symbols = useSymbols()

  return (
    <Box flexDirection="column">
      <Text bold>OTEL E2E Smoke Test</Text>
      <Text> </Text>
      {state.steps.map((step: TestStep, i: number) => (
        <StepRow key={String(i)} step={step} />
      ))}
      {state._tag === 'Complete' ? (
        <>
          <Text> </Text>
          {state.allPassed ? (
            <Text color="green" bold>
              {symbols.status.check} All tests passed
            </Text>
          ) : (
            <Text color="red" bold>
              {symbols.status.cross} Some tests failed
            </Text>
          )}
        </>
      ) : null}
    </Box>
  )
}

// =============================================================================
// Internal Components
// =============================================================================

const StepRow = ({ step }: { readonly step: TestStep }) => {
  const symbols = useSymbols()

  const icon =
    step.status === 'passed'
      ? symbols.status.check
      : step.status === 'failed'
        ? symbols.status.cross
        : step.status === 'running'
          ? symbols.status.circle
          : symbols.status.dot
  const color =
    step.status === 'passed'
      ? 'green'
      : step.status === 'failed'
        ? 'red'
        : step.status === 'running'
          ? 'blue'
          : ('gray' as const)

  return (
    <Box flexDirection="row">
      <Text color={color}>{icon}</Text>
      <Text> {step.name}</Text>
      {step.message !== undefined ? <Text color="gray"> — {step.message}</Text> : null}
    </Box>
  )
}
