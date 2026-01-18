- [ ] factor out parallel task execution and printing for cli
  - use cases
    - `mono install`
    - `mono check`
    - `mono lint`
    - `mono test`

## dotdot

- [ ] command to generate vscode workspace file for the workspace
- [ ] get rid of `link` command in favour of `sync`

### worktrees

- [ ] use worktrees for each repo (add warning to status if not using worktrees)
  - we'll need a cannonical path for git worktrees (e.g. ~/worktrees/repo-name)
- [ ] poses a form of conflict because exposed packages are now overlapping

## mono

- [ ] add to `mono check` that bun lock files are up to date and devnenv builds
- [ ] make it easy to see whether binary version is up to date with source version (to avoid running an outdated version)
- [ ] make it easier to rebuild the binary (both for nix flakes and devenv)
- [ ] fish auto complete for `mk bun nix build`
- [ ] devenv/direnv local fish autocomplete loading

## genie

- [ ] flow generate AGENTS.md file
  - dotdot
  - tasks flow
  - where to find common things (e.g. skills, shared libs, references (e.g. effect), ...)
    - tension: i want to run agent in sub dir to scope it but i also want to give it access to the whole workspace for context/references
- [ ] add effect-lsp to each package
- [ ] patches feature: we currently don't have a good way to enforce dependents of a package with patches to also have patches in their package.json.genie.ts
- [ ] refactor handling of relative paths in genie (embrace dotdot workspace root)
  - [ ] genie generators get ctx (including package location), should embrace that (e.g. use placeholder symbols for replacement or allow callbacks for less magic)

