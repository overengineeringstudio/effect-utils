import { RuleTester } from 'eslint'
import tseslint from 'typescript-eslint'
import { describe, it } from 'vitest'

import plugin from './exports-first-plugin.js'

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

const tsRuleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    parser: tseslint.parser,
  },
})

const rule = plugin.rules['exports-first']

describe('overeng/exports-first', () => {
  describe('valid cases', () => {
    it('allows exports before non-exports', () => {
      ruleTester.run('exports-first', rule, {
        valid: [
          {
            code: `
export const publicApi = () => {}
export const anotherExport = 42
const helper = () => {}
const internal = 'value'
`,
          },
        ],
        invalid: [],
      })
    })

    it('allows file with only exports', () => {
      ruleTester.run('exports-first', rule, {
        valid: [
          {
            code: `
export const a = 1
export const b = 2
export function c() {}
`,
          },
        ],
        invalid: [],
      })
    })

    it('allows file with only non-exports', () => {
      ruleTester.run('exports-first', rule, {
        valid: [
          {
            code: `
const a = 1
const b = 2
function c() {}
`,
          },
        ],
        invalid: [],
      })
    })

    it('allows imports anywhere before exports', () => {
      tsRuleTester.run('exports-first', rule, {
        valid: [
          {
            code: `
import { something } from 'module'
import type { Type } from 'types'
export const a = something
const b = 2
`,
          },
        ],
        invalid: [],
      })
    })

    it('allows re-exports (export from) anywhere', () => {
      ruleTester.run('exports-first', rule, {
        valid: [
          {
            code: `
export const a = 1
const b = 2
export { something } from 'module'
export * from 'other'
`,
          },
        ],
        invalid: [],
      })
    })

    it('allows type exports anywhere (they are hoisted conceptually)', () => {
      tsRuleTester.run('exports-first', rule, {
        valid: [
          {
            code: `
export const a = 1
const b = 2
export type { MyType } from 'types'
`,
          },
        ],
        invalid: [],
      })
    })

    it('allows export default at top', () => {
      ruleTester.run('exports-first', rule, {
        valid: [
          {
            code: `
export default function main() {}
export const helper = () => {}
const internal = 'value'
`,
          },
        ],
        invalid: [],
      })
    })

    it('allows exported class declarations', () => {
      ruleTester.run('exports-first', rule, {
        valid: [
          {
            code: `
export class PublicClass {}
export const util = () => {}
class InternalClass {}
`,
          },
        ],
        invalid: [],
      })
    })

    it('allows type aliases and interfaces anywhere (type-only, no runtime impact)', () => {
      tsRuleTester.run('exports-first', rule, {
        valid: [
          {
            code: `
export const a = 1
interface InternalInterface {}
type InternalType = string
export const b = 2
`,
          },
        ],
        invalid: [],
      })
    })

    it('allows private constant before export that references it', () => {
      ruleTester.run('exports-first', rule, {
        valid: [
          {
            code: `
const MAX_OPTIONS = 5
export const LiteralField = () => MAX_OPTIONS
`,
          },
        ],
        invalid: [],
      })
    })

    it('allows private function before export that calls it', () => {
      ruleTester.run('exports-first', rule, {
        valid: [
          {
            code: `
const helper = (x) => x * 2
export const publicApi = (n) => helper(n)
`,
          },
        ],
        invalid: [],
      })
    })

    it('allows multiple private dependencies before exports', () => {
      ruleTester.run('exports-first', rule, {
        valid: [
          {
            code: `
const CONFIG = { max: 10 }
const helper = () => CONFIG.max
export const publicA = () => helper()
export const publicB = () => CONFIG.max
`,
          },
        ],
        invalid: [],
      })
    })

    it('allows private dependency used by later export', () => {
      ruleTester.run('exports-first', rule, {
        valid: [
          {
            code: `
const helper = () => 42
export const first = () => 1
export const second = () => helper()
`,
          },
        ],
        invalid: [],
      })
    })

    it('allows type alias used by export type annotation', () => {
      tsRuleTester.run('exports-first', rule, {
        valid: [
          {
            code: `
type MyType = { value: number }
export const thing: MyType = { value: 42 }
`,
          },
        ],
        invalid: [],
      })
    })

    it('allows Storybook pattern with meta and type alias', () => {
      tsRuleTester.run('exports-first', rule, {
        valid: [
          {
            code: `
const meta = { title: 'Test' }
export default meta
type Story = { args: object }
export const Default: Story = { args: {} }
export const Another: Story = { args: {} }
`,
          },
        ],
        invalid: [],
      })
    })
  })

  describe('invalid cases', () => {
    it('reports export after non-export variable', () => {
      ruleTester.run('exports-first', rule, {
        valid: [],
        invalid: [
          {
            code: `
const helper = () => {}
export const publicApi = () => {}
`,
            errors: [{ messageId: 'exportAfterNonExport' }],
          },
        ],
      })
    })

    it('reports export after non-export function', () => {
      ruleTester.run('exports-first', rule, {
        valid: [],
        invalid: [
          {
            code: `
function helper() {}
export function publicApi() {}
`,
            errors: [{ messageId: 'exportAfterNonExport' }],
          },
        ],
      })
    })

    it('reports multiple exports after non-export', () => {
      ruleTester.run('exports-first', rule, {
        valid: [],
        invalid: [
          {
            code: `
const internal = 1
export const a = 2
export const b = 3
`,
            errors: [{ messageId: 'exportAfterNonExport' }, { messageId: 'exportAfterNonExport' }],
          },
        ],
      })
    })

    it('reports export default after non-export', () => {
      ruleTester.run('exports-first', rule, {
        valid: [],
        invalid: [
          {
            code: `
const helper = 'internal'
export default function main() {}
`,
            errors: [{ messageId: 'exportAfterNonExport' }],
          },
        ],
      })
    })

    it('reports export class after non-export', () => {
      ruleTester.run('exports-first', rule, {
        valid: [],
        invalid: [
          {
            code: `
class InternalClass {}
export class PublicClass {}
`,
            errors: [{ messageId: 'exportAfterNonExport' }],
          },
        ],
      })
    })

    it('reports when export is sandwiched between non-exports', () => {
      ruleTester.run('exports-first', rule, {
        valid: [],
        invalid: [
          {
            code: `
const before = 1
export const middle = 2
const after = 3
`,
            errors: [{ messageId: 'exportAfterNonExport' }],
          },
        ],
      })
    })

    it('reports export after unreferenced private declaration', () => {
      ruleTester.run('exports-first', rule, {
        valid: [],
        invalid: [
          {
            code: `
const unrelatedHelper = () => 'not used by export'
export const publicApi = () => 'does not use helper'
`,
            errors: [{ messageId: 'exportAfterNonExport' }],
          },
        ],
      })
    })

    it('reports when private is only used by earlier export', () => {
      ruleTester.run('exports-first', rule, {
        valid: [],
        invalid: [
          {
            code: `
export const first = () => 1
const helper = () => 42
export const second = () => 2
`,
            errors: [{ messageId: 'exportAfterNonExport' }],
          },
        ],
      })
    })
  })
})
