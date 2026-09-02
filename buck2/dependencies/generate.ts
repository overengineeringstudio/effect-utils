import { existsSync, readFileSync } from 'node:fs'

import {
  decodePnpmSha256Sidecar,
  translatePnpmLock,
  validatePnpmSha256Sidecar,
  type PnpmLockMetadata,
  type PnpmSha256Sidecar,
} from './pnpm-lock.ts'

const sidecarPath = 'buck2/dependencies/pnpm-lock.sha256.json' as const

/** Real lock translation and its verified, freshness-gated archive sidecar. */
export type RealPnpmLockData = {
  readonly metadata: PnpmLockMetadata
  readonly sidecar: PnpmSha256Sidecar
}

let loaded: RealPnpmLockData | undefined

/**
 * Loads the real lock projection once per Genie process. A fresh existing sidecar avoids all
 * network access. A missing or stale sidecar is refreshed in a synchronous Bun subprocess so
 * Genie keeps its synchronous output contract; that subprocess verifies lockfile sha512 before
 * returning each archive's sha256 and bin metadata.
 */
export const loadRealPnpmLockData = (): RealPnpmLockData => {
  if (loaded !== undefined) return loaded
  const metadata = translatePnpmLock({
    lockfileText: readFileSync('pnpm-lock.yaml', 'utf8'),
    workspaceText: readFileSync('pnpm-workspace.yaml', 'utf8'),
  })
  let sidecar: PnpmSha256Sidecar | undefined
  if (existsSync(sidecarPath) === true) {
    let value: unknown
    try {
      value = JSON.parse(readFileSync(sidecarPath, 'utf8'))
    } catch (error) {
      throw new Error(
        `${sidecarPath} is malformed and cannot be refreshed safely: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
    sidecar = decodePnpmSha256Sidecar(value)
    try {
      validatePnpmSha256Sidecar({ metadata, sidecar })
    } catch {
      sidecar = undefined
    }
  }
  if (sidecar === undefined) {
    const bun = Bun.which('bun')
    if (bun === null) throw new Error('pnpm sha256 sidecar generation requires Bun on PATH')
    const result = Bun.spawnSync({
      cmd: [bun, 'buck2/dependencies/generate-sidecar.ts'],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (result.exitCode !== 0) {
      throw new Error(
        `pnpm sha256 sidecar generation failed: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`,
      )
    }
    let value: unknown
    try {
      value = JSON.parse(result.stdout.toString())
    } catch (error) {
      throw new Error(
        `pnpm sha256 sidecar generator returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
    sidecar = decodePnpmSha256Sidecar(value)
    validatePnpmSha256Sidecar({ metadata, sidecar })
  }
  loaded = { metadata, sidecar }
  return loaded
}
