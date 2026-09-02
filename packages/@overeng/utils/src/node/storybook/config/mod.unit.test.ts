import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { shouldNeverHappen } from '../../../isomorphic/core.ts'
import { createDomStorybookConfig } from './mod.ts'

const runViteFinal = async () => {
  const existingPlugin = { name: 'existing' }
  const viteFinal = createDomStorybookConfig({}).viteFinal

  if (viteFinal === undefined) {
    return shouldNeverHappen('Expected createDomStorybookConfig to define viteFinal')
  }

  const config = { plugins: [existingPlugin] } as Parameters<typeof viteFinal>[0]
  const options = {} as Parameters<typeof viteFinal>[1]
  const result = await viteFinal(config, options)

  return { existingPlugin, result }
}

Vitest.describe('createDomStorybookConfig', () => {
  // The factory used to be able to inject the StyleX plugin itself. It no
  // longer touches the plugin list at all: the Storybook builder merges the
  // package's own Vite config, which already registers it, and installing a
  // second instance produced byte-identical CSS — noise, not a defect.
  Vitest.it('leaves the plugin list to the merged app config', async () => {
    const { existingPlugin, result } = await runViteFinal()

    expect(result.plugins).toEqual([existingPlugin])
  })

  Vitest.it('registers the accessibility addon only when the gate asks for it', () => {
    expect({
      off: createDomStorybookConfig({}).addons,
      on: createDomStorybookConfig({ a11y: true }).addons,
    }).toEqual({ off: undefined, on: ['@storybook/addon-a11y'] })
  })
})
