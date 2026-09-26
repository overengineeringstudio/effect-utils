import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  reconcileStandaloneCachePosture,
  standaloneCachePostureConfig,
} from './buck2-cache-posture.ts'
import { standardCIEnv } from '../genie/ci-workflow/shared.ts'

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
