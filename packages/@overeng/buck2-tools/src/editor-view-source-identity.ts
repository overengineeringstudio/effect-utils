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
import { join } from 'node:path'

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
  inventoried,
  repoRoot,
}: {
  device: bigint
  inventoried: ReadonlySet<string>
  repoRoot: string
}): bigint | undefined => {
  for (const directory of new Set([repoRoot, tmpdir()])) {
    let scratch: string | undefined
    try {
      if (inventoried.has(realpathThroughName(directory)) === true) continue
      scratch = mkdtempSync(join(directory, '.editor-view-clock-'))
      const probe = join(scratch, 'clock')
      writeFileSync(probe, '')
      const status = lstatSync(probe, { bigint: true })
      if (status.dev === device) return status.ctimeNs
    } catch {
    } finally {
      if (scratch !== undefined) rmSync(scratch, { recursive: true })
    }
  }
  return undefined
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
      clocks.set(status.dev, undefined)
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
  if (probing === true) {
    scan() // Discover all covered devices/directories before writing any probes.
    for (const device of clocks.keys())
      clocks.set(device, probeClock({ device, repoRoot, inventoried: visited }))
  }
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
