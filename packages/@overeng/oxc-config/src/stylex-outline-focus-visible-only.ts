/**
 * stylex-outline-focus-visible-only oxlint rule.
 *
 * `outline`, `outlineOffset` and `outlineColor` are reserved, design-system-wide,
 * for the focus-visible state. Any *other* state condition setting them is a
 * defect.
 *
 * This is the lintable half of the focus-ring invariant. StyleX assigns a fixed
 * numeric priority per condition *kind*, not per authoring position, so an
 * attribute-state condition outranks a pseudo-class condition on the same
 * property no matter how they are written. Measured: a selected-state shadow beat
 * a focus-visible shadow, so an element that was both selected and
 * keyboard-focused silently lost its focus ring — an accessibility regression
 * neither the type checker nor value validation can see. Partitioning the
 * properties makes the collision impossible rather than merely managed: focus
 * owns `outline*`, selection and pressed states restyle `boxShadow` and
 * background.
 *
 * Allowed alongside focus-visible:
 * - the unconditional base value, so `outline: 'none'` can suppress the
 *   user-agent ring;
 * - `default` inside a condition object, same reason;
 * - at-rule conditions (`@media`, `@container`, `@supports`), which are not
 *   states — a forced-colours or reduced-motion override of the ring is fine;
 * - pseudo-elements (`::before`), which draw a different box entirely.
 *
 * Any condition key containing `focus-visible` counts as the focus-visible state,
 * which covers both the native `:focus-visible` pseudo-class and the accessible-
 * component library's `[data-focus-visible]` attribute state. Plain `:focus` does
 * NOT count: that is the mistake this rule exists to catch.
 *
 * See stylex spec "State styling" and requirement R06.
 *
 * @example
 * // ✅ Good - base suppression plus the focus-visible ring
 * stylex.create({
 *   button: {
 *     outline: { default: 'none', ':focus-visible': '2px solid' },
 *     boxShadow: { default: null, '[data-selected]': 'inset 0 0 0 1px' },
 *   },
 * })
 *
 * // ❌ Bad - a selection state claims the focus-ring property
 * stylex.create({ button: { outline: { default: 'none', '[data-selected]': '2px solid' } } })
 *
 * // ❌ Bad - same defect written the other way round
 * stylex.create({ button: { ':hover': { outlineColor: 'red' } } })
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

/** The focus-ring properties, reserved for the focus-visible state. */
const FOCUS_RING_PROPERTIES: Readonly<Record<string, true>> = {
  outline: true,
  outlineOffset: true,
  outlineColor: true,
}

/**
 * A condition key that is a *state* — a pseudo-class or an attribute condition —
 * as opposed to `default`, an at-rule, or a pseudo-element. Only states can
 * collide with the focus ring, because only states describe the same element in
 * the same layout.
 */
const isStateCondition = (name: string): boolean => {
  if (name === 'default') return false
  if (name.startsWith('@') === true) return false
  if (name.startsWith('::') === true) return false
  if (name.includes('focus-visible') === true) return false
  return isConditionKey(name) === true
}

type ConditionWalk = {
  readonly context: StylexRuleContext
  readonly node: TSESTree.Node
  /** Focus-ring property already on the path, if any. */
  readonly focusRingProperty: string | undefined
  /** Non-focus-visible state condition already on the path, if any. */
  readonly stateCondition: string | undefined
}

/**
 * Walk a style object reporting where a focus-ring property and a
 * non-focus-visible state condition meet.
 *
 * StyleX allows either nesting order — property outside condition, or condition
 * outside property — so the report fires at whichever of the two is encountered
 * second. That yields exactly one diagnostic per offending pair, at the node that
 * introduced the conflict.
 */
const walkConditions = ({
  context,
  node,
  focusRingProperty,
  stateCondition,
}: ConditionWalk): void => {
  // A dynamic style is an arrow returning the style object; unwrap to reach it.
  if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
    walkConditions({ context, node: node.body, focusRingProperty, stateCondition })
    return
  }
  if (
    node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSNonNullExpression'
  ) {
    walkConditions({ context, node: node.expression, focusRingProperty, stateCondition })
    return
  }
  if (node.type !== 'ObjectExpression') return

  for (const member of node.properties) {
    if (member.type !== 'Property') continue

    const key = staticKeyName(member)
    if (key === undefined) {
      // A computed key is a `when.*` observed condition: a state, and never
      // focus-visible.
      if (focusRingProperty !== undefined) {
        context.report({
          node: member,
          messageId: 'outlineOutsideFocusVisible',
          data: { property: focusRingProperty, condition: 'an observed `when.*` condition' },
        })
      }
      walkConditions({
        context,
        node: member.value,
        focusRingProperty,
        stateCondition: stateCondition ?? 'an observed `when.*` condition',
      })
      continue
    }

    if (isConditionKey(key) === true) {
      const isState = isStateCondition(key)
      if (isState === true && focusRingProperty !== undefined) {
        context.report({
          node: member,
          messageId: 'outlineOutsideFocusVisible',
          data: { property: focusRingProperty, condition: key },
        })
      }
      walkConditions({
        context,
        node: member.value,
        focusRingProperty,
        stateCondition: isState === true ? (stateCondition ?? key) : stateCondition,
      })
      continue
    }

    const isFocusRing = FOCUS_RING_PROPERTIES[key] === true
    if (isFocusRing === true && stateCondition !== undefined) {
      context.report({
        node: member,
        messageId: 'outlineOutsideFocusVisible',
        data: { property: key, condition: stateCondition },
      })
    }
    walkConditions({
      context,
      node: member.value,
      focusRingProperty: isFocusRing === true ? key : focusRingProperty,
      stateCondition,
    })
  }
}

/** ESLint rule reserving the outline properties for the focus-visible state. */
export const stylexOutlineFocusVisibleOnlyRule = {
  meta: {
    type: 'problem' as const,
    docs: {
      description:
        'Reserve outline, outlineOffset and outlineColor for the focus-visible state',
      recommended: false,
    },
    messages: {
      outlineOutsideFocusVisible:
        '`{{property}}` is reserved for the focus-visible state but is set under `{{condition}}`. StyleX orders conditions by kind, not by authoring position, so this state can silently outrank the focus ring on the same property. Restyle `boxShadow` or a background property for `{{condition}}` instead — partitioning the properties is what makes the focus ring collision-proof.',
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

        // The style-map level names style objects, not properties or conditions,
        // so descend one level before tracking anything.
        for (const member of styleMap.properties) {
          if (member.type !== 'Property') continue
          walkConditions({
            context,
            node: member.value,
            focusRingProperty: undefined,
            stateCondition: undefined,
          })
        }
      },
    }
  },
}
