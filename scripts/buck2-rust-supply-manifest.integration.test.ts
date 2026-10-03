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

const makeVersionFixture = ({
  virtual,
  renamed,
}: {
  readonly virtual: boolean
  readonly renamed: boolean
}) => {
  const temporaryRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'buck2-rust-versions-')))
  temporaryRoots.push(temporaryRoot)
  const workspace = path.join(temporaryRoot, 'consumer')
  const provider = path.join(temporaryRoot, '.staged/provider')
  const cargoHome = path.join(temporaryRoot, 'cargo-home')
  const supplyDir = path.join(temporaryRoot, 'supply')
  const member = virtual === true ? path.join(workspace, 'member') : workspace
  const vendor = path.join(temporaryRoot, 'vendor')
  for (const dir of [member, provider, cargoHome, supplyDir, path.join(workspace, '.cargo')]) {
    mkdirSync(dir, { recursive: true })
  }
  symlinkSync(provider, path.join(temporaryRoot, 'provider'), 'dir')
  // A real offline directory source replaces crates.io: Cargo itself resolves
  // semver and features, with no network or dependence on the machine's cache.
  for (const [version, feature] of [
    ['0.28.0', 'old-api'],
    ['0.29.0', 'new-api'],
  ]) {
    const crate = path.join(vendor, `nix-${version}`)
    mkdirSync(path.join(crate, 'src'), { recursive: true })
    writeFileSync(
      path.join(crate, 'Cargo.toml'),
      `[package]\nname = "nix"\nversion = "${version}"\nedition = "2021"\n\n[features]\ndefault = []\n${feature} = []\n`,
    )
    writeFileSync(path.join(crate, 'src/lib.rs'), 'pub struct ResolvedVersion;\n')
    writeFileSync(
      path.join(crate, '.cargo-checksum.json'),
      JSON.stringify({ files: {}, package: '0'.repeat(64) }),
    )
  }
  // A library whose target name differs from its package name: Cargo's resolve
  // node names the edge `md5`, not `md_5`.
  const md5 = path.join(vendor, 'md-5-0.10.0')
  mkdirSync(path.join(md5, 'src'), { recursive: true })
  writeFileSync(
    path.join(md5, 'Cargo.toml'),
    '[package]\nname = "md-5"\nversion = "0.10.0"\nedition = "2021"\n\n[lib]\nname = "md5"\n',
  )
  writeFileSync(path.join(md5, 'src/lib.rs'), 'pub struct Digest;\n')
  writeFileSync(
    path.join(md5, '.cargo-checksum.json'),
    JSON.stringify({ files: {}, package: '0'.repeat(64) }),
  )
  writeFileSync(
    path.join(workspace, '.cargo/config.toml'),
    `[source.crates-io]\nreplace-with = "fixture"\n\n[source.fixture]\ndirectory = ${JSON.stringify(vendor)}\n`,
  )
  for (const dir of [member, provider]) {
    mkdirSync(path.join(dir, 'src'))
    writeFileSync(path.join(dir, 'src/lib.rs'), '')
  }
  const key = renamed === true ? 'current-nix' : 'nix'
  writeFileSync(
    path.join(member, 'Cargo.toml'),
    `[package]\nname = "consumer"\nversion = "0.1.0"\nedition = "2021"\n\n${virtual === true ? '' : '[workspace]\nresolver = "2"\n\n'}[dependencies]\nprovider = { path = "${virtual === true ? '../../provider' : '../provider'}" }\n${key} = { ${renamed === true ? 'package = "nix", ' : ''}version = "0.29", default-features = false, features = ["new-api"] }\n\n[build-dependencies]\n${key} = { ${renamed === true ? 'package = "nix", ' : ''}version = "0.28", default-features = false, features = ["old-api"] }\n\n[target.'cfg(unix)'.dev-dependencies]\n${key} = { ${renamed === true ? 'package = "nix", ' : ''}version = "0.29", default-features = false, features = ["new-api"] }\n`,
  )
  writeFileSync(path.join(member, 'build.rs'), 'fn main() {}\n')
  if (virtual === true) {
    writeFileSync(
      path.join(workspace, 'Cargo.toml'),
      '[workspace]\nmembers = ["member"]\nresolver = "2"\n',
    )
  }
  writeFileSync(
    path.join(provider, 'Cargo.toml'),
    '[package]\nname = "provider"\nversion = "0.1.0"\nedition = "2021"\n\n[workspace]\n\n[dependencies]\nmd-5 = "0.10"\nnix = { version = "0.28", default-features = false, features = ["old-api"] }\n\n[build-dependencies]\nnew-nix = { package = "nix", version = "0.29", default-features = false, features = ["new-api"] }\n',
  )
  writeFileSync(path.join(provider, 'build.rs'), 'fn main() {}\n')
  writeFileSync(
    path.join(workspace, 'foreign-packages.json'),
    JSON.stringify({ foreignPackageManifestPaths: ['provider/Cargo.toml'] }),
  )
  const env = { ...process.env, CARGO_HOME: cargoHome, RUSTC_WRAPPER: '' }
  const lock = Bun.spawnSync({
    cmd: [cargo, 'generate-lockfile', '--offline'],
    cwd: workspace,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (lock.exitCode !== 0) throw new Error(lock.stderr.toString())
  const run = (script = path.join(import.meta.dir, 'buck2-rust-supply-manifest.ts')) =>
    Bun.spawnSync({
      cmd: [process.execPath, script, temporaryRoot, workspace, cargo, cargoHome, supplyDir],
      cwd: workspace,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
  return { workspace, supplyDir, key, run }
}
const makeFixture = ({ escapes = false }: { readonly escapes?: boolean } = {}) => {
  const temporaryRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'buck2-rust-supply-')))
  temporaryRoots.push(temporaryRoot)
  const root = path.join(temporaryRoot, 'repository')
  const workspace = path.join(root, 'consumer')
  const provider =
    escapes === true ? path.join(temporaryRoot, 'outside') : path.join(root, '.staged/provider')
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
  }, 30_000)

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

describe('Cargo-resolved supply aliases', () => {
  for (const virtual of [false, true]) {
    for (const renamed of [false, true]) {
      it(`keeps the newer ${renamed === true ? 'renamed' : 'canonical'} consumer edge in a ${virtual === true ? 'virtual' : 'root-package'} workspace`, () => {
        const fixture = makeVersionFixture({ virtual, renamed })
        const lockBefore = readFileSync(path.join(fixture.workspace, 'Cargo.lock'), 'utf8')
        const result = fixture.run()
        expect(result.exitCode, result.stderr.toString()).toBe(0)
        const supply = Bun.TOML.parse(
          readFileSync(path.join(fixture.supplyDir, 'Cargo.toml'), 'utf8'),
        )
        expect(supply.dependencies[fixture.key]).toEqual({
          ...(renamed === true ? { package: 'nix' } : {}),
          version: '=0.29.0',
          'default-features': false,
          features: ['new-api'],
        })
        const oldAlias = 'buck2-supply-nix-0-28-0'
        expect(supply.dependencies[oldAlias]).toEqual({
          package: 'nix',
          version: '=0.28.0',
          'default-features': false,
          features: ['old-api'],
        })
        const resolution = JSON.parse(
          readFileSync(path.join(fixture.supplyDir, 'cargo-buck2-resolution.json'), 'utf8'),
        )
        expect(resolution.dependencies).toEqual([
          {
            manifestPath: virtual === true ? 'consumer/member/Cargo.toml' : 'consumer/Cargo.toml',
            name: fixture.key,
            package: 'nix',
            version: '0.28.0',
            kind: 'build',
            alias: oldAlias,
          },
          {
            manifestPath: virtual === true ? 'consumer/member/Cargo.toml' : 'consumer/Cargo.toml',
            name: fixture.key,
            package: 'nix',
            version: '0.29.0',
            kind: 'dev',
            target: 'cfg(unix)',
            alias: fixture.key,
          },
          {
            manifestPath: virtual === true ? 'consumer/member/Cargo.toml' : 'consumer/Cargo.toml',
            name: fixture.key,
            package: 'nix',
            version: '0.29.0',
            kind: 'normal',
            alias: fixture.key,
          },
          {
            manifestPath: 'provider/Cargo.toml',
            name: 'md-5',
            package: 'md-5',
            version: '0.10.0',
            kind: 'normal',
            alias: 'md-5',
          },
          {
            manifestPath: 'provider/Cargo.toml',
            name: 'new-nix',
            package: 'nix',
            version: '0.29.0',
            kind: 'build',
            alias: fixture.key,
          },
          {
            manifestPath: 'provider/Cargo.toml',
            name: 'nix',
            package: 'nix',
            version: '0.28.0',
            kind: 'normal',
            alias: oldAlias,
          },
        ])
        expect(readFileSync(path.join(fixture.workspace, 'Cargo.lock'), 'utf8')).toBe(lockBefore)
      }, 30_000)
    }
  }
})
