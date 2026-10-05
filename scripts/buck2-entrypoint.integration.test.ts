import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http2'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { directBuckArguments } from './buck2-entrypoint.ts'

const roots: string[] = []
const fixture = (address = 'grpc://127.0.0.1:1', archive = 'http://127.0.0.1:1/cas/'): string => {
  const root = mkdtempSync(join(tmpdir(), 'direct-buck-posture-'))
  roots.push(root)
  writeFileSync(join(root, '.buckroot'), '')
  writeFileSync(
    join(root, '.buckconfig'),
    `[buck2]\nremote_cache_enabled = true\nallow_cache_uploads = false\n[buck2_re_client]\naction_cache_address = ${address}\ninstance_name = fixture\ntls = false\n[archive_origin]\ntrusted_url_prefix = ${archive}\ntrusted_tier = private\n`,
  )
  return root
}
const options = (root: string) => ({
  cwd: root,
  env: {},
  cacheDirectory: join(root, 'probe-cache'),
})
const effective = (args: readonly string[]): Record<string, string> => {
  const values: Record<string, string> = {}
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--') break
    if (args[index] === '-c' || args[index] === '--config') {
      const value = args[++index] ?? ''
      const equals = value.indexOf('=')
      values[value.slice(0, equals)] = value.slice(equals + 1)
    }
  }
  return values
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('direct pinned Buck posture', () => {
  it('falls back both unavailable endpoints without overwriting concurrent checkout configuration or run arguments', async () => {
    const root = fixture()
    const local = '[ui]\ncolor = false\n'
    writeFileSync(join(root, '.buckconfig.local'), local)
    const result = await directBuckArguments({
      ...options(root),
      args: ['run', '//:app', '--', '-c', 'buck2.remote_cache_enabled=true'],
    })
    expect(effective(result)['buck2.remote_cache_enabled']).toBe('false')
    expect(effective(result)['archive_origin.url_prefix']).toBe('')
    expect(effective(result)['archive_origin.tier']).toBe('public')
    expect(result.slice(result.indexOf('--'))).toEqual([
      '--',
      '-c',
      'buck2.remote_cache_enabled=true',
    ])
    expect(readFileSync(join(root, '.buckconfig.local'), 'utf8')).toBe(local)
  })

  it('admits the consuming policy default when the root omits remote_cache_enabled', async () => {
    const root = fixture()
    const config = readFileSync(join(root, '.buckconfig'), 'utf8')
    writeFileSync(join(root, '.buckconfig'), config.replace('remote_cache_enabled = true\n', ''))
    const reader = await directBuckArguments({ ...options(root), args: ['build', '//:app'] })
    expect(effective(reader)['buck2.remote_cache_enabled']).toBe('false')
    await expect(
      directBuckArguments({
        ...options(root),
        env: { BUCK2_CACHE_WRITE_BASIC_AUTH: 'publisher-credential' },
        args: ['build', '//:app'],
      }),
    ).rejects.toThrow('refusing to publish')
  })

  it('uses effective CLI endpoints rather than the tracked endpoint, and preserves a caller registry selection', async () => {
    const root = fixture()
    const result = await directBuckArguments({
      ...options(root),
      args: [
        'build',
        '//:app',
        '-c',
        'buck2.remote_cache_enabled=false',
        '-c',
        'archive_origin.url_prefix=',
      ],
    })
    const values = effective(result)
    expect(values['buck2.remote_cache_enabled']).toBe('false')
    expect(values['archive_origin.url_prefix']).toBe('')
  })

  it('caches healthy capabilities across hot loops but does not reuse them for a different endpoint or writer credential', async () => {
    let requests = 0
    const grpc = createServer()
    grpc.on('stream', (stream) => {
      requests++
      stream.on('data', () => {})
      stream.on('end', () => {
        stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '0' })
        stream.end(Buffer.from([0, 0, 0, 0, 0]))
      })
    })
    grpc.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => grpc.once('listening', resolve))
    const bound = grpc.address()
    if (bound === null || typeof bound === 'string') throw new Error('expected TCP listener')
    const archive = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response(null, { status: 404 }),
    })
    try {
      const root = fixture(
        `grpc://127.0.0.1:${bound.port}`,
        `http://127.0.0.1:${archive.port}/cas/`,
      )
      for (let index = 0; index < 3; index++) {
        const result = await directBuckArguments({ ...options(root), args: ['build', '//:app'] })
        expect(effective(result)['buck2.remote_cache_enabled']).not.toBe('false')
        expect(effective(result)['archive_origin.url_prefix']).toBe(
          `http://127.0.0.1:${archive.port}/cas/`,
        )
      }
      expect(requests).toBe(1)
      const ignoredClientOverride = await directBuckArguments({
        ...options(root),
        args: ['build', '//:app', '-c', 'buck2_re_client.action_cache_address=grpc://127.0.0.1:1'],
      })
      expect(effective(ignoredClientOverride)['buck2.remote_cache_enabled']).not.toBe('false')
      const config = readFileSync(join(root, '.buckconfig'), 'utf8')
      writeFileSync(
        join(root, '.buckconfig'),
        config.replace(`grpc://127.0.0.1:${bound.port}`, 'grpc://127.0.0.1:1'),
      )
      const changed = await directBuckArguments({ ...options(root), args: ['build', '//:app'] })
      expect(effective(changed)['buck2.remote_cache_enabled']).toBe('false')
      writeFileSync(join(root, '.buckconfig'), config)
      const archiveFallback = await directBuckArguments({
        ...options(root),
        args: ['build', '//:app', '-c', 'archive_origin.url_prefix=http://127.0.0.1:1/cas/'],
      })
      expect(effective(archiveFallback)['archive_origin.url_prefix']).toBe('')
      expect(effective(archiveFallback)['buck2.remote_cache_enabled']).not.toBe('false')
      await directBuckArguments({
        ...options(root),
        env: {
          BUCK2_PRIVATE_CACHE_WRITE_BASIC_AUTH: 'writer-credential',
          BUCK2_PRIVATE_CACHE_ADDRESS: `grpc://127.0.0.1:${bound.port}`,
        },
        args: ['build', '//:app'],
      })
      expect(requests).toBe(2)
      await expect(
        directBuckArguments({
          ...options(root),
          env: {
            BUCK2_PRIVATE_CACHE_WRITE_BASIC_AUTH: 'writer-credential',
            BUCK2_PRIVATE_CACHE_ADDRESS: 'grpc://127.0.0.1:1',
          },
          args: ['build', '//:app'],
        }),
      ).rejects.toThrow('refusing to publish')
    } finally {
      archive.stop(true)
      grpc.close()
    }
  })
})
