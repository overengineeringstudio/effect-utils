# CLI Distribution Patterns

This document describes the two patterns for distributing CLI tools (genie, megarepo, etc.) across repos, and when to use each.

## Design Decision

**Source-based CLIs (`mkSourceCli`) are only for the repo that defines the CLI.**

When you're developing a CLI, you want fast iteration without rebuilding Nix packages. But when you're consuming a CLI from another repo, you should use the pre-built Nix packages for reliability and reproducibility.

## The Two Patterns

### Pattern 1: Source-based (for CLI development)

Use `mkSourceCli` when you're **developing** a CLI within the same repo.

```nix
# effect-utils/devenv.nix - where genie/megarepo are defined
mkSourceCli = import ./nix/devenv-modules/lib/mk-source-cli.nix { inherit pkgs; };

packages = [
  (mkSourceCli { name = "genie"; entry = "packages/@overeng/genie/src/build/mod.ts"; })
  (mkSourceCli { name = "mr"; entry = "packages/@overeng/megarepo/bin/mr.ts"; })
];
```

**Characteristics:**

- Runs CLI directly from TypeScript source via `bun`
- No Nix build step, instant changes
- Uses `WORKSPACE_ROOT` or `$PWD` to find entry files
- Only works within the repo where the CLI source lives

**When to use:**

- You're actively developing the CLI
- The CLI source code is in the same repo as your devenv.nix

### Pattern 2: Nix packages (for CLI consumption)

Use pre-built Nix packages when you're **consuming** a CLI from another repo.

```nix
# schickling.dev/devenv.nix - consuming genie/megarepo from effect-utils
packages = [
  inputs.effect-utils.packages.${pkgs.system}.genie
  inputs.effect-utils.packages.${pkgs.system}.megarepo
];
```

**Characteristics:**

- Uses hermetically built CLI binary
- Reproducible across machines
- Hash-verified dependencies
- Works regardless of where effect-utils source is

**When to use:**

- You're using a CLI defined in another repo
- You want stable, reproducible CLI behavior
- You don't need to modify the CLI source

## Quick Reference

| Scenario                         | Pattern      | Example                               |
| -------------------------------- | ------------ | ------------------------------------- |
| Developing genie in effect-utils | Source-based | `mkSourceCli { name = "genie"; ... }` |
| Using genie in schickling.dev    | Nix packages | `effect-utils.packages.*.genie`       |
| Using genie in livestore         | Nix packages | `effect-utils.packages.*.genie`       |
| Developing livestore's own CLI   | Source-based | `mkSourceCli { name = "ls"; ... }`    |

## Anti-pattern: Source-based for external CLIs

**Don't do this:**

```nix
# WRONG - using mkSourceCli for CLIs from another repo
mkSourceCli = effectUtils.lib.mkSourceCli { inherit pkgs; };
effectUtilsRoot = effectUtils.outPath;

packages = [
  (mkSourceCli { name = "genie"; entry = "..."; root = effectUtilsRoot; })
];
```

This pattern:

- Requires hacks (`root` parameter) to make paths work
- Defeats the purpose of Nix's reproducibility
- Makes it unclear where the CLI comes from
- Breaks when effect-utils source structure changes

## Implementation Details

### effect-utils exports

```nix
# effect-utils/flake.nix
{
  # Pre-built CLI packages for consumers
  packages.${system} = {
    genie = ...;      # Nix-built genie binary
    megarepo = ...;   # Nix-built megarepo binary
  };

  # mkSourceCli is internal-only, not exported
  # (used only in effect-utils devenv.nix)
}
```

### Hash management

Nix packages require hash updates when dependencies change:

- `pnpmDepsHash` - hash of pnpm dependencies
- `localDeps[].hash` - hashes of local workspace dependencies

Use `dt nix:hash` to update all hashes automatically.

## See Also

- [Flake Packages](./flake-packages.md) - How to build CLI packages with Nix
- [Setup Guide](./setup-guide.md) - Setting up devenv in a new repo
