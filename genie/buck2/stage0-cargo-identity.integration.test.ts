import { expect, it } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const genie = '/nix/store/015rck220f45nwg9v2xlxi1q71x8d86c-genie-buck2-candidate/bin/genie'
const run = ({
  args,
  cwd,
  env = process.env,
}: {
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
}) => {
  const result = Bun.spawnSync(args, { cwd, env })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout)
}

it('disconnected crates preserve stage-zero/product identities; reachable authority changes invalidate', () => {
  const repo = process.cwd()
  mkdirSync('tmp', { recursive: true })
  const fixture = resolve(mkdtempSync('tmp/stage0-identity-'))
  try {
    for (const file of run({ args: ['git', 'ls-files', '-z'], cwd: repo })
      .split('\0')
      .filter(Boolean)) {
      mkdirSync(dirname(`${fixture}/${file}`), { recursive: true })
      cpSync(`${repo}/${file}`, `${fixture}/${file}`)
    }
    const manifest = readFileSync(`${fixture}/rust/Cargo.toml`, 'utf8')
    const lock = readFileSync(`${fixture}/rust/Cargo.lock`, 'utf8')
    const generate = (refresh: boolean) =>
      run({
        args: [genie, '--cwd', 'nix/stage0-cargo', '--output', 'json'],
        cwd: fixture,
        env: {
          ...process.env,
          OTEL_SDK_DISABLED: 'true',
          STAGE0_CARGO_REFRESH: refresh === true ? '1' : '0',
        },
      })
    const paths = () =>
      JSON.parse(
        run({
          args: [
            'nix',
            'eval',
            '--impure',
            '--json',
            '--option',
            'allow-import-from-derivation',
            'false',
            '--expr',
            `
      let pinned = builtins.getFlake ${JSON.stringify(`git+file://${repo}?shallow=1`)};
          source = builtins.path { path = ${JSON.stringify(fixture)}; name = "source"; };
          outputs = (import (source + "/flake.nix")).outputs (pinned.inputs // {
            self.sourceInfo = { rev = "1111111111111111111111111111111111111111"; lastModified = 1; };
          });
          p = outputs.packages.x86_64-linux;
      in { archive = p.buck2-archive-tool.drvPath;
           genie = { drvPath = p.buck-product-genie-from-source.compileProduct.drvPath;
                     identity = p.buck-product-genie-from-source.recipeIdentity; };
           megarepo = { drvPath = p.buck-product-megarepo-from-source.compileProduct.drvPath;
                        identity = p.buck-product-megarepo-from-source.recipeIdentity; }; }
    `,
          ],
          cwd: repo,
        }),
      )
    const before = paths()
    mkdirSync(`${fixture}/rust/unrelated-new-crate/src`, { recursive: true })
    writeFileSync(
      `${fixture}/rust/unrelated-new-crate/Cargo.toml`,
      '[package]\nname = "unrelated-new-crate"\nversion = "0.0.0"\nedition = "2021"\n',
    )
    writeFileSync(`${fixture}/rust/unrelated-new-crate/src/lib.rs`, 'pub fn unrelated() {}\n')
    writeFileSync(
      `${fixture}/rust/Cargo.toml`,
      manifest.replace('members = [', 'members = [\n  "unrelated-new-crate",'),
    )
    writeFileSync(
      `${fixture}/rust/Cargo.lock`,
      lock + '\n[[package]]\nname = "unrelated-new-crate"\nversion = "0.0.0"\n',
    )
    generate(false)
    const unrelated = paths()
    expect(unrelated).toEqual(before)
    console.log(JSON.stringify({ control: 'new member and lock record', before, after: unrelated }))
    for (const control of ['profile', 'version']) {
      writeFileSync(
        `${fixture}/rust/Cargo.toml`,
        control === 'profile'
          ? manifest.replace('opt-level = 3', 'opt-level = 2')
          : manifest.replace('version = "0.0.0"', 'version = "0.0.1"'),
      )
      writeFileSync(
        `${fixture}/rust/Cargo.lock`,
        control === 'profile' ? lock : lock.replaceAll('version = "0.0.0"', 'version = "0.0.1"'),
      )
      generate(true)
      const changed = paths()
      expect(changed.archive).not.toBe(before.archive)
      for (const product of ['genie', 'megarepo']) {
        expect(changed[product].drvPath).not.toBe(before[product].drvPath)
        expect(changed[product].identity).not.toBe(before[product].identity)
      }
      console.log(JSON.stringify({ control, before, after: changed }))
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}, 180_000)
