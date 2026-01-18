# Dotdot Issues

## Rethink `WORKSPACE_ROOT` env var concept

## Can we make dotdot optional e.g. for livestore to improve contributor experience?

## Playwright duplicate loads in dotdot setups

See `context/workarounds/playwright-duplicate-loading.md` for the detailed investigation, constraints, and solution options.

## Weird relative path patterns

### Nix

- `dotfiles/nixpkgs/home-manager/modules/ts/oi/flake.nix`
  ```nix
  effect-utils = {
    url = "git+file:../../../../../../effect-utils";
    flake = false;
  };
  ```
  - and vendoring of packages from effect-utils into the oi flake (e.g. `vendor/effect-react`)
  - Related: https://gist.github.com/schickling/38e55f176e504d170430098d91982ef3

### Genie

- `schickling.dev/genie/external.ts`
  ```typescript
  const overengPath = (pkg: string) => `file:../../../effect-utils/packages/${pkg}`
  ```
  - and using `overengPath` to resolve paths to effect-utils packages

### CSS

- `dotfiles/nixpkgs/home-manager/modules/ts/oi/src/am/ui/styles.css`
  ```css
  @source "../../../node_modules/@overeng/geist-design-system/src";
  ```
  - This is a workaround to allow Tailwind to scan the Geist component sources. The `node_modules` part is weird.

### VSCode

- Installed TS version can't be selected as VSC expects it in the root `node_modules` folder.

## Bun patchedDependencies bug

See `context/workarounds/bun-patched-dependencies.md` for the detailed investigation, constraints, and solution options.