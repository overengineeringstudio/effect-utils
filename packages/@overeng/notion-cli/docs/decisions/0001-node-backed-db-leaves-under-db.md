# Node-backed database leaves stay under `notion db`

Status: accepted

Datasource-sync needs Node 24 for `node:sqlite`, while the public `notion` executable remains a Bun-compiled umbrella CLI. We expose datasource-sync commands as import-safe `notion db` descriptors in the root command tree and route selected packaged leaves to the Node runtime with wrapper dispatch.

## Considered Options

| Option                                                  | Outcome                                                                                   |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Keep `notion sqlite`                                    | Rejected because it creates a second public database namespace.                           |
| Publish `notion-datasource-sync` as a public executable | Rejected because users should have one Notion CLI surface.                                |
| Move all `notion db` execution to Node                  | Rejected because `notion db info` is Bun-compatible and does not need the SQLite runtime. |
| Hide Node-backed leaves from root help                  | Rejected because help/completion output would not match the packaged CLI surface.         |

## Consequences

The root CLI must use import-safe descriptors for Node-backed leaves. The Nix package must smoke-test wrapper dispatch so missing runtime workspace files fail at build time.
