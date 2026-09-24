import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'bun:test'

import { acquireArchive } from './acquire-archive.ts'

const bytes = new TextEncoder().encode('verified archive')
const sha256 = createHash('sha256').update(bytes).digest('hex')
const casUrl = `https://cas.example/cas/${sha256}`
const registryUrl = 'https://registry.npmjs.org/postcss/-/postcss-8.4.31.tgz'

const withOutput = async (run: (output: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), 'pnpm-archive-'))
  try {
    await run(join(directory, 'package.tgz'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const options = (output: string) => ({ casUrl, output, registryUrl, sha256, size: bytes.byteLength })

describe('pnpm archive acquisition', () => {
  it('recovers only a CAS 404 from the canonical registry URL and verifies the archive', async () => {
    await withOutput(async (output) => {
      const urls: string[] = []
      const source = await acquireArchive({
        ...options(output),
        fetchArchive: async (url) => {
          urls.push(String(url))
          return urls.length === 1 ? new Response(undefined, { status: 404 }) : new Response(bytes)
        },
      })
      expect(source).toBe('registry')
      expect(urls).toEqual([casUrl, registryUrl])
      expect(await readFile(output)).toEqual(Buffer.from(bytes))
    })
  })

  it('uses a present CAS without contacting the registry', async () => {
    await withOutput(async (output) => {
      const urls: string[] = []
      expect(
        await acquireArchive({
          ...options(output),
          fetchArchive: async (url) => {
            urls.push(String(url))
            return new Response(bytes)
          },
        }),
      ).toBe('cas')
      expect(urls).toEqual([casUrl])
      expect(await readFile(output)).toEqual(Buffer.from(bytes))
    })
  })

  it('does not mask a CAS error with registry fallback', async () => {
    await withOutput(async (output) => {
      const urls: string[] = []
      await expect(
        acquireArchive({
          ...options(output),
          fetchArchive: async (url) => {
            urls.push(String(url))
            return new Response(undefined, { status: 503 })
          },
        }),
      ).rejects.toThrow('cas returned HTTP 503')
      expect(urls).toEqual([casUrl])
    })
  })

  it('rejects mismatched fallback bytes instead of admitting them to Buck', async () => {
    await withOutput(async (output) => {
      await expect(
        acquireArchive({
          ...options(output),
          fetchArchive: async (url) =>
            String(url) === casUrl
              ? new Response(undefined, { status: 404 })
              : new Response('wrong archive'),
        }),
      ).rejects.toThrow('archive digest mismatch')
      await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })
})
