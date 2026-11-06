import { join } from 'node:path'

import {
  inputExistsSync,
  inputReadFileSync,
  inputReaddirSync,
} from '../../packages/@overeng/genie/src/runtime/node/inputs.ts'
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

const reject = (path: string): never => {
  throw new Error(
    `Unsupported stage-zero Cargo input (${path}); the source filter of nix/buck2-stage0-tools.nix has to be extended first`,
  )
}
/** Reject Cargo inputs not yet represented by the stage-zero Nix source filter. */
export const assertStage0SourceInputs = ({
  members,
  root = '.',
}: {
  members: string[]
  root?: string
}) => {
  for (const config of ['rust/.cargo/config', 'rust/.cargo/config.toml'])
    if (inputExistsSync(join(root, config)) === true) reject(config)
  if (inputExistsSync(join(root, '.cargo')) === true)
    for (const name of inputReaddirSync(join(root, '.cargo')))
      if (name.startsWith('config') === true) reject(`.cargo/${name}`)
  for (const member of members) {
    const manifest = `rust/${member}/Cargo.toml`
    const pkg = object(object(Bun.TOML.parse(read(join(root, manifest)))).package)
    if (Object.hasOwn(pkg, 'build') === true) reject(`${manifest}: package.build`)
    const script = `rust/${member}/build.rs`
    if (inputExistsSync(join(root, script)) === true) reject(script)
  }
}

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
      assertStage0SourceInputs({ members: projection.members })
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
