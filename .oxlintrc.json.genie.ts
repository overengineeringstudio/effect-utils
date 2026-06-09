import {
  baseOxlintCategories,
  baseOxlintIgnorePatterns,
  baseOxlintOverrides,
  baseOxlintPlugins,
  baseOxlintRules,
} from './genie/oxlint-base.ts'
import { oxlintConfig, type OxlintConfigArgs } from './packages/@overeng/genie/src/runtime/mod.ts'

/** Path to custom oxlint rules plugin */
const OXC_PLUGIN_PATH = './packages/@overeng/oxc-config/src/mod.ts'

export default oxlintConfig({
  plugins: baseOxlintPlugins,
  jsPlugins: [OXC_PLUGIN_PATH],
  categories: baseOxlintCategories,
  rules: baseOxlintRules,
  ignorePatterns: baseOxlintIgnorePatterns,
  overrides: [
    ...baseOxlintOverrides,
    // Genie runtime must be dependency-free (issue #138)
    {
      files: ['**/genie/src/runtime/**'],
      rules: { 'overeng/no-external-imports': 'error' },
    },
    {
      files: ['**/genie/src/runtime/**/*.test.ts'],
      rules: { 'overeng/no-external-imports': 'off' },
    },
    // restate-effect: ban raw nondeterminism in SOURCE handler code (R20, decision
    // 0004). The journaled Clock/Random + explicit durable combinators are the
    // primary guarantee; this lint is an advisory backstop. Scoped to `src/` only —
    // the follow-up override re-disables it for test setup + the `./testing`
    // harness so they can use Date.now / random freely.
    {
      files: ['**/restate-effect/src/**'],
      rules: {
        'overeng/no-raw-nondeterminism': 'error',
        // Ban non-durable Effect.sleep/timeout in handler src (steer to
        // Restate.sleep/timeout, which journal a durable timer that survives
        // suspension/replay). EXEMPT for the same test + harness/testing infra
        // files below — that lifecycle code (live-clock sleeps, in-memory context)
        // is not a durable handler.
        'overeng/no-non-durable-wait': 'error',
      },
    },
    {
      files: [
        '**/restate-effect/src/**/*.test.ts',
        '**/restate-effect/src/**/*.test.tsx',
        // The `./testing` harness manages the native restate-server lifecycle
        // (poll deadlines, ephemeral ports, the live-clock sleep util) — server
        // infra, not handler code. The in-memory TestContext is likewise test infra.
        '**/restate-effect/src/testing/testing.ts',
        '**/restate-effect/src/testing/TestContext.ts',
        '**/restate-effect/test/**',
      ],
      rules: {
        'overeng/no-raw-nondeterminism': 'off',
        'overeng/no-non-durable-wait': 'off',
      },
    },
    // effect-utils specific: react-inspector is a fork with its own style
    {
      files: ['**/react-inspector/**'],
      rules: {
        'func-style': 'off',
        'overeng/named-args': 'off',
        'unicorn/no-new-array': 'off',
        'unicorn/no-array-sort': 'off',
        'unicorn/consistent-function-scoping': 'off',
        'import/no-named-as-default': 'off',
        'overeng/exports-first': 'off',
        'overeng/jsdoc-require-exports': 'off',
        // oxlint reports this rule's strictNullChecks precondition at byte 0,
        // before inline suppression comments can apply. react-inspector keeps
        // package-local relaxed TypeScript settings while the fork is upstreamed.
        'typescript/no-useless-default-assignment': 'off',
      },
    },
    // notion-react: incubation lint waiver (tracked in #599; remove before GA)
    {
      files: ['**/notion-react/**'],
      rules: {
        'overeng/jsdoc-require-exports': 'off',
        'overeng/explicit-boolean-compare': 'off',
        'overeng/named-args': 'off',
        'overeng/exports-first': 'off',
        'overeng/storybook/csf-component': 'off',
        'no-await-in-loop': 'off',
      },
    },
    // KDL parser uses control chars in regexes (KDL spec whitespace/newline matching),
    // generator functions (can't be arrow), and has a structural document<->node cycle
    // KDL packages: ported from @bgotink/kdl — relaxed rules for the port
    {
      files: ['**/kdl/src/**', '**/kdl-effect/src/**'],
      rules: {
        'no-control-regex': 'off',
        'func-style': 'off',
        'import/no-cycle': 'off',
        'overeng/jsdoc-require-exports': 'off',
        'overeng/explicit-boolean-compare': 'off',
        'overeng/exports-first': 'off',
        'overeng/named-args': 'off',
      },
    },
  ],
} satisfies OxlintConfigArgs)
