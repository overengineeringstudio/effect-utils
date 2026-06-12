import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

/*
 * CLI boundary tests for the decided v-next surface: three verbs `track` /
 * `status` / `sync` over self-describing files. These were revised from the
 * pre-redesign surface (`plan`, `--from-remote`, `--root`, `--root-file`,
 * two-arg `sync`) which the v-next redesign explicitly DROPS — direction lives
 * in each file's frontmatter `source`, not in flags (R34). The old assertions
 * encoded the superseded engine and would contradict the decided spec.
 */

const execFileAsync = promisify(execFile)
const packageDir = fileURLToPath(new URL('..', import.meta.url))
const cliProcessTimeoutMs = 20_000
const cliTestTimeoutMs = 25_000

const runCli = (args: readonly string[]) =>
  execFileAsync('bun', ['src/cli.ts', ...args], {
    cwd: packageDir,
    timeout: cliProcessTimeoutMs,
    env: {
      ...process.env,
      NOTION_API_TOKEN: '',
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
    },
  })

describe('notion-md CLI boundary', () => {
  const withTempDir = async <T>(callback: (dir: string) => Promise<T>): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), 'notion-md-cli-'))
    try {
      return await callback(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it(
    'renders top-level help with the three decided verbs',
    async () => {
      const { stdout } = await runCli(['--help'])

      expect(stdout).toContain('track')
      expect(stdout).toContain('status')
      expect(stdout).toContain('sync')
    },
    cliTestTimeoutMs,
  )

  it(
    'no longer exposes the dropped tree/direction flags or the plan verb',
    async () => {
      const { stdout } = await runCli(['--help'])

      expect(stdout).not.toContain('--from-remote')
      expect(stdout).not.toContain('--root')
      expect(stdout).not.toContain('--root-file')
      expect(stdout).not.toContain('clone')
      expect(stdout).not.toContain('plan')
    },
    cliTestTimeoutMs,
  )

  it(
    'renders sync help without requiring a Notion token',
    async () => {
      const { stdout } = await runCli(['sync', '--help'])

      expect(stdout).toContain('--watch')
      expect(stdout).toContain('--poll-interval-ms')
      expect(stdout).toContain('--recursive')
      expect(stdout).toContain('--concurrency')
      expect(stdout).toContain('--force')
      expect(stdout).toContain('--dry-run')
    },
    cliTestTimeoutMs,
  )

  it(
    'renders track help with --as direction option',
    async () => {
      const { stdout } = await runCli(['track', '--help'])

      expect(stdout).toContain('--as')
      expect(stdout).toContain('--dry-run')
      expect(stdout).toContain('page-id-or-url')
    },
    cliTestTimeoutMs,
  )

  it(
    'validates missing sync targets before resolving Notion credentials',
    async () => {
      await expect(runCli(['sync'])).rejects.toThrow('Missing argument <path>')
    },
    cliTestTimeoutMs,
  )

  it(
    'validates watch polling interval before resolving Notion credentials',
    async () => {
      await expect(
        runCli(['sync', 'page.nmd', '--watch', '--poll-interval-ms', '0']),
      ).rejects.toThrow('Expected a positive number')
    },
    cliTestTimeoutMs,
  )

  it(
    'rejects a non-page-id track argument before resolving Notion credentials',
    async () => {
      await withTempDir(async (dir) => {
        const filePath = join(dir, 'page.nmd')
        writeFileSync(filePath, '')

        await expect(runCli(['track', filePath])).rejects.toMatchObject({
          stdout: expect.stringContaining('Invalid Notion page id/url'),
        })
      })
    },
    cliTestTimeoutMs,
  )

  it(
    'surfaces missing Notion credentials as a typed CLI failure after argument validation',
    async () => {
      await expect(runCli(['status', 'page.nmd'])).rejects.toMatchObject({
        stdout: expect.stringContaining('NmdTokenMissingError'),
      })
      await expect(runCli(['status', 'page.nmd'])).rejects.toMatchObject({
        stdout: expect.stringContaining('NOTION_API_TOKEN is required'),
      })
    },
    cliTestTimeoutMs,
  )
})
