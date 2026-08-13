import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { launchBuck as launchBuckRaw, type LaunchOptions } from './launcher.ts'

const launchBuck = (options: Omit<LaunchOptions, 'repositoryRevision' | 'executionPlatform'>) =>
  launchBuckRaw({
    ...options,
    repositoryRevision: '0123456789abcdef0123456789abcdef01234567',
    executionPlatform: 'x86_64-linux',
  })

const fakeBuckSource = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === 'log' && args[1] === 'what-ran') {
  const mode = fs.existsSync('log-mode') ? fs.readFileSync('log-mode', 'utf8').trim() : 'ok'
  if (mode === 'exit') process.exit(9)
  if (mode === 'malformed') { process.stdout.write('not-json\\n'); process.exit(0) }
  if (mode === 'unsupported') { process.stdout.write('{"unexpected":true}\\n'); process.exit(0) }
  if (mode === 'delayed-drain') {
    process.stdout.write(JSON.stringify({ reason: 'build', identity: 'root//:first', executor: 'Local' }) + '\\n')
    require('node:child_process').spawn(process.execPath, ['-e',
      "setTimeout(() => process.stdout.write(JSON.stringify({ reason: 'build', identity: 'root//:second', executor: 'Local' }) + '\\\\n'), 100)"
    ], { stdio: ['ignore', 1, 2] }).unref()
    process.exit(0)
  }
  process.stdout.write(JSON.stringify({
    reason: 'build',
    identity: 'root//:check /home/private token=hunter2',
    reproducer: { executor: 'Local', details: { env: { PRIVATE_TOKEN: 'hunter2' } } },
  }) + '\\n')
  process.exit(0)
}
if (args[0] === 'log' && args[1] === 'what-materialized') process.exit(0)
const delimiter = args.indexOf('--')
const buckArgs = delimiter === -1 ? args : args.slice(0, delimiter)
const value = (flag) => buckArgs[buckArgs.indexOf(flag) + 1]
const buildMode = fs.existsSync('build-mode') ? fs.readFileSync('build-mode', 'utf8').trim() : 'ok'
if (buildMode !== 'missing-event') fs.writeFileSync(value('--event-log'), '{"Event":{}}\\n')
fs.writeFileSync(value('--write-build-id'), '11111111-1111-4111-8111-111111111111\\n')
if (buildMode === 'bad-report') fs.writeFileSync(value('--build-report'), '{"trace_id":7}')
else fs.writeFileSync(value('--build-report'), JSON.stringify({
  trace_id: '11111111-1111-4111-8111-111111111111',
  success: buildMode !== 'fail',
  error_category: buildMode === 'fail' ? 'USER' : undefined,
  results: { 'root//:check': { success: 'SUCCESS', configured: {
    'platform#1': { artifact_info: { DEFAULT: { digest: 'abc123:7' } } },
  } } },
}))
process.exit(buildMode === 'fail' ? 3 : 0)
`

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const canonical = (value: unknown): unknown =>
  Array.isArray(value) === true
    ? value.map(canonical)
    : isRecord(value) === true
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => [key, canonical(child)]),
        )
      : value

const closureManifest = (label = 'root//:check') => {
  const semantic = {
    packagePath: 'packages/example',
    target: {
      name: 'check',
      kind: 'typescript_check',
      sources: ['src/a.ts'],
      configs: ['tsconfig.json'],
      deps: [],
      closureDescriptor: 'buck2/check.closure.json',
    },
    closure: { task: { label } },
  }
  const semanticFingerprint = `sha256:${createHash('sha256')
    .update(JSON.stringify(canonical(semantic)))
    .digest('hex')}`
  return JSON.stringify({
    schemaVersion: 1,
    ...semantic,
    provenance: {
      generator: 'effect-utils/genie/buck2',
      regenerationCommand: 'devenv tasks run genie:run',
      semanticFingerprint,
      semanticInputs: ['package.json'],
    },
  })
}

describe('launchBuck process boundary', () => {
  it.each([
    ['missing', undefined],
    ['malformed', '{not-json'],
    ['unsupported', JSON.stringify({ schema: 'buck-run-receipt/v999' })],
  ])(
    'rejects an explicitly requested %s comparison receipt before executing Buck',
    async (kind, body) => {
      const root = await mkdtemp(join(tmpdir(), `buck2-launcher-compare-${kind}-`))
      const compareReceipt = join(root, 'compare-receipt.json')
      if (body !== undefined) await writeFile(compareReceipt, body)

      await expect(
        launchBuck({
          buckBinary: join(root, 'does-not-exist'),
          buckArgs: ['build', 'root//:check'],
          cwd: root,
          evidenceRoot: join(root, 'evidence'),
          compareReceipt,
          launcherRunId: `compare-${kind}`,
        }),
      ).rejects.toThrow(`explicit compare receipt is ${kind}`)
    },
  )

  it('rejects an explicitly requested incomplete comparison receipt before executing Buck', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buck2-launcher-compare-incomplete-'))
    const binary = join(root, 'fake-buck2')
    await writeFile(binary, fakeBuckSource)
    await chmod(binary, 0o700)
    const first = await launchBuck({
      buckBinary: binary,
      buckArgs: ['build', 'root//:check'],
      cwd: root,
      evidenceRoot: join(root, 'evidence'),
      launcherRunId: 'before-incomplete',
    })
    if (first.receiptPath === undefined) throw new Error('first launch did not write a receipt')
    const incomplete = JSON.parse(await readFile(first.receiptPath, 'utf8')) as Record<
      string,
      unknown
    >
    incomplete.observation = {
      complete: false,
      verdict: 'incomplete',
      reasons: ['event-log'],
      whatRan: { exitCode: 0, parseComplete: true, semanticComplete: true, records: 1 },
      materialized: { exitCode: 0, parseComplete: true, semanticComplete: true, records: 0 },
    }
    await writeFile(first.receiptPath, JSON.stringify(incomplete))

    await expect(
      launchBuck({
        buckBinary: join(root, 'does-not-exist'),
        buckArgs: ['build', 'root//:check'],
        cwd: root,
        evidenceRoot: join(root, 'evidence'),
        compareReceipt: first.receiptPath,
        launcherRunId: 'after-incomplete',
      }),
    ).rejects.toThrow('explicit compare receipt is incomplete')
  })

  it.each([
    {
      name: 'repository revision',
      previousRevision: '1111111111111111111111111111111111111111',
      previousPlatform: 'x86_64-linux',
      currentRevision: '2222222222222222222222222222222222222222',
      currentPlatform: 'x86_64-linux',
      diagnostic: 'repository revision does not match current run',
    },
    {
      name: 'execution platform',
      previousRevision: '1111111111111111111111111111111111111111',
      previousPlatform: 'aarch64-linux',
      currentRevision: '1111111111111111111111111111111111111111',
      currentPlatform: 'x86_64-linux',
      diagnostic: 'execution platform does not match current run',
    },
  ])('rejects a cross-$name comparison receipt before executing Buck', async (identity) => {
    const root = await mkdtemp(join(tmpdir(), `buck2-launcher-compare-${identity.name}-`))
    const binary = join(root, 'fake-buck2')
    await writeFile(binary, fakeBuckSource)
    await chmod(binary, 0o700)
    const first = await launchBuckRaw({
      buckBinary: binary,
      buckArgs: ['build', 'root//:check'],
      cwd: root,
      evidenceRoot: join(root, 'evidence'),
      repositoryRevision: identity.previousRevision,
      executionPlatform: identity.previousPlatform,
      launcherRunId: 'identity-before',
    })
    if (first.receiptPath === undefined) throw new Error('first launch did not write a receipt')

    await expect(
      launchBuckRaw({
        buckBinary: join(root, 'does-not-exist'),
        buckArgs: ['build', 'root//:check'],
        cwd: root,
        evidenceRoot: join(root, 'evidence'),
        repositoryRevision: identity.currentRevision,
        executionPlatform: identity.currentPlatform,
        compareReceipt: first.receiptPath,
        launcherRunId: 'identity-after',
      }),
    ).rejects.toThrow(identity.diagnostic)
  })

  it('rejects inexact receipt identity before executing Buck', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buck2-launcher-identity-'))
    await expect(
      launchBuckRaw({
        buckBinary: join(root, 'does-not-exist'),
        buckArgs: ['build', 'root//:check'],
        cwd: root,
        evidenceRoot: join(root, 'evidence'),
        repositoryRevision: 'main',
        executionPlatform: 'x86_64-linux',
      }),
    ).rejects.toThrow('exact 40- or 64-character Git revision')
  })

  it('runs Buck directly, preserves target args, and writes a sanitized receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buck2-launcher-test-'))
    const binary = join(root, 'fake-buck2')
    const closure = join(root, 'closure.json')
    await writeFile(binary, fakeBuckSource)
    await chmod(binary, 0o700)
    await writeFile(closure, closureManifest())

    const result = await launchBuck({
      buckBinary: binary,
      buckArgs: ['build', 'root//:check'],
      cwd: root,
      evidenceRoot: join(root, 'evidence'),
      closureManifests: [{ label: 'root//:check', path: closure }],
      launcherRunId: 'run-1',
      now: () => new Date('2026-08-11T12:00:00.000Z'),
    })

    expect(result.exitCode).toBe(0)
    expect(result.receipt).toMatchObject({
      schema: 'buck-run-receipt/v1',
      buckInvocationId: '11111111-1111-4111-8111-111111111111',
      repositoryRevision: '0123456789abcdef0123456789abcdef01234567',
      executionPlatform: 'x86_64-linux',
      command: { kind: 'build', requestedTargets: ['root//:check'] },
      outcomes: { local_execution: 1 },
      closures: [{ label: 'root//:check' }],
    })
    const bytes = await readFile(result.receiptPath!, 'utf8')
    expect(bytes).not.toContain('/home/private')
    expect(bytes).not.toContain('hunter2')
    expect(bytes).not.toContain('PRIVATE_TOKEN')
  })

  it.each(['exit', 'malformed', 'unsupported'])(
    'keeps %s log evidence at no verdict',
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), 'buck2-launcher-negative-'))
      const binary = join(root, 'fake-buck2')
      const closure = join(root, 'closure.json')
      await writeFile(binary, fakeBuckSource)
      await chmod(binary, 0o700)
      await writeFile(closure, closureManifest())
      const first = await launchBuck({
        buckBinary: binary,
        buckArgs: ['build', 'root//:check'],
        cwd: root,
        evidenceRoot: join(root, 'evidence'),
        closureManifests: [{ label: 'root//:check', path: closure }],
        launcherRunId: 'before',
      })
      const compareReceipt = first.receiptPath
      if (compareReceipt === undefined) throw new Error('first launch did not write a receipt')
      await writeFile(join(root, 'log-mode'), mode)
      const result = await launchBuck({
        buckBinary: binary,
        buckArgs: ['build', 'root//:check'],
        cwd: root,
        evidenceRoot: join(root, 'evidence'),
        closureManifests: [{ label: 'root//:check', path: closure }],
        compareReceipt,
        launcherRunId: `after-${mode}`,
      })
      expect(result.receipt).toMatchObject({
        observation: { complete: false, verdict: 'incomplete' },
        outcomes: { unknown: 1 },
        explanation: { status: 'unknown', changedDimensions: [] },
      })
      expect(result.receipt?.outcomes).not.toHaveProperty('dice_reuse')
    },
  )

  it('waits for captured log output to drain before constructing the receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buck2-launcher-drain-'))
    const binary = join(root, 'fake-buck2')
    await writeFile(binary, fakeBuckSource)
    await chmod(binary, 0o700)
    await writeFile(join(root, 'log-mode'), 'delayed-drain')
    const result = await launchBuck({
      buckBinary: binary,
      buckArgs: ['build', 'root//:check'],
      cwd: root,
      evidenceRoot: join(root, 'evidence'),
      launcherRunId: 'delayed-drain',
    })
    expect(result.receipt?.actions.map(({ identity }) => identity)).toEqual([
      'root//:first',
      'root//:second',
    ])
    expect(result.receipt?.outcomes).toEqual({ local_execution: 2 })
  })

  it('rejects duplicate closure labels before executing Buck', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buck2-launcher-duplicate-'))
    const closure = join(root, 'closure.json')
    await writeFile(closure, closureManifest())
    await expect(
      launchBuck({
        buckBinary: join(root, 'does-not-exist'),
        buckArgs: ['build', 'root//:check'],
        cwd: root,
        closureManifests: [
          { label: 'root//:check', path: closure },
          { label: 'root//:check', path: closure },
        ],
      }),
    ).rejects.toThrow('duplicate closure manifest label')
  })

  it('instruments Buck before the run argument delimiter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buck2-launcher-passthrough-'))
    const binary = join(root, 'fake-buck2')
    await writeFile(binary, fakeBuckSource)
    await chmod(binary, 0o700)
    const result = await launchBuck({
      buckBinary: binary,
      buckArgs: ['run', 'root//:tool', '--', '--user-flag'],
      cwd: root,
      evidenceRoot: join(root, 'evidence'),
      launcherRunId: 'passthrough',
    })
    expect(result.exitCode).toBe(0)
    expect(result.receipt?.observation.complete).toBe(true)
  })

  it('rejects a reused launcher run ID before executing Buck', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buck2-launcher-reused-run-id-'))
    const evidenceRoot = join(root, 'evidence')
    await mkdir(join(evidenceRoot, 'reused'), { recursive: true })
    await expect(
      launchBuck({
        buckBinary: join(root, 'does-not-exist'),
        buckArgs: ['build', 'root//:check'],
        cwd: root,
        evidenceRoot,
        launcherRunId: 'reused',
      }),
    ).rejects.toThrow('launcher run ID already exists')
  })

  it.each(['../escape', '/absolute', 'nested/path', '.', '', 'x'.repeat(129)])(
    'rejects unsafe launcher run ID %j before creating evidence',
    async (launcherRunId) => {
      const root = await mkdtemp(join(tmpdir(), 'buck2-launcher-run-id-'))
      await expect(
        launchBuck({
          buckBinary: join(root, 'does-not-exist'),
          buckArgs: ['build', 'root//:check'],
          cwd: root,
          evidenceRoot: join(root, 'evidence'),
          launcherRunId,
        }),
      ).rejects.toThrow('safe path component')
    },
  )

  it.each(['bad-report', 'missing-event'])('marks %s build evidence incomplete', async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'buck2-launcher-evidence-negative-'))
    const binary = join(root, 'fake-buck2')
    await writeFile(binary, fakeBuckSource)
    await chmod(binary, 0o700)
    await writeFile(join(root, 'build-mode'), mode)
    const result = await launchBuck({
      buckBinary: binary,
      buckArgs: ['build', 'root//:check'],
      cwd: root,
      evidenceRoot: join(root, 'evidence'),
      launcherRunId: mode,
    })
    expect(result.receipt).toMatchObject({
      observation: { complete: false, verdict: 'incomplete' },
      outcomes: { unknown: 1 },
      explanation: { status: 'unknown' },
    })
  })

  it('includes failed outcome alongside observed actions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buck2-launcher-failed-action-'))
    const binary = join(root, 'fake-buck2')
    await writeFile(binary, fakeBuckSource)
    await chmod(binary, 0o700)
    await writeFile(join(root, 'build-mode'), 'fail')
    const result = await launchBuck({
      buckBinary: binary,
      buckArgs: ['build', 'root//:check'],
      cwd: root,
      evidenceRoot: join(root, 'evidence'),
      launcherRunId: 'failed',
    })
    expect(result.exitCode).toBe(3)
    expect(result.receipt?.outcomes).toMatchObject({ local_execution: 1, failed: 1 })
  })
})
