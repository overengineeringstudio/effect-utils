import { expect, test } from 'bun:test'

import ciWorkflow from '../../.github/workflows/ci.yml.genie.ts'

interface Step {
  name?: string
  run?: string
  if?: string
  'continue-on-error'?: boolean
  'timeout-minutes'?: number
}

const workflow: { jobs: Record<string, { steps: Step[] }> } = Bun.YAML.parse(
  ciWorkflow.stringify({ cwd: process.cwd(), location: '' }),
)
const steps = workflow.jobs['test-macos']!.steps
const earlyName = 'Warm local Nix substituter after bootstrap'
const finalName = 'Save signed and content-addressed store paths to local Nix substituter'
const early = steps.find((step) => step.name === earlyName)!
const final = steps.find((step) => step.name === finalName)!

test('macOS warms the substituter immediately after successful bootstrap and retains the final save', () => {
  const bootstrap = steps.findIndex(
    (step) => step.name === 'Prepare source generator dependency views',
  )
  expect(bootstrap).toBeGreaterThan(-1)
  expect(steps[bootstrap + 1]?.name).toBe(earlyName)
  expect(early.if).toBe(
    "${{ (success()) && ((runner.os != 'Linux' || steps.linux-sandbox-admission.outcome == 'success')) }}",
  )
  expect(steps.findIndex((step) => step.name === finalName)).toBeGreaterThan(
    steps.findIndex((step) => step.name === 'Unit tests'),
  )
  expect(final.if).toBe(
    "${{ (!cancelled()) && ((runner.os != 'Linux' || steps.linux-sandbox-admission.outcome == 'success')) }}",
  )
  expect(workflow.jobs.test!.steps.some((step) => step.name === earlyName)).toBe(false)
  expect(workflow.jobs.test!.steps.some((step) => step.name === finalName)).toBe(false)
})

test('early and final saves share the exact copy mechanism and bounded best-effort budget', () => {
  expect(early.run).toBeDefined()
  expect(early.run).toBe(final.run)
  for (const step of [early, final]) {
    expect(step['continue-on-error']).toBe(true)
    expect(step['timeout-minutes']).toBe(15)
    expect(step.run).toContain('nix copy --stdin --to')
    expect(step.run).not.toContain('require-sigs')
  }
})

test('the actual save filter includes unsigned content-addressed paths but not unsigned input-addressed paths', () => {
  const filter = final.run!.match(/jq -r '([^']+)'/)?.[1]
  expect(filter).toBeDefined()
  const result = Bun.spawnSync(['jq', '-r', filter!], {
    stdin: new TextEncoder().encode(
      JSON.stringify({
        '/nix/store/signed': { signatures: ['upstream-1:signature'] },
        '/nix/store/fixed': { signatures: [], ca: 'fixed:sha256:hash', ultimate: true },
        '/nix/store/text': { ca: 'text:sha256:hash' },
        '/nix/store/unsigned': { signatures: [], ultimate: true },
        '/nix/store/empty-ca': { signatures: [], ca: '' },
        '/nix/store/missing': {},
      }),
    ),
  })
  expect(result.exitCode).toBe(0)
  expect(new TextDecoder().decode(result.stdout).trim().split('\n')).toEqual([
    '/nix/store/signed',
    '/nix/store/fixed',
    '/nix/store/text',
  ])
})
