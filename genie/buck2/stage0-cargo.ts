import { posix } from 'node:path'
import { inputReadFileSync } from '../../packages/@overeng/genie/src/runtime/node/inputs.ts'
import { cargoAuthority, refreshCommand, resolveCargoLock } from './stage0-cargo-resolver.ts'

export interface CargoProjection {
  package: string
  workspaceMember: string
  members: string[]
  manifest: string
  lock: string
}

export const stage0Tools = ['archive-tool', 'events', 'fingerprint', 'product'] as const
const object = (value: unknown): Record<string, unknown> => {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected Cargo table')
  return value as Record<string, unknown> // Established object boundary; fields remain unknown.
}
const text = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('Expected Cargo string')
  return value
}
const parse = (value: string) => object(Bun.TOML.parse(value))
const read = (path: string) => inputReadFileSync(path, 'utf8')

/** Preserve authority bytes; only membership and unreachable lock records change. */
export const projectStage0Cargo = (manifest: string, lock: string, tool: string,
  readManifest: (member: string) => string = (member) => read(`rust/${member}/Cargo.toml`)): CargoProjection => {
  const workspace = object(parse(manifest).workspace)
  const members = new Set<string>()
  const packageName = (member: string) => text(object(parse(readManifest(member)).package).name)
  const visit = (member: string) => {
    if (members.has(member)) return
    members.add(member)
    const crate = parse(readManifest(member))
    const tables = [crate, ...Object.values(object(crate.target)).map(object)]
    for (const target of tables) for (const kind of ['dependencies', 'dev-dependencies', 'build-dependencies']) {
      for (const [name, request] of Object.entries(object(target[kind]))) {
        if (typeof request === 'string') continue
        const inherited = object(request).workspace === true
        const dependency = inherited ? object(workspace.dependencies)[name] : request
        if (typeof dependency === 'string') continue
        const path = object(dependency).path
        if (path !== undefined) visit(posix.normalize(posix.join(inherited ? '.' : member, text(path))))
      }
    }
  }
  const workspaceMember = `buck2-tools/${tool}`
  visit(workspaceMember)
  const ordered = [...members].toSorted()
  const narrowed = manifest.replace(/^members = \[[\s\S]*?^\]/m,
    `members = ${JSON.stringify(ordered)}`)
  if (narrowed === manifest) throw new Error('Missing workspace members declaration')
  return { package: packageName(workspaceMember), workspaceMember,
    members: ordered, manifest: narrowed, lock }
}

export const stage0CargoProjection = () => {
  const refresh = process.env.STAGE0_CARGO_REFRESH === '1'
  const previous = refresh ? {} : object(JSON.parse(read('nix/stage0-cargo/inventory.json'))).tools
  const rootLock = read('rust/Cargo.lock')
  const readMember = (member: string) => read(`rust/${member}/Cargo.toml`)
  return Object.fromEntries(stage0Tools.map((tool) => {
    const projection = projectStage0Cargo(read('rust/Cargo.toml'), rootLock, tool, readMember)
    const seed = object(object(previous)[tool])
    projection.lock = refresh ? resolveCargoLock(projection) : text(seed.lock)
    const authority = cargoAuthority(projection, rootLock, readMember)
    if (!refresh && authority !== seed.authority) {
      throw new Error(`Stale stage-zero Cargo projection (${tool}); refresh: ${refreshCommand}`)
    }
    return [tool, { ...projection, authority }]
  }))
}
