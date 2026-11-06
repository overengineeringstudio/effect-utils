import { expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { cargoAuthority, refreshCommand } from './stage0-cargo-resolver.ts'
import { assertStage0SourceInputs, stage0CargoProjection } from './stage0-cargo.ts'
import { projectStage0Workspace, stage0Tools } from './stage0-workspace.ts'

const manifest = readFileSync('rust/Cargo.toml', 'utf8')
const lock = readFileSync('rust/Cargo.lock', 'utf8')
const readMember = (member: string) => readFileSync(`rust/${member}/Cargo.toml`, 'utf8')
it('commits exactly the statically validated Cargo projection', () => {
  expect(JSON.parse(readFileSync('nix/stage0-cargo/inventory.json', 'utf8')).tools).toEqual(
    stage0CargoProjection(),
  )
})
for (const tool of stage0Tools)
  it(`${tool}: ignores a disconnected member and lock record byte-for-byte`, () => {
    const seed = stage0CargoProjection()[tool]!
    const root = manifest.replace('members = [', 'members = [\n  "unrelated-new-crate",')
    const extra = '\n[[package]]\nname = "unrelated-new-crate"\nversion = "0.0.0"\n'
    const projection = { ...projectStage0Workspace({ manifest: root, tool }), lock: seed.lock }
    const { authority, ...expected } = seed
    expect(projection).toEqual(expected)
    expect(cargoAuthority({ projection, rootLock: lock + extra, readMember })).toBe(authority)
  })
it('fails loud on stale versions, checksums, or altered projected records', () => {
  const seed = stage0CargoProjection()['archive-tool']!
  const checksum = seed.lock.match(/^checksum = "[^"]+"/m)![0]
  for (const rootLock of [
    lock.replace(checksum, 'checksum = "changed"'),
    lock.replace(
      `name = "${seed.package}"\nversion = "0.0.0"`,
      `name = "${seed.package}"\nversion = "0.0.1"`,
    ),
  ]) {
    expect(() => cargoAuthority({ projection: seed, rootLock, readMember })).toThrow(refreshCommand)
  }
  expect(() =>
    cargoAuthority({
      projection: { ...seed, lock: seed.lock.replace(checksum, 'checksum = "changed"') },
      rootLock: lock,
      readMember,
    }),
  ).toThrow(refreshCommand)
  const changed = { ...seed, manifest: seed.manifest.replace('opt-level = 3', 'opt-level = 2') }
  expect(cargoAuthority({ projection: changed, rootLock: lock, readMember })).not.toBe(
    seed.authority,
  )
})

it('rejects unprojected build scripts, manifest build keys and Cargo configuration', () => {
  for (const [path, content] of [
    ['rust/tool/build.rs', 'fn main() {}'],
    ['rust/tool/Cargo.toml', '[package]\nname = "tool"\nbuild = "custom.rs"\n'],
    ['rust/tool/Cargo.toml', '[package]\nname = "tool"\nbuild = false\n'],
    ['rust/.cargo/config', ''],
    ['rust/.cargo/config.toml', ''],
    ['.cargo/config', ''],
    ['.cargo/config.toml', ''],
    ['.cargo/config.backup', ''],
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), 'stage0-source-guard-'))
    try {
      mkdirSync(join(root, 'rust/tool'), { recursive: true })
      writeFileSync(join(root, 'rust/tool/Cargo.toml'), '[package]\nname = "tool"\n')
      assertStage0SourceInputs({ members: ['tool'], root })
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), content)
      expect(() => assertStage0SourceInputs({ members: ['tool'], root })).toThrow(
        'the source filter of nix/buck2-stage0-tools.nix has to be extended first',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})
