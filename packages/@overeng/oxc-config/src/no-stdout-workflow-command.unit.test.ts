import { RuleTester } from 'eslint'
import { describe, it } from 'vitest'

import plugin from './mod.ts'

RuleTester.describe = describe
RuleTester.it = it

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

const rule = plugin.rules['no-stdout-workflow-command']

/** The exact rendered message for a flagged `console.log`. */
const consoleLogMessage =
  'GitHub workflow command written to stdout via `console.log`. `devenv tasks run` discards a task stdout, so this never reaches the runner and never becomes an annotation. Write it to stderr instead (`console.error`).'

ruleTester.run('no-stdout-workflow-command: stderr and non-commands are fine', rule, {
  valid: [
    { code: `console.error('::warning::store rebuilt')` },
    { code: 'process.stderr.write(`::group::${label}\\n`)' },
    { code: `console.log('build finished')` },
    // A `::` arriving from an interpolated value is not at the start of the line, so GitHub
    // never reads it as a command.
    { code: 'console.log(`${prefix}::warning::not a command`)' },
    // Not stdout, and not a workflow command either.
    { code: `logger.log('::warning::custom sink')` },
  ],
  invalid: [],
})

ruleTester.run('no-stdout-workflow-command: stdout sinks are flagged', rule, {
  valid: [],
  invalid: [
    {
      code: `console.log('::warning::store rebuilt')`,
      errors: [{ message: consoleLogMessage }],
    },
    {
      code: `console.log(\`::warning title=Quarantined test failure::\${summary}\`)`,
      errors: [{ messageId: 'stdoutWorkflowCommand' }],
    },
    {
      code: `console.info('::notice::skipped')`,
      errors: [{ messageId: 'stdoutWorkflowCommand' }],
    },
    {
      code: `console.log('::group::' + label)`,
      errors: [{ messageId: 'stdoutWorkflowCommand' }],
    },
    {
      code: `process.stdout.write('::endgroup::\\n')`,
      errors: [{ messageId: 'stdoutWorkflowCommand' }],
    },
    {
      code: `globalThis.process.stdout.write('::error::boom\\n')`,
      errors: [{ messageId: 'stdoutWorkflowCommand' }],
    },
  ],
})
