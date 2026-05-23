import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const packageDir = fileURLToPath(new URL('..', import.meta.url))

const runCli = (args: readonly string[]) =>
  execFileAsync('bun', ['src/cli.ts', ...args], {
    cwd: packageDir,
    env: {
      ...process.env,
      NOTION_TOKEN: '',
      NOTION_API_TOKEN: '',
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
    },
  })

describe('notion-md CLI boundary', () => {
  it('renders sync help without requiring a Notion token', async () => {
    const { stdout } = await runCli(['sync', '--help'])

    expect(stdout).toContain('Reconcile a local .nmd file with its Notion page')
    expect(stdout).toContain('--watch')
    expect(stdout).toContain('--poll-interval-ms')
  })

  it('validates watch polling interval before resolving Notion credentials', async () => {
    await expect(
      runCli(['sync', 'page.nmd', '--watch', '--poll-interval-ms', '0']),
    ).rejects.toThrow('Expected a positive number')
  })

  it('surfaces missing Notion credentials as a typed CLI failure after argument validation', async () => {
    await expect(runCli(['status', 'page.nmd'])).rejects.toMatchObject({
      stdout: expect.stringContaining('NmdTokenMissingError'),
    })
    await expect(runCli(['status', 'page.nmd'])).rejects.toMatchObject({
      stdout: expect.stringContaining('NOTION_TOKEN or NOTION_API_TOKEN is required'),
    })
  })
})
