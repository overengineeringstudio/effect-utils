import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
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
