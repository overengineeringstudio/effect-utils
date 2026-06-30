import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

type ApiMode = 'ok' | 'unauthorized' | 'missing'

const repoRoot = resolve(import.meta.dirname, '../../../..')
const cliPath = join(repoRoot, 'packages/@overeng/ci-tools/bin/ci-tools.ts')
let apiMode: ApiMode = 'ok'
let server: Server
let apiBaseUrl = ''

const testProcessEnv = () => {
  const { DEVENV_TASK_OUTPUT_FILE: _taskOutputFile, ...env } = process.env
  return env
}

const readRecord = (path: string) => {
  const line = readFileSync(path, 'utf8')
    .split('\n')
    .find((entry) => entry.startsWith('WORKFLOW_REPORT_V1: '))
  if (line === undefined) throw new Error(`No workflow report record in ${path}`)
  return JSON.parse(line.slice('WORKFLOW_REPORT_V1: '.length)) as {
    readonly status: string
    readonly links?: readonly { readonly url: string }[]
    readonly data?: Record<string, unknown>
  }
}

const readStreamText = (stream: NodeJS.ReadableStream) =>
  new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer | string) =>
      chunks.push(Buffer.isBuffer(chunk) === true ? chunk : Buffer.from(chunk)),
    )
    stream.on('error', reject)
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })

const runCiTools = async (opts: {
  readonly workdir: string
  readonly fakeVercelBin: string
  readonly reportFile: string
  readonly args: readonly string[]
  readonly env?: Readonly<Record<string, string | undefined>>
}) => {
  const child = spawn(
    'bun',
    [
      cliPath,
      'deploy',
      'vercel',
      '--vercel-bin',
      opts.fakeVercelBin,
      '--vercel-api-base-url',
      apiBaseUrl,
      '--created-at-utc',
      '2026-06-29T08:00:00Z',
      '--workflow-report-output-file',
      opts.reportFile,
      ...opts.args,
    ],
    {
      cwd: opts.workdir,
      env: {
        ...testProcessEnv(),
        FORCE_COLOR: '0',
        OTEL_EXPORTER_OTLP_ENDPOINT: '',
        VERCEL_TOKEN: 'fake-token',
        VERCEL_ORG_ID: 'fake-org',
        VERCEL_PROJECT_ID: 'fake-project',
        VERCEL_SCOPE: 'fake-scope',
        ...opts.env,
      },
    },
  )
  const [stdout, stderr, status] = await Promise.all([
    readStreamText(child.stdout),
    readStreamText(child.stderr),
    new Promise<number | null>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (code) => resolve(code))
    }),
  ])
  return { status, stdout, stderr }
}

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url !== '/v9/projects/fake-project?teamId=fake-org') {
      response.writeHead(404, { connection: 'close' }).end('not found')
      return
    }
    if (apiMode === 'unauthorized') {
      response.writeHead(401, { connection: 'close' }).end('unauthorized')
      return
    }
    if (apiMode === 'missing') {
      response.writeHead(404, { connection: 'close' }).end('missing')
      return
    }
    response
      .writeHead(200, { 'content-type': 'application/json', connection: 'close' })
      .end(JSON.stringify({ id: 'fake-project', name: 'fake-vercel-project' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected TCP server')
  apiBaseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  )
})

describe('ci-tools deploy vercel', () => {
  const makeWorkspace = () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-tools-vercel-'))
    const artifactDir = join(root, 'static')
    const binDir = join(root, 'bin')
    mkdirSync(artifactDir)
    mkdirSync(binDir)
    mkdirSync(join(root, 'app'))
    writeFileSync(join(artifactDir, 'index.html'), 'vercel static marker')
    writeFileSync(join(artifactDir, '.well-known'), 'dotfile marker')
    writeFileSync(join(root, 'app', 'package.json'), '{"name":"fixture-app"}\n')
    const logPath = join(root, 'vercel.log')
    const fakeVercelBin = join(binDir, 'vercel')
    writeFileSync(
      fakeVercelBin,
      `#!/usr/bin/env bash
set -euo pipefail
printf 'cwd=%s VERCEL_PROJECT_ID=%s VERCEL_ORG_ID=%s args=%s\\n' "$PWD" "\${VERCEL_PROJECT_ID:-}" "\${VERCEL_ORG_ID:-}" "$*" >> "${logPath}"
if [ "\${1:-}" = "pull" ]; then
  mkdir -p .vercel
  printf '{"settings":{}}\\n' > .vercel/project.json
  exit 0
fi
if [ "\${1:-}" = "build" ]; then
  test -f app/vercel.json
  grep -q '"installCommand":"true"' app/vercel.json
  grep -q '"rootDirectory":"app"' .vercel/project.json
  test "\${BUILD_MARKER:-}" = "ci-tools"
  mkdir -p .vercel/output/static
  printf '{"version":3}\\n' > .vercel/output/config.json
  printf 'built marker\\n' > .vercel/output/static/index.html
  exit 0
fi
if [ "\${1:-}" = "deploy" ]; then
  test -f .vercel/output/static/index.html
  if [ "\${FAKE_VERCEL_REQUIRE_DOTFILE:-1}" = "1" ]; then
    test -f .vercel/output/static/.well-known
  fi
  if [ "\${FAKE_VERCEL_MODE:-success}" = "no-url" ]; then
    printf 'Deployment completed without URL\\n'
    exit 0
  fi
  if [ "\${FAKE_VERCEL_MODE:-success}" = "unauthorized" ]; then
    echo 'Error: invalid token fake-token' >&2
    exit 1
  fi
  printf 'https://deploy-web.vercel.app\\n'
  exit 0
fi
if [ "\${1:-}" = "alias" ] && [ "\${2:-}" = "rm" ]; then
  printf 'Removed alias %s\\n' "\${3:-}"
  exit 0
fi
if [ "\${1:-}" = "alias" ]; then
  printf 'Aliased %s to %s\\n' "\${2:-}" "\${3:-}"
  exit 0
fi
echo "unexpected fake vercel invocation: $*" >&2
exit 1
`,
      { mode: 0o755 },
    )
    return { root, artifactDir, fakeVercelBin, logPath }
  }

  it('deploys PR previews with Vercel prebuilt packaging, alias semantics, and records', async () => {
    apiMode = 'ok'
    const workspace = makeWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    const githubOutputFile = join(workspace.root, 'github-output')
    const githubEnvFile = join(workspace.root, 'github-env')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeVercelBin: workspace.fakeVercelBin,
        reportFile,
        args: [
          '--target',
          'web',
          '--display-name',
          'Web',
          '--artifact-dir',
          workspace.artifactDir,
          '--mode',
          'pr',
          '--pr',
          '123',
          '--alias-suffix',
          'team',
          '--scope-env',
          'VERCEL_SCOPE',
          '--github-output-file',
          githubOutputFile,
          '--github-env-file',
          githubEnvFile,
          '--url-env-key',
          'WEB_URL',
        ],
      })
      if (result.status !== 0) {
        console.error({ stdout: result.stdout, stderr: result.stderr })
      }
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('Vercel deploy URL: https://web-pr-123-team.vercel.app')
      const log = readFileSync(workspace.logPath, 'utf8')
      expect(log).toContain('args=deploy --prebuilt --yes --scope fake-scope --token fake-token')
      expect(log).toContain(
        'args=alias https://deploy-web.vercel.app web-pr-123-team.vercel.app --scope fake-scope',
      )
      expect(log).toContain('VERCEL_PROJECT_ID=fake-project')

      const record = readRecord(reportFile)
      expect(record.status).toBe('success')
      expect(record.links?.[0]?.url).toBe('https://web-pr-123-team.vercel.app/')
      expect(record.data).toMatchObject({
        provider: 'vercel',
        target: 'web',
        mode: 'pr',
        alias: 'web-pr-123-team',
        finalUrl: 'https://web-pr-123-team.vercel.app/',
        rawDeployUrl: 'https://deploy-web.vercel.app/',
      })
      expect(readFileSync(githubOutputFile, 'utf8')).toContain(
        'final_url=https://web-pr-123-team.vercel.app/',
      )
      expect(readFileSync(githubOutputFile, 'utf8')).toContain('workflow_report=')
      expect(readFileSync(githubEnvFile, 'utf8')).toContain(
        'WEB_URL=https://web-pr-123-team.vercel.app/',
      )
    } finally {
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })

  it('runs Vercel pull/build for build-mode prebuilt output before deploy', async () => {
    apiMode = 'ok'
    const workspace = makeWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeVercelBin: workspace.fakeVercelBin,
        reportFile,
        args: [
          '--target',
          'app',
          '--artifact-dir',
          join(workspace.root, '.vercel', 'output'),
          '--artifact-kind',
          'prebuilt-output',
          '--mode',
          'prod',
          '--build-prebuilt-output',
          '--vercel-root-directory',
          'app',
          '--build-env',
          'BUILD_MARKER=ci-tools',
          '--scope-env',
          'VERCEL_SCOPE',
        ],
        env: { FAKE_VERCEL_REQUIRE_DOTFILE: '0' },
      })
      if (result.status !== 0) {
        console.error({ stdout: result.stdout, stderr: result.stderr })
      }
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('Pulling Vercel project settings and env for app')
      expect(result.stdout).toContain('Building app locally with vercel build')
      const log = readFileSync(workspace.logPath, 'utf8')
      expect(log).toContain(
        'args=pull --yes --environment production --scope fake-scope --token fake-token',
      )
      expect(log).toContain('args=build --yes --prod --scope fake-scope --token fake-token')
      expect(log).toContain(
        'args=deploy --prebuilt --yes --prod --scope fake-scope --token fake-token',
      )
      expect(existsSync(join(workspace.root, 'app', 'vercel.json'))).toBe(false)
      expect(existsSync(join(workspace.root, '.vercel'))).toBe(false)
      expect(readRecord(reportFile).data).toMatchObject({
        provider: 'vercel',
        target: 'app',
        mode: 'prod',
      })
    } finally {
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })

  it('rejects build-mode orchestration for static artifacts', async () => {
    apiMode = 'ok'
    const workspace = makeWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeVercelBin: workspace.fakeVercelBin,
        reportFile,
        args: [
          '--target',
          'web',
          '--artifact-dir',
          workspace.artifactDir,
          '--artifact-kind',
          'static',
          '--mode',
          'preview',
          '--build-prebuilt-output',
        ],
      })
      expect(result.status).not.toBe(0)
      expect(existsSync(workspace.logPath)).toBe(false)
      expect(readRecord(reportFile).data).toMatchObject({
        errorKind: 'ProviderOperationFailed',
        retryable: false,
      })
    } finally {
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })

  it('emits failure records when Vercel output does not contain a deploy URL', async () => {
    apiMode = 'ok'
    const workspace = makeWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeVercelBin: workspace.fakeVercelBin,
        reportFile,
        args: ['--target', 'web', '--artifact-dir', workspace.artifactDir, '--mode', 'preview'],
        env: { FAKE_VERCEL_MODE: 'no-url' },
      })
      expect(result.status).not.toBe(0)
      const record = readRecord(reportFile)
      expect(record.status).toBe('failure')
      expect(record.data).toMatchObject({
        errorKind: 'InvalidProviderOutput',
        retryable: false,
      })
    } finally {
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })

  it('emits failure records for missing local static output before upload', async () => {
    apiMode = 'ok'
    const workspace = makeWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeVercelBin: workspace.fakeVercelBin,
        reportFile,
        args: [
          '--target',
          'web',
          '--artifact-dir',
          join(workspace.root, 'missing'),
          '--mode',
          'preview',
        ],
      })
      expect(result.status).not.toBe(0)
      expect(existsSync(workspace.logPath)).toBe(false)
      expect(readRecord(reportFile).data).toMatchObject({ errorKind: 'MissingBuildOutput' })
    } finally {
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })

  it('emits missing-auth records before local output checks', async () => {
    apiMode = 'ok'
    const workspace = makeWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeVercelBin: workspace.fakeVercelBin,
        reportFile,
        args: [
          '--target',
          'web',
          '--artifact-dir',
          join(workspace.root, 'missing'),
          '--mode',
          'preview',
        ],
        env: { VERCEL_TOKEN: undefined },
      })
      expect(result.status).not.toBe(0)
      expect(existsSync(workspace.logPath)).toBe(false)
      expect(readRecord(reportFile).data).toMatchObject({ errorKind: 'MissingAuth' })
    } finally {
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })

  it('fails before upload when API-first project lookup rejects credentials', async () => {
    apiMode = 'unauthorized'
    const workspace = makeWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeVercelBin: workspace.fakeVercelBin,
        reportFile,
        args: ['--target', 'web', '--artifact-dir', workspace.artifactDir, '--mode', 'preview'],
      })
      expect(result.status).not.toBe(0)
      expect(readRecord(reportFile).data).toMatchObject({ errorKind: 'Unauthorized' })
      expect(existsSync(workspace.logPath)).toBe(false)
    } finally {
      apiMode = 'ok'
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })

  it('redacts Vercel tokens from provider command failures', async () => {
    apiMode = 'ok'
    const workspace = makeWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeVercelBin: workspace.fakeVercelBin,
        reportFile,
        args: ['--target', 'web', '--artifact-dir', workspace.artifactDir, '--mode', 'preview'],
        env: { FAKE_VERCEL_MODE: 'unauthorized' },
      })
      expect(result.status).not.toBe(0)
      expect(`${result.stdout}\n${result.stderr}`).not.toContain('fake-token')
      expect(JSON.stringify(readRecord(reportFile))).not.toContain('fake-token')
    } finally {
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })

  it('refuses shared-project live E2E aliases outside the reserved prefix', async () => {
    apiMode = 'ok'
    const workspace = makeWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeVercelBin: workspace.fakeVercelBin,
        reportFile,
        args: [
          '--target',
          'web',
          '--artifact-dir',
          workspace.artifactDir,
          '--mode',
          'pr',
          '--pr',
          '123',
          '--e2e-allow-shared-project',
          '--e2e-reserved-alias-prefix',
          'ci-tools-e2e',
        ],
      })
      expect(result.status).not.toBe(0)
      expect(readRecord(reportFile).data).toMatchObject({ errorKind: 'UnsafeE2EAlias' })
    } finally {
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })
})
