import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const analyzerFile = fileURLToPath(new URL('./closure-analyzer.ts', import.meta.url))

/** Fresh Bun processes exercise the actual CLI module-loading/session boundary, not a mocked cache. */
const invoke = ({
  cacheDirectory,
  source = 'export const persistentCacheFixture = 42',
  analyzerVersion,
  disableServer = false,
}: {
  cacheDirectory: string
  source?: string
  analyzerVersion?: string
  disableServer?: boolean
}) => {
  const filename = `${cacheDirectory}.entry.ts`
  writeFileSync(filename, source)
  try {
    // Runtime-selected subprocess entry intentionally tests the module loading boundary.
    const result = spawnSync(
      'bun',
      [
        '--no-install',
        '-e',
        `
      const { analyzeClosureModule } = await import(${JSON.stringify(analyzerFile)})
      console.log(JSON.stringify(await analyzeClosureModule({
        module: ${JSON.stringify({ source, filename })},
        options: ${JSON.stringify({ cacheDirectory, analyzerVersion })},
      })))
    `,
      ],
      {
        encoding: 'utf8',
        timeout: 30_000,
        env:
          disableServer === true
            ? {
                ...process.env,
                GENIE_TYPESCRIPT_API_SERVER: '/nonexistent-genie-cache-test-server',
              }
            : process.env,
      },
    )
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr + result.stdout).toBe(0)
    return JSON.parse(result.stdout) as unknown
  } finally {
    rmSync(filename, { force: true })
  }
}

describe('persistent closure analysis cache', () => {
  it('survives CLI processes without acquiring a native compiler on warm hits', () => {
    const cacheDirectory = mkdtempSync(path.join(os.tmpdir(), 'genie-closure-cache-'))
    try {
      expect(invoke({ cacheDirectory })).toEqual({ imports: [], reasons: [] })
      const files = readdirSync(cacheDirectory)
      expect(files).toHaveLength(1)
      const serialized = readFileSync(path.join(cacheDirectory, files[0]!), 'utf8')
      expect(serialized).not.toContain(cacheDirectory)
      // A cold miss cannot acquire this deliberately nonexistent server.
      expect(invoke({ cacheDirectory, disableServer: true })).toEqual({ imports: [], reasons: [] })
      expect(readdirSync(cacheDirectory)).toEqual(files)
    } finally {
      rmSync(cacheDirectory, { recursive: true, force: true })
    }
  })

  it('invalidates byte and analyzer-version changes across processes', () => {
    const cacheDirectory = mkdtempSync(path.join(os.tmpdir(), 'genie-closure-invalidation-'))
    try {
      expect(invoke({ cacheDirectory })).toEqual({ imports: [], reasons: [] })
      expect(invoke({ cacheDirectory, analyzerVersion: 'next-reviewed-analyzer' })).toEqual({
        imports: [],
        reasons: [],
      })
      expect(invoke({ cacheDirectory, source: 'process.env.CHANGED' })).toMatchObject({
        reasons: expect.arrayContaining([expect.objectContaining({ operation: 'ambient-access' })]),
      })
      expect(readdirSync(cacheDirectory).filter((name) => name.endsWith('.json'))).toHaveLength(3)
      expect(readdirSync(cacheDirectory).some((name) => name.endsWith('.tmp'))).toBe(false)
    } finally {
      rmSync(cacheDirectory, { recursive: true, force: true })
    }
  })

  it('recomputes malformed and incompatible cache entries instead of accounting from them', () => {
    const cacheDirectory = mkdtempSync(path.join(os.tmpdir(), 'genie-closure-corruption-'))
    try {
      const source = 'process.env.UNRECORDED'
      const expected = invoke({ cacheDirectory, source })
      const cacheFile = path.join(cacheDirectory, readdirSync(cacheDirectory)[0]!)
      for (const invalid of ['{', '{}', '{"analysis":{"imports":[],"reasons":[]}}']) {
        writeFileSync(cacheFile, invalid)
        expect(invoke({ cacheDirectory, source })).toEqual(expected)
      }
    } finally {
      rmSync(cacheDirectory, { recursive: true, force: true })
    }
  })

  it('keeps analysis available when the cache directory cannot be created', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'genie-closure-unavailable-'))
    try {
      const cacheDirectory = path.join(root, 'not-a-directory')
      writeFileSync(cacheDirectory, 'occupied')
      expect(invoke({ cacheDirectory })).toEqual({ imports: [], reasons: [] })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
