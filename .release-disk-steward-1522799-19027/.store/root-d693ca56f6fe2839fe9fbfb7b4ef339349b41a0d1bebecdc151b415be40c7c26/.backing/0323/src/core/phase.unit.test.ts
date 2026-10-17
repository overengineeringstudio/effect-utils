import { describe, expect, it } from 'vitest'

import { DEFAULT_GENERATOR_PHASE, parseGeneratorPhase } from './phase.ts'

describe('parseGeneratorPhase', () => {
  it('defaults to design-time when no marker is present', () => {
    expect(parseGeneratorPhase("import { x } from './y.ts'\nexport default x")).toBe('design-time')
    expect(DEFAULT_GENERATOR_PHASE).toBe('design-time')
  })

  it('reads a leading `// @genie-bootstrap` flag', () => {
    const source = '// @genie-bootstrap\nimport { packageJson } from "./genie/internal.ts"\n'
    expect(parseGeneratorPhase(source)).toBe('bootstrap')
  })

  it('accepts leading whitespace and flexible spacing in the flag', () => {
    expect(parseGeneratorPhase('  //   @genie-bootstrap\n')).toBe('bootstrap')
  })

  it('accepts the flag anywhere in the file, not only the first line', () => {
    expect(parseGeneratorPhase('import x from "./y.ts"\n// @genie-bootstrap\n')).toBe('bootstrap')
  })

  it('does not match a longer namespaced flag (word boundary)', () => {
    expect(parseGeneratorPhase('// @genie-bootstrap-later\n')).toBe('design-time')
  })

  it('does not match the keyword inside ordinary code or block comments', () => {
    expect(parseGeneratorPhase('const s = "@genie-bootstrap"\n')).toBe('design-time')
    expect(parseGeneratorPhase('/* @genie-bootstrap */\n')).toBe('design-time')
  })
})
