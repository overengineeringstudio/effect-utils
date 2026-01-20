# megarepo

Status: Needs to be implemented to replace dotdot

## What it actually does?

1. Check these things out
2. Make symlinks
3. Generate stuff (e.g. vscode workspace config, nix flakes, ...)

## goals

- duality
  - each (workspace) member repo should be self-contained and work independently
  - workspace provides convenience for working on things together


## changes to v1

- get rid of `exposes` / hoisting concept
  - the `exec` command now only covers repos. more fine-grained scopes (e.g. packages) needto be handled by something else (i.e. leave it to the repo)
- supported env var to configure the store location: `MEGAREPO_STORE` env var + feature
  - default `~/.megarepo` directory
  - store layout mirrors GitHub names:
    - `~/.megarepo/github.com/<owner>/<repo>`
    - for non-GitHub repos: `~/.megarepo/local/<repo>`
- env vars
  - `MEGAREPO_ROOT` env var: nearest ancestor directory with a `megarepo.json` file
  - `MEGAREPO_MEMBERS` env var (e.g. `livestore,effect-utils,other-repo`). comma separated list of repo names
- we no longer enforce a flat structure, you can now have nested megarepos
- there's no longer different kinds of configs (e.g. `dotdot.json` vs `dotdot-root.json`) only one `megarepo.json`
  - no longer roll up config into `dotdot-root.json`
- the concept of a "workspace" is now a "megarepo"
- we change the purpose of the `sync` command
  - 1. Check these things out
  - 2. Make symlinks
  - 3. Generate configs (e.g. vscode workspace config, nix flakes, ...)
- introduce generators: initially baked in and part of config
  - vscode workspace config
  - nix flakes
  - devenv file

### commands

#### core commands
- `mr sync`
  - does the heavy lifting: checks out the repos, makes symlinks, runs generators

#### common options

- `--dry-run`
- `--scope shallow|deep`
- `--filter <glob>`

#### convenience commands
- `mr init`: initializes a `megarepo.json` file in the current directory
- `mr status`: shows the status of the megarepo
- `mr env`: prints the environment variables used by the cli
  - `--shell bash|zsh|fish`
- `mr ls`
- `mr update`: pulls all repos from their remotes
  - `--update-revs`: optionally updates the pinned revisions in the config where present
- `mr exec`
  - `--mode parallel|sequential|topo|topo-parallel`
- `mr isolate <repo> <branch>`: replaces the symlink for the repo and  creates a worktree with the given branch name (convenience: changes the config and runs sync)
  - opposite: `mr unisolate <repo>`: removes the worktree and restores the symlink

#### store commands
- `mr store ls`
- `mr store add <repo> <branch>`: adds a repo to the store
- `mr store fetch`: runs git fetch on all repos in the store

## faq

- couldn't we also use submodules?
  - no, doesn't work well with symlinking strategy  

## minimum level of usage barrier

- `dotdot` cli (via bunx)

---

# archived notes

## open questions

- can we get rid of `exposes` / hoisting concept?
- flake vs devenv
- hoisted node_modules (e.g. for pw)
- where do "exposes" for packages go?
- do we want the `WORKSPACE_ROOT` env var? (pros/cons)
- why would we still need a repo-level dotdot config?
  - dependencies!
- can you have `dotdot-workspace.json` in multiple hierarchies?
- bun install too slow when running in parallel
- task running
  - `bun install` everywhere


## workspace config (sketch, real version will use `megarepo.json`)

```toml
[workspace]
name = "shareup-main"

[dependencies]
poc-server = { github = "shareup/poc-server", isolated = "feature-notifications" }
frontend = { github = "shareup/frontend", isolated = "feature-notifications" }
api-gateway = { github = "shareup/api-gateway", pin = "v2.3.1" }
mobile-app = { github = "shareup/mobile-app", pin = "abc123f" }
design-system = { github = "shareup/design-system" }
docs = { github = "shareup/docs" }
# what does `flake = false` mean/do?

[generators.flake]
skip = ["design-system", "docs"]

[generators.vscode]
exclude = ["design-system", "docs"]
```

## ideas

- git-style `git-some-cmd` -> `git some-cmd` convention to allow users to add their own commands to the cli
- `mr develop` (handled in user land)
- containerizing the workspace (e.g. vscode dev container)
- generated combined workspace flake (to setup all infrastructure for the workspace)
  - would be a union of all dev shells of all repos
    ```nix
    {
    inputs = {
      nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
      dev-supervisord.url = "github:shareup/dev-supervisord";
      poc-server.url = "git+file:///path/to/poc-server";
      other-repo.url = "git+file:///path/to/other-repo";
    };

    outputs = { self, nixpkgs, dev-supervisord, poc-server, other-repo }:
      let
        system = "aarch64-darwin";
        pkgs = import nixpkgs { inherit system; };
      in {
        devServices.${system} =
          poc-server.devServices.${system} //
          other-repo.devServices.${system};

        devShells.${system}.default = pkgs.mkShell {
          inputsFrom = [
            poc-server.devShells.${system}.default
            other-repo.devShells.${system}.default
          ];
          shellHook = ''
            ${poc-server.devShells.${system}.default.shellHook or ""}
            ${other-repo.devShells.${system}.default.shellHook or ""}
            devd up
          '';
        };
      };
  }
  ```
- separate hostname per workspace (with isolated ports)

## notes

- Nathan doesn't like devenv -> flakes
  - services are scoped (to a repo, we don't want 4 postgres services running on the same machine)
  - we could make dd plugable (both flake/devenv)
