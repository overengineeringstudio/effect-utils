import type { Meta, StoryObj } from '@storybook/react'
import { Effect, Layer } from 'effect'
import React from 'react'

import { EffectProvider } from '../context.tsx'
import { ProgressReporter } from '../progress-reporter.ts'
import { EffectButton } from './EffectButton.tsx'

const demoSuccessEffect = Effect.gen(function* () {
  const total = 3
  yield* ProgressReporter.set({ total, completed: 0 })
  yield* Effect.sleep(200)
  yield* ProgressReporter.set({ total, completed: 1 })
  yield* Effect.sleep(200)
  yield* ProgressReporter.set({ total, completed: 2 })
  yield* Effect.sleep(200)
  yield* ProgressReporter.set({ total, completed: 3 })
})

const demoFailureEffect = Effect.gen(function* () {
  const total = 2
  yield* ProgressReporter.set({ total, completed: 0 })
  yield* Effect.sleep(200)
  yield* ProgressReporter.set({ total, completed: 1 })
  return yield* Effect.die('Boom')
})

const meta = {
  title: 'Effect React/EffectButton',
  // Note: component omitted to avoid type portability issues with react-aria types
  decorators: [
    (Story: React.ComponentType) => (
      <EffectProvider layer={Layer.empty}>
        <Story />
      </EffectProvider>
    ),
  ],
} satisfies Meta

export default meta

export const Success: StoryObj = {
  render: () => <EffectButton effect={demoSuccessEffect}>Run success</EffectButton>,
}

export const Failure: StoryObj = {
  render: () => <EffectButton effect={demoFailureEffect}>Run failure</EffectButton>,
}
