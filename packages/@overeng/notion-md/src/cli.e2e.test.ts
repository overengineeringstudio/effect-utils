import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

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
    'renders top-level help with the canonical command modes',
    async () => {
      const { stdout } = await runCli(['--help'])

      expect(stdout).toContain('status')
      expect(stdout).toContain('plan')
      expect(stdout).toContain('sync')
      expect(stdout).toContain('--from-remote')
      expect(stdout).toContain('--root')
      expect(stdout).toContain('--root-file')
      expect(stdout).toContain('--recursive')
    },
    cliTestTimeoutMs,
  )

  it(
    'renders sync help without requiring a Notion token',
    async () => {
      const { stdout } = await runCli(['sync', '--help'])

      expect(stdout).toContain('Sync a local target')
      expect(stdout).toContain('--watch')
      expect(stdout).toContain('--poll-interval-ms')
      expect(stdout).toContain('--recursive')
      expect(stdout).toContain('--concurrency')
      expect(stdout).toContain('--from-remote')
      expect(stdout).toContain('--root')
      expect(stdout).toContain('--root-file')
    },
    cliTestTimeoutMs,
  )

  it(
    'validates missing sync targets before resolving Notion credentials',
    async () => {
      await expect(runCli(['sync'])).rejects.toThrow('Missing argument <source>')
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
    'rejects from-remote flat batch mode before resolving Notion credentials',
    async () => {
      await withTempDir(async (dir) => {
        await expect(
          runCli([
            'sync',
            dir,
            '--recursive',
            '--from-remote',
            '--root',
            '00000000000040008000000000000001',
          ]),
        ).rejects.toMatchObject({
          stdout: expect.stringContaining('Cannot combine --recursive and --from-remote'),
        })
      })
    },
    cliTestTimeoutMs,
  )

  it(
    'rejects from-remote file targets before resolving Notion credentials',
    async () => {
      await withTempDir(async (dir) => {
        const filePath = join(dir, 'page.nmd')
        writeFileSync(filePath, '')

        await expect(runCli(['sync', filePath, '--from-remote'])).rejects.toMatchObject({
          stdout: expect.stringContaining('--from-remote is directory-tree only'),
        })
      })
    },
    cliTestTimeoutMs,
  )

  it(
    'rejects from-remote directory imports without a root or existing tree index',
    async () => {
      await withTempDir(async (dir) => {
        await expect(runCli(['sync', dir, '--from-remote'])).rejects.toMatchObject({
          stdout: expect.stringContaining('--from-remote requires --root'),
        })
      })
    },
    cliTestTimeoutMs,
  )

  it(
    'rejects file plan targets before resolving Notion credentials',
    async () => {
      await withTempDir(async (dir) => {
        const filePath = join(dir, 'page.nmd')
        writeFileSync(filePath, '')

        await expect(runCli(['plan', filePath])).rejects.toMatchObject({
          stdout: expect.stringContaining('plan is directory-tree only'),
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
