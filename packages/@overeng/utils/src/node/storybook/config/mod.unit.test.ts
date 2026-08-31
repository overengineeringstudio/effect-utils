import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { shouldNeverHappen } from '../../../isomorphic/core.ts'
import { createDomStorybookConfig } from './mod.ts'

const runViteFinal = async (stylex: boolean) => {
  const existingPlugin = { name: 'existing' }
  const viteFinal = createDomStorybookConfig({ stylex }).viteFinal

  if (viteFinal === undefined) {
    return shouldNeverHappen('Expected createDomStorybookConfig to define viteFinal')
  }

  const config = { plugins: [existingPlugin] } as Parameters<typeof viteFinal>[0]
  const options = {} as Parameters<typeof viteFinal>[1]
  const result = await viteFinal(config, options)

  return { existingPlugin, result }
}

Vitest.describe('createDomStorybookConfig', () => {
  Vitest.it('leaves the plugin list unchanged when StyleX is disabled', async () => {
    const { existingPlugin, result } = await runViteFinal(false)

    expect(result.plugins).toEqual([existingPlugin])
  })

  Vitest.it('prepends the StyleX plugin when explicitly enabled', async () => {
    const { existingPlugin, result } = await runViteFinal(true)

    expect(result.plugins).toHaveLength(2)
    expect(result.plugins?.[1]).toBe(existingPlugin)
  })
})
