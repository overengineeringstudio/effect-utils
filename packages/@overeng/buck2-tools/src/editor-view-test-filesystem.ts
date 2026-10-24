import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { editorViewLeaseFilesystem } from './editor-view-leases.ts'

/** Lease-bearing fixture data needs retirement semantics; executable helpers stay in tmpdir(). */
export const editorViewTestDataRoot = (): string => {
  const candidates = [tmpdir(), '/dev/shm']
  for (const root of candidates)
    if (existsSync(root) === true && editorViewLeaseFilesystem(root) === 'local') return root
  throw new Error(
    `editor view tests require a supported local filesystem for fixture data; neither ${candidates.join(' nor ')} qualifies`,
  )
}
