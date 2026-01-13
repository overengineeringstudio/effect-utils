# Nix Setup

Two approaches for setting up Nix-based development environments with effect-utils:

## [Pure Nix Flakes](./nix-flake-setup.md)

Use `flake.nix` with GitHub URLs and `--override-input` in `.envrc` for local overrides.

- Works with unpushed local changes via input overrides
- No deprecation warnings
- Direct control over Nix configuration

## [devenv](./devenv-setup.md)

Use `devenv.yaml` and `devenv.nix` for a higher-level declarative setup.

- Simpler configuration
- Built-in support for languages, services, processes
- Uses GitHub URLs (requires pushed changes)

## Choosing an Approach

Both approaches work well. Choose based on your needs:

| Need | Recommended |
|------|-------------|
| Local changes before pushing | Pure Flake |
| Simple setup | devenv |
| Fine-grained Nix control | Pure Flake |
| Language/service integrations | devenv |
| CI without changes | Both work |

## Test Setup

See `tests/mk-bun-cli` for the fixture repos and runner that exercise
flakes, devenv, and peer-repo composition.
