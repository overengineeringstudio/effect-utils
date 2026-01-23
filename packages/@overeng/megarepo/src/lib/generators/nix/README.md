# Nix generator

The nix generator produces a local workspace flake under
`.direnv/megarepo-nix/workspace` and writes `.envrc.generated.megarepo` with the megarepo
environment variables. It mirrors each member into the workspace (filtered to
skip heavy build outputs) so the flake can use relative `path:./<member>` inputs
in pure evaluation mode.

`mr generate nix` only writes `.envrc.generated.megarepo`. `.envrc.local` is reserved for user customization and is never modified by generators.

## Outputs

- `.envrc.generated.megarepo`
- `.direnv/megarepo-nix/workspace/flake.nix`

The generated `.envrc.generated.megarepo` sets:

- `MEGAREPO_ROOT_OUTERMOST`
- `MEGAREPO_ROOT_NEAREST`
- `MEGAREPO_MEMBERS`
- `MEGAREPO_NIX_WORKSPACE`

The workspace flake exposes each member's packages and apps under:

- `packages.<member>.<package>`
- `apps.<member>.<app>`

Members without a `flake.nix` are mirrored into the workspace but skipped in
the workspace flake inputs.

Example:

```bash
nix build "path:$MEGAREPO_ROOT_OUTERMOST/.direnv/megarepo-nix/workspace#packages.<system>.effect-utils.genie"
```

## Enable

```json
{
  "generators": {
    "nix": { "enabled": true }
  }
}
```

To change the workspace location:

```json
{
  "generators": {
    "nix": { "enabled": true, "workspaceDir": ".direnv/megarepo-nix/workspace" }
  }
}
```

## Run

```bash
mr generate nix
```
