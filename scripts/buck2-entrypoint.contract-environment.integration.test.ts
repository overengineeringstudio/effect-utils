import { expect, it } from 'bun:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const commandDeadlineMs = 60_000
// One build RPC and teardown each own a bounded child, including daemon startup.
const caseDeadlineMs = 2 * commandDeadlineMs + 10_000

it(
  'resets the real quick contract profile inherited from its native daemon',
  async () => {
    const wrapper = process.env['BUCK2_BIN']
    assert(wrapper, 'BUCK2_BIN must declare the managed Buck wrapper')
    const managed = realpathSync(wrapper)
    assert(managed.startsWith('/nix/store/'), 'BUCK2_BIN must be Nix-pinned')
    const native = realpathSync(join(dirname(dirname(managed)), 'libexec', 'buck2'))
    const declaredBash = Bun.which('bash')
    assert(declaredBash, 'the declared task PATH must provide bash')
    const bash = realpathSync(declaredBash)
    assert(bash.startsWith('/nix/store/'), 'the fixture interpreter must be Nix-pinned')
    const repository = realpathSync(join(import.meta.dir, '..'))
    // Use the owning checkout's actual prepared cell, not synthetic capability data.
    const capabilities = realpathSync(join(repository, '.buck2', 'capabilities'))
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'buck2-contract-environment-')))
    const isolation = `contract-environment-${randomUUID()}`
    const env = { ...process.env, WORKTREE_CAPABILITIES_PROFILE: 'stale-daemon-profile' }
    const run = (args: string[]): Promise<string> => {
      const { promise, resolve, reject } = Promise.withResolvers<string>()
      const child = spawn(native, ['--isolation-dir', isolation, ...args], {
        cwd: root,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: commandDeadlineMs,
        killSignal: 'SIGKILL',
      })
      let stdout = ''
      let stderr = ''
      let failure: Error | undefined
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk)
      })
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk)
      })
      child.once('error', (error) => {
        failure = error
      })
      // close reaps the child and drains both pipes, including timeout/spawn errors.
      child.once('close', (code, signal) => {
        if (failure !== undefined) reject(failure)
        else if (code !== 0)
          reject(new Error(`Buck ${args.join(' ')} (${code ?? signal}): ${stderr}`))
        else resolve(stdout)
      })
      return promise
    }
    let daemonMayExist = false
    try {
      writeFileSync(join(root, '.buckroot'), '')
      // Cell paths must stay normalized inside this private root. Copy the actual
      // rules and link only the immutable/tool-only prepared capability cell,
      // matching the real TypeScript toolchain integration fixture.
      mkdirSync(join(root, 'effect_utils'), { recursive: true })
      cpSync(join(repository, 'buck2'), join(root, 'effect_utils', 'buck2'), {
        recursive: true,
        verbatimSymlinks: true,
      })
      mkdirSync(join(root, '.buck2'), { recursive: true })
      symlinkSync(capabilities, join(root, '.buck2', 'capabilities'), 'dir')
      writeFileSync(
        join(root, '.buckconfig'),
        `[cells]
fixture = .
effect_utils = effect_utils
capabilities = .buck2/capabilities
prelude = prelude
[cell_aliases]
rules = effect_utils
toolchains = effect_utils
config = prelude
ovr_config = prelude
fbsource = prelude
[external_cells]
prelude = bundled
[parser]
target_platform_detector_spec = target:fixture//...->effect_utils//buck2/platforms:host_platform
[build]
execution_platforms = effect_utils//buck2/platforms:host_execution_platform
[buck2]
file_watcher = fs_hash_crawler
remote_cache_enabled = false
allow_cache_uploads = false
`,
      )
      const executable = join(root, 'observe-profile.sh')
      writeFileSync(
        executable,
        `#!${bash}\nset -eu\nprintf '%s' "\${WORKTREE_CAPABILITIES_PROFILE-unset}" > "$1"\n`,
        { mode: 0o700 },
      )
      writeFileSync(join(root, 'manifest.json'), '{}\n')
      writeFileSync(
        join(root, 'fixture.bzl'),
        `load("@effect_utils//buck2/toolchains:configured.bzl", "BuckSupportToolInfo")

def _runtime_impl(ctx):
    return [
        DefaultInfo(other_outputs = [ctx.attrs.executable, ctx.attrs.manifest]),
        BuckSupportToolInfo(
            content_digest = "fixture",
            closure_identity = "fixture",
            closure_store_paths = [],
            execution_platform = "fixture",
            executable = ctx.attrs.executable,
            manifest = ctx.attrs.manifest,
            protocol = "effect-utils/quick-contract-task/v1",
            runtime_contract = "native-executable/v1",
            store_path = ctx.attrs.store_path,
            tool_id = "observe-profile",
        ),
    ]

fixture_runtime = rule(impl = _runtime_impl, attrs = {
    "executable": attrs.source(),
    "manifest": attrs.source(),
    "store_path": attrs.string(),
})

def _control_impl(ctx):
    tool = ctx.attrs.runtime[BuckSupportToolInfo]
    output = ctx.actions.declare_output("profile.txt")
    # Deliberately omit env: the control must demonstrate daemon inheritance.
    ctx.actions.run(
        cmd_args([tool.store_path, output.as_output()], hidden = [tool.executable, tool.manifest]),
        local_only = True,
        allow_cache_upload = False,
        category = "contract_environment_control",
    )
    return [DefaultInfo(default_output = output)]

profile_control = rule(impl = _control_impl, attrs = {
    "runtime": attrs.exec_dep(providers = [BuckSupportToolInfo]),
})
`,
      )
      writeFileSync(
        join(root, 'BUCK'),
        `load("@effect_utils//buck2:quick_contracts.bzl", "quick_contract")
load("@effect_utils//buck2/platforms:defs.bzl", "host_execution_constraints")
load(":fixture.bzl", "fixture_runtime", "profile_control")

fixture_runtime(
    name = "runtime",
    executable = "observe-profile.sh",
    manifest = "manifest.json",
    store_path = ${JSON.stringify(executable)},
)
profile_control(name = "control", runtime = ":runtime", exec_compatible_with = host_execution_constraints())
quick_contract(
    name = "contract",
    task = "fixture:environment",
    runtime = ":runtime",
    source_sets = [],
    membership = [],
    membership_mode = "tracked",
    membership_digest = "",
    requires = [],
    cache_policy = "local-fixture",
    agent_actor = "",
    policy_path = "",
    exec_compatible_with = host_execution_constraints(),
)
`,
      )
      daemonMayExist = true
      // Both targets run in one native build/RPC on this fresh owned daemon.
      const outputs: unknown = JSON.parse(
        await run([
          'build',
          '--local-only',
          '--show-full-json-output',
          '//:control',
          '//:contract',
        ]),
      )
      assert(outputs !== null && typeof outputs === 'object')
      const outputFor = (name: string) => {
        const matches = Object.entries(outputs).filter(([label]) => label === `fixture//:${name}`)
        assert(matches.length === 1, `expected exactly one output for ${name}`)
        const path: unknown = matches[0]![1]
        assert(typeof path === 'string', 'expected --show-full-json-output path')
        return readFileSync(path, 'utf8')
      }
      expect(outputFor('control')).toBe('stale-daemon-profile')
      expect(outputFor('contract')).toBe('')
    } finally {
      // Only the owned root/isolation is stopped. Never remove a live daemon root;
      // a teardown failure retains it and fails the case rather than leaking silently.
      if (daemonMayExist === true) await run(['kill'])
      rmSync(root, { recursive: true, force: true })
    }
  },
  caseDeadlineMs,
)
