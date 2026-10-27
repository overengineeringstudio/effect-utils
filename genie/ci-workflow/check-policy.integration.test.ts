import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sameRepoPullRequestGuard } from '../../packages/@overeng/genie/src/runtime/github-workflow/policy.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const fixture = async (yaml: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'ci-policy-'))
  roots.push(root)
  await mkdir(join(root, '.github/workflows'), { recursive: true })
  await Bun.write(join(root, '.github/workflows/ci.yml'), yaml)
  return root
}
const workflow = ({
  runner = '[sh-linux-x64, nix]',
  event = 'push',
  step = 'run: echo compliant',
  condition,
}: {
  runner?: string
  event?: string
  step?: string
  condition?: string
} = {}): string => `on: ${event}
jobs:
  check:
    runs-on: ${runner}
${condition === undefined ? '' : `    if: ${condition}\n`}    steps:
      - ${step}
`
const run = async (root: string, exceptionsFile?: string) => {
  const process = Bun.spawn(
    [
      Bun.which('bun') ?? Bun.argv[0]!,
      new URL('./check-policy.ts', import.meta.url).pathname,
      root,
      'example/consumer',
      ...(exceptionsFile === undefined ? [] : [exceptionsFile]),
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

test('entrypoint admits a compliant workflow without dependencies or network', async () => {
  const result = await run(await fixture(workflow()))
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('CI workflow fleet policy passed')
})

for (const [name, yaml, rule] of [
  ['hosted runner', workflow({ runner: 'ubuntu-latest' }), 'hosted-runner'],
  ['target event', workflow({ event: 'pull_request_target' }), 'pull-request-target'],
  [
    'Actions cache',
    workflow({ step: 'uses: actions/cache@0123456789012345678901234567890123456789' }),
    'banned-action',
  ],
  [
    'unguarded pull request',
    workflow({ event: 'pull_request' }),
    'fleet-pr-without-same-repo-guard',
  ],
  [
    'fork-controlled runner',
    workflow({ event: 'pull_request', runner: "'${{ inputs.runner }}'" }),
    'fork-controlled-runner',
  ],
] as const) {
  test(`entrypoint rejects ${name} with the shared finding`, async () => {
    const result = await run(await fixture(yaml))
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(rule)
    expect(result.stderr).toContain('.github/workflows/ci.yml')
  })
}

test('entrypoint recognizes the canonical same-repository guard', async () => {
  const result = await run(
    await fixture(workflow({ event: 'pull_request', condition: sameRepoPullRequestGuard() })),
  )
  expect(result.exitCode).toBe(0)
})

test('entrypoint includes .yaml files and aggregates findings across workflows', async () => {
  const root = await fixture(workflow({ runner: 'ubuntu-latest' }))
  await Bun.write(
    join(root, '.github/workflows/cache.yaml'),
    workflow({ step: 'uses: actions/cache@v4' }),
  )
  const result = await run(root)
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain('hosted-runner')
  expect(result.stderr).toContain('banned-action')
  expect(result.stderr).toContain('.github/workflows/cache.yaml')
})

test('entrypoint rejects malformed workflows rather than skipping them', async () => {
  const result = await run(await fixture('jobs: {}\n'))
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain('expected workflow triggers and nonempty jobs')
})

test('entrypoint fails closed for opaque reusable workflow calls', async () => {
  const result = await run(
    await fixture(
      'on: push\njobs:\n  check:\n    uses: example/consumer/.github/workflows/reusable.yml@main\n',
    ),
  )
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain('reusable workflow calls are not admitted')
})

test('consumer exceptions cannot suppress never-exceptable cache findings', async () => {
  const root = await fixture(workflow({ step: 'uses: actions/cache@v4' }))
  await Bun.write(
    join(root, 'exceptions.json'),
    JSON.stringify({
      exceptions: [
        {
          repository: 'example/consumer',
          workflow: '.github/workflows/ci.yml',
          job: 'check',
          rule: 'banned-action',
          owner: 'owner',
          approver: 'approver',
          justification: 'test',
          expiry: '2099-01-01',
          trackingIssue: 'https://github.com/example/consumer/issues/1',
        },
      ],
    }),
  )
  const result = await run(root, 'exceptions.json')
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain('INVALID_EXCEPTION')
})

test('consumer exceptions reject unknown workflow identities', async () => {
  const root = await fixture(workflow())
  await Bun.write(
    join(root, 'exceptions.json'),
    JSON.stringify({
      exceptions: [
        {
          repository: 'example/consumer',
          workflow: '.github/workflows/missing.yml',
          job: 'check',
          rule: 'dynamic-runner',
          owner: 'owner',
          approver: 'approver',
          justification: 'test',
          expiry: '2099-01-01',
          trackingIssue: 'https://github.com/example/consumer/issues/1',
        },
      ],
    }),
  )
  const result = await run(root, 'exceptions.json')
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain('Stale or unmatched exception')
})

for (const condition of ['true', 'false', '0', '1', '-1', '1.5']) {
  test(`entrypoint normalizes scalar condition ${condition}`, async () => {
    expect((await run(await fixture(workflow({ condition })))).exitCode).toBe(0)
  })
  test(`scalar condition ${condition} does not replace a same-repository guard`, async () => {
    const result = await run(await fixture(workflow({ event: 'pull_request', condition })))
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('fleet-pr-without-same-repo-guard')
  })
}

for (const condition of ['{ unexpected: true }', '[true]']) {
  test(`entrypoint rejects nonscalar condition ${condition}`, async () => {
    const result = await run(await fixture(workflow({ condition })))
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('must be a scalar expression')
  })
}

for (const step of [
  '{}',
  '[]',
  'name: not executable',
  '{ run: echo invalid, uses: actions/checkout@v6 }',
  '{ run: null }',
  '{ uses: false }',
  '{ run: 1 }',
  '{ uses: \"\" }',
  '{ run: \" \" }',
]) {
  test(`entrypoint rejects unknown step shape ${step}`, async () => {
    const result = await run(await fixture(workflow({ step })))
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('has an invalid step')
  })
}
