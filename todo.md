- [ ] factor out parallel task execution and printing for cli
  - use cases
    - `mono install`
    - `mono check`
    - `mono lint`
    - `mono test`

## mono

- [ ] make it easy to see whether binary version is up to date with source version (to avoid running an outdated version)
- [ ] make it easier to rebuild the binary (both for nix flakes and devenv)
- [ ] fish auto complete for `mk bun nix build`

## genie

- [ ] add effect-lsp to each package
- [ ] patches feature: we currently don't have a good way to enforce dependents of a package with patches to also have patches in their package.json.genie.ts
- [ ] refactor handling of relative paths in genie (embrace dotdot workspace root)
  - [ ] genie generators get ctx (including package location), should embrace that (e.g. use placeholder symbols for replacement or allow callbacks for less magic)
