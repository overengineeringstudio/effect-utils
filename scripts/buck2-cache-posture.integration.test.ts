import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createGrpcServer } from 'node:http2'
import { createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { standardCIEnv } from '../genie/ci-workflow/shared.ts'
import {
  reconcileStandaloneCachePostureForInvocation,
  reconcileStandaloneCachePosture,
  standaloneCachePostureConfig,
} from './buck2-cache-posture.ts'

const trustedOrigin = {
  tier: 'private',
  urlPrefix: 'https://trusted-cache.example/cas/',
} as const

const temporaryRoots: string[] = []

const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'buck2-cache-posture-'))
  writeFileSync(
    join(root, '.buckconfig'),
    `[archive_origin]
  trusted_url_prefix = ${trustedOrigin.urlPrefix}
  trusted_tier = ${trustedOrigin.tier}
`,
  )
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true })
})

describe('standalone Buck cache posture', () => {
  it('selects registry for the exact public-lane opt-out and CAS otherwise', () => {
    expect(
      standaloneCachePostureConfig({
        current: '',
        env: { BUCK2_NO_REMOTE_CACHE: '1' },
        trustedOrigin,
      }),
    ).toBe(`# effect-utils standalone cache posture: begin
[buck2]
  remote_cache_enabled = false
  allow_cache_uploads = false
[archive_origin]
  url_prefix =
  tier = public
# effect-utils standalone cache posture: end
`)

    for (const value of [undefined, '0', 'true', ' 1'])
      expect(
        standaloneCachePostureConfig({
          current: '',
          env: { BUCK2_NO_REMOTE_CACHE: value },
          trustedOrigin,
        }),
      ).toBe(`# effect-utils standalone cache posture: begin
[archive_origin]
  url_prefix = https://trusted-cache.example/cas/
  tier = private
# effect-utils standalone cache posture: end
`)
  })

  it('reads the public TLS tier anonymously in a PR lane, without upload rights', () => {
    const tracked = readFileSync(join(import.meta.dir, '..', '.buckconfig'), 'utf8')
    const prLane = standaloneCachePostureConfig({
      current: '',
      env: standardCIEnv({ trustTier: 'public' }),
      trustedOrigin,
    })
    const effective = `${tracked}\n${prLane}`

    expect(prLane).toContain('remote_cache_enabled = true')
    expect(prLane).toContain('allow_cache_uploads = false')
    expect(prLane).toContain('url_prefix =\n  tier = public')
    expect(effective).toContain('action_cache_address = grpc://dev3.tail8108.ts.net:8443')
    expect(effective).toContain('cas_address = grpc://dev3.tail8108.ts.net:8443')
    expect(effective).toContain('tls = true')
    expect(effective).not.toContain('http_headers')
    expect(effective).not.toContain('trusted-cache.example')

    const escapeHatch = standaloneCachePostureConfig({
      current: prLane,
      env: { ...standardCIEnv({ trustTier: 'public' }), BUCK2_NO_REMOTE_CACHE: '1' },
      trustedOrigin,
    })
    expect(escapeHatch).toContain('remote_cache_enabled = false')
    expect(escapeHatch).toContain('allow_cache_uploads = false')
    expect(escapeHatch).not.toContain('remote_cache_enabled = true')
    expect(escapeHatch).not.toContain('http_headers')
  })

  it('selects the publisher posture only with a writer credential and never writes the credential', () => {
    const credential = 'd3JpdGVyOnNlY3JldA=='
    const publisher = standaloneCachePostureConfig({
      current: '',
      env: { BUCK2_NO_REMOTE_CACHE: '0', BUCK2_CACHE_WRITE_BASIC_AUTH: credential },
      trustedOrigin,
    })
    expect(publisher).toBe(`# effect-utils standalone cache posture: begin
[buck2]
  allow_cache_uploads = true
  default_allow_cache_upload = true
[buck2_re_client]
  http_headers = authorization: Basic $BUCK2_CACHE_WRITE_BASIC_AUTH
[archive_origin]
  url_prefix =
  tier = public
# effect-utils standalone cache posture: end
`)
    expect(publisher).not.toContain(credential)

    for (const value of [undefined, ''])
      expect(
        standaloneCachePostureConfig({
          current: '',
          env: { BUCK2_CACHE_WRITE_BASIC_AUTH: value },
          trustedOrigin,
        }),
      ).not.toContain('allow_cache_uploads = true')

    // The exact public-lane opt-out wins over a leaked credential.
    expect(
      standaloneCachePostureConfig({
        current: '',
        env: { BUCK2_NO_REMOTE_CACHE: '1', BUCK2_CACHE_WRITE_BASIC_AUTH: credential },
        trustedOrigin,
      }),
    ).not.toContain('allow_cache_uploads = true')
  })

  it('admits a private host writer without exposing credentials and removes auth on public lanes', () => {
    const credential = Buffer.from('host-a:secret').toString('base64')
    const env = {
      BUCK2_PRIVATE_CACHE_WRITE_BASIC_AUTH: credential,
      BUCK2_PRIVATE_CACHE_ADDRESS: 'grpc://private-cache.example:41045',
      BUCK2_CACHE_WRITE_BASIC_AUTH: 'publisher-credential',
    }
    const writer = standaloneCachePostureConfig({ current: '', env, trustedOrigin })
    expect(writer).toContain('allow_cache_uploads = true')
    for (const field of ['action_cache_address', 'cas_address', 'engine_address'])
      expect(writer).toContain(`${field} = ${env.BUCK2_PRIVATE_CACHE_ADDRESS}`)
    expect(writer).toContain('tls = false')
    expect(writer).toContain('$BUCK2_PRIVATE_CACHE_WRITE_BASIC_AUTH')
    expect(writer).toContain(`url_prefix = ${trustedOrigin.urlPrefix}`)
    expect(writer).not.toContain(credential)
    expect(writer).not.toContain('$BUCK2_CACHE_WRITE_BASIC_AUTH')
    for (const override of [
      { BUCK2_PUBLIC_CACHE_READ_ONLY: '1' },
      { BUCK2_NO_REMOTE_CACHE: '1' },
    ]) {
      const reader = standaloneCachePostureConfig({
        current: writer,
        env: { ...env, ...override },
        trustedOrigin,
      })
      expect(reader).toContain('allow_cache_uploads = false')
      expect(reader).not.toContain('http_headers')
      expect(reader).not.toContain('private-cache.example')
    }
    expect(() =>
      standaloneCachePostureConfig({
        current: '',
        env: { BUCK2_PRIVATE_CACHE_WRITE_BASIC_AUTH: credential },
        trustedOrigin,
      }),
    ).toThrow()
  })

  it('replaces a publisher overlay with anonymous read-only posture in a reader root', () => {
    const publisher = standaloneCachePostureConfig({
      current: '',
      env: { BUCK2_CACHE_WRITE_BASIC_AUTH: 'd3JpdGVyOnNlY3JldA==' },
      trustedOrigin,
    })
    const reader = standaloneCachePostureConfig({
      current: publisher,
      env: { BUCK2_PUBLIC_CACHE_READ_ONLY: '1' },
      trustedOrigin,
    })

    expect(reader).toContain('remote_cache_enabled = true')
    expect(reader).toContain('allow_cache_uploads = false')
    expect(reader).not.toContain('default_allow_cache_upload = true')
    expect(reader).not.toContain('http_headers')
    expect(reader).not.toContain('BUCK2_CACHE_WRITE_BASIC_AUTH')
  })

  it('preserves local overrides while adding and removing the managed posture atomically', () => {
    const root = makeRoot()
    const output = join(root, '.buckconfig.local')
    const local = `[ui]\n  color = true\n`
    writeFileSync(output, local)

    reconcileStandaloneCachePosture({ repoRoot: root, env: { BUCK2_NO_REMOTE_CACHE: '1' } })
    expect(readFileSync(output, 'utf8')).toBe(`${local.trimEnd()}

# effect-utils standalone cache posture: begin
[buck2]
  remote_cache_enabled = false
  allow_cache_uploads = false
[archive_origin]
  url_prefix =
  tier = public
# effect-utils standalone cache posture: end
`)

    reconcileStandaloneCachePosture({ repoRoot: root, env: {} })
    expect(readFileSync(output, 'utf8')).toBe(`${local.trimEnd()}

# effect-utils standalone cache posture: begin
[archive_origin]
  url_prefix = https://trusted-cache.example/cas/
  tier = private
# effect-utils standalone cache posture: end
`)
  })

  it('replaces the public posture when a checkout returns to the trusted tier', () => {
    const root = makeRoot()
    const output = join(root, '.buckconfig.local')

    reconcileStandaloneCachePosture({ repoRoot: root, env: { BUCK2_NO_REMOTE_CACHE: '1' } })
    expect(existsSync(output)).toBeTrue()

    reconcileStandaloneCachePosture({ repoRoot: root, env: { BUCK2_NO_REMOTE_CACHE: '0' } })
    expect(readFileSync(output, 'utf8')).toContain(
      'url_prefix = https://trusted-cache.example/cas/',
    )
    expect(readFileSync(output, 'utf8')).not.toContain('remote_cache_enabled = false')
  })
})

describe('Buck2 REAPI capability preflight', () => {
  it('keeps the cache enabled after a real GetCapabilities RPC', async () => {
    const root = makeRoot()
    const server = createGrpcServer()
    const requests: { path: string | undefined; instance: string | undefined }[] = []
    server.on('stream', (stream, headers) => {
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => {
        const frame = Buffer.concat(chunks)
        requests.push({
          path: headers[':path'],
          instance: frame.subarray(7).toString(),
        })
        expect(frame[0]).toBe(0)
        expect(frame.readUInt32BE(1)).toBe(frame.length - 5)
        expect(frame[5]).toBe(0x0a)
        expect(frame[6]).toBe(Buffer.byteLength('effect-utils'))
        stream.respond(
          { ':status': 200, 'content-type': 'application/grpc' },
          { waitForTrailers: true },
        )
        stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }))
        stream.end(Buffer.from([0, 0, 0, 0, 4, 0x0a, 2, 8, 1]))
      })
    })
    server.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => server.once('listening', resolve))
    try {
      const bound = server.address()
      if (bound === null || typeof bound === 'string') throw new Error('expected TCP listener')
      writeFileSync(
        join(root, '.buckconfig'),
        `${readFileSync(join(root, '.buckconfig'), 'utf8')}
[buck2_re_client]
  action_cache_address = grpc://127.0.0.1:${bound.port}
  instance_name = effect-utils
  tls = false
`,
      )
      const healthy = await reconcileStandaloneCachePostureForInvocation({
        repoRoot: root,
        env: { BUCK2_PUBLIC_CACHE_READ_ONLY: '1' },
      })
      expect(healthy).toBe(true)
      expect(requests).toEqual([
        {
          path: '/build.bazel.remote.execution.v2.Capabilities/GetCapabilities',
          instance: 'effect-utils',
        },
      ])
      expect(readFileSync(join(root, '.buckconfig.local'), 'utf8')).toContain(
        'remote_cache_enabled = true',
      )
    } finally {
      server.close()
    }
  })

  it('fails open on an unreachable endpoint, then restores the cache on the next invocation', async () => {
    const root = makeRoot()
    const socket = createTcpServer()
    socket.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => socket.once('listening', resolve))
    const bound = socket.address()
    if (bound === null || typeof bound === 'string') throw new Error('expected TCP listener')
    const endpoint = `grpc://127.0.0.1:${bound.port}`
    socket.close()
    await new Promise<void>((resolve) => socket.once('close', resolve))
    writeFileSync(
      join(root, '.buckconfig'),
      `${readFileSync(join(root, '.buckconfig'), 'utf8')}
[buck2_re_client]
  action_cache_address = ${endpoint}
  instance_name = effect-utils
  tls = false
`,
    )
    const run = Bun.spawnSync({
      cmd: [process.execPath, join(import.meta.dir, 'buck2-cache-posture.ts'), root, '--probe'],
      env: { ...process.env, GITHUB_ACTIONS: 'true', BUCK2_PUBLIC_CACHE_READ_ONLY: '1' },
    })
    const stderr = run.stderr.toString()
    expect(run.exitCode).toBe(0)
    expect(stderr).toContain('warning: Buck2 REAPI GetCapabilities failed')
    expect(stderr).toContain('::warning title=Buck2 cache::')
    expect(stderr).toContain('buck2_reapi_fail_open_total 1')
    expect(stderr).not.toContain(endpoint)
    expect(readFileSync(join(root, '.buckconfig.local'), 'utf8')).toContain(
      'remote_cache_enabled = false',
    )

    const server = createGrpcServer()
    server.on('stream', (stream) => {
      stream.on('data', () => {})
      stream.on('end', () => {
        stream.respond({
          ':status': 200,
          'content-type': 'application/grpc',
          'grpc-status': '0',
        })
        stream.end(Buffer.from([0, 0, 0, 0, 4, 0x0a, 2, 8, 1]))
      })
    })
    server.listen(bound.port, '127.0.0.1')
    await new Promise<void>((resolve) => server.once('listening', resolve))
    try {
      expect(
        await reconcileStandaloneCachePostureForInvocation({
          repoRoot: root,
          env: { BUCK2_PUBLIC_CACHE_READ_ONLY: '1' },
        }),
      ).toBe(true)
      expect(readFileSync(join(root, '.buckconfig.local'), 'utf8')).toContain(
        'remote_cache_enabled = true',
      )
    } finally {
      server.close()
    }
  })
  it.each(['publisher', 'private'] as const)('rejects unavailable %s cache', async (tier) => {
    const root = makeRoot()
    const server = createGrpcServer()
    const receivedHeaders: string[] = []
    server.on('stream', (stream, headers) => {
      receivedHeaders.push(String(headers['authorization']))
      stream.respond({
        ':status': 200,
        'content-type': 'application/grpc',
        'grpc-status': '7',
      })
      stream.end()
    })
    server.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => server.once('listening', resolve))
    try {
      const bound = server.address()
      if (bound === null || typeof bound === 'string') throw new Error('expected TCP listener')
      writeFileSync(
        join(root, '.buckconfig'),
        `${readFileSync(join(root, '.buckconfig'), 'utf8')}
[buck2_re_client]
  action_cache_address = grpc://127.0.0.1:${bound.port}
  instance_name = effect-utils
  tls = false
  http_headers = authorization: Basic $BUCK2_CACHE_WRITE_BASIC_AUTH
`,
      )
      const credential = 'not-for-logs'
      const run = Bun.spawn({
        cmd: [process.execPath, join(import.meta.dir, 'buck2-cache-posture.ts'), root, '--probe'],
        stderr: 'pipe',
        env: {
          ...process.env,
          GITHUB_ACTIONS: 'true',
          ...(tier === 'publisher'
            ? { BUCK2_CACHE_WRITE_BASIC_AUTH: credential }
            : {
                BUCK2_PRIVATE_CACHE_WRITE_BASIC_AUTH: credential,
                BUCK2_PRIVATE_CACHE_ADDRESS: `grpc://127.0.0.1:${bound.port}`,
              }),
        },
      })
      const stderr = await new Response(run.stderr).text()
      expect(await run.exited).toBe(1)
      expect(receivedHeaders).toEqual([`Basic ${credential}`])
      expect(stderr).toContain('::error title=Buck2 cache::')
      expect(stderr).not.toContain('buck2_reapi_fail_open_total')
      expect(stderr).not.toContain(credential)
      const posture = readFileSync(join(root, '.buckconfig.local'), 'utf8')
      expect(posture).toContain('allow_cache_uploads = true')
      expect(posture).not.toContain('remote_cache_enabled = false')
      expect(posture).not.toContain(credential)
    } finally {
      server.close()
    }
  })

  it('preserves the explicit no-cache opt-out without probing', async () => {
    const root = makeRoot()
    expect(
      await reconcileStandaloneCachePostureForInvocation({
        repoRoot: root,
        env: { BUCK2_NO_REMOTE_CACHE: '1' },
      }),
    ).toBe(true)
    expect(readFileSync(join(root, '.buckconfig.local'), 'utf8')).toContain(
      'remote_cache_enabled = false',
    )
  })
})

/** A REAPI endpoint that answers GetCapabilities, so only the archive origin varies. */
const withHealthyReapi = async (run: (endpoint: string) => Promise<void>): Promise<void> => {
  const server = createGrpcServer()
  server.on('stream', (stream) => {
    stream.on('data', () => {})
    stream.on('end', () => {
      stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '0' })
      stream.end(Buffer.from([0, 0, 0, 0, 4, 0x0a, 2, 8, 1]))
    })
  })
  server.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  try {
    const bound = server.address()
    if (bound === null || typeof bound === 'string') throw new Error('expected TCP listener')
    await run(`grpc://127.0.0.1:${bound.port}`)
  } finally {
    server.close()
  }
}

const writeTrustedRoot = ({
  archivePrefix,
  reapiEndpoint,
}: {
  archivePrefix: string
  reapiEndpoint: string
}): string => {
  const root = makeRoot()
  writeFileSync(
    join(root, '.buckconfig'),
    `[archive_origin]
  trusted_url_prefix = ${archivePrefix}
  trusted_tier = private
[buck2_re_client]
  action_cache_address = ${reapiEndpoint}
  instance_name = effect-utils
  tls = false
`,
  )
  return root
}

describe('trusted archive origin preflight', () => {
  it('keeps a reachable archive origin, whatever HTTP status it answers with', async () => {
    const archive = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response(null, { status: 400 }),
    })
    try {
      await withHealthyReapi(async (reapiEndpoint) => {
        const prefix = `http://127.0.0.1:${archive.port}/cas/`
        const root = writeTrustedRoot({ archivePrefix: prefix, reapiEndpoint })
        expect(
          await reconcileStandaloneCachePostureForInvocation({ repoRoot: root, env: {} }),
        ).toBe(true)
        expect(readFileSync(join(root, '.buckconfig.local'), 'utf8')).toContain(
          `url_prefix = ${prefix}`,
        )
      })
    } finally {
      archive.stop(true)
    }
  })

  it('drops an unresolvable archive origin for the invocation while REAPI stays enabled, then restores it', async () => {
    await withHealthyReapi(async (reapiEndpoint) => {
      const prefix = 'http://archive-origin.invalid/cas/'
      const root = writeTrustedRoot({ archivePrefix: prefix, reapiEndpoint })
      // Async spawn: a synchronous one would block the in-process REAPI server from answering.
      const child = Bun.spawn({
        cmd: [process.execPath, join(import.meta.dir, 'buck2-cache-posture.ts'), root, '--probe'],
        env: { ...process.env, GITHUB_ACTIONS: 'true' },
        stderr: 'pipe',
      })
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ])
      expect(exitCode).toBe(0)
      expect(stderr).toContain('warning: Buck2 archive origin is unreachable')
      expect(stderr).toContain('::warning title=Buck2 cache::')
      expect(stderr).toContain('buck2_archive_origin_fail_open_total 1')
      expect(stderr).not.toContain(prefix)
      const local = readFileSync(join(root, '.buckconfig.local'), 'utf8')
      expect(local).not.toContain('remote_cache_enabled = false')
      expect(local).not.toContain(prefix)
      expect(local).toContain('url_prefix =\n')

      // The next invocation writes the trusted posture again before it probes.
      reconcileStandaloneCachePosture({ repoRoot: root, env: {} })
      expect(readFileSync(join(root, '.buckconfig.local'), 'utf8')).toContain(
        `url_prefix = ${prefix}`,
      )
    })
  })
})
