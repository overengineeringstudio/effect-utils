# Align Devenv Repos on Single nixpkgs Input

## Problem Statement

The devenv repos in the workspace have inconsistent nixpkgs configurations:
- Most repos use `github:NixOS/nixpkgs/nixos-unstable` as their single nixpkgs
- `private-shared` uses `release-25.11` + separate `nixpkgsUnstable`
- `effect-utils/flake.nix` (the library) has both `nixpkgs` (release-25.11) and `nixpkgsUnstable`

This inconsistency:
- Makes it harder to reason about package versions across repos
- Requires passing both `pkgs` and `pkgsUnstable` through the API
- Creates confusion about which nixpkgs to use

## Constraints

- Don't modify `mk-bun-cli.nix` directly - it still accepts `pkgsUnstable` param
- All devenv shells must work after changes
- Minimize changes to consumer repos that already pass `pkgsUnstable = pkgs`

## Proposed Solution

Standardize on single nixpkgs input: `github:NixOS/nixpkgs/nixos-unstable`

- Update `effect-utils/flake.nix` to use single nixpkgs
- Update `build.nix` files to pass `pkgsUnstable = pkgs` with TODO to drop later
- Update `private-shared` to use single nixpkgs
- Consumer repos already pass `pkgsUnstable = pkgs` - no changes needed

## Implementation

### Phase 1: Update effect-utils/flake.nix

- [x] Change `nixpkgs.url` from `release-25.11` to `github:NixOS/nixpkgs/nixos-unstable`
- [x] Remove `nixpkgsUnstable` input
- [x] Update outputs to use single `pkgs` (pass to both params in build calls)
- [x] Update `lib.mkCliPackages` to use single pkgs internally

### Phase 2: Update build.nix files with TODO

- [x] `packages/@overeng/genie/nix/build.nix` - add TODO, handle pkgsUnstable = pkgs default
- [x] `packages/@overeng/dotdot/nix/build.nix` - add TODO, handle pkgsUnstable = pkgs default
- [x] `packages/@overeng/megarepo/nix/build.nix` - add TODO, handle pkgsUnstable = pkgs default
- [x] `scripts/nix/build.nix` - add TODO, handle pkgsUnstable = pkgs default

### Phase 3: Update private-shared

- [x] `devenv.yaml` - change to `nixos-unstable`, remove `nixpkgsUnstable`
- [x] `devenv.nix` - use `pkgs` everywhere instead of `pkgsUnstable`

### Phase 4: Verify all dev shells

**Note**: Verification blocked by GitHub API rate limiting during implementation.
All nix syntax checks pass. Manual verification needed when rate limits reset.

- [ ] `effect-utils` - `devenv shell -- exit`
- [ ] `livestore` - `devenv shell -- exit`
- [ ] `private-shared` - `devenv shell -- exit`
- [ ] `schickling-stiftung` - `devenv shell -- exit`
- [ ] `schickling.dev` - `devenv shell -- exit`
- [ ] `test-devenv` - `devenv shell -- exit`

### Phase 5: Cleanup (future)

- [ ] Remove `pkgsUnstable` param from `mk-bun-cli.nix`
- [ ] Remove `pkgsUnstable` param from `build.nix` files
- [ ] Remove `pkgsUnstable` from `lib.mkCliPackages` signature
- [ ] Update consumer repos to stop passing `pkgsUnstable`

## Iteration/Feedback Loop

After each phase, verify affected dev shells:
```bash
cd <repo> && devenv shell -- exit
```

For effect-utils specifically, also verify CLI builds:
```bash
nix build .#genie
nix build .#dotdot
```
