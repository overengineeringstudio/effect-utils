import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { realpathThroughName } from './real-path.ts'

type SourceRoots = {
  readonly repoRoot: string
  readonly editorInputs: string
  readonly nodeModules: string
  readonly backingRoots?: readonly string[]
}
type Clocks = ReadonlyMap<bigint, bigint | undefined>
/** Filesystem-clock receipt retained through the fenced recheck. */
export type EditorViewSourceIdentity = {
  readonly digest: string
  readonly clocks: Clocks
  readonly rehashedFiles: number
}

const probeClock = ({
  device,
  path,
  repoRoot,
}: {
  device: bigint
  path: string
  repoRoot: string
}): bigint | undefined => {
  for (const directory of new Set([repoRoot, tmpdir(), dirname(path), path])) {
    let scratch: string | undefined
    try {
      if (lstatSync(directory, { bigint: true }).dev !== device) continue
      scratch = mkdtempSync(join(directory, '.editor-view-clock-'))
      const probe = join(scratch, 'clock')
      writeFileSync(probe, '')
      return lstatSync(probe, { bigint: true }).ctimeNs
    } catch {
      // No writable same-device probe means every file on that device is racy.
    } finally {
      if (scratch !== undefined) rmSync(scratch, { recursive: true })
    }
  }
}

/** Metadata guards proof lifetime; filesystem clocks identify racily clean files. */
export const editorViewSourceIdentity = ({
  options,
  priorClocks,
}: {
  readonly options: SourceRoots
  readonly priorClocks?: Clocks
}): EditorViewSourceIdentity => {
  const { repoRoot, editorInputs, nodeModules, backingRoots = [] } = options
  const hash = createHash('sha256')
  const clocks =
    priorClocks === undefined ? new Map<bigint, bigint | undefined>() : new Map(priorClocks)
  const visited = new Set<string>()
  let rehashedFiles = 0
  let probing = priorClocks === undefined
  const visit = (path: string): void => {
    if (visited.has(path) === true) return
    visited.add(path)
    const status = lstatSync(path, { bigint: true })
    if (probing === true) {
      if (clocks.has(status.dev) === false)
        clocks.set(status.dev, probeClock({ device: status.dev, path, repoRoot }))
    } else {
      const { dev, ino, mode, size, mtimeNs, ctimeNs } = status
      hash.update(JSON.stringify([path, dev, ino, mode, size, mtimeNs, ctimeNs].map(String)))
      const clock = clocks.get(status.dev)
      // Racy-git: at/after the same-device prehash probe, or unprobed, requires bytes.
      if (
        status.isFile() === true &&
        (clock === undefined || status.ctimeNs >= clock || status.mtimeNs >= clock)
      ) {
        hash.update(createHash('sha256').update(readFileSync(path)).digest('hex'))
        rehashedFiles++
      }
    }
    if (status.isSymbolicLink() === true) {
      const target = realpathThroughName(path)
      if (probing === false) hash.update(JSON.stringify([readlinkSync(path), target]))
      visit(target)
    } else if (status.isDirectory() === true)
      for (const name of readdirSync(path).toSorted()) visit(join(path, name))
  }
  const scan = (): void => {
    visited.clear()
    for (const source of new Set([editorInputs, nodeModules, ...backingRoots]))
      visit(realpathThroughName(source))
  }
  if (probing === true) scan() // All probes precede the first content read.
  probing = false
  scan()
  return { digest: hash.digest('hex'), clocks, rehashedFiles }
}

/** The same fail-closed comparison used after acquiring the publication fence. */
export const editorViewSourceIdentityMatches = ({
  options,
  identity,
}: {
  readonly options: SourceRoots
  readonly identity: EditorViewSourceIdentity
}): boolean =>
  editorViewSourceIdentity({ options, priorClocks: identity.clocks }).digest === identity.digest
