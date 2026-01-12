# dotdot Roadmap

## user todos

- [ ] bun patch only works if the patch is in the same directory as the package.json
- [ ] how to run `effect-language-service patch` only once per workspace
- [ ] custom bun store per workspace?
- [ ] rethink separating repos vs packages in config.

- [ ] refactor to embrace effect more (e.g. better schemas, effect fs, cmd etc)

### document

- [ ] docs page for usage with nix 
  - [ ] git vs local path stuff (use overrides in .envrc)
  - [ ] how to use with devenv
- [ ] docs page for usage with mono cli pattern

### nice to have

- hierarchy map
- worktree feature on project level


## Completed

- [x] **Foundation**
  - [x] Project setup (bun workspace, Effect dependencies)
  - [x] TypeScript configuration
  - [x] Config schema (JSON-based `dotdot.json`)
  - [x] Git operations module (`isGitRepo`, `getCurrentRev`, `isDirty`, etc.)
  - [x] Config loader (JSON config files)
  - [x] Workspace discovery (`findWorkspaceRoot`)
  - [x] Config flattening (`collectAllConfigs`)
  - [x] Test infrastructure with fixtures

- [x] **Core Commands**
  - [x] `status` command - shows workspace status
  - [x] `sync` command - clones missing repos, checkouts pinned revs, runs install (repo + package level)
  - [x] `update-revs` command - updates pinned revisions in config
  - [x] `pull` command - pulls all repos (parallel/sequential modes)
  - [x] `exec` command - runs commands in all repos (parallel/sequential modes)
  - [x] `tree` command - displays dependency tree
  - [x] `link` command - creates/removes symlinks based on `packages` config

- [x] **Execution Modes**
  - [x] Parallel execution with optional max concurrency
  - [x] Sequential execution
  - [x] `--mode` and `--max-parallel` options for sync, pull, exec
  - [x] Topological execution (`topo`, `topo-parallel`) with custom graph module
  - [x] Dependency graph built from nested configs

- [x] **Package Management**
  - [x] `packages` field in repo config for exposing packages as symlinks
  - [x] Package-level install commands in sync
  - [x] Symlink creation with proper handling for nested package names

## Future

- [ ] **Clone Command**
  - [ ] `dotdot clone <url> [name]` - add new repo to workspace
  - [ ] Parse git URL to extract repo name
  - [ ] Add entry to root `dotdot.json`
  - [ ] Pin current revision automatically

- [ ] **Distribution**
  - [ ] Nix build with binary output
  - [ ] npm package with TypeScript types for editor support

- [ ] **Developer Experience**
  - [ ] Shell completions (bash, zsh, fish)
  - [ ] `--json` output for scripting
  - [ ] Color support (detect TTY)

- [ ] **Documentation**
  - [ ] Usage with Nix
  - [ ] Usage with mono CLI pattern
  - [ ] How to use with devenv

- [ ] **Advanced Features**
  - [ ] Watch mode for live status updates
  - [ ] Pre/post hooks for clone, pull, etc.
  - [ ] GitHub/GitLab shorthand URLs
