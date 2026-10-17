import { RuleTester } from '@typescript-eslint/rule-tester'
import { afterAll, describe, it } from 'vitest'

import plugin from './mod.ts'

RuleTester.afterAll = afterAll
RuleTester.describe = describe
RuleTester.it = it

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
})

const rule = plugin.rules['otel-contract-in-seam-file']

const contract = `import { defineOtelContract, span, attr } from '@overeng/otel-contract/registry'
const S = span({ id: 'x', kind: 'internal', brief: 'b', stability: 'development', attributes: {} })
export default defineOtelContract({ memberPath: 'p', displayName: 'd', signals: [S] })`

ruleTester.run('otel-contract-in-seam-file', rule, {
  valid: [
    // A seam file (`*.contract.ts`) is the allowed home — no report.
    { code: contract, filename: 'packages/@overeng/x/src/observability/x.contract.ts' },
    // Non-seam file, but the constructors are not imported from the registry module.
    {
      code: `import { span } from './local'
const s = span({})`,
      filename: 'packages/@overeng/x/src/mod.ts',
    },
  ],
  invalid: [
    // Non-seam file using registry contract constructors → warns (one per call: span + defineOtelContract + attr).
    {
      code: `import { defineOtelContract, attr } from '@overeng/otel-contract/registry'
const A = attr.string({ key: 'x.y', cardinality: 'low', brief: 'b', stability: 'development', examples: ['e'] })
export default defineOtelContract({ memberPath: 'p', displayName: 'd', signals: [] })`,
      filename: 'packages/@overeng/x/src/telemetry.ts',
      errors: [{ messageId: 'contractOutsideSeam' }, { messageId: 'contractOutsideSeam' }],
    },
  ],
})
