# Nix Streamlining Notes

Context and rationale for the Nix/direnv/devenv streamlining work in
effect-utils.

## Contents

- `overview.md` — goals, constraints, changes, tradeoffs, and touched files
- `mk-bun-cli.md` — mk-bun-cli patterns and rationale (with snippets)
- `validation.md` — validation runs and notable fixes

## Helper Outputs and Paths

Flake outputs:

- `direnv.autoRebuildClis`
- `direnv.peerEnvrc`
- `direnv.peerEnvrcEffectUtils`
- `direnv.effectUtilsEnvrc`
- `lib.mkBunCli`
- `lib.cliBuildStamp`

Helper files:

- `env/direnv/auto-rebuild-clis.nix`
- `env/direnv/peer-envrc.nix`
- `env/direnv/peer-envrc-effect-utils.nix`
- `env/direnv/effect-utils-envrc.nix`
