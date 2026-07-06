import { describe, expect, it } from 'vitest'

import { DEFAULT_GENERATOR_PHASE, parseGeneratorPhase } from './phase.ts'

describe('parseGeneratorPhase', () => {
  it('defaults to design-time when no pragma is present', () => {
    expect(parseGeneratorPhase("import { x } from './y.ts'\nexport default x")).toBe('design-time')
    expect(DEFAULT_GENERATOR_PHASE).toBe('design-time')
  })

  it('reads a leading `// @genie-phase bootstrap` pragma', () => {
    const source = '// @genie-phase bootstrap\nimport { packageJson } from "./genie/internal.ts"\n'
    expect(parseGeneratorPhase(source)).toBe('bootstrap')
  })

  it('reads an explicit design-time pragma', () => {
    expect(parseGeneratorPhase('// @genie-phase design-time\nexport default {}')).toBe(
      'design-time',
    )
  })

  it('accepts leading whitespace and flexible spacing in the pragma', () => {
    expect(parseGeneratorPhase('  //   @genie-phase\tbootstrap\n')).toBe('bootstrap')
  })

  it('accepts the pragma anywhere in the file, not only the first line', () => {
    expect(parseGeneratorPhase('import x from "./y.ts"\n// @genie-phase bootstrap\n')).toBe(
      'bootstrap',
    )
  })

  it('ignores an unknown phase value and falls back to the default', () => {
    expect(parseGeneratorPhase('// @genie-phase runtime\n')).toBe('design-time')
  })

  it('does not match the keyword inside ordinary code or block comments', () => {
    expect(parseGeneratorPhase('const s = "@genie-phase bootstrap"\n')).toBe('design-time')
    expect(parseGeneratorPhase('/* @genie-phase bootstrap */\n')).toBe('design-time')
  })
})
