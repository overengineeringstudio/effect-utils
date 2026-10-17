/**
 * Shared AST helpers for the `overeng/stylex-*` rules.
 *
 * Both StyleX rules need the same two things: recognise a `stylex.create(...)`
 * call — and *only* that call, because the token-layer APIs `defineConsts`,
 * `defineVars` and `createTheme` are exactly where literal colours legitimately
 * live — and tell a CSS property key apart from a condition key inside a style
 * object.
 *
 * Source of truth for the call-shape detection is `@stylexjs/eslint-plugin`'s
 * `stylex-valid-styles` (`isStylexCallee` plus its import tracking),
 * reimplemented here because an oxlint JS plugin cannot reuse the upstream
 * rule's internals.
 *
 * NOTE on typing: the oxlint JS-plugin API ships no TypeScript definitions, and
 * every older rule in this plugin annotates it `any`. These rules instead use
 * `TSESTree` from `@typescript-eslint/utils` (already a devDependency, and the
 * type-only import is erased before bundling) because the host presents
 * ESLint-v8-compatible ESTree nodes, and because `any` is prohibited.
 */

import type { TSESTree } from '@typescript-eslint/utils'

/** The subset of the ESLint/oxlint rule context these rules use. */
export type StylexRuleContext = {
  readonly report: (descriptor: {
    readonly node: TSESTree.Node
    readonly messageId: string
    readonly data?: Readonly<Record<string, string>>
  }) => void
}

/** Mutable per-file record of which local bindings refer to the StyleX API. */
export type StylexImports = {
  /** Locals bound to the whole namespace, e.g. `import * as stylex from '@stylexjs/stylex'`. */
  readonly namespaces: Set<string>
  /** Locals bound to `create` directly, e.g. `import { create } from '@stylexjs/stylex'`. */
  readonly creates: Set<string>
}

/** Fresh, empty import record for one linted file. */
export const createStylexImports = (): StylexImports => ({
  namespaces: new Set<string>(),
  creates: new Set<string>(),
})

/**
 * Record the StyleX bindings introduced by one `ImportDeclaration`.
 *
 * Only the runtime module counts. A `*.stylex.ts` token module is deliberately
 * NOT treated as the StyleX namespace: its exports are token objects, and
 * mistaking one for the API would make `tokens.create` look like a style
 * declaration.
 */
export const trackStylexImport = ({
  imports,
  node,
}: {
  readonly imports: StylexImports
  readonly node: TSESTree.ImportDeclaration
}): void => {
  const source = node.source.value
  if (source !== '@stylexjs/stylex' && source !== 'stylex') return

  for (const specifier of node.specifiers) {
    if (
      specifier.type === 'ImportNamespaceSpecifier' ||
      specifier.type === 'ImportDefaultSpecifier'
    ) {
      imports.namespaces.add(specifier.local.name)
    }
    if (
      specifier.type === 'ImportSpecifier' &&
      specifier.imported.type === 'Identifier' &&
      specifier.imported.name === 'create'
    ) {
      imports.creates.add(specifier.local.name)
    }
  }
}

/**
 * The single style-map argument of a `stylex.create({ ... })` call, or
 * `undefined` when `node` is not such a call.
 *
 * The bare name `stylex` is accepted even without a tracked import, because that
 * is the fleet-wide convention and it keeps the rule working when the namespace
 * arrives through a re-export. A same-named method on any other object (say
 * `db.create({ ... })`) is not a match.
 */
export const stylexCreateArgument = ({
  imports,
  node,
}: {
  readonly imports: StylexImports
  readonly node: TSESTree.CallExpression
}): TSESTree.ObjectExpression | undefined => {
  if (node.arguments.length !== 1) return undefined

  // `as const` / `satisfies` around the style map must not silently bypass the rule.
  let argument = node.arguments[0]
  while (
    argument !== undefined &&
    (argument.type === 'TSAsExpression' || argument.type === 'TSSatisfiesExpression')
  ) {
    argument = argument.expression
  }
  if (argument === undefined || argument.type !== 'ObjectExpression') return undefined

  const callee = node.callee
  if (callee.type === 'Identifier') {
    return imports.creates.has(callee.name) === true ? argument : undefined
  }

  const isCreateMember =
    callee.type === 'MemberExpression' &&
    callee.computed === false &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'create' &&
    callee.object.type === 'Identifier' &&
    (imports.namespaces.has(callee.object.name) === true || callee.object.name === 'stylex')

  return isCreateMember === true ? argument : undefined
}

/** Static name of a non-computed object-property key, if it has one. */
export const staticKeyName = (property: TSESTree.Property): string | undefined => {
  if (property.computed === true) return undefined
  const key = property.key
  if (key.type === 'Identifier') return key.name
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value
  return undefined
}

/**
 * Whether a static style-object key selects a *condition* rather than naming a
 * CSS property: `default`, a pseudo-class or pseudo-element (`:hover`,
 * `::before`), an at-rule (`@media`, `@container`), or an attribute state
 * (`[data-selected]`).
 */
export const isConditionKey = (name: string): boolean =>
  name === 'default' || /^[:@[&>~+*]/.test(name)
