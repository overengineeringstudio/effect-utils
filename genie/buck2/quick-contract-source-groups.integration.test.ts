import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { expect, it } from 'vitest'

import targetCatalog from '../../nix/quick-contracts-targets.json'
import { quickContractInputs } from './quick-contract-inputs.ts'
import {
  contractSourceGroup,
  contractSourceOwners,
  discoverContractPackages,
  renderContractSourceExclusions,
} from './quick-contract-source-groups.ts'

it('filters checkout source before frozen teardown commands can capture it', () => {
  const projection = readFileSync(new URL('../../nix/quick-contracts.nix', import.meta.url), 'utf8')
  expect(projection).toContain('root = lib.fileset.toSource {')
  expect(projection).toContain('fileset = lib.fileset.gitTracked ../.;')
  expect(projection).not.toContain('root = ../.;\n  cfg =')
  const retained = readFileSync(
    new URL('../../nix/devenv-modules/tasks/shared/tests/worktree-teardown.test.sh', import.meta.url),
    'utf8',
  )
  expect(retained).toContain('sourceRoot = pkgs.lib.fileset.toSource {')
  expect(retained).toContain('fileset = pkgs.lib.fileset.gitTracked $ROOT;')
  expect(retained).not.toContain('{ sourceRoot = $ROOT; }')
})

it('projects the retained provider audit into the same real configured native guards', () => {
  const source = (file: string): string =>
    readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
  const task = 'buck2:providers:check'
  const native = targetCatalog[task].native_providers
  expect(quickContractInputs.contracts[task]!.native_providers).toEqual(native)
  const legacy = source('devenv.nix').split(`tasks."${task}" = {`)[1]!.split('\n  };')[0]!
  expect(legacy).toContain('exec "$BUCK2_BIN" audit providers')
  expect(legacy).toContain('--target-platforms //buck2/platforms:host_platform')
  expect([...legacy.matchAll(/\/\/buck2\/toolchains:[a-z_]+/g)].map(([label]) => label)).toEqual(
    [native.toolchain, native.product],
  )
  const rule = source('buck2/quick_contracts.bzl')
  const declaration = rule.split('if native_providers != None:')[1]!.split('continue')[0]!
  expect(declaration).toContain('_provider_contract(')
  expect(declaration).toContain('toolchain = native_providers["toolchain"]')
  expect(declaration).toContain('product = native_providers["product"]')
  expect(declaration).toContain('default_target_platform = "//buck2/platforms:host_platform"')
  expect(declaration).not.toContain('runtime =')
  const implementation = rule
    .split('def _provider_contract_impl(ctx):')[1]!
    .split('def _quick_contracts_impl(ctx):')[0]!
  expect(implementation).toContain('attrs.toolchain_dep(providers = [ConfiguredRustToolchainInfo])')
  expect(implementation).toContain('attrs.dep(providers = [BuildProductInfo])')
  expect(implementation).toContain('"status": "passed"')
  const verdict = implementation.split('ctx.actions.write_json("passed.json", {')[1]!.split('})')[0]!
  expect([...verdict.matchAll(/"([^"]+)":/g)].map((match) => match[1]).sort()).toEqual([
    'status',
    'task',
  ])
  expect(implementation).toContain('other_outputs = predecessors')
  expect(implementation).not.toContain('ctx.actions.run(')
  expect(rule).toContain('inputs.extend(contract[DefaultInfo].other_outputs)')

  // The native contract resolves the originals, not replacement identity
  // providers or an alias bypassing the executable/product platform guard.
  const targets = source('buck2/toolchains/BUCK.template')
  expect(targets).toContain(
    `configured_rust_toolchain(\n    name = "${native.toolchain.split(':')[1]}"`,
  )
  expect(targets).toContain(
    `cross_cell_product_identity(\n    name = "${native.product.split(':')[1]}"`,
  )
  const fixture = source('buck2/toolchains/provider_identity_fixture.bzl')
  expect(fixture).toContain('ctx.attrs.target_platform[ProductPlatformInfo]')
  expect(fixture).toContain('target_platform = executable_target_platform')
  expect(fixture).toContain('build_product(')
  expect(fixture).toContain('artifact = ":" + executable')
  expect(fixture).toContain('target_platform = target_platform')
  const mismatch = targets.split('name = "cross_cell_product_mismatch",')[1]!.split('\n)')[0]!
  expect(mismatch).toContain('executable_target_platform = "//buck2/platforms:macos_aarch64"')
  expect(mismatch).toContain('target_platform = "//buck2/platforms:linux_x86_64"')
  expect(source('buck2/toolchains/defs.bzl')).toContain(
    'if ctx.attrs.target_triple != platform.rust_target_triple:\n        fail(',
  )
  expect(source('buck2/products/defs.bzl')).toContain(
    'if actual_platform != expected_platform:\n        fail("build_product executable platform',
  )
})

it('acquires the real Linux sandbox probe through outer declared Buck artifacts', () => {
  const source = (file: string): string =>
    readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
  const task = 'buck2:ts-sandbox:test'
  const probe = targetCatalog[task].native_ts_sandbox
  expect(probe).toBe('//buck2/tests/ts_sandbox:probe')
  expect(quickContractInputs.contracts[task]!.native_ts_sandbox).toBe(probe)
  const rule = source('buck2/quick_contracts.bzl')
  expect(rule).toContain('attrs.dep(providers = [TsSandboxProbeInfo])')
  expect(rule).toContain(
    'native_ts_sandbox = spec.get("native_ts_sandbox") if host_info().os.is_linux else None',
  )
  expect(rule).toContain('"QUICK_CONTRACT_NATIVE_INPUTS": "1"')
  expect(rule).toContain('"TS_SANDBOX_LAUNCHER": cmd_args(probe.launcher)')
  expect(rule).toContain('"TS_SANDBOX_PROBE_OUTPUT": cmd_args(probe.summary)')
  expect(rule).toContain('predecessors + native_inputs')
  for (const [binding, field] of [
    ['BWRAP_BIN', 'bubblewrap'],
    ['BUN_BIN', 'bun'],
    ['BASH_BIN', 'shell'],
  ])
    expect(rule).toContain(`"${binding}": probe.sandbox.${field}`)
  const native = source('buck2/tests/ts_sandbox/probe.bzl')
  expect(native).toContain('launcher = ts_action(')
  expect(native).toContain('cacheable = False,')
  expect(native).toContain(
    'TsSandboxProbeInfo(launcher = launcher, summary = summary, sandbox = sandbox)',
  )
  const retained = source('devenv.nix')
  const acquisition = retained
    .split('tsSandboxTestEnvironment =')[1]!
    .split('\n  \'\';')[0]!
  const [declared, ordinary] = acquisition.split('\n    else\n')
  expect(declared).toContain('QUICK_CONTRACT_NATIVE_INPUTS')
  expect(declared).toContain('TS_SANDBOX_LAUNCHER:?')
  expect(declared).toContain('TS_SANDBOX_PROBE_OUTPUT:?')
  expect(declared).not.toContain('"$BUCK2_BIN" build')
  expect(ordinary).toContain('"$BUCK2_BIN" build')
  expect(ordinary).toContain('--show-full-json-output effect_utils//buck2/tests/ts_sandbox:probe')
  const command = retained.split(`tasks."${task}" = {`)[1]!.split('\n  };')[0]!
  expect(command).toContain('src/bun-test-runner.ts" test')
  expect(command).toContain('src/ts-sandbox.integration.test.ts')
})

it('declares and projects per-contract CPU demands into honest local weights', () => {
  const source = (file: string): string =>
    readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
  const rule = source('buck2/quick_contracts.bzl')
  const demands = new Map<string, string>()
  for (const [name, inputs] of Object.entries(targetCatalog)) {
    if (inputs.native_providers !== undefined) {
      // The native provider verdict stays an analysis-only guard; no weight
      // declaration may smuggle an execution claim into it.
      expect(inputs.cpu_demand, `${name} must stay execution-free`).toBeUndefined()
      expect(quickContractInputs.contracts[name]!.cpu_demand).toBeUndefined()
      continue
    }
    expect(inputs.cpu_demand, `${name} must declare cpu_demand`).toMatch(
      /^(single-thread|bounded:[1-9][0-9]*|whole-pool)$/,
    )
    expect(quickContractInputs.contracts[name]!.cpu_demand).toBe(inputs.cpu_demand)
    demands.set(name, inputs.cpu_demand!)
  }
  // Host-wide tooling (live Buck daemons, watchers, pool-parallel generators,
  // unbound rustc) reserves the whole local pool instead of one slot each.
  expect([...demands.entries()].filter(([, demand]) => demand === 'whole-pool').map(([name]) => name).sort())
    .toEqual(
      [
        'buck2:cache-admission:check',
        'buck2:cache-posture:ci-test',
        'buck2:cache-posture:test',
        'buck2:capabilities:test',
        'cargo:proto-bindings:check',
        'genie:check',
        'lint:check:format:parity',
        'worktree:teardown:test',
      ].sort(),
    )
  // The validation action projects the declared demand onto ctx.actions.run.
  const contract = rule
    .split('def _contract_impl(ctx):')[1]!
    .split('def _provider_contract_impl(ctx):')[0]!
  expect(contract).toContain('**_cpu_weight_args(ctx.attrs.cpu_demand)')
  const projection = rule
    .split('def _cpu_weight_args(demand):')[1]!
    .split('def _contract_impl(ctx):')[0]!
  expect(projection).toContain('return {"weight": 1}')
  expect(projection).toContain('return {"weight": int(count)}')
  expect(projection).toContain('return {"weight_percentage": 100}')
  expect(rule).toContain('cpu_demand = spec.get("cpu_demand")')
  expect(rule).toContain('cpu_demand = cpu_demand,')
  // Threaded repo-wide scans reserve the full pool rather than claiming one slot.
  expect(source('buck2/static_checks.bzl')).toContain('weight_percentage = 100,')
  // tsgo actions bind the real Go thread setting to their declared budget.
  const typescript = source('buck2/typescript.bzl')
  expect(typescript).toContain('env = {"GOMAXPROCS": "2"},')
  expect(typescript).toContain('weight = 2,')
  expect(source('buck2/hermetic.bzl')).toContain(
    'bind_args.add("--setenv", name, cmd_args(env[name], quote = "shell"))',
  )
})

it('keeps live selectors stable across new files while discovering nested, hidden, and empty owners', () => {
  const temporary = path.resolve('tmp/quick-contract-source-groups')
  mkdirSync(temporary, { recursive: true })
  const root = mkdtempSync(path.join(temporary, 'case-'))
  const put = (file: string): void => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), '')
  }
  try {
    for (const file of [
      'BUCK',
      'src/BUCK.genie.ts',
      'src/nested/BUCK',
      'src/empty/BUCK',
      'src/.config/.nested/old.nix',
      'src/node_modules/ignored/BUCK',
      'src/target/ignored/BUCK',
      'src/.devenv/ignored/BUCK',
    ])
      put(file)
    const before = discoverContractPackages(root)
    expect(before.owners).toEqual(['.', 'src', 'src/empty', 'src/nested'])
    expect(before.directories).toContain('src/.config/.nested')
    expect(before.directories).not.toContain('src/node_modules')
    expect(before.directories).not.toContain('src/target')
    expect(before.directories).not.toContain('src/.devenv')
    const selection = {
      paths: ['src/missing.unit.test.ts'],
      prefixes: ['src/'],
      extensions: ['.ts', '.nix'],
    }
    const selected = contractSourceOwners(selection, before.owners, before.directories)
    expect(selected).toContain('src/empty')
    const source = contractSourceGroup({ selection, owner: 'src', ...before })
    const otherSelection = { paths: [], prefixes: ['other/'] }
    const unaffected = contractSourceGroup({ selection: otherSelection, owner: '.', ...before })
    put('src/new.nix')
    put('src/nested/new.nix')
    put('src/.config/.nested/new.nix')
    put('src/target/new.nix')
    const after = discoverContractPackages(root)
    expect(after).toEqual(before)
    expect(contractSourceGroup({ selection, owner: 'src', ...after })).toEqual(source)
    expect(source.include).toContain('**/*.nix')
    expect(source.include).not.toContain('missing.unit.test.ts')
    expect(contractSourceGroup({ selection: otherSelection, owner: '.', ...after })).toEqual(
      unaffected,
    )
    put('src/new-package/BUCK.genie.ts')
    expect(discoverContractPackages(root).owners).toContain('src/new-package')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

const nativeCommandDeadlineMs = 30_000
it(
  'evaluates compact exclusions with real Buck hidden-file and package-boundary semantics',
  () => {
    const native = process.env.BUCK2_NATIVE_BIN
    if (native === undefined)
      throw new Error('Run the owning genie:buck2:test with declared BUCK2_NATIVE_BIN')
    const temporary = path.resolve('tmp/quick-contract-source-groups')
    mkdirSync(temporary, { recursive: true })
    const root = realpathSync(mkdtempSync(path.join(temporary, 'native-')))
    const put = (file: string, content = ''): void => {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
      writeFileSync(path.join(root, file), content)
    }
    const run = (args: readonly string[]): string => {
      const result = spawnSync(
        native,
        ['--isolation-dir', 'quick-contract-glob-fixture', ...args],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: nativeCommandDeadlineMs,
          killSignal: 'SIGKILL',
        },
      )
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
      if (result.error !== undefined || result.status !== 0)
        throw new Error(`Native Buck ${args.join(' ')} failed (${result.status}): ${output}`, {
          cause: result.error,
        })
      return output.trim()
    }
    let primaryError: unknown
    try {
      put('.buckroot')
      put('.buckconfig', '[cells]\nroot = .\n')
      for (const file of [
        'BUCK',
        'visible.txt',
        '.root-hidden',
        '.github/one/.two/three/.leaf',
        '.github/one/.two/three/node_modules/.hidden/deep.txt',
        '.github/node_modules/pkg.txt',
        '.devenv/cache/.hidden/root.txt',
        '.BUCK.next.probe',
        'node_modules/pkg/file.txt',
        'child/BUCK',
        'child/.hidden',
        'child/child.txt',
      ])
        put(file)
      const discovered = discoverContractPackages(root)
      const selected = contractSourceGroup({
        selection: { paths: [], prefixes: [''] },
        owner: '.',
        ...discovered,
      })
      put(
        'BUCK',
        `_excludes = ${renderContractSourceExclusions(selected.exclusionAnchors)}
print("W9_COMPACT_GLOB=" + repr(glob(${JSON.stringify(selected.include)}, exclude = _excludes)))
`,
      )
      // A missing .buckroot silently queries the parent repository, not this fixture.
      expect(run(['root'])).toBe(root)
      const output = run(['targets', '//...'])
      const marker = 'W9_COMPACT_GLOB='
      const line = output.split('\n').find((value) => value.includes(marker))
      expect(line).toBeDefined()
      expect(JSON.parse(line!.slice(line!.indexOf(marker) + marker.length))).toEqual([
        '.buckconfig',
        '.buckroot',
        '.github/one/.two/three/.leaf',
        '.root-hidden',
        'BUCK',
        'visible.txt',
      ])
    } catch (error) {
      primaryError = error
      throw error
    } finally {
      try {
        run(['kill'])
        rmSync(root, { recursive: true, force: true })
      } catch (error) {
        // Preserve the owning fixture when teardown cannot prove daemon shutdown.
        if (primaryError !== undefined)
          throw new AggregateError(
            [primaryError, error],
            'Native glob fixture and teardown failed',
            {
              cause: error,
            },
          )
        throw error
      }
    }
  },
  3 * nativeCommandDeadlineMs + 10_000,
)
