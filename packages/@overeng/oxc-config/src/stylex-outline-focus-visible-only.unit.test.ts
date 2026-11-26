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
    // An observed non-focus state still competes with the focus ring.
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

ruleTester.run('stylex-outline-focus-visible-only: observed sibling focus requires proof', rule, {
  valid: [
    // The hidden input's focus-visible state draws the ring on its following label.
    {
      code: `${IMPORT}const styles = stylex.create({
        label: {
          outline: 'none',
          outlineColor: { default: null, [stylex.when.siblingBefore(':focus-visible')]: 'blue' },
          outlineOffset: { default: 0, [stylex.when.siblingBefore(':focus-visible')]: 2 },
        },
      })`,
    },
    // Both nesting orders preserve the focus-visible classification.
    {
      code: `${IMPORT}const styles = stylex.create({
        label: { [stylex.when.siblingBefore(':focus-visible')]: { outline: '2px solid' } },
      })`,
    },
    // Namespace and named imports use the same import tracker as create.
    {
      code: `import * as sx from '@stylexjs/stylex'
        const styles = sx.create({ label: {
          [sx.when.siblingBefore(':focus-visible')]: { outlineOffset: 2 },
        } })`,
    },
    {
      code: `import sx from '@stylexjs/stylex'
        const styles = sx.create({ label: {
          [sx.when.siblingBefore(':focus-visible')]: { outlineColor: 'blue' },
        } })`,
    },
    {
      code: `import { create as makeStyles, when as observed } from '@stylexjs/stylex'
        const styles = makeStyles({ label: {
          outlineOffset: { [observed.siblingBefore(':focus-visible')]: 2 },
        } })`,
    },
    {
      code: `import { create, when } from 'stylex'
        const styles = create({ label: {
          [when.siblingBefore(':focus-visible')]: { outlineColor: 'blue' },
        } })`,
    },
    // Existing default, media and pseudo-element exemptions remain available.
    {
      code: `${IMPORT}const styles = stylex.create({ label: {
        outlineColor: { default: null, '@media (forced-colors: active)': {
          [stylex.when.siblingBefore(':focus-visible')]: 'Highlight',
        } },
        '::before': { outline: '1px solid' },
      } })`,
    },
  ],
  invalid: [
    // Exact literal matching proves positive focus; it must not infer focus
    // from substrings, negation, mixed selector lists or unresolved expressions.
    ...[
      "stylex.when.siblingBefore(':checked')",
      "stylex.when.siblingBefore(':hover')",
      "stylex.when.siblingBefore(':focus')",
      "stylex.when.siblingBefore(':not(:focus-visible)')",
      "stylex.when.siblingBefore(':focus-visible, :hover')",
      "stylex.when.siblingBefore(':is(:focus-visible, :checked)')",
      "stylex.when.siblingBefore('[data-not-focus-visible]')",
      'stylex.when.siblingBefore(predicate)',
      'stylex.when.siblingBefore(`:focus-visible`)',
      "stylex.when.siblingBefore(':focus-visible', extra)",
      'stylex.when.siblingBefore(...predicates)',
      "stylex.when[method](':focus-visible')",
      "stylex[api].siblingBefore(':focus-visible')",
      "stylex.when.unknown(':focus-visible')",
      "stylex.when.siblingAfter(':focus-visible')",
      "stylex.when.ancestor(':focus-visible')",
      "other.when.siblingBefore(':focus-visible')",
      "observed.siblingBefore(':focus-visible')",
      "unknown(':focus-visible')",
      "stylex.when.siblingBefore?.(':focus-visible')",
    ].map((condition) => ({
      code: `${IMPORT}const styles = stylex.create({ label: {
        outlineColor: { [${condition}]: 'blue' },
      } })`,
      errors: [{ messageId: 'outlineOutsideFocusVisible' }],
    })),
    // The conventional bare stylex.create fallback is not proof of an imported when API.
    {
      code: `const styles = stylex.create({ label: {
        [stylex.when.siblingBefore(':focus-visible')]: { outlineOffset: 2 },
      } })`,
      errors: [{ messageId: 'outlineOutsideFocusVisible' }],
    },
    // Token modules do not provide the runtime observed-state API.
    {
      code: `import * as tokens from './tokens.stylex'
        ${IMPORT}const styles = stylex.create({ label: {
          [tokens.when.siblingBefore(':focus-visible')]: { outlineOffset: 2 },
        } })`,
      errors: [{ messageId: 'outlineOutsideFocusVisible' }],
    },
    {
      code: `import { when as observed } from './other'
        ${IMPORT}const styles = stylex.create({ label: {
          [observed.siblingBefore(':focus-visible')]: { outlineOffset: 2 },
        } })`,
      errors: [{ messageId: 'outlineOutsideFocusVisible' }],
    },
    // Genuine observed focus must not erase competing states in either nesting order.
    {
      code: `${IMPORT}const styles = stylex.create({ label: {
        '[data-selected]': {
          [stylex.when.siblingBefore(':focus-visible')]: { outlineColor: 'blue' },
        },
      } })`,
      errors: [{ messageId: 'outlineOutsideFocusVisible' }],
    },
    {
      code: `${IMPORT}const styles = stylex.create({ label: {
        [stylex.when.siblingBefore(':focus-visible')]: {
          '[data-selected]': { outlineOffset: 2 },
        },
      } })`,
      errors: [{ messageId: 'outlineOutsideFocusVisible' }],
    },
    // Observed non-focus states remain defects in condition-outside-property order too.
    {
      code: `${IMPORT}const styles = stylex.create({ label: {
        [stylex.when.siblingBefore(':checked')]: { outlineOffset: 2 },
      } })`,
      errors: [{ messageId: 'outlineOutsideFocusVisible' }],
    },
  ],
})
