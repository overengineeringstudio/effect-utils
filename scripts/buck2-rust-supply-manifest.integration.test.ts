import { afterEach, describe, expect, it } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const temporaryRoots: string[] = []
const cargo = process.env.CARGO_BIN ?? 'cargo'

const makeFixture = ({ escapes = false }: { readonly escapes?: boolean } = {}) => {
  const temporaryRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'buck2-rust-supply-')))
  temporaryRoots.push(temporaryRoot)
  const root = path.join(temporaryRoot, 'repository')
  const workspace = path.join(root, 'consumer')
  const provider = escapes
    ? path.join(temporaryRoot, 'outside')
    : path.join(root, '.staged/provider')
  const cargoHome = path.join(temporaryRoot, 'cargo-home')
  const supplyDir = path.join(temporaryRoot, 'supply')
  for (const dir of [workspace, provider, cargoHome, supplyDir, path.join(root, 'repos')]) {
    mkdirSync(dir, { recursive: true })
  }
  for (const dir of [workspace, provider]) {
    mkdirSync(path.join(dir, 'src'))
    writeFileSync(path.join(dir, 'src/lib.rs'), '')
  }
  writeFileSync(
    path.join(workspace, 'Cargo.toml'),
    '[package]\nname = "consumer"\nversion = "0.1.0"\nedition = "2021"\n\n[workspace]\n\n[dependencies]\nprovider = { path = "../repos/provider" }\n',
  )
  writeFileSync(
    path.join(provider, 'Cargo.toml'),
    '[package]\nname = "provider"\nversion = "0.1.0"\nedition = "2021"\n\n[workspace]\n',
  )
  symlinkSync(provider, path.join(root, 'repos/provider'), 'dir')
  const declarationPath = path.join(workspace, 'foreign-packages.json')
  writeFileSync(
    declarationPath,
    JSON.stringify({ foreignPackageManifestPaths: ['repos/provider/Cargo.toml'] }),
  )
  const env = {
    ...process.env,
    CARGO_HOME: cargoHome,
    RUSTC_WRAPPER: '',
    CARGO_BUILD_RUSTC_WRAPPER: '',
  }
  const lock = Bun.spawnSync({
    cmd: [cargo, 'generate-lockfile', '--offline'],
    cwd: workspace,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (lock.exitCode !== 0) throw new Error(lock.stderr.toString())
  const run = () =>
    Bun.spawnSync({
      cmd: [
        process.execPath,
        path.join(import.meta.dir, 'buck2-rust-supply-manifest.ts'),
        root,
        workspace,
        cargo,
        cargoHome,
        supplyDir,
      ],
      cwd: workspace,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
  return { root, workspace, supplyDir, declarationPath, run }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('foreign Cargo package paths', () => {
  it('projects a symlinked external package without including it in supply or changing the authoritative lock', () => {
    const fixture = makeFixture()
    const lockBefore = readFileSync(path.join(fixture.workspace, 'Cargo.lock'), 'utf8')
    const result = fixture.run()
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    const supply = Bun.TOML.parse(readFileSync(path.join(fixture.supplyDir, 'Cargo.toml'), 'utf8'))
    expect(supply.dependencies).toEqual({})
    const lock = Bun.TOML.parse(readFileSync(path.join(fixture.supplyDir, 'Cargo.lock'), 'utf8'))
    expect(lock.package).toEqual([{ name: 'buck2-foreign-supply', version: '0.0.0' }])
    expect(readFileSync(path.join(fixture.workspace, 'Cargo.lock'), 'utf8')).toBe(lockBefore)
  })

  it('rejects a foreign package symlink that escapes the repository', () => {
    const fixture = makeFixture({ escapes: true })
    const result = fixture.run()
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain(
      'foreign package manifest escapes repository: repos/provider/Cargo.toml',
    )
  })

  it('rejects a declared package absent from the external path dependency graph', () => {
    const fixture = makeFixture()
    mkdirSync(path.join(fixture.root, 'other/src'), { recursive: true })
    writeFileSync(
      path.join(fixture.root, 'other/Cargo.toml'),
      '[package]\nname = "other"\nversion = "0.1.0"\nedition = "2021"\n',
    )
    writeFileSync(path.join(fixture.root, 'other/src/lib.rs'), '')
    writeFileSync(
      fixture.declarationPath,
      JSON.stringify({ foreignPackageManifestPaths: ['other/Cargo.toml'] }),
    )
    const result = fixture.run()
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain(
      'foreign package is absent from the external path dependency graph: other/Cargo.toml',
    )
  })
})
