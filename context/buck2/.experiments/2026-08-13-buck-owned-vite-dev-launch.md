# Buck-owned Vite development launch

Date: 2026-08-13
Host class: aarch64-linux development host (`dev4`)
Candidate: PR #1080 at `c86121bd38c389c6a5a3db3c49b65fc7b1e9bb1f`

## Question

Can Buck own a canonical, exact development-server launch closure without a
worktree-local `node_modules`, while Vite retains correct live-source HMR and a
supervisor retains process lifecycle authority?

## Model under test

```text
Buck RunInfo -> exact runnable closure and launch contract
Vite         -> live source transformation and HMR
supervisor   -> ports, signals, restart, readiness, and writable state
```

The experiment did not model the long-running server as a cacheable Buck action.
It used `buck2 run` to materialize and launch a declared closure, then let Vite
observe mutable source files.

## Method

The experiment prepared a minimal pinned Nix tool environment, a separate exact
Vite dependency projection, a disposable nested Buck cell, and an external
writable state root. It exercised the environment and model below.

### Environment

- Buck2 revision prefix: `a447e6d1`
- Node: `24.18.1`
- Vite: `8.0.16`, matching the PR #1080 lock resolution
- Minimal Nix tool environment: Bash, coreutils, Buck2, Node, `util-linux`, and
  Watchman from nixpkgs revision
  `8b8c811c7c2541c30382c5de7ed26be055569c60`
- Vite dependencies: a separate exact projection inside the disposable Buck
  cell, not under the live application source root
- Writable Vite state: external per-instance directories

The minimal environment avoided importing `devenv.nix`. A preceding bounded
attempt through the full devenv shell produced no verdict because it expanded
unrelated Grafana, OTEL, Notion, CI, and Rust-product closures before timing out.

### Causal controls

The first real Buck launch produced RED before readiness because the prototype
required every Nix `buildEnv` entrypoint's real path to remain below the union
directory. Nix union entries legitimately resolve to constituent store paths.
The corrected invariant compared the resolved executable with the declared
tool entrypoint. Two other setup failures identified missing `util-linux` for
`setsid` and Vite 8's rejection of the obsolete `--cacheDir` CLI flag. The
GREEN candidate supplied launcher utilities through the declared tool
environment and configured cache location through the Vite configuration
boundary.

## Result

| Control                                          | Result |
| ------------------------------------------------ | ------ |
| Real `buck2 run` readiness                       | Pass   |
| Launch ownership receipt                         | Pass   |
| Terminating the Buck client removed the listener | Pass   |
| HTTP serving                                     | Pass   |
| Vite HMR after a local source edit               | Pass   |
| Vite HMR after a workspace-relative source edit  | Pass   |
| Two concurrent ports and state namespaces        | Pass   |
| Launcher signal teardown                         | Pass   |
| Restart served current source                    | Pass   |
| Node, `setsid`, and Vite matched declared tools  | Pass   |
| Writable cache remained outside live source      | Pass   |
| Application `node_modules` and `.vite` absent    | Pass   |
| Mutated source restored after the experiment     | Pass   |

Four launch receipts were observed across the direct, concurrent, and restart
controls. Peak measured free-space delta was 97,169,408 bytes. Cleanup removed
the exact experiment root, Buck daemon, listeners, matching processes, and the
experiment-owned GC root. Final free space was 111,919,648,768 bytes. About
33.6 MB remained only as unrooted Nix-store realization/download state; no Nix
GC or service deployment was performed.

## Conclusion

Pass for the narrow model under test. A Buck-owned canonical launcher can supply
an exact Node/Vite closure and coexist with live local and workspace-source HMR,
external writable caches, concurrent instances, signal teardown, and restart
without a worktree-local `node_modules`.

This does not establish that Buck owns transformations performed by Vite after
launch. It also does not establish editor/language-server parity, native Node
addon parity, Storybook parity, remote-cache trust for locally executed code,
secret allowlisting, or a steady-state local Buck cache and isolation-directory
retention policy. Those remain separate admission gates.

## VRS Impact

The viable option is a bounded development-process contract, not transfer of
long-running lifecycle authority into Buck:

```text
Buck              owns the exact runnable closure and launch identity
Vite or Storybook owns interactive transforms and HMR
devenv/process-compose owns supervision, ports, secrets, readiness, and state
```

The production design should generate this launch contract from the semantic
package model and dependency projection. It must not preserve the disposable
directory-source prototype or treat a worktree-local package projection as
authoritative action input.
