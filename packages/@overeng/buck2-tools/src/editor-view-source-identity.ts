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
type Device = { device: string; rootClass: string; probed: boolean; pathPrefix: string }
/** Filesystem-clock receipt retained through the fenced recheck. */
export type EditorViewSourceIdentity = {
  readonly digest: string
  readonly clocks: Clocks
  readonly rehashedFiles: number
  readonly hashedBytes: number
  readonly devices: ReadonlyMap<string, Device>
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
  const canonicalRepo = realpathThroughName(repoRoot)
  const canonicalTmp = realpathThroughName(tmpdir())
  const hash = createHash('sha256')
  const clocks =
    priorClocks === undefined ? new Map<bigint, bigint | undefined>() : new Map(priorClocks)
  const visited = new Set<string>()
  let rehashedFiles = 0
  let hashedBytes = 0
  const devices = new Map<string, Device>()
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
      const rootClass =
        path.startsWith('/nix/store/') === true
          ? 'nix-store'
          : path === canonicalRepo || path.startsWith(`${canonicalRepo}/`) === true
            ? 'repo'
            : path === canonicalTmp || path.startsWith(`${canonicalTmp}/`) === true
              ? 'tmp'
              : 'other'
      if (devices.has(`${dev}:${rootClass}`) === false)
        devices.set(`${dev}:${rootClass}`, {
          device: String(dev),
          rootClass,
          pathPrefix:
            ['/nix/store', '/home/runner/work', '/tmp', '/private/tmp'].find(
              (prefix) => path === prefix || path.startsWith(`${prefix}/`),
            ) ?? 'other',
          probed: clock !== undefined,
        })
      // Racy-git: at/after the same-device prehash probe, or unprobed, requires bytes.
      if (
        status.isFile() === true &&
        (clock === undefined || status.ctimeNs >= clock || status.mtimeNs >= clock)
      ) {
        const bytes = readFileSync(path)
        hashedBytes += bytes.byteLength
        hash.update(createHash('sha256').update(bytes).digest('hex'))
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
  return { digest: hash.digest('hex'), clocks, rehashedFiles, hashedBytes, devices }
}

/** The same fail-closed comparison used after acquiring the publication fence. */
export const editorViewSourceIdentityMatches = ({
  options,
  identity,
  onChecked,
}: {
  readonly options: SourceRoots
  readonly identity: EditorViewSourceIdentity
  readonly onChecked?: (checked: EditorViewSourceIdentity) => void
}): boolean => {
  const checked = editorViewSourceIdentity({ options, priorClocks: identity.clocks })
  onChecked?.(checked)
  return checked.digest === identity.digest
}

/** Existing timing wire format; admissionId deduplicates replayed stderr without merging real work. */
export const editorViewAdmissionTiming = (input: {
  package: string
  admissionId: string
  durationMs: number
  prehash: readonly EditorViewSourceIdentity[]
  fenced: readonly EditorViewSourceIdentity[]
  fenceMismatches: number
  proofRebuilds: number
  innerLockWaitMs: number
}): string => {
  const { prehash, fenced, ...fields } = input
  const checks = [...prehash, ...fenced]
  const devices = new Map(checks.flatMap((check) => [...check.devices]))
  return `[editor-view-timing] ${JSON.stringify({
    phase: 'editor-view',
    packagePath: input.package,
    ...fields,
    prehashRehashedFiles: prehash.reduce((sum, check) => sum + check.rehashedFiles, 0),
    fencedRehashedFiles: fenced.reduce((sum, check) => sum + check.rehashedFiles, 0),
    hashedBytes: checks.reduce((sum, check) => sum + check.hashedBytes, 0),
    probedDevices: [...devices.values()].filter((device) => device.probed === true),
    unprobedDevices: [...devices.values()].filter((device) => device.probed === false),
    outerFlockWaitMs: null,
  })}\n`
}
