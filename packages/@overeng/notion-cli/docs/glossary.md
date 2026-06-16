# Notion CLI — Glossary

Domain language for the `@overeng/notion-cli` package. This glossary covers the umbrella CLI and runtime boundary, not datasource-sync replica internals.

## Language

**Umbrella CLI**:
The public `notion` executable that composes package-owned command trees under one root.
_Avoid_: monolithic CLI

**Namespace**:
A first-level command group under `notion`, currently `md`, `schema`, or `db`.
_Avoid_: alias, mode

**Native Leaf**:
A command implemented directly inside the Bun-compatible root CLI, such as `notion db info`.
_Avoid_: local command

**Editor alias**:
The top-level `notion edit <page>` command, an intentional marquee verb that
delegates to `notion md edit`. The only first-level command outside the
`md`/`schema`/`db` namespaces. Distinct from a retired legacy alias.
_Avoid_: shortcut, legacy alias

**Editor command**:
A `notion md` command for editor-based page editing, owned by
`@overeng/notion-md`: the stateless `cat`/`put` body pipes (stdin/stdout, no local
file) and `edit` (an ephemeral file-engine session over a `$TMPDIR` temp tree).
`--frontmatter` is read-only on `cat` and read/write on `edit`.
_Avoid_: streaming command (it spans the engine-backed `edit`), pipe command

**Node-backed Leaf**:
A `notion db` command that must execute in the packaged Node runtime because datasource-sync imports `node:sqlite`.
_Avoid_: sqlite command, replica namespace

**Import-safe Descriptor**:
An Effect CLI command tree that can be imported by the Bun root CLI for help and completions without importing Node-only runtime modules.
_Avoid_: stub command, alias

**Wrapper Dispatch**:
The Nix package shell wrapper logic that routes selected `notion db` leaves from the Bun binary to the Node-backed datasource-sync runtime.
_Avoid_: compatibility alias
