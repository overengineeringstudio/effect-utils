import { RuleTester as ESLintRuleTester } from 'eslint'
import { describe, it } from 'vitest'

import plugin from './mod.ts'

ESLintRuleTester.describe = describe
ESLintRuleTester.it = it

const ruleTester = new ESLintRuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

const rule = plugin.rules['stylex-outline-focus-visible-only']

const IMPORT = `import * as stylex from '@stylexjs/stylex'\n`

/** The exact rendered message for `outline` claimed by a selection state. */
const selectedOutlineMessage =
  '`outline` is reserved for the focus-visible state but is set under `[data-selected]`. StyleX orders conditions by kind, not by authoring position, so this state can silently outrank the focus ring on the same property. Restyle `boxShadow` or a background property for `[data-selected]` instead — partitioning the properties is what makes the focus ring collision-proof.'

ruleTester.run('stylex-outline-focus-visible-only: focus-visible owns the ring', rule, {
  valid: [
    // The prescribed shape: base suppression plus the focus-visible ring, with
    // selection restyling a disjoint property.
    {
      code: `${IMPORT}const styles = stylex.create({
        button: {
          outline: { default: 'none', ':focus-visible': '2px solid' },
          outlineOffset: { default: 0, ':focus-visible': '2px' },
          boxShadow: { default: null, '[data-selected]': 'inset 0 0 0 1px' },
        },
      })`,
    },
    // The accessible-component library's attribute state counts as focus-visible.
    {
      code: `${IMPORT}const styles = stylex.create({ button: { outline: { default: 'none', '[data-focus-visible]': '2px solid' } } })`,
    },
    // Condition-outside-property nesting, still focus-visible.
    {
      code: `${IMPORT}const styles = stylex.create({ button: { ':focus-visible': { outline: '2px solid', outlineColor: 'red' } } })`,
    },
    // An unconditional base value is how the user-agent ring gets suppressed.
    {
      code: `${IMPORT}const styles = stylex.create({ button: { outline: 'none' } })`,
    },
    // At-rules are not states: a forced-colours override of the ring is fine.
    {
      code: `${IMPORT}const styles = stylex.create({ button: { outline: { default: 'none', '@media (forced-colors: active)': { default: '1px solid', ':focus-visible': '3px solid' } } } })`,
    },
    // A pseudo-element draws a different box entirely.
    {
      code: `${IMPORT}const styles = stylex.create({ button: { '::before': { outline: '1px dashed' } } })`,
    },
    // Non-outline properties are free to use any state.
    {
      code: `${IMPORT}const styles = stylex.create({ button: { boxShadow: { default: null, ':hover': '0 0 0 1px', '[data-pressed]': 'inset 0 0 0 1px' } } })`,
    },
    // A same-named method on a different object is not a style declaration.
    {
      code: `${IMPORT}const row = db.create({ ':hover': { outline: '2px solid' } })`,
    },
  ],
  invalid: [],
})

ruleTester.run('stylex-outline-focus-visible-only: competing states are defects', rule, {
  valid: [],
  invalid: [
    // Assert the exact rendered message once.
    {
      code: `${IMPORT}const styles = stylex.create({ button: { outline: { default: 'none', '[data-selected]': '2px solid' } } })`,
      errors: [{ message: selectedOutlineMessage }],
    },
    // The other nesting order is the same defect.
    {
      code: `${IMPORT}const styles = stylex.create({ button: { ':hover': { outlineColor: 'red' } } })`,
      errors: [{ messageId: 'outlineOutsideFocusVisible' }],
    },
    // Plain `:focus` is exactly the mistake this rule exists to catch.
    {
      code: `${IMPORT}const styles = stylex.create({ button: { outline: { default: 'none', ':focus': '2px solid' } } })`,
      errors: [{ messageId: 'outlineOutsideFocusVisible' }],
    },
    // outlineOffset is partitioned too.
    {
      code: `${IMPORT}const styles = stylex.create({ button: { outlineOffset: { default: 0, '[data-pressed]': '4px' } } })`,
      errors: [{ messageId: 'outlineOutsideFocusVisible' }],
    },
    // One diagnostic per offending pair, not per nesting level.
    {
      code: `${IMPORT}const styles = stylex.create({ button: { outline: { default: 'none', ':focus-visible': '2px solid', '[data-selected]': '2px dotted', ':active': 'none' } } })`,
      errors: [
        { messageId: 'outlineOutsideFocusVisible' },
        { messageId: 'outlineOutsideFocusVisible' },
      ],
    },
    // A state nested inside a media query still competes.
    {
      code: `${IMPORT}const styles = stylex.create({ button: { outline: { default: 'none', '@media (hover: hover)': { ':hover': '2px solid' } } } })`,
      errors: [{ messageId: 'outlineOutsideFocusVisible' }],
    },
    // An observed `when.*` condition is a state and never focus-visible.
    {
      code: `${IMPORT}const styles = stylex.create({ button: { outline: { default: 'none', [stylex.when.ancestor(':hover')]: '2px solid' } } })`,
      errors: [{ messageId: 'outlineOutsideFocusVisible' }],
    },
    // Dynamic styles are not an escape hatch.
    {
      code: `${IMPORT}const styles = stylex.create({ button: (w) => ({ outline: { default: 'none', '[data-selected]': w } }) })`,
      errors: [{ messageId: 'outlineOutsideFocusVisible' }],
    },
  ],
})
