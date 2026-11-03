import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  formatLiveDeployFailure,
  vercelLiveProcessEnvironment,
  type LiveDeployProcessResult,
} from './deploy-live-diagnostics.ts'

const repoRoot = resolve(import.meta.dirname, '../../../..')
const cliPath = join(repoRoot, 'packages/@overeng/ci-tools/bin/ci-tools.ts')
const liveEnabled = process.env.CI_TOOLS_VERCEL_LIVE === '1'
const requiredEnv = ['VERCEL_TOKEN', 'VERCEL_PROJECT_ID', 'VERCEL_ORG_ID', 'VERCEL_SCOPE'] as const
const missingEnv = requiredEnv.filter((name) => process.env[name] === undefined)
const liveIt = liveEnabled === true && missingEnv.length === 0 ? it : it.skip

type VercelLiveProcessResult = LiveDeployProcessResult & {
  readonly secretValues: readonly string[]
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

const readRecord = (path: string) => {
  const line = readFileSync(path, 'utf8')
    .split('\n')
    .find((entry) => entry.startsWith('WORKFLOW_REPORT_V1: '))
  if (line === undefined) throw new Error(`No workflow report record in ${path}`)
  try {
    return JSON.parse(line.slice('WORKFLOW_REPORT_V1: '.length)) as {
      readonly status: string
      readonly links?: readonly { readonly url: string }[]
      readonly data?: Record<string, unknown>
    }
  } catch {
    throw new Error('Workflow report JSON is invalid')
  }
}

const runCiTools = async (opts: {
  readonly workdir: string
  readonly reportFile: string
  readonly artifactDir: string
  readonly target: string
  readonly marker: string
}) => {
  const environment = vercelLiveProcessEnvironment(process.env)
  const child = spawn(
    'bun',
    [
      cliPath,
      'deploy',
      'vercel',
      '--target',
      opts.target,
      '--display-name',
      'ci-tools live Vercel E2E',
      '--artifact-dir',
      opts.artifactDir,
      '--mode',
      'prod',
      '--vercel-bin',
      process.env.CI_TOOLS_LIVE_VERCEL_BIN ?? 'vercel',
      ...(process.env.VERCEL_TEAM_ID === undefined ? [] : ['--team-id-env', 'VERCEL_TEAM_ID']),
      ...(process.env.VERCEL_SCOPE === undefined ? [] : ['--scope-env', 'VERCEL_SCOPE']),
      ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET === undefined
        ? []
        : ['--protection-bypass-env', 'VERCEL_AUTOMATION_BYPASS_SECRET']),
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
      env: environment.env,
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
  return { status, stdout, stderr, secretValues: environment.secretValues }
}

describe('ci-tools deploy vercel live E2E', () => {
  liveIt(
    'deploys a local static fixture to a reserved shared-project alias and verifies served content',
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'ci-tools-vercel-live-'))
      const artifactDir = join(workspace, 'public')
      const reportFile = join(workspace, 'report.jsonl')
      const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`
      const suffix = runId
        .toLowerCase()
        .replaceAll(/[^a-z0-9-]/gu, '-')
        .slice(0, 24)
      const target = `ci-tools-e2e-${suffix}`
      const marker = `ci-tools-live-vercel-e2e:${runId}:${process.env.GITHUB_RUN_ATTEMPT ?? '0'}`
      let failureResult: VercelLiveProcessResult | undefined

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
        failureResult = result
        expect(
          result.secretValues.some((secret) =>
            `${result.stdout}\n${result.stderr}`.includes(secret),
          ),
        ).toBe(false)
        expect(result.status).toBe(0)
        // Predicate assertions prevent Vitest from echoing captured private values.
        expect(result.stdout.includes('Vercel deploy URL: https://ci-tools-e2e-')).toBe(true)

        const record = readRecord(reportFile)
        expect(record.status === 'success').toBe(true)
        expect(record.links?.[0]?.url.includes('https://ci-tools-e2e-') === true).toBe(true)
        expect(
          Object.entries({ provider: 'vercel', target, mode: 'prod', alias: target }).every(
            ([key, value]) => record.data?.[key] === value,
          ),
        ).toBe(true)
        expect(['succeeded', 'failed'].some((status) => status === record.data?.cleanup)).toBe(true)
      } catch (cause) {
        if (failureResult !== undefined) {
          console.error(
            formatLiveDeployFailure({
              status: failureResult.status,
              report:
                existsSync(reportFile) === true ? readFileSync(reportFile, 'utf8') : undefined,
              providerCause: {
                secretValues: failureResult.secretValues,
              },
            }),
          )
        }
        throw cause
      } finally {
        rmSync(workspace, { recursive: true, force: true })
      }
    },
    180_000,
  )
})
