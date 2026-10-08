import { describe, expect, it } from 'vitest'

import { buck2TypeScriptAdmissions } from './typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from './typescript-package-projection.ts'

const admission = buck2TypeScriptAdmissions.kdl
const context = { cwd: process.cwd(), location: '' }

describe('JavaScript lane cache policy', () => {
  it('keeps an explicitly uncacheable execution and collection lane uncacheable', () => {
    const output = buck2TypeScriptPackageProjection({
      ...admission,
      tests: [{ name: 'test', runner: 'vitest', cacheable: false }],
    }).stringify(context)
    for (const rule of ['vitest_test', 'vitest_collect']) {
      const target = output.split(`${rule}(\n`)[1]?.split('\n)')[0]
      expect(target).toContain('    cacheable = False,')
    }
  })

  it.each(['bun', 'shell'] as const)(
    'refuses cached %s lanes with undeclared ambient inputs',
    (runner) => {
      expect(() =>
        buck2TypeScriptPackageProjection({
          ...admission,
          tests: [{ name: 'test', runner, inheritedEnv: ['HOST_CONTEXT'] }],
        }).stringify(context),
      ).toThrow('outside the action identity')
    },
  )
})
