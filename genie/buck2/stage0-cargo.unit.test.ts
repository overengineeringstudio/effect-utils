import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

import { cargoAuthority, refreshCommand } from './stage0-cargo-resolver.ts'
import { projectStage0Cargo, stage0CargoProjection, stage0Tools } from './stage0-cargo.ts'

const manifest = readFileSync('rust/Cargo.toml', 'utf8')
const lock = readFileSync('rust/Cargo.lock', 'utf8')
const readMember = (member: string) => readFileSync(`rust/${member}/Cargo.toml`, 'utf8')

describe('stage-zero Cargo projection', () => {
  it('commits exactly the statically validated projection', () => {
    expect(JSON.parse(readFileSync('nix/stage0-cargo/inventory.json', 'utf8')).tools).toEqual(
      stage0CargoProjection(),
    )
  })
  for (const tool of stage0Tools) {
    it(`${tool}: ignores a disconnected member and lock record byte-for-byte`, () => {
      const seed = stage0CargoProjection()[tool]!
      const root = manifest.replace('members = [', 'members = [\n  "unrelated-new-crate",')
      const extra = '\n[[package]]\nname = "unrelated-new-crate"\nversion = "0.0.0"\n'
      const projected = { ...projectStage0Cargo(root, lock + extra, tool), lock: seed.lock }
      const { authority, ...expected } = seed
      expect(projected).toEqual(expected)
      expect(projected.manifest).toBe(seed.manifest)
      expect(cargoAuthority(projected, lock + extra, readMember)).toBe(authority)
    })
    it(`${tool}: preserves shared authority sections unchanged`, () => {
      const before = projectStage0Cargo(manifest, lock, tool)
      expect(before.manifest.slice(before.manifest.indexOf('[workspace.package]'))).toBe(
        manifest.slice(manifest.indexOf('[workspace.package]')),
      )
      for (const change of [
        manifest.replace('opt-level = 3', 'opt-level = 2'),
        manifest + '\n[workspace.lints.rust]\nunsafe_code = "forbid"\n',
        manifest + '\n[patch.crates-io]\n',
      ])
        expect(projectStage0Cargo(change, lock, tool).manifest).not.toBe(before.manifest)
    })
  }
  it('fails loud on stale versions, checksums, or altered projected records', () => {
    const seed = stage0CargoProjection()['archive-tool']!
    const checksum = seed.lock.match(/^checksum = "[^"]+"/m)![0]
    for (const changed of [
      lock.replace(checksum, 'checksum = "changed"'),
      lock.replace(
        `name = "${seed.package}"\nversion = "0.0.0"`,
        `name = "${seed.package}"\nversion = "0.0.1"`,
      ),
    ]) {
      expect(() => cargoAuthority(seed, changed, readMember)).toThrow(refreshCommand)
    }
    expect(() =>
      cargoAuthority(
        { ...seed, lock: seed.lock.replace(checksum, 'checksum = "changed"') },
        lock,
        readMember,
      ),
    ).toThrow(refreshCommand)
  })
})
