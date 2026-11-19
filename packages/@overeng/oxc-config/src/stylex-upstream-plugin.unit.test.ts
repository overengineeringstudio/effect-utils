import tsParser from '@typescript-eslint/parser'
import { RuleTester } from '@typescript-eslint/rule-tester'
import { RuleTester as ESLintRuleTester } from 'eslint'
import { afterAll, describe, it } from 'vitest'

import plugin from './stylex-upstream-plugin.ts'

RuleTester.afterAll = afterAll
RuleTester.describe = describe
RuleTester.it = it
ESLintRuleTester.describe = describe
ESLintRuleTester.it = it

const ruleTester = new ESLintRuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
})
const tsRuleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module', parser: tsParser },
})
const rule = plugin.rules['valid-styles']
const IMPORT = `import * as stylex from '@stylexjs/stylex';\n`
const TOKENS = `import { tokens } from './tokens.stylex';\n`
const limitedTransition = {
  propLimits: { transitionProperty: { limit: ['opacity', 'transform'], reason: 'Use supported transitions' } },
}

ruleTester.run('upstream valid-styles: firstThatWorks validates each fallback', rule, {
  valid: [
    {
      code: `${IMPORT}${TOKENS}stylex.create({ box: {
        transitionProperty: stylex.firstThatWorks(tokens.transition, 'opacity'),
        position: stylex.firstThatWorks(tokens.position, 'relative'),
        animationName: stylex.firstThatWorks(tokens.animation, 'none'),
      } })`,
    },
    {
      code: `${IMPORT}${TOKENS}
        const fade = stylex.keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });
        stylex.create({ box: { animationName: stylex.firstThatWorks(tokens.animation, fade) } })`,
    },
    {
      code: `import { create as makeStyles, keyframes as makeFrames, firstThatWorks as fallback } from '@stylexjs/stylex';
        ${TOKENS}
        const fade = makeFrames({ from: { opacity: 0 }, to: { opacity: 1 } });
        makeStyles({ box: { animationName: fallback(tokens.animation, fade) } })`,
    },
    {
      code: `import { create, firstThatWorks } from '@stylexjs/stylex';
        ${TOKENS}create({ box: { position: firstThatWorks(tokens.position, 'absolute') } })`,
    },
    {
      code: `import { create as makeStyles, firstThatWorks as fallback } from '@stylexjs/stylex';
        ${TOKENS}makeStyles({ box: { transitionProperty: fallback(tokens.transition, 'opacity') } })`,
      options: [limitedTransition],
    },
    {
      code: `import * as sx from '@stylexjs/stylex';
        ${TOKENS}sx.create({ box: { position: sx.firstThatWorks(tokens.position, sx.firstThatWorks('sticky', 'relative')) } })`,
    },
    {
      code: `${IMPORT}stylex.create({ box: { position: stylex.firstThatWorks('relative') } })`,
    },
  ],
  invalid: [
    ...[
      `stylex.firstThatWorks('not-a-position', 'relative')`,
      `stylex.firstThatWorks('relative', 'not-a-position')`,
      `stylex.firstThatWorks('relative', stylex.firstThatWorks('sticky', 'not-a-position'))`,
      `stylex.firstThatWorks('relative', unknown())`,
      `stylex.firstThatWorks()`,
      `stylex.firstThatWorks(...values)`,
      `other.firstThatWorks('relative', 'absolute')`,
    ].map((value) => ({
      code: `${IMPORT}stylex.create({ box: { position: ${value} } })`,
      errors: 1,
    })),
    {
      code: `import { firstThatWorks as fallback } from './other';
        ${IMPORT}stylex.create({ box: { position: fallback('relative', 'absolute') } })`,
      errors: 1,
    },
    {
      code: `import { firstThatWorks as fallback } from '@stylexjs/stylex';
        ${IMPORT}stylex.create({ box: { position: fallback('relative', 'invalid') } })`,
      errors: 1,
    },
    {
      code: `import { create, firstThatWorks as fallback } from '@stylexjs/stylex';
        create({ box: fallback => ({ position: fallback('relative') }) })`,
      errors: 1,
    },
    {
      code: `${IMPORT}stylex.create({ box: stylex => ({ position: stylex.firstThatWorks('relative') }) })`,
      errors: 1,
    },
    {
      code: `import sx, { create } from '@stylexjs/stylex';
        create({ box: sx => ({ position: sx.firstThatWorks('relative') }) })`,
      errors: 1,
    },
    {
      code: `${IMPORT}${TOKENS}stylex.create({ box: { transitionProperty: stylex.firstThatWorks(tokens.transition, 'all') } })`,
      options: [limitedTransition],
      errors: 1,
    },
    {
      code: `${IMPORT}${TOKENS}stylex.create({ box: { color: stylex.firstThatWorks(tokens.color, '#ff0000') } })`,
      options: [{ propLimits: { color: { limit: ['transparent', 'currentColor'], reason: 'Use color tokens' } } }],
      errors: 1,
    },
    {
      code: `${IMPORT}${TOKENS}stylex.create({ box: { animationName: stylex.firstThatWorks(tokens.animation, 'not-keyframes') } })`,
      errors: 1,
    },
  ],
})

tsRuleTester.run('upstream valid-styles: typed firstThatWorks calls retain validation', rule, {
  valid: [
    {
      code: `${IMPORT}${TOKENS}stylex.create({ box: { position: stylex.firstThatWorks<string>(tokens.position, 'relative') } })`,
    },
    {
      code: `import { create, firstThatWorks as fallback } from '@stylexjs/stylex';
        ${TOKENS}create({ box: { position: fallback<string>(tokens.position, 'sticky') satisfies string } })`,
    },
  ],
  invalid: [
    {
      code: `${IMPORT}stylex.create({ box: { position: stylex.firstThatWorks<string>('relative', 'invalid') as string } })`,
      errors: [{ message: /relative/ }],
    },
  ],
})

ruleTester.run('upstream valid-styles: parameterized view-transition pseudo-elements', rule, {
  valid: [
    ...[
      '::view-transition',
      '::view-transition-old(root)',
      '::view-transition-new(root)',
      '::view-transition-group(card)',
      '::view-transition-image-pair(*)',
      '::view-transition-group-children(card)',
      '::view-transition-old(card.featured)',
      '::view-transition-new(*.featured)',
      '::view-transition-group(.featured)',
      '::view-transition-old( card )',
      '::view-transition-old(-card_2)',
      '::view-transition-new(über)',
      String.raw`::view-transition-old(\31 card)`,
    ].map((pseudo) => ({
      code: `${IMPORT}stylex.create({ box: { ${JSON.stringify(pseudo)}: { opacity: 0 } } })`,
    })),
    {
      code: `${IMPORT}stylex.create({ box: { '::view-transition-old(root)': { opacity: { default: 1, ':hover': 0 } } } })`,
    },
    {
      code: `${IMPORT}stylex.create({ box: { '::view-transition-new(root)': { opacity: 0 } } })`,
      options: [{ allowOuterPseudoAndMedia: true }],
    },
  ],
  invalid: [
    ...[
      '::view-transition(root)',
      '::view-transition-old',
      '::view-transition-new()',
      '::view-transition-group(1card)',
      '::view-transition-group(root, card)',
      '::view-transition-old(root) trailing',
      '::view-transition-image-pair(root > card)',
      '::view-transition-old(inherit)',
      '::view-transition-old(default)',
      '::view-transition-old(root.inherit)',
      '::view-transition-old(.default)',
      '::view-transition-new(root.REVERT-LAYER)',
      String.raw`::view-transition-old(\69 nherit)`,
      String.raw`::view-transition-old(root.\64 efault)`,
      '::view-transition-new(root..card)',
      '::view-transition-unknown(root)',
      '::unknown(root)',
    ].map((pseudo) => ({
      code: `${IMPORT}stylex.create({ box: { ${JSON.stringify(pseudo)}: { opacity: 0 } } })`,
      errors: [{ message: `Unknown pseudo element "${pseudo}"` }],
    })),
    {
      code: `${IMPORT}stylex.create({ box: { '::view-transition-old(root)': { position: 'invalid' } } })`,
      errors: 1,
    },
    {
      code: `${IMPORT}stylex.create({ box: { opacity: { default: 1, '::view-transition-old(root)': 0 } } })`,
      errors: [{ message: 'Invalid Pseudo class or At Rule used for conditional style value' }],
    },
  ],
})
