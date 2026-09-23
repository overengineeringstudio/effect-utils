import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import { defineRepoContext } from '../../packages/@overeng/genie/src/runtime/repo-context/mod.ts'
import {
  decodePnpmSha256Sidecar,
  generatePnpmSha256Sidecar,
  translatePnpmLock,
  type PnpmSha256Sidecar,
} from './pnpm-lock.ts'

// Same anchoring as `generate.ts`: this refresher is spawned by the Genie process, whose
// working directory is not necessarily the repository being projected.
const repo = defineRepoContext({ name: 'effect-utils', importMetaUrl: import.meta.url })

const main = async (): Promise<void> => {
  const metadata = translatePnpmLock({
    lockfileText: repo.readText('pnpm-lock.yaml'),
    workspaceText: repo.readText('pnpm-workspace.yaml'),
  })
  let previous: PnpmSha256Sidecar | undefined
  const sidecarPath = repo.resolve('buck2/dependencies/pnpm-lock.sha256.json')
  if (existsSync(sidecarPath) === true) {
    try {
      previous = decodePnpmSha256Sidecar(JSON.parse(readFileSync(sidecarPath, 'utf8')))
    } catch {
      previous = undefined
    }
  }
  const sidecar = await generatePnpmSha256Sidecar({
    metadata,
    ...(previous === undefined ? {} : { previous }),
  })
  const contents = `${JSON.stringify(sidecar)}\n`
  if (process.argv.includes('--write')) {
    writeFileSync(sidecarPath, contents)
  } else {
    process.stdout.write(contents)
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  )
  process.exitCode = 1
})
