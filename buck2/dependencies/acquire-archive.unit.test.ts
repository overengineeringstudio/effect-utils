import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { acquireArchive, type ArchiveOriginFallback } from './acquire-archive.ts'

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

const options = (output: string) => ({
  casUrl,
  output,
  registryUrl,
  sha256,
  size: bytes.byteLength,
})

describe('pnpm archive acquisition', () => {
  it('reports a CAS 404 miss, recovers from the canonical registry and verifies the archive', async () => {
    await withOutput(async (output) => {
      const urls: string[] = []
      const fallbacks: ArchiveOriginFallback[] = []
      const source = await acquireArchive({
        ...options(output),
        reportFallback: (fallback) => fallbacks.push(fallback),
        fetchArchive: async (url) => {
          urls.push(String(url))
          return urls.length === 1 ? new Response(undefined, { status: 404 }) : new Response(bytes)
        },
      })
      expect(source).toBe('registry')
      expect(urls).toEqual([casUrl, registryUrl])
      expect(await readFile(output)).toEqual(Buffer.from(bytes))
      expect(fallbacks).toEqual([
        { type: 'archive-origin-fallback', reason: 'not-found', sha256, status: 404 },
      ])
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

  it.each([500, 503, 599])(
    'reports CAS HTTP %i and cancels its body before registry recovery',
    async (status) => {
      await withOutput(async (output) => {
        const urls: string[] = []
        const fallbacks: ArchiveOriginFallback[] = []
        let cancelled = false
        const body = new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true
          },
        })
        const source = await acquireArchive({
          ...options(output),
          reportFallback: (fallback) => fallbacks.push(fallback),
          fetchArchive: async (url) => {
            urls.push(String(url))
            if (String(url) === casUrl) return new Response(body, { status })
            expect(cancelled).toBe(true)
            return new Response(bytes)
          },
        })
        expect(source).toBe('registry')
        expect(urls).toEqual([casUrl, registryUrl])
        expect(await readFile(output)).toEqual(Buffer.from(bytes))
        expect(fallbacks).toEqual([
          { type: 'archive-origin-fallback', reason: 'server-error', sha256, status },
        ])
      })
    },
  )

  it.each(['rejecting-cancel', 'errored-stream'])(
    'recovers a CAS 5xx despite %s cleanup and reports a sanitized diagnostic',
    async (failure) => {
      await withOutput(async (output) => {
        const urls: string[] = []
        const fallbacks: ArchiveOriginFallback[] = []
        let casSignal: AbortSignal | undefined
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            if (failure === 'errored-stream') controller.error(new Error('private reset detail'))
          },
          cancel() {
            return Promise.reject(new Error('private reset detail'))
          },
        })
        const source = await acquireArchive({
          ...options(output),
          reportFallback: (fallback) => fallbacks.push(fallback),
          fetchArchive: async (url, init) => {
            urls.push(String(url))
            if (String(url) === casUrl) {
              casSignal = init?.signal ?? undefined
              return new Response(body, { status: 503 })
            }
            expect(casSignal?.aborted).toBe(true)
            expect(fallbacks).toHaveLength(1)
            return new Response(bytes)
          },
        })
        expect(source).toBe('registry')
        expect(urls).toEqual([casUrl, registryUrl])
        expect(await readFile(output)).toEqual(Buffer.from(bytes))
        expect(fallbacks).toEqual([
          {
            type: 'archive-origin-fallback',
            reason: 'server-error',
            sha256,
            status: 503,
            cleanupDiagnostic: 'body-cancel-rejected',
          },
        ])
        expect(JSON.stringify(fallbacks)).not.toContain('private reset detail')
      })
    },
  )

  it('preserves a header-timeout reason when the late CAS response cannot be cancelled', async () => {
    await withOutput(async (output) => {
      const fallbacks: ArchiveOriginFallback[] = []
      const urls: string[] = []
      const source = await acquireArchive({
        ...options(output),
        headersTimeoutMs: 20,
        reportFallback: (fallback) => fallbacks.push(fallback),
        fetchArchive: (url, init) => {
          urls.push(String(url))
          if (String(url) === registryUrl) return Promise.resolve(new Response(bytes))
          return new Promise<Response>((resolve) => {
            init?.signal?.addEventListener(
              'abort',
              () => {
                resolve(
                  new Response(
                    new ReadableStream<Uint8Array>({
                      cancel() {
                        return Promise.reject(new Error('private reset detail'))
                      },
                    }),
                  ),
                )
              },
              { once: true },
            )
          })
        },
      })
      expect(source).toBe('registry')
      expect(urls).toEqual([casUrl, registryUrl])
      expect(await readFile(output)).toEqual(Buffer.from(bytes))
      expect(fallbacks).toEqual([
        {
          type: 'archive-origin-fallback',
          reason: 'headers-timeout',
          sha256,
          cleanupDiagnostic: 'body-cancel-rejected',
        },
      ])
    })
  })

  it('reports a refused CAS connection and aborts the request before registry recovery', async () => {
    await withOutput(async (output) => {
      const urls: string[] = []
      const fallbacks: ArchiveOriginFallback[] = []
      let casSignal: AbortSignal | undefined
      const source = await acquireArchive({
        ...options(output),
        reportFallback: (fallback) => fallbacks.push(fallback),
        fetchArchive: async (url, init) => {
          urls.push(String(url))
          if (String(url) === casUrl) {
            casSignal = init?.signal ?? undefined
            throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNREFUSED' })
          }
          expect(casSignal?.aborted).toBe(true)
          return new Response(bytes)
        },
      })
      expect(source).toBe('registry')
      expect(urls).toEqual([casUrl, registryUrl])
      expect(await readFile(output)).toEqual(Buffer.from(bytes))
      expect(fallbacks).toEqual([
        { type: 'archive-origin-fallback', reason: 'connection-error', sha256 },
      ])
    })
  })

  it('fails closed on a CAS client error without registry fallback', async () => {
    await withOutput(async (output) => {
      const urls: string[] = []
      const fallbacks: ArchiveOriginFallback[] = []
      await expect(
        acquireArchive({
          ...options(output),
          reportFallback: (fallback) => fallbacks.push(fallback),
          fetchArchive: async (url) => {
            urls.push(String(url))
            return new Response(undefined, { status: 403 })
          },
        }),
      ).rejects.toThrow('cas returned HTTP 403')
      expect(urls).toEqual([casUrl])
      expect(fallbacks).toEqual([])
    })
  })

  it('does not mask a registry failure after a reported CAS fallback', async () => {
    await withOutput(async (output) => {
      const urls: string[] = []
      const fallbacks: ArchiveOriginFallback[] = []
      await expect(
        acquireArchive({
          ...options(output),
          reportFallback: (fallback) => fallbacks.push(fallback),
          fetchArchive: async (url) => {
            urls.push(String(url))
            return new Response(undefined, { status: 503 })
          },
        }),
      ).rejects.toThrow('registry returned HTTP 503')
      expect(urls).toEqual([casUrl, registryUrl])
      expect(fallbacks).toHaveLength(1)
      expect(await readdir(dirname(output))).toEqual([])
    })
  })

  it('fails closed on mismatched CAS bytes without registry fallback', async () => {
    await withOutput(async (output) => {
      const urls: string[] = []
      const fallbacks: ArchiveOriginFallback[] = []
      await expect(
        acquireArchive({
          ...options(output),
          reportFallback: (fallback) => fallbacks.push(fallback),
          fetchArchive: async (url) => {
            urls.push(String(url))
            return new Response('wrong archive')
          },
        }),
      ).rejects.toThrow('archive digest mismatch')
      expect(urls).toEqual([casUrl])
      expect(fallbacks).toEqual([])
      expect(await readdir(dirname(output))).toEqual([])
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
  it('aborts an oversized archive without replacing the output or leaving a candidate', async () => {
    await withOutput(async (output) => {
      await writeFile(output, 'previous output')
      let cancelled = false
      const oversized = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(bytes.byteLength + 1))
        },
        cancel() {
          cancelled = true
        },
      })
      await expect(
        acquireArchive({
          ...options(output),
          fetchArchive: async () => new Response(oversized),
        }),
      ).rejects.toThrow('archive size exceeded')
      expect(cancelled).toBe(true)
      expect(await readFile(output, 'utf8')).toBe('previous output')
      expect(await readdir(dirname(output))).toEqual(['package.tgz'])
    })
  })

  it('rejects a short archive by size without publishing a candidate', async () => {
    await withOutput(async (output) => {
      await expect(
        acquireArchive({
          ...options(output),
          size: bytes.byteLength + 1,
          fetchArchive: async () => new Response(bytes),
        }),
      ).rejects.toThrow('archive size mismatch')
      await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readdir(dirname(output))).toEqual([])
    })
  })
  it('reports a CAS response-header timeout, then tries and verifies the registry', async () => {
    await withOutput(async (output) => {
      const urls: string[] = []
      const fallbacks: ArchiveOriginFallback[] = []
      let casSignal: AbortSignal | undefined
      const source = await acquireArchive({
        ...options(output),
        headersTimeoutMs: 20,
        reportFallback: (fallback) => fallbacks.push(fallback),
        fetchArchive: (url, init) => {
          urls.push(String(url))
          if (String(url) === registryUrl) {
            expect(casSignal?.aborted).toBe(true)
            return Promise.resolve(new Response(bytes))
          }
          casSignal = init?.signal ?? undefined
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            })
          })
        },
      })
      expect(source).toBe('registry')
      expect(urls).toEqual([casUrl, registryUrl])
      expect(await readFile(output)).toEqual(Buffer.from(bytes))
      expect(await readdir(dirname(output))).toEqual(['package.tgz'])
      expect(fallbacks).toEqual([
        { type: 'archive-origin-fallback', reason: 'headers-timeout', sha256 },
      ])
    })
  })

  it('aborts a stalled archive body at the overall transfer deadline', async () => {
    await withOutput(async (output) => {
      let cancelled = false
      const stalled = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, 1))
        },
        cancel() {
          cancelled = true
        },
      })
      await expect(
        acquireArchive({
          ...options(output),
          transferTimeoutMs: 20,
          fetchArchive: async () => new Response(stalled),
        }),
      ).rejects.toThrow()
      expect(cancelled).toBe(true)
      expect(await readdir(dirname(output))).toEqual([])
    })
  })
  it('rejects CAS redirects without following them or falling back to the registry', async () => {
    await withOutput(async (output) => {
      const urls: string[] = []
      await expect(
        acquireArchive({
          ...options(output),
          fetchArchive: async (url, init) => {
            expect(init?.redirect).toBe('manual')
            urls.push(String(url))
            return new Response(undefined, {
              status: 302,
              headers: { location: registryUrl },
            })
          },
        }),
      ).rejects.toThrow('CAS redirect is not allowed')
      expect(urls).toEqual([casUrl])
      expect(await readdir(dirname(output))).toEqual([])
    })
  })

  it('rejects a registry redirect to a non-approved archive origin', async () => {
    await withOutput(async (output) => {
      const urls: string[] = []
      await expect(
        acquireArchive({
          ...options(output),
          fetchArchive: async (url, init) => {
            expect(init?.redirect).toBe('manual')
            urls.push(String(url))
            return String(url) === casUrl
              ? new Response(undefined, { status: 404 })
              : new Response(undefined, {
                  status: 302,
                  headers: { location: 'https://unapproved.example/archive.tgz' },
                })
          },
        }),
      ).rejects.toThrow('approved public HTTPS archive origin')
      expect(urls).toEqual([casUrl, registryUrl])
      expect(await readdir(dirname(output))).toEqual([])
    })
  })

  it('follows an approved public HTTPS archive redirect and verifies its bytes', async () => {
    await withOutput(async (output) => {
      const redirected = 'https://overeng-effect-utils.cachix.org/serve/archive.tgz'
      const urls: string[] = []
      const source = await acquireArchive({
        ...options(output),
        fetchArchive: async (url, init) => {
          expect(init?.redirect).toBe('manual')
          urls.push(String(url))
          if (String(url) === casUrl) return new Response(undefined, { status: 404 })
          if (String(url) === registryUrl)
            return new Response(undefined, {
              status: 302,
              headers: { location: redirected },
            })
          return new Response(bytes)
        },
      })
      expect(source).toBe('registry')
      expect(urls).toEqual([casUrl, registryUrl, redirected])
      expect(await readFile(output)).toEqual(Buffer.from(bytes))
    })
  })
})
