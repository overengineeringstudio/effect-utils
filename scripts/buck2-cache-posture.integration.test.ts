import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  reconcileStandaloneCachePosture,
  standaloneCachePostureConfig,
} from './buck2-cache-posture.ts'

const temporaryRoots: string[] = []

const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'buck2-cache-posture-'))
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true })
})

describe('standalone Buck cache posture', () => {
  it('disables cache reads and uploads only for the exact public-lane opt-out', () => {
    expect(standaloneCachePostureConfig({ current: '', env: { BUCK2_NO_REMOTE_CACHE: '1' } }))
      .toBe(`# effect-utils standalone cache posture: begin
[buck2]
  remote_cache_enabled = false
  allow_cache_uploads = false
# effect-utils standalone cache posture: end
`)

    for (const value of [undefined, '0', 'true', ' 1'])
      expect(
        standaloneCachePostureConfig({
          current: '',
          env: { BUCK2_NO_REMOTE_CACHE: value },
        }),
      ).toBeUndefined()
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
# effect-utils standalone cache posture: end
`)

    reconcileStandaloneCachePosture({ repoRoot: root, env: {} })
    expect(readFileSync(output, 'utf8')).toBe(local)
  })

  it('removes the generated file when a checkout leaves the public trust tier', () => {
    const root = makeRoot()
    const output = join(root, '.buckconfig.local')

    reconcileStandaloneCachePosture({ repoRoot: root, env: { BUCK2_NO_REMOTE_CACHE: '1' } })
    expect(existsSync(output)).toBeTrue()

    reconcileStandaloneCachePosture({ repoRoot: root, env: { BUCK2_NO_REMOTE_CACHE: '0' } })
    expect(existsSync(output)).toBeFalse()
  })
})
