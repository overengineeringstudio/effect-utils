#!/usr/bin/env bash
# Shared task templates must be executable with the manifest-backed product,
# not merely with the CLI sources at the consumer's checkout.
set -euo pipefail

root="${1:-$(cd "$(dirname "$0")/../../../../.." && pwd -P)}"
export MR_PRODUCT_CONTRACT_ROOT="$root"
# Realize the cache importer only: do not build the current source CLI, which
# would conceal the very product/source skew this gate protects against.
product="$(nix build "git+file://$root?shallow=1#megarepo" --no-link --print-out-paths)"
export MR_PRODUCT_CONTRACT_BINARY="$product/bin/mr"
export MR_PRODUCT_CONTRACT_SCRIPTS="$(nix eval --impure --json --expr '
  let
    root = builtins.toPath (builtins.getEnv "MR_PRODUCT_CONTRACT_ROOT");
    flake = builtins.getFlake ("git+file://" + toString root + "?shallow=1");
    pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    module = (import (root + /nix/devenv-modules/tasks/shared/megarepo.nix) {
      syncAll = true;
      bootstrapMembers = [ "contract-fixture" ];
      setupCommitMembers = [ "contract-fixture" ];
    }) { inherit pkgs; lib = pkgs.lib; };
  in pkgs.lib.mapAttrs (_: task: {
    inherit (task) exec status;
  }) module.tasks
')"

node <<'NODE'
const { spawnSync } = require('node:child_process')
const tasks = JSON.parse(process.env.MR_PRODUCT_CONTRACT_SCRIPTS)
const requirements = new Map()
for (const [task, scripts] of Object.entries(tasks)) {
  for (const [phase, text] of Object.entries(scripts)) {
    // Nix evaluation resolves optional strings and helper interpolation. Both
    // shell branches (CI/local) remain visible; comments are not invocations.
    const script = text.replace(/^\s*#.*$/gm, '')
    const arrays = new Map()
    for (const match of script.matchAll(/\b(MR_[A-Z_]+)\+?=\(([^)\n]*)\)/g)) {
      const flags = [...match[2].matchAll(/--[a-z][a-z0-9-]*/g)].map((m) => m[0])
      arrays.set(match[1], [...(arrays.get(match[1]) ?? []), ...flags])
    }
    for (const invocation of script.matchAll(/\bmr\s+([a-z][a-z-]*)([^\n|]*)/g)) {
      const [, command, args] = invocation
      const flags = new Set([...args.matchAll(/--[a-z][a-z0-9-]*/g)].map((m) => m[0]))
      for (const variable of args.matchAll(/\$\{?(MR_[A-Z_]+)/g)) {
        if (!arrays.has(variable[1])) {
          throw new Error(`${task}.${phase}: unresolved mr argument array ${variable[1]}`)
        }
        for (const flag of arrays.get(variable[1])) flags.add(flag)
      }
      const required = requirements.get(command) ?? new Map()
      for (const flag of flags) required.set(flag, `${task}.${phase}`)
      requirements.set(command, required)
    }
  }
}
if (!requirements.has('apply') || !requirements.get('apply').has('--commit-all-members')) {
  throw new Error('Task extraction did not cover CI nested mr:setup')
}
let failed = false
for (const [command, flags] of requirements) {
  const result = spawnSync(process.env.MR_PRODUCT_CONTRACT_BINARY, [command, '--help'], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  })
  if (result.error || result.status !== 0) {
    throw new Error(`Published mr ${command} --help failed: ${result.error ?? result.stderr}`)
  }
  const available = new Set([...(result.stdout + result.stderr).matchAll(/--[a-z][a-z0-9-]*/g)].map((m) => m[0]))
  for (const [flag, location] of flags) {
    if (!available.has(flag)) {
      console.error(`${location}: manifest-backed mr ${command} lacks ${flag}`)
      failed = true
    }
  }
}
if (failed) process.exit(1)
console.log('megarepo product flags: every emitted task flag is supported by the published CLI')
NODE
