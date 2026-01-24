# Nix Build Sandbox Constraints

## The `/usr/bin/env` Problem

### Context

Nix builds run in a **sandboxed environment** that isolates the build from the host system. This sandbox does not include standard FHS paths like `/usr/bin/`. When npm/pnpm packages have lifecycle scripts (postinstall, prepare) that invoke binaries with `#!/usr/bin/env node` shebangs, they fail:

```
sh: /build/workspace/.../node_modules/.bin/effect-language-service: /usr/bin/env: bad interpreter: No such file or directory
```

### Why This Happens

1. Many npm packages ship binaries with `#!/usr/bin/env node` shebangs
2. pnpm/npm runs lifecycle scripts (`prepare`, `postinstall`) during `install`
3. In the Nix sandbox, `/usr/bin/env` doesn't exist
4. The script fails, causing the entire dependency installation to fail

## References

- [Nix manual: patchShebangs](https://nixos.org/manual/nixpkgs/stable/#fun-patchShebangs)
- [pnpm --ignore-scripts](https://pnpm.io/cli/install#--ignore-scripts)
- [NixOS Discourse: FHS and shebangs](https://discourse.nixos.org/t/how-to-handle-usr-bin-env-in-nix-builds/5695)
