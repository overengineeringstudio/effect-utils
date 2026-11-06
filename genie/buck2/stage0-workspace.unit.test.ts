import { expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

import { projectStage0Workspace, stage0Tools } from './stage0-workspace.ts'

const manifest = readFileSync('rust/Cargo.toml', 'utf8')
for (const tool of stage0Tools) {
  it(`${tool}: scopes members without changing shared workspace sections`, () => {
    const before = projectStage0Workspace({ manifest, tool })
    const changed = manifest.replace('members = [', 'members = [\n  "unrelated-new-crate",')
    expect(projectStage0Workspace({ manifest: changed, tool })).toEqual(before)
    expect(before.manifest.slice(before.manifest.indexOf('[workspace.package]'))).toBe(
      manifest.slice(manifest.indexOf('[workspace.package]')),
    )
    expect(before.members).toEqual(
      tool === 'archive-tool' || tool === 'product'
        ? [`buck2-tools/${tool}`, 'buck2-tools/core'].toSorted()
        : [`buck2-tools/${tool}`],
    )
    for (const suffix of ['[workspace.lints.rust]\nunsafe_code = "forbid"', '[patch.crates-io]']) {
      expect(projectStage0Workspace({ manifest: manifest + '\n' + suffix, tool }).manifest).toBe(
        before.manifest + '\n' + suffix,
      )
    }
  })
}
it('follows inherited, target-specific, build and dev path dependencies transitively', () => {
  const crates = new Map([
    [
      'buck2-tools/test',
      '[package]\nname="test"\n[dependencies]\na.workspace=true\n[target.cfg.dev-dependencies]\nb={path="../b"}\n',
    ],
    ['buck2-tools/a', '[package]\nname="a"\n[build-dependencies]\nb={path="../b"}\n'],
    ['buck2-tools/b', '[package]\nname="b"\n[dev-dependencies]\nc={path="../c"}\n'],
    ['buck2-tools/c', '[package]\nname="c"\n'],
  ])
  const root =
    '[workspace]\nmembers = [\n"buck2-tools/test",\n]\n[workspace.dependencies]\na={path="buck2-tools/a"}\n'
  const readManifest = (member: string) => {
    const value = crates.get(member)
    if (value === undefined) throw new Error(`Missing member ${member}`)
    return value
  }
  expect(projectStage0Workspace({ manifest: root, tool: 'test', readManifest }).members).toEqual([
    'buck2-tools/a',
    'buck2-tools/b',
    'buck2-tools/c',
    'buck2-tools/test',
  ])
  crates.delete('buck2-tools/c')
  expect(() => projectStage0Workspace({ manifest: root, tool: 'test', readManifest })).toThrow(
    'Missing member',
  )
})
