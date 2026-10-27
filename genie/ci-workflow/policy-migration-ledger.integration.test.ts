import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { collectWorkflowPolicyViolations } from '../../packages/@overeng/genie/src/runtime/github-workflow/policy.ts'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const policy = {
  repository: 'example/project',
  workflow: 'ci.yml',
  admittedRunnerLabels: ['pool-small'],
}
const workflow = (runner: string) => ({
  on: 'push' as const,
  jobs: { check: { 'runs-on': runner, steps: [{ run: 'echo ok' }] } },
})

const withFixture = (
  run: (fixture: {
    root: string
    ledgerPath: string
    setRunner: (runner: string) => void
    generate: (check?: boolean) => { status: number | null; output: string }
  }) => void,
) => {
  const parent = join(repositoryRoot, 'tmp')
  mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(join(parent, 'policy-ledger-refresh-'))
  const ledgerPath = join(root, 'ledger.json')
  const runtime = pathToFileURL(join(repositoryRoot, 'packages/@overeng/genie/src/runtime')).href
  const setRunner = (runner: string) =>
    writeFileSync(
      join(root, 'workflow.ts'),
      `
import { githubWorkflow } from '${runtime}/github-workflow/mod.ts'
import ledger from './ledger.json' with { type: 'json' }
export default githubWorkflow({
  ...${JSON.stringify(workflow(runner))},
  actionlint: false,
  policy: { ...${JSON.stringify(policy)}, mode: 'report', ledger: ledger.violations },
})
`,
    )
  try {
    // Give discovery an isolated Git boundary rather than the parent's ignored tmp/.
    const initialized = Bun.spawnSync(['git', 'init', root], { cwd: repositoryRoot })
    expect(initialized.exitCode).toBe(0)
    writeFileSync(
      ledgerPath,
      JSON.stringify(
        {
          source: 'ledger.json.genie.ts',
          violations: collectWorkflowPolicyViolations({
            workflow: workflow('legacy-runner'),
            policy,
          }),
        },
        null,
        2,
      ) + '\n',
    )
    writeFileSync(
      join(root, 'ledger.json.genie.ts'),
      `
import workflow from './workflow.ts'
import { createGenieOutput } from '${runtime}/core.ts'
import { collectEffectiveWorkflowPolicyViolations } from '${runtime}/github-workflow/policy.ts'
import ledger from './ledger.json' with { type: 'json' }
const data = {
  source: 'ledger.json.genie.ts',
  violations: collectEffectiveWorkflowPolicyViolations({
    workflow: workflow.data,
    policy: { ...${JSON.stringify(policy)}, mode: 'report', ledger: ledger.violations },
  }),
}
export default createGenieOutput({ data, stringify: () => JSON.stringify(data, null, 2) + '\\n' })
`,
    )
    const generate = (check = false) => {
      const result = Bun.spawnSync(
        [
          process.execPath,
          join(repositoryRoot, 'packages/@overeng/genie/bin/genie.tsx'),
          '--cwd',
          root,
          '--output',
          'json',
          ...(check === true ? ['--check'] : []),
        ],
        { cwd: repositoryRoot, env: process.env },
      )
      return {
        status: result.exitCode,
        output: new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr),
      }
    }
    run({ root, ledgerPath, setRunner, generate })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('migration ledger refresh through eager workflow imports', () => {
  it('fails freshness on removed debt, regenerates a smaller ledger, then passes check', () => {
    withFixture(({ ledgerPath, setRunner, generate }) => {
      setRunner('pool-small')
      const before = generate(true)
      expect(before.status, before.output).toBe(1)
      expect(before.output).toContain('ledger.json')
      expect(before.output).not.toContain('WorkflowPolicyError')
      expect(JSON.parse(readFileSync(ledgerPath, 'utf8')).violations).toHaveLength(1)
      const regenerated = generate()
      expect(regenerated.status, regenerated.output).toBe(0)
      expect(JSON.parse(readFileSync(ledgerPath, 'utf8')).violations).toEqual([])
      const after = generate(true)
      expect(after.status, after.output).toBe(0)
    })
  }, 30_000)

  it('never generates new debt or overwrites the committed ledger on failure', () => {
    withFixture(({ ledgerPath, setRunner, generate }) => {
      const committed = readFileSync(ledgerPath, 'utf8')
      setRunner('different-runner')
      const result = generate()
      expect(result.status, result.output).toBe(1)
      expect(result.output).toContain('NEW')
      expect(readFileSync(ledgerPath, 'utf8')).toBe(committed)
    })
  }, 30_000)
})
