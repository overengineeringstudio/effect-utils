/**
 * stylex-no-raw-color oxlint rule.
 *
 * Bans raw colour literals as values inside `stylex.create(...)`. Colour values in
 * component styles must come from a semantic token exported by a `*.stylex.ts`
 * token module, because raw scale steps are inlined constants that cannot vary by
 * colour scheme: a component reading one compiles cleanly and silently ignores
 * dark mode.
 *
 * Deliberately complementary to `@stylexjs/valid-styles`' `propLimits`, which is
 * the source of truth for pure colour properties. A value limit is keyed on one
 * property, so it structurally cannot see a colour *embedded in a composite
 * value* — measured: a colour inside a `boxShadow` and inside a gradient both
 * passed upstream validation untouched. Hence the pattern here is NOT anchored.
 * The overlap on plain colour properties is kept on purpose, because an upstream
 * allowlist limit drops its custom `reason` text and only this message can name
 * the remedy.
 *
 * The token layer is untouched by construction: only `create` is visited, never
 * `defineConsts`, `defineVars` or `createTheme`, which is where literal colours
 * belong.
 *
 * See stylex spec "Enforcement" and decision 0005 Amendment 2.
 *
 * @example
 * // ✅ Good - semantic token from a *.stylex.ts module
 * import { colors } from './tokens.stylex.ts'
 * stylex.create({ box: { color: colors.textPrimary } })
 *
 * // ✅ Good - literals belong in the token layer
 * stylex.defineConsts({ red500: 'oklch(63.7% .237 25.331)' })
 *
 * // ✅ Good - an SVG fragment reference is not a colour
 * stylex.create({ icon: { fill: 'url(#brandGradient)' } })
 *
 * // ❌ Bad - colour literal in a component style
 * stylex.create({ box: { color: '#fff' } })
 *
 * // ❌ Bad - colour embedded in a composite value (upstream limits cannot see this)
 * stylex.create({ box: { boxShadow: '0 1px 2px #00000014' } })
 */

import type { TSESTree } from '@typescript-eslint/utils'

import {
  createStylexImports,
  isConditionKey,
  staticKeyName,
  stylexCreateArgument,
  trackStylexImport,
  type StylexRuleContext,
} from './stylex-shared.ts'

/**
 * `url(...)` is erased before matching so an SVG fragment reference such as
 * `url(#abc)` — which is shaped exactly like a 3-digit hex colour — cannot be
 * mistaken for one.
 */
const URL_FUNCTION_PATTERN = /url\([^)]*\)/gi

/**
 * Hex colours in all four legal lengths, longest first so `#00000014` reports as
 * one 8-digit colour rather than a 6-digit prefix. The trailing lookahead rejects
 * longer hex runs, which are not colours.
 */
const HEX_COLOR_PATTERN = /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})(?![\da-f])/i

/**
 * Functional notations that CONSTRUCT a colour from raw channel values. `\b`
 * before the name keeps `forcedColorAdjust` and `--color-brand` out, and the
 * required `(` keeps `background-color 200ms` out.
 *
 * Two families of *derivations* are deliberately absent, because their colour
 * comes from their arguments rather than from raw channels — and a derivation
 * over a token still follows the colour scheme, which is the whole hazard this
 * rule exists for:
 * - `color-mix(...)`, and
 * - relative-colour syntax, `<fn>(from <colour> ...)`, hence the lookahead.
 *
 * Neither is a loophole: a raw colour among their arguments is still matched,
 * because the patterns here are not anchored to the start of the value.
 */
const COLOR_FUNCTION_PATTERN =
  /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|device-cmyk)\((?!\s*from\b)/i

/**
 * `content` holds text, never a colour, so a quoted hash such as `content: '"#"'`
 * or `content: '"#fff"'` is legal.
 */
const TEXT_VALUED_PROPERTIES: Readonly<Record<string, true>> = { content: true }

/** The colour literal inside `value`, or `undefined` when there is none. */
const rawColorIn = (value: string): string | undefined => {
  const scrubbed = value.replaceAll(URL_FUNCTION_PATTERN, 'url()')

  const hex = HEX_COLOR_PATTERN.exec(scrubbed)
  if (hex !== null) return hex[0]

  const fn = COLOR_FUNCTION_PATTERN.exec(scrubbed)
  if (fn === null) return undefined

  // Report the whole colour function call, not just its name, by scanning to the
  // balanced closing paren.
  let depth = 0
  for (let index = fn.index; index < scrubbed.length; index++) {
    const char = scrubbed[index]
    if (char === '(') depth = depth + 1
    else if (char === ')') {
      depth = depth - 1
      if (depth === 0) return scrubbed.slice(fn.index, index + 1)
    }
  }
  return scrubbed.slice(fn.index)
}

type ValueWalk = {
  readonly context: StylexRuleContext
  readonly node: TSESTree.Node
  /** Innermost CSS property name on the path, used for the message and exemptions. */
  readonly property: string | undefined
}

/**
 * Walk a style value, reporting every string or template literal that contains a
 * colour. Handles the shapes StyleX actually produces: nested condition objects,
 * pseudo-element blocks, fallback arrays, dynamic-style arrow functions, and both
 * arms of a conditional.
 */
const walkValue = ({ context, node, property }: ValueWalk): void => {
  switch (node.type) {
    case 'ObjectExpression': {
      for (const member of node.properties) {
        if (member.type !== 'Property') continue
        const key = staticKeyName(member)
        const nextProperty = key !== undefined && isConditionKey(key) === false ? key : property
        walkValue({ context, node: member.value, property: nextProperty })
      }
      return
    }

    case 'Literal': {
      if (typeof node.value !== 'string') return
      if (property !== undefined && TEXT_VALUED_PROPERTIES[property] === true) return
      const color = rawColorIn(node.value)
      if (color === undefined) return
      context.report({
        node,
        messageId: 'rawColor',
        data: { color, property: property ?? 'a style value' },
      })
      return
    }

    case 'TemplateLiteral': {
      if (property === undefined || TEXT_VALUED_PROPERTIES[property] !== true) {
        // Join with a space so a colour cannot be forged across an interpolation
        // boundary (`` `#${a}bc` `` must not read as `#abc`).
        const text = node.quasis.map((quasi) => quasi.value.cooked).join(' ')
        const color = rawColorIn(text)
        if (color !== undefined) {
          context.report({
            node,
            messageId: 'rawColor',
            data: { color, property: property ?? 'a style value' },
          })
        }
      }
      for (const expression of node.expressions) {
        walkValue({ context, node: expression, property })
      }
      return
    }

    case 'ConditionalExpression': {
      walkValue({ context, node: node.consequent, property })
      walkValue({ context, node: node.alternate, property })
      return
    }

    case 'LogicalExpression':
    case 'BinaryExpression': {
      if (node.left.type !== 'PrivateIdentifier') {
        walkValue({ context, node: node.left, property })
      }
      walkValue({ context, node: node.right, property })
      return
    }

    case 'ArrayExpression': {
      for (const element of node.elements) {
        if (element === null) continue
        walkValue({ context, node: element, property })
      }
      return
    }

    case 'ArrowFunctionExpression':
    case 'FunctionExpression': {
      walkValue({ context, node: node.body, property })
      return
    }

    case 'BlockStatement': {
      for (const statement of node.body) {
        walkValue({ context, node: statement, property })
      }
      return
    }

    case 'ReturnStatement': {
      if (node.argument !== null) walkValue({ context, node: node.argument, property })
      return
    }

    case 'IfStatement': {
      walkValue({ context, node: node.consequent, property })
      if (node.alternate !== null) walkValue({ context, node: node.alternate, property })
      return
    }

    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression': {
      walkValue({ context, node: node.expression, property })
      return
    }

    default:
      return
  }
}

/** ESLint rule banning raw colour literals as values inside `stylex.create`. */
export const stylexNoRawColorRule = {
  meta: {
    type: 'problem' as const,
    docs: {
      description: 'Ban raw colour literals as values inside stylex.create',
      recommended: false,
    },
    messages: {
      rawColor:
        'Raw colour `{{color}}` in `{{property}}`. Component styles must read colours from a semantic token exported by a `*.stylex.ts` module — a raw colour is an inlined constant and silently ignores the colour scheme. Move the value into the token layer and reference the token here.',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context: StylexRuleContext) {
    const imports = createStylexImports()

    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration) {
        trackStylexImport({ imports, node })
      },

      CallExpression(node: TSESTree.CallExpression) {
        const styleMap = stylexCreateArgument({ imports, node })
        if (styleMap === undefined) return
        walkValue({ context, node: styleMap, property: undefined })
      },
    }
  },
}
