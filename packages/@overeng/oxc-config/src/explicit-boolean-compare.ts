/**
 * explicit-boolean-compare oxlint rule.
 *
 * Enforce explicit boolean-literal comparisons in condition positions.
 * This is the inverse of the standard `typescript/no-unnecessary-boolean-literal-compare` rule.
 *
 * Conditions in `if`, `while`, `do-while`, `for`, and ternary expressions
 * must use explicit comparisons rather than relying on implicit truthiness coercion.
 *
 * @example
 * // ✅ Good - explicit comparisons
 * if (isReady === true) {}
 * if (isReady === false) {}
 * if (count > 0) {}
 * if (value !== null) {}
 * if (isReady === true && count > 0) {}
 * while (running === true) {}
 * const result = enabled === true ? 'yes' : 'no'
 *
 * // ❌ Bad - implicit boolean coercion
 * if (isReady) {}
 * if (!isReady) {}
 * if (getValue()) {}
 * while (running) {}
 * const result = enabled ? 'yes' : 'no'
 *
 * See: https://github.com/overengineeringstudio/effect-utils/issues/219
 */

const COMPARISON_OPERATORS = new Set([
  '===',
  '!==',
  '==',
  '!=',
  '<',
  '>',
  '<=',
  '>=',
  'instanceof',
  'in',
])

/** Check if a node is an explicit comparison or boolean literal (terminal explicit node). */
const isExplicit = (node: any): boolean => {
  if (!node) return true

  // Comparison operators produce explicit boolean results
  if (node.type === 'BinaryExpression' && COMPARISON_OPERATORS.has(node.operator)) return true

  // Boolean literals are explicit
  if (node.type === 'Literal' && typeof node.value === 'boolean') return true

  return false
}

/**
 * Collect all implicitly-coerced sub-expressions within a condition.
 *
 * Recurses through `&&`/`||` logical combinators and `!` negation to find
 * leaf expressions that rely on implicit truthiness coercion.
 */
const collectImplicit = (node: any): any[] => {
  if (!node) return []

  // Explicit comparison or boolean literal — nothing to flag
  if (isExplicit(node)) return []

  // Logical combinators (&&, ||) — check each side independently
  if (node.type === 'LogicalExpression' && (node.operator === '&&' || node.operator === '||')) {
    return [...collectImplicit(node.left), ...collectImplicit(node.right)]
  }

  // Negation (!) — transparent if argument is explicit or logical
  if (node.type === 'UnaryExpression' && node.operator === '!') {
    if (isExplicit(node.argument)) return []
    if (
      node.argument.type === 'LogicalExpression' &&
      (node.argument.operator === '&&' || node.argument.operator === '||')
    ) {
      return collectImplicit(node.argument)
    }
    // !identifier, !callExpr, etc. — flag the whole !expr
    return [node]
  }

  // Everything else (identifier, call, member, etc.) — implicit
  return [node]
}

/** ESLint rule enforcing explicit boolean comparisons in condition positions */
export const explicitBooleanCompareRule = {
  meta: {
    type: 'suggestion' as const,
    docs: {
      description:
        'Enforce explicit boolean-literal comparisons in condition positions (if, while, for, ternary)',
      recommended: false,
    },
    messages: {
      implicitBooleanCondition:
        'Avoid implicit boolean coercion. Use an explicit comparison (e.g. `=== true`, `=== false`, `!== null`).',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context: any) {
    const checkTest = (test: any) => {
      if (!test) return
      for (const node of collectImplicit(test)) {
        context.report({ node, messageId: 'implicitBooleanCondition' })
      }
    }

    return {
      IfStatement(node: any) {
        checkTest(node.test)
      },
      WhileStatement(node: any) {
        checkTest(node.test)
      },
      DoWhileStatement(node: any) {
        checkTest(node.test)
      },
      ForStatement(node: any) {
        checkTest(node.test)
      },
      ConditionalExpression(node: any) {
        checkTest(node.test)
      },
    }
  },
}
