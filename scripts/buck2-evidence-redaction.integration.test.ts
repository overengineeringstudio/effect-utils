import { describe, expect, it } from 'bun:test'
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  readCacheEvidenceRedaction,
  recordCacheEvidenceRedaction,
  removeCacheEvidenceRedaction,
} from './buck2-evidence-redaction.ts'

const collector = new URL('../genie/ci-scripts/buck2-cache-evidence.ts', import.meta.url).pathname

describe('private cache evidence redaction context', () => {
  it('records both effective credentials across invocations without publishing context for readers', () => {
    const directory = mkdtempSync(join(tmpdir(), 'buck-redaction-context-'))
    try {
      const evidencePath = join(directory, 'evidence.json')
      const path = `${evidencePath}.redaction-context.jsonl`
      expect(readCacheEvidenceRedaction({ evidencePath })).toEqual([])
      removeCacheEvidenceRedaction({ evidencePath })
      recordCacheEvidenceRedaction({ env: {} })
      recordCacheEvidenceRedaction({ env: { CI_BUCK2_CACHE_EVIDENCE_PATH: evidencePath } })
      expect(readCacheEvidenceRedaction({ evidencePath })).toEqual([])
      recordCacheEvidenceRedaction({
        cwd: directory,
        env: {
          CI_BUCK2_CACHE_EVIDENCE_PATH: 'evidence.json',
          BUCK2_CACHE_WRITE_BASIC_AUTH: 'first-opaque-value',
          BUCK2_PRIVATE_CACHE_WRITE_BASIC_AUTH: 'private-opaque-value',
        },
      })
      recordCacheEvidenceRedaction({
        env: {
          CI_BUCK2_CACHE_EVIDENCE_PATH: evidencePath,
          BUCK2_CACHE_WRITE_BASIC_AUTH: 'rotated-opaque-value',
        },
      })
      expect(statSync(path).mode & 0o7777).toBe(0o600)
      expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2)
      expect(readCacheEvidenceRedaction({ evidencePath })).toEqual([
        'first-opaque-value',
        'private-opaque-value',
        'rotated-opaque-value',
      ])
      removeCacheEvidenceRedaction({ evidencePath })
      expect(readCacheEvidenceRedaction({ evidencePath })).toEqual([])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('fails closed before any collector output for unsafe or malformed private contexts', async () => {
    for (const kind of [
      'permissions',
      'symlink',
      'directory',
      'hardlink',
      'malformed',
      'partial',
      'empty',
      'invalid-values',
    ]) {
      const directory = mkdtempSync(join(tmpdir(), 'buck-unsafe-redaction-'))
      try {
        const evidencePath = join(directory, 'evidence.json')
        const path = `${evidencePath}.redaction-context.jsonl`
        const target = join(directory, 'target')
        const secret = 'planted-private-context-credential'
        writeFileSync(target, `${JSON.stringify([secret])}\n`, { mode: 0o600 })
        if (kind === 'symlink') symlinkSync(target, path)
        else if (kind === 'hardlink') linkSync(target, path)
        else if (kind === 'directory') mkdirSync(path, { mode: 0o600 })
        else {
          const content =
            kind === 'malformed'
              ? `${secret}\n`
              : kind === 'partial'
                ? JSON.stringify([secret])
                : kind === 'empty'
                  ? ''
                  : kind === 'invalid-values'
                    ? '[123]\n'
                    : `${JSON.stringify([secret])}\n`
          writeFileSync(path, content, { mode: 0o600 })
          if (kind === 'permissions') chmodSync(path, 0o644)
        }
        expect(() => readCacheEvidenceRedaction({ evidencePath })).toThrow(
          'Unsafe cache evidence redaction context',
        )
        if (['permissions', 'symlink', 'directory', 'hardlink'].includes(kind)) {
          expect(() =>
            recordCacheEvidenceRedaction({
              env: {
                CI_BUCK2_CACHE_EVIDENCE_PATH: evidencePath,
                BUCK2_CACHE_WRITE_BASIC_AUTH: secret,
              },
            }),
          ).toThrow('Unsafe cache evidence redaction context')
          expect(() => removeCacheEvidenceRedaction({ evidencePath })).toThrow(
            'Unsafe cache evidence redaction context',
          )
        }
        const stepSummary = join(directory, 'summary')
        const child = Bun.spawn(
          [process.execPath, collector, '--output', evidencePath, '--finalize'],
          {
            env: {
              ...process.env,
              BUCK2_CACHE_WRITE_BASIC_AUTH: undefined,
              BUCK2_PRIVATE_CACHE_WRITE_BASIC_AUTH: undefined,
              GITHUB_STEP_SUMMARY: stepSummary,
            },
            stdout: 'pipe',
            stderr: 'pipe',
          },
        )
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        expect(exit).toBe(1)
        expect(stderr).toContain('Unsafe cache evidence redaction context')
        expect(`${stdout}${stderr}`).not.toContain(secret)
        for (const output of [
          evidencePath,
          join(directory, 'buck2-cache-actions.jsonl.gz'),
          stepSummary,
        ])
          expect(await Bun.file(output).exists()).toBe(false)
        expect(readFileSync(target, 'utf8')).toBe(`${JSON.stringify([secret])}\n`)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  })
})
