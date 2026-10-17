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
MR_PRODUCT_CONTRACT_SCRIPTS="$(nix eval --impure --json --expr '
  let
    root = builtins.toPath (builtins.getEnv "MR_PRODUCT_CONTRACT_ROOT");
    flake = builtins.getFlake ("git+file://" + toString root + "?shallow=1");
    pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    module = (import (root + "/nix/devenv-modules/tasks/shared/megarepo.nix") {
      syncAll = true;
      bootstrapMembers = [ "contract-fixture" ];
      setupCommitMembers = [ "contract-fixture" ];
    }) { inherit pkgs; lib = pkgs.lib; };
  in pkgs.lib.mapAttrs (_: task:
    pkgs.lib.filterAttrs (name: _: builtins.elem name [ "exec" "status" ]) task
  ) (pkgs.lib.filterAttrs (name: _: pkgs.lib.hasPrefix "mr:" name) module.tasks)
')"
export MR_PRODUCT_CONTRACT_SCRIPTS

node <<'NODE'
const { spawnSync } = require('node:child_process')
const tasks = JSON.parse(process.env.MR_PRODUCT_CONTRACT_SCRIPTS)
function extractRequirements(tasks) {
const requirements = new Map()
for (const [task, scripts] of Object.entries(tasks)) {
  for (const [phase, text] of Object.entries(scripts)) {
    // Nix evaluation resolves optional strings and helper interpolation. Both
    // shell branches (CI/local) remain visible; comments are not invocations.
    const script = text.replace(/^\s*#.*$/gm, '')
    const arrays = new Map()
    // A publication bridge may emit a flag only when this same command's help
    // advertises it. Recognize the complete probe/guard/assignment shape, not
    // arbitrary conditionals or an allowlist of unsupported product flags.
    const gatedArrays = new Map()
    const capabilityGuard = /([a-z_][a-z0-9_]*)="\$\(mr ([a-z][a-z-]*) --help\)"\s+if \[\[ "\$\1" == \*(--[a-z][a-z0-9-]*)\* \]\]; then\s+(MR_[A-Z_]+)=\(\3\)\s+fi/g
    for (const match of script.matchAll(capabilityGuard)) {
      const previous = gatedArrays.get(match[4])
      const sameGate = previous?.command === match[2] && previous.flag === match[3]
      gatedArrays.set(match[4], { command: match[2], flag: match[3], count: (sameGate ? previous.count : 0) + 1 })
    }
    // Outside recognized guards, only an empty initialization and read-only
    // parameter references are allowed. Fail closed on scalar/indexed writes,
    // +=, unset/read/printf -v, or other uses this small extractor cannot prove.
    for (const [name, gate] of gatedArrays) {
      const outsideGuard = script.replace(capabilityGuard, '')
        .replace(new RegExp(`^\\s*${name}=\\(\\)\\s*$`, 'gm'), '')
        .replace(new RegExp(`\\$\\{${name}(?:\\[@\\])?\\}|\\$${name}\\b`, 'g'), '')
      gate.unmodified = !new RegExp(`\\b${name}\\b`).test(outsideGuard)
    }
    for (const match of script.matchAll(/\b(MR_[A-Z_]+)\+?=\(([^)\n]*)\)/g)) {
      const flags = [...match[2].matchAll(/--[a-z][a-z0-9-]*/g)].map((m) => m[0])
      arrays.set(match[1], [...(arrays.get(match[1]) ?? []), ...flags])
    }
    for (const invocation of script.matchAll(/\bmr\s+([a-z][a-z-]*)([^\n|]*)/g)) {
      const [, command, args] = invocation
      const flags = new Map([...args.matchAll(/--[a-z][a-z0-9-]*/g)].map((m) => [m[0], false]))
      for (const variable of args.matchAll(/\$\{?(MR_[A-Z_]+)/g)) {
        if (!arrays.has(variable[1])) {
          throw new Error(`${task}.${phase}: unresolved mr argument array ${variable[1]}`)
        }
        const gate = gatedArrays.get(variable[1])
        for (const flag of arrays.get(variable[1])) {
          const gated = gate?.unmodified && gate.command === command && gate.flag === flag
            && arrays.get(variable[1]).filter((candidate) => candidate === flag).length === gate.count
          flags.set(flag, (flags.get(flag) ?? true) && gated)
        }
      }
      const required = requirements.get(command) ?? new Map()
      for (const [flag, gated] of flags) {
        const previous = required.get(flag)
        required.set(flag, { location: `${task}.${phase}`, gated: (previous?.gated ?? true) && gated })
      }
      requirements.set(command, required)
    }
  }
}
return requirements
}
// Guard recognition must not exempt direct flags, another command's help,
// another capability, or an unconditional use elsewhere in the task.
const guarded = `MR_OPTION_ARGS=()
help="$(mr apply --help)"
if [[ "$help" == *--future-option* ]]; then
  MR_OPTION_ARGS=(--future-option)
fi
mr apply "\${MR_OPTION_ARGS[@]}"`
const extracted = (script) => extractRequirements({ fixture: { exec: script } }).get('apply').get('--future-option').gated
if (!extracted(guarded)
  || extracted(guarded.replace('mr apply --help', 'mr status --help'))
  || extracted(guarded.replace('== *--future-option*', '== *--different-option*'))
  || extracted(`${guarded}\nmr apply --future-option`)
  || extracted(guarded.replace('mr apply "$', 'MR_OPTION_ARGS=--future-option\nmr apply "$'))
  || extracted(guarded.replace('mr apply "$', 'MR_OPTION_ARGS[0]=--future-option\nmr apply "$'))
  || extracted(guarded.replace('mr apply "$', 'MR_OPTION_ARGS+=(--future-option)\nmr apply "$'))
  || extracted('mr apply --future-option')) {
  throw new Error('Product flag extraction did not preserve capability boundaries')
}
const requirements = extractRequirements(tasks)
const flagCount = [...requirements.values()].reduce((total, flags) => total + flags.size, 0)
if (flagCount === 0) {
  throw new Error('Task extraction found no mr flags')
}
if (!requirements.get('apply')?.has('--commit-all-members')) {
  throw new Error('Task extraction did not cover CI nested mr:setup --commit-all-members')
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
  // Match option declarations, not flags merely mentioned in descriptions.
  const available = new Set(
    [...(result.stdout + result.stderr).matchAll(/^[ \t]+(--[a-z][a-z0-9-]*)(?=[, \t])/gm)].map((m) => m[1]),
  )
  for (const [flag, { location, gated }] of flags) {
    if (!available.has(flag) && !gated) {
      console.error(`${location}: manifest-backed mr ${command} lacks ${flag}`)
      failed = true
    }
  }
}
if (failed) process.exit(1)
console.log('megarepo product flags: every unconditional task flag is supported; capability-gated flags retain their help guard')
NODE
