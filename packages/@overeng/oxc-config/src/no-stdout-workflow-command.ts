/**
 * no-stdout-workflow-command oxlint rule.
 *
 * Bans GitHub workflow commands (`::warning::`, `::group::`, `::notice::`, …) written to
 * stdout. `devenv tasks run` does not forward a task's stdout to the caller — on success or
 * on failure, regardless of `--show-output` or `DEVENV_TASK_PASSTHROUGH` — so a workflow
 * command emitted there never reaches the runner and never becomes an annotation or a log
 * group. stderr is forwarded in every case.
 *
 * The mistake is invisible without a guard: the emit reads as correct and simply does
 * nothing. It has already happened at six lines across four Nix task modules
 * (overengineeringstudio/effect-utils#969) and once in a TypeScript CI script
 * (livestorejs/livestore#968); `lint:nix:workflow-commands` covers the Nix side.
 *
 * This rule is a **workaround, not a general best practice.** GitHub's documented form writes
 * workflow commands to stdout, and on a plain shell step that works. stderr is required only
 * because devenv drops task stdout — reported as cachix/devenv#3038, where stdout is also shown
 * to carry no protocol data (task outputs travel via `DEVENV_TASK_OUTPUT_FILE`).
 *
 * TODO(cachix/devenv#3038): remove this rule, its test, and the `>&2` redirects in the shared
 * task modules once devenv forwards task stdout and the fixed version is pinned everywhere.
 *
 * @example
 * // ✅ Good
 * console.error('::warning::pnpm store was rebuilt from scratch')
 * process.stderr.write(`::group::${label}\n`)
 *
 * // ❌ Bad — silently discarded under devenv
 * console.log('::warning::pnpm store was rebuilt from scratch')
 * process.stdout.write(`::group::${label}\n`)
 */

// NOTE: Using `any` types because oxlint JS plugin API doesn't have TypeScript definitions yet

/**
 * The leading text a node contributes, or `undefined` when it cannot be read statically.
 *
 * Only the head of the emitted string matters: GitHub parses a workflow command by its `::`
 * prefix at the start of a line, so a `::` arriving from an interpolated value mid-string is
 * not one. A template literal therefore reports its first quasi, and a `+` concatenation
 * recurses into its left operand.
 */
const leadingText = (node: any): string | undefined => {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value

  if (node?.type === 'TemplateLiteral') {
    const head = node.quasis?.[0]?.value?.cooked
    return typeof head === 'string' ? head : undefined
  }

  if (node?.type === 'BinaryExpression' && node.operator === '+') {
    return leadingText(node.left)
  }

  return undefined
}

/** Whether a first argument begins a GitHub workflow command. */
const isWorkflowCommand = (node: any): boolean => leadingText(node)?.startsWith('::') === true

/** Match `console.log(...)` and `console.info(...)`, both of which write to stdout. */
const isConsoleStdoutCallee = (callee: any): boolean =>
  callee?.type === 'MemberExpression' &&
  callee.computed === false &&
  callee.object?.type === 'Identifier' &&
  callee.object.name === 'console' &&
  (callee.property?.name === 'log' || callee.property?.name === 'info')

/** Match `process.stdout.write(...)`, including the `globalThis.process` spelling. */
const isProcessStdoutWriteCallee = (callee: any): boolean => {
  if (callee?.type !== 'MemberExpression' || callee.computed === true) return false
  if (callee.property?.name !== 'write') return false

  const stdout = callee.object
  if (stdout?.type !== 'MemberExpression' || stdout.computed === true) return false
  if (stdout.property?.name !== 'stdout') return false

  const process = stdout.object
  if (process?.type === 'Identifier' && process.name === 'process') return true

  return (
    process?.type === 'MemberExpression' &&
    process.computed === false &&
    process.object?.type === 'Identifier' &&
    process.object.name === 'globalThis' &&
    process.property?.name === 'process'
  )
}

/** ESLint rule banning GitHub workflow commands on stdout, which devenv discards */
export const noStdoutWorkflowCommandRule = {
  meta: {
    type: 'problem' as const,
    docs: {
      description: 'Ban GitHub workflow commands written to stdout, which devenv discards',
      recommended: false,
    },
    messages: {
      stdoutWorkflowCommand:
        'GitHub workflow command written to stdout via `{{sink}}`. `devenv tasks run` discards a task stdout, so this never reaches the runner and never becomes an annotation. Write it to stderr instead ({{replacement}}).',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context: any) {
    return {
      CallExpression(node: any) {
        const [first] = node.arguments ?? []
        if (isWorkflowCommand(first) === false) return

        if (isConsoleStdoutCallee(node.callee) === true) {
          context.report({
            node,
            messageId: 'stdoutWorkflowCommand',
            data: { sink: `console.${node.callee.property.name}`, replacement: '`console.error`' },
          })
          return
        }

        if (isProcessStdoutWriteCallee(node.callee) === true) {
          context.report({
            node,
            messageId: 'stdoutWorkflowCommand',
            data: { sink: 'process.stdout.write', replacement: '`process.stderr.write`' },
          })
        }
      },
    }
  },
}
