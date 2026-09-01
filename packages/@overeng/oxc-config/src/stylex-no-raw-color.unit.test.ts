import tsParser from '@typescript-eslint/parser'
import { RuleTester } from '@typescript-eslint/rule-tester'
import { RuleTester as ESLintRuleTester } from 'eslint'
import { afterAll, describe, it } from 'vitest'

import plugin from './mod.ts'

RuleTester.afterAll = afterAll
RuleTester.describe = describe
RuleTester.it = it
ESLintRuleTester.describe = describe
ESLintRuleTester.it = it

const ruleTester = new ESLintRuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

const tsRuleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    parser: tsParser,
  },
})

const rule = plugin.rules['stylex-no-raw-color']

const IMPORT = `import * as stylex from '@stylexjs/stylex'\n`

/** The exact rendered message for a flagged 6-digit hex in `color`. */
const hexColorMessage =
  'Raw colour `#ff0000` in `color`. Component styles must read colours from a semantic token exported by a `*.stylex.ts` module — a raw colour is an inlined constant and silently ignores the colour scheme. Move the value into the token layer and reference the token here.'

ruleTester.run('stylex-no-raw-color: the token layer is where colours belong', rule, {
  valid: [
    // Raw scale, semantic tokens and themes are all definitions, not usages.
    {
      code: `${IMPORT}export const colors = stylex.defineConsts({ red500: 'oklch(63.7% .237 25.331)', hex: '#ff0000' })`,
    },
    {
      code: `${IMPORT}export const tokens = stylex.defineVars({ textPrimary: '#111827', surface: 'rgb(255 255 255)' })`,
    },
    {
      code: `${IMPORT}export const dark = stylex.createTheme(tokens, { textPrimary: '#f9fafb' })`,
    },
    // A token reference is the whole point of the rule.
    {
      code: `${IMPORT}const styles = stylex.create({ box: { color: tokens.textPrimary, backgroundColor: tokens.surface } })`,
    },
  ],
  invalid: [],
})

ruleTester.run('stylex-no-raw-color: legal lookalikes stay silent', rule, {
  valid: [
    // An SVG fragment reference is shaped exactly like a 3-digit hex colour.
    {
      code: `${IMPORT}const styles = stylex.create({ icon: { fill: 'url(#abc)', clipPath: 'url(#fff)' } })`,
    },
    // Non-colour literals, including composite ones with literal offsets.
    {
      code: `${IMPORT}const styles = stylex.create({ box: { padding: '1px 2px', border: '1px solid', transition: 'background-color 200ms', boxShadow: 'inset 0 1px 2px' } })`,
    },
    // Keyword-valued members of the colour-adjust family take no colour.
    {
      code: `${IMPORT}const styles = stylex.create({ box: { colorScheme: 'light dark', forcedColorAdjust: 'none' } })`,
    },
    // Generated content is text, so a quoted hash is not a colour.
    {
      code: `${IMPORT}const styles = stylex.create({ box: { '::before': { content: '"#"' } } })`,
    },
    {
      code: `${IMPORT}const styles = stylex.create({ box: { '::before': { content: '"#fff"' } } })`,
    },
    // A longer hex run is not a colour.
    {
      code: `${IMPORT}const styles = stylex.create({ box: { gridArea: '#abcdefabcdef' } })`,
    },
    // Colour-shaped strings outside stylex.create are none of this rule's business.
    {
      code: `${IMPORT}const brand = '#ff0000'\nconst theme = { color: 'rgb(1 2 3)' }`,
    },
    // A same-named method on a different object is not a style declaration.
    {
      code: `${IMPORT}const row = db.create({ color: '#ff0000' })`,
    },
    // A colour cannot be forged across an interpolation boundary.
    {
      code: `${IMPORT}const styles = stylex.create({ box: { color: \`#\${suffix}bc\` } })`,
    },
    // A derivation over a TOKEN still follows the colour scheme, so it is legal.
    // This is the shape real code uses for a translucent border.
    {
      code: `${IMPORT}const styles = stylex.create({ box: { borderColor: \`color-mix(in oklab, \${tokens.border} 50%, transparent)\` } })`,
    },
    // Relative-colour syntax is a derivation too.
    {
      code: `${IMPORT}const styles = stylex.create({ box: { color: \`oklch(from \${tokens.text} l c h / 0.6)\` } })`,
    },
  ],
  invalid: [],
})

ruleTester.run('stylex-no-raw-color: pure colour values', rule, {
  valid: [],
  invalid: [
    // Assert the exact rendered message once (RuleTester forbids combining
    // `message` and `messageId` on the same error).
    {
      code: `${IMPORT}const styles = stylex.create({ box: { color: '#ff0000' } })`,
      errors: [{ message: hexColorMessage }],
    },
    // Hex in all four legal lengths.
    {
      code: `${IMPORT}const styles = stylex.create({ box: { color: '#fff' } })`,
      errors: [{ messageId: 'rawColor' }],
    },
    {
      code: `${IMPORT}const styles = stylex.create({ box: { color: '#fff8' } })`,
      errors: [{ messageId: 'rawColor' }],
    },
    {
      code: `${IMPORT}const styles = stylex.create({ box: { color: '#00000014' } })`,
      errors: [{ messageId: 'rawColor' }],
    },
    // Functional notations.
    {
      code: `${IMPORT}const styles = stylex.create({ box: { color: 'rgb(255 0 0)' } })`,
      errors: [{ messageId: 'rawColor' }],
    },
    {
      code: `${IMPORT}const styles = stylex.create({ box: { color: 'rgba(255, 0, 0, 0.5)' } })`,
      errors: [{ messageId: 'rawColor' }],
    },
    {
      code: `${IMPORT}const styles = stylex.create({ box: { color: 'hsl(0 100% 50%)' } })`,
      errors: [{ messageId: 'rawColor' }],
    },
    {
      code: `${IMPORT}const styles = stylex.create({ box: { color: 'oklch(63.7% .237 25.331)' } })`,
      errors: [{ messageId: 'rawColor' }],
    },
    // A derivation is not a loophole: a raw argument is still caught.
    {
      code: `${IMPORT}const styles = stylex.create({ box: { color: 'color-mix(in oklab, #ff0000 50%, transparent)' } })`,
      errors: [{ messageId: 'rawColor' }],
    },
    {
      code: `${IMPORT}const styles = stylex.create({ box: { color: 'color-mix(in srgb, rgb(255 0 0) 50%, transparent)' } })`,
      errors: [{ messageId: 'rawColor' }],
    },
    {
      code: `${IMPORT}const styles = stylex.create({ box: { color: 'oklch(from #ff0000 l c h / 0.5)' } })`,
      errors: [{ messageId: 'rawColor' }],
    },
  ],
})

ruleTester.run('stylex-no-raw-color: colours embedded in composite values', rule, {
  valid: [],
  invalid: [
    // The decisive cases: per-property upstream limits structurally cannot reach
    // a colour inside a composite value, so an anchored pattern would miss these.
    {
      code: `${IMPORT}const styles = stylex.create({ box: { boxShadow: '0 1px 2px #00000014' } })`,
      errors: [{ messageId: 'rawColor' }],
    },
    {
      code: `${IMPORT}const styles = stylex.create({ box: { backgroundImage: 'linear-gradient(to right, #fff, rgba(0,0,0,0.5))' } })`,
      errors: [{ messageId: 'rawColor' }],
    },
    {
      code: `${IMPORT}const styles = stylex.create({ box: { border: '1px solid #e5e7eb' } })`,
      errors: [{ messageId: 'rawColor' }],
    },
    {
      code: `${IMPORT}const styles = stylex.create({ box: { filter: 'drop-shadow(0 0 2px rgb(0 0 0 / 0.5))' } })`,
      errors: [{ messageId: 'rawColor' }],
    },
  ],
})

ruleTester.run('stylex-no-raw-color: nested and dynamic positions', rule, {
  valid: [],
  invalid: [
    // Inside a pseudo-class condition.
    {
      code: `${IMPORT}const styles = stylex.create({ box: { color: { default: tokens.text, ':hover': '#ff0000' } } })`,
      errors: [{ messageId: 'rawColor' }],
    },
    // Inside a media query.
    {
      code: `${IMPORT}const styles = stylex.create({ box: { '@media (prefers-color-scheme: dark)': { color: '#fff' } } })`,
      errors: [{ messageId: 'rawColor' }],
    },
    // Inside a pseudo-element block.
    {
      code: `${IMPORT}const styles = stylex.create({ box: { '::before': { backgroundColor: '#fff' } } })`,
      errors: [{ messageId: 'rawColor' }],
    },
    // Template literal.
    {
      code: `${IMPORT}const styles = stylex.create({ box: { boxShadow: \`0 0 0 1px #00000014\` } })`,
      errors: [{ messageId: 'rawColor' }],
    },
    // Both arms of a conditional in a dynamic style.
    {
      code: `${IMPORT}const styles = stylex.create({ box: (on) => ({ color: on ? '#fff' : '#000' }) })`,
      errors: [{ messageId: 'rawColor' }, { messageId: 'rawColor' }],
    },
    // Fallback stack array.
    {
      code: `${IMPORT}const styles = stylex.create({ box: { color: ['#ff0000', 'oklch(63.7% .237 25.331)'] } })`,
      errors: [{ messageId: 'rawColor' }, { messageId: 'rawColor' }],
    },
    // Named `create` import, and a dynamic style with a block body.
    {
      code: `import { create } from '@stylexjs/stylex'\nconst styles = create({ box: (on) => { return { color: '#fff' } } })`,
      errors: [{ messageId: 'rawColor' }],
    },
  ],
})

tsRuleTester.run('stylex-no-raw-color: TypeScript', rule, {
  valid: [
    {
      code: `${IMPORT}const styles = stylex.create({ box: { color: tokens.textPrimary } } as const)`,
    },
  ],
  invalid: [
    {
      code: `${IMPORT}const styles = stylex.create({ box: { color: '#ff0000' as string } })`,
      errors: [{ messageId: 'rawColor' }],
    },
    // `as const` around the style map must not become a bypass.
    {
      code: `${IMPORT}const styles = stylex.create({ box: { color: '#ff0000' } } as const)`,
      errors: [{ messageId: 'rawColor' }],
    },
  ],
})
