import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '../../../..')
const cliPath = join(repoRoot, 'packages/@overeng/ci-tools/bin/ci-tools.ts')
const liveEnabled = process.env.CI_TOOLS_NETLIFY_LIVE === '1'
const requiredEnv = ['NETLIFY_AUTH_TOKEN', 'NETLIFY_SITE_ID'] as const
const missingEnv = requiredEnv.filter((name) => process.env[name] === undefined)
const liveIt = liveEnabled === true && missingEnv.length === 0 ? it : it.skip

const readStreamText = (stream: NodeJS.ReadableStream) =>
  new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer | string) =>
      chunks.push(Buffer.isBuffer(chunk) === true ? chunk : Buffer.from(chunk)),
    )
    stream.on('error', reject)
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })

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

const runCiTools = async (opts: {
  readonly workdir: string
  readonly reportFile: string
  readonly artifactDir: string
  readonly target: string
  readonly marker: string
}) => {
  const child = spawn(
    'bun',
    [
      cliPath,
      'deploy',
      'netlify',
      '--target',
      opts.target,
      '--display-name',
      'ci-tools live Netlify E2E',
      '--artifact-dir',
      opts.artifactDir,
      '--mode',
      'prod',
      '--netlify-bin',
      process.env.CI_TOOLS_LIVE_NETLIFY_BIN ?? 'netlify',
      ...(process.env.CI_TOOLS_NETLIFY_SITE_NAME === undefined
        ? []
        : ['--site-name', process.env.CI_TOOLS_NETLIFY_SITE_NAME]),
      '--workflow-report-output-file',
      opts.reportFile,
      '--e2e-allow-shared-project',
      '--e2e-reserved-alias-prefix',
      'ci-tools-e2e',
      '--e2e-verify-path',
      '/index.html',
      '--e2e-verify-text',
      opts.marker,
    ],
    {
      cwd: opts.workdir,
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        OTEL_EXPORTER_OTLP_ENDPOINT: '',
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

describe('ci-tools deploy netlify live E2E', () => {
  liveIt(
    'deploys a local static fixture to a reserved shared-project alias and verifies served content',
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'ci-tools-netlify-live-'))
      const artifactDir = join(workspace, 'public')
      const reportFile = join(workspace, 'report.jsonl')
      const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`
      const suffix = runId
        .toLowerCase()
        .replaceAll(/[^a-z0-9-]/gu, '-')
        .slice(0, 24)
      const target = `ci-tools-e2e-${suffix}`
      const marker = `ci-tools-live-netlify-e2e:${runId}:${process.env.GITHUB_RUN_ATTEMPT ?? '0'}`

      try {
        mkdirSync(artifactDir, { recursive: true })
        writeFileSync(
          join(artifactDir, 'index.html'),
          `<!doctype html><html><body><main>${marker}</main></body></html>`,
        )

        const result = await runCiTools({
          workdir: workspace,
          reportFile,
          artifactDir,
          target,
          marker,
        })
        const token = process.env.NETLIFY_AUTH_TOKEN
        expect(
          token === undefined ? false : `${result.stdout}\n${result.stderr}`.includes(token),
        ).toBe(false)
        expect(result.status).toBe(0)
        expect(result.stdout).toContain('Netlify deploy URL: https://ci-tools-e2e-')

        const record = readRecord(reportFile)
        expect(record.status).toBe('success')
        expect(record.links?.[0]?.url).toContain('https://ci-tools-e2e-')
        expect(record.data).toMatchObject({
          provider: 'netlify',
          target,
          mode: 'prod',
          alias: target,
          cleanup: 'skipped',
        })
      } finally {
        rmSync(workspace, { recursive: true, force: true })
      }
    },
    180_000,
  )
})
