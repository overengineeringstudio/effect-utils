import { inputReadFileSync } from '../../packages/@overeng/genie/src/runtime/node/inputs.ts'
import { cargoAuthority, refreshCommand, resolveCargoLock } from './stage0-cargo-resolver.ts'
import { projectStage0Workspace, stage0Tools, type Stage0Workspace } from './stage0-workspace.ts'

export interface CargoProjection extends Stage0Workspace {
  lock: string
}
const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value) === true)
    throw new Error(`Missing stage-zero Cargo seed; refresh: ${refreshCommand}`)
  return value as Record<string, unknown> // Object boundary established; fields remain unknown.
}
const text = (value: unknown): string => {
  if (typeof value !== 'string')
    throw new Error(`Missing stage-zero Cargo seed; refresh: ${refreshCommand}`)
  return value
}
const read = (path: string) => inputReadFileSync(path, 'utf8')

export const stage0CargoProjection = () => {
  const refresh = process.env.STAGE0_CARGO_REFRESH === '1'
  const previous =
    refresh === true ? {} : object(JSON.parse(read('nix/stage0-cargo/inventory.json'))).tools
  const rootLock = read('rust/Cargo.lock')
  const readMember = (member: string) => read(`rust/${member}/Cargo.toml`)
  return Object.fromEntries(
    stage0Tools.map((tool) => {
      const projection = {
        ...projectStage0Workspace({
          manifest: read('rust/Cargo.toml'),
          tool,
          readManifest: readMember,
        }),
        lock: rootLock,
      }
      const seed = refresh === true ? {} : object(object(previous)[tool])
      projection.lock = refresh === true ? resolveCargoLock(projection) : text(seed.lock)
      const authority = cargoAuthority({ projection, rootLock, readMember })
      if (refresh === false && authority !== seed.authority) {
        throw new Error(`Stale stage-zero Cargo projection (${tool}); refresh: ${refreshCommand}`)
      }
      return [tool, { ...projection, authority }]
    }),
  )
}
