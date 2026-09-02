import { existsSync, readFileSync } from 'node:fs'

import {
  decodePnpmSha256Sidecar,
  generatePnpmSha256Sidecar,
  translatePnpmLock,
  type PnpmSha256Sidecar,
} from './pnpm-lock.ts'

const main = async (): Promise<void> => {
  const metadata = translatePnpmLock({
    lockfileText: readFileSync('pnpm-lock.yaml', 'utf8'),
    workspaceText: readFileSync('pnpm-workspace.yaml', 'utf8'),
  })
  let previous: PnpmSha256Sidecar | undefined
  const sidecarPath = 'buck2/dependencies/pnpm-lock.sha256.json'
  if (existsSync(sidecarPath) === true) {
    previous = decodePnpmSha256Sidecar(JSON.parse(readFileSync(sidecarPath, 'utf8')))
  }
  const sidecar = await generatePnpmSha256Sidecar({
    metadata,
    ...(previous === undefined ? {} : { previous }),
  })
  process.stdout.write(`${JSON.stringify(sidecar)}\n`)
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  )
  process.exitCode = 1
})
